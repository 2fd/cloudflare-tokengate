// Caller provider (service consumer) mutations, validated per profile (I-TEN-1 tenant pin, I-JWT-1
// algorithms and audience). Trust changes under enabled grants need confirmation; anchor/pin
// changes that would invalidate an enabled grant are refused (I-AUTHZ-2). One audit row per change
// (I-AUDIT-1): display labels of pin values (claim_labels) are written in the batch of the change
// that typed them. Labels are display and form data only; policy evaluation never reads them.
import {
  type CallerProviderValues,
  callerProviderEnabledGrantsUnchangedGuard,
  callerProviderExistsGuard,
  callerProviderUnreferencedGuard,
  callerProviderVersionGuard,
  callerProviderWithoutEnabledGrantsGuard,
  deferForeignKeysStatement,
  deleteCallerProviderStatement,
  getCallerProvider,
  insertCallerProviderStatement,
  listCallerProviders,
  setCallerProviderEnabledStatement,
  updateCallerProviderStatement,
} from '../../db/caller-providers';
import {
  type ClaimLabelInput,
  changedLabels,
  deleteClaimLabelsStatement,
  listClaimLabels,
  upsertClaimLabelStatement,
} from '../../db/claim-labels';
import { deleteGrantsByIdsStatement, exactGrantSetGuard, listGrants } from '../../db/grants';
import type { Actor, CallerProvider, ClaimLabel, Grant, LabelledClaim } from '../../db/types';
import type { Deps } from '../../deps';
import { discoverIssuer } from '../../identity/jwt';
import { getProfile } from '../../identity/profiles';
import { GITHUB_ACTIONS_ISSUER } from '../../identity/profiles/github-actions';
import { GITLAB_COM_ISSUER } from '../../identity/profiles/gitlab-ci';
import type { IssuerProfile, ProfileId } from '../../identity/types';
import { newId } from '../../lib/ids';
import { canonicalJson } from '../../lib/json';
import type { Condition } from '../../policy/types';
import { ALLOWED_ALGS, validateCallerProvider, validateGrant } from '../../policy/validate';
import {
  allOf,
  booleanErrors,
  commitOrConstraintFailure,
  concurrentChange,
  NAME_MAX_LENGTH,
  nextVersion,
  normalizeConditions,
  type OpFailure,
  opFailure,
  pick,
  type SqlGuard,
  staleEdit,
  trimmed,
} from './shared';

const AUDIENCE_PREFIX = 'tokengate:';
const AUDIENCE_RANDOM_CHARS = 26;
/** RFC 4648 base32 alphabet, lower case. */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const DIGITS_RE = /^[0-9]{1,20}$/;

/** Profiles whose pin values are numeric IDs with display labels (claim_labels). */
const TENANT_CLAIM: Readonly<Partial<Record<ProfileId, LabelledClaim>>> = {
  'github-actions': 'repository_owner_id',
  'gitlab-ci': 'namespace_id',
};

/** The labelled pin claim of a profile (organizations or groups), or null (generic). */
export function tenantClaimOf(profile: ProfileId): LabelledClaim | null {
  return TENANT_CLAIM[profile] ?? null;
}

/**
 * Default audience for a new caller provider: `tokengate:` + 26 random base32 characters
 * (130 bits). Random rather than derived from the hostname, so it is unique per deployment and
 * tokens minted for another gateway are never accepted here.
 */
export function defaultAudience(random: (length: number) => Uint8Array): string {
  const bytes = random(AUDIENCE_RANDOM_CHARS);
  let out = AUDIENCE_PREFIX;
  // 256 is a multiple of 32, so `byte % 32` is uniform.
  for (const byte of bytes) out += BASE32[byte % 32];
  return out;
}

/**
 * The name a consumer gets when none is typed (A7.1): "GitHub Actions (acme, acme-labs)",
 * "GitHub Actions (acme +3)" when the list would pass 100 characters, "GitLab (acme-group)",
 * "GitLab (gitlab.example.com)" for a self-managed instance, or the issuer host plus path.
 * `tenants` are the labels (or IDs) of the pin values, in pin order.
 */
export function deriveConsumerName(
  profile: ProfileId,
  issuer: string,
  tenants: readonly string[],
): string {
  if (profile === 'generic') return issuerText(issuer).slice(0, NAME_MAX_LENGTH);
  const label = profile === 'github-actions' ? 'GitHub Actions' : 'GitLab';
  if (profile === 'gitlab-ci' && issuer.replace(/\/$/, '') !== GITLAB_COM_ISSUER) {
    return `${label} (${issuerText(issuer)})`.slice(0, NAME_MAX_LENGTH);
  }
  if (tenants.length === 0) return label;
  const full = `${label} (${tenants.join(', ')})`;
  if (full.length <= NAME_MAX_LENGTH) return full;
  return `${label} (${tenants[0]} +${tenants.length - 1})`.slice(0, NAME_MAX_LENGTH);
}

function issuerText(issuer: string): string {
  try {
    const url = new URL(issuer);
    return `${url.host}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return issuer;
  }
}

/** The derived name of a stored consumer, from its pin and the stored labels. */
function derivedNameOf(
  provider: Pick<CallerProvider, 'profile' | 'issuer' | 'tenant_pin'>,
  labels: readonly Pick<ClaimLabel, 'claim' | 'value' | 'label'>[],
): string {
  const claim = tenantClaimOf(provider.profile);
  const values = claim === null ? [] : pinValues(provider.tenant_pin, claim);
  return deriveConsumerName(
    provider.profile,
    provider.issuer,
    values.map(
      (value) => labels.find((l) => l.claim === claim && l.value === value)?.label ?? value,
    ),
  );
}

/** Values of the exact, non-negated pin conditions on `claim`, in order. */
export function pinValues(pin: readonly Condition[], claim: string): string[] {
  return [
    ...new Set(
      pin
        .filter((c) => c.claim === claim && c.match === 'exact' && c.negate !== true)
        .flatMap((c) => c.values),
    ),
  ];
}

/** `base`, or `base (2)`, `base (3)`… : the first name no other consumer uses. */
async function freeName(db: D1Database, base: string, excludeId?: string): Promise<string> {
  const taken = new Set(
    (await listCallerProviders(db))
      .filter((provider) => provider.id !== excludeId)
      .map((provider) => provider.name.toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`;
    const candidate = `${base.slice(0, NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

export interface CallerProviderCreateInput {
  /** Empty or absent: deriveConsumerName, made unique with " (2)". */
  name?: string;
  profile: string;
  /** Default: the profile's issuer (GitHub Actions, GitLab.com). */
  issuer?: string;
  /** Generic profile only: explicit JWKS URI; otherwise discovered from the issuer. */
  jwks_uri?: string | null;
  /** Default: defaultAudience(). */
  audience?: string | null;
  /** Default: the profile's; generic: what discovery lists, within ALLOWED_ALGS, else RS256. */
  allowed_algs?: string[];
  max_token_age_seconds?: number;
  tenant_pin?: Condition[];
  /** Display labels of pin values, written in the create batch. */
  tenant_labels?: Array<{ claim: LabelledClaim; value: string; label: string }>;
  anchor_claims?: string[];
  enabled?: boolean;
}

export type CallerProviderOpResult =
  | {
      ok: true;
      callerProvider: CallerProvider;
      warnings: string[];
      /** Updates only: false when the submitted values matched and nothing was written. */
      changed?: boolean;
    }
  | OpFailure;

export async function createCallerProvider(
  deps: Deps,
  actor: Actor,
  input: CallerProviderCreateInput,
): Promise<CallerProviderOpResult> {
  const profile = getProfile(String(input.profile));
  if (!profile)
    return opFailure('invalid', ['profile must be github-actions, gitlab-ci or generic']);
  const flagErrors = booleanErrors('enabled', input.enabled);
  if (flagErrors.length > 0) return opFailure('invalid', flagErrors);

  const db = deps.env.DB;
  const issuer = trimmed(input.issuer) || profile.defaults.issuer || '';
  const explicitJwks = explicitJwksUri(profile, input.jwks_uri);
  const audience = trimmed(input.audience) || defaultAudience(deps.random);
  const tenantPin = normalizeConditions(input.tenant_pin ?? []);
  const labels = (input.tenant_labels ?? []).map((label) => ({
    ...label,
    label: label.label.trim(),
  }));
  const typedName = trimmed(input.name ?? '');
  const derived = deriveConsumerName(
    profile.id,
    issuer,
    pinValues(tenantPin, tenantClaimOf(profile.id) ?? '').map(
      (value) => labels.find((label) => label.value === value)?.label ?? value,
    ),
  );
  const valuesWith = (jwksUri: string, algs: string[], name: string): CallerProviderValues => ({
    name,
    issuer,
    jwks_uri: jwksUri,
    audience,
    allowed_algs: algs,
    max_token_age_seconds: input.max_token_age_seconds ?? profile.defaults.maxTokenAgeSeconds,
    tenant_pin: tenantPin,
    anchor_claims: input.anchor_claims ?? [],
    enabled: input.enabled ?? true,
  });
  const defaultAlgs = input.allowed_algs ?? [...profile.defaults.allowedAlgs];

  // Validate before any network call; discovery runs only for an acceptable configuration.
  const precheck = validateCallerProvider(
    {
      ...valuesWith(explicitJwks ?? issuer, defaultAlgs, typedName || derived),
      profile: profile.id,
    },
    profile,
    null,
  );
  const extra = [...numericPinErrors(profile, tenantPin), ...labelErrors(labels)];
  if (precheck.errors.length > 0 || extra.length > 0) {
    return opFailure('invalid', [...precheck.errors, ...extra], precheck.warnings);
  }
  const jwks = await resolveJwks(deps, issuer, explicitJwks);
  if (!jwks.ok) return opFailure('invalid', [jwks.error]);
  const algs =
    input.allowed_algs ??
    (profile.id === 'generic' ? discoveredAlgs(jwks.signingAlgs) : defaultAlgs);
  const name = typedName || (await freeName(db, derived));
  const values = valuesWith(jwks.jwksUri, algs, name);
  const validation = validateCallerProvider({ ...values, profile: profile.id }, profile, null);
  if (validation.errors.length > 0) {
    return opFailure('invalid', validation.errors, validation.warnings);
  }

  const now = deps.now();
  const callerProvider: CallerProvider = {
    ...values,
    id: newId('cpr', now, deps.random),
    profile: profile.id,
    created_at: now,
    updated_at: now,
  };
  const labelInputs = labels.map((label) => ({ ...label, caller_provider_id: callerProvider.id }));
  const exists = callerProviderExistsGuard(callerProvider.id);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'caller_provider.create',
      targetType: 'caller_provider',
      targetId: callerProvider.id,
      summary: `Created caller provider ${callerProvider.name} (${profile.id})`,
      diff: {
        after: callerProvider,
        warnings: validation.warnings,
        ...(labelInputs.length > 0 ? { labels: labelDiff(labelInputs, []) } : {}),
      },
    },
    null,
    [
      insertCallerProviderStatement(db, callerProvider),
      ...labelInputs.map((label) => upsertClaimLabelStatement(db, label, now, actor.id, exists)),
    ],
  );
  if (!outcome.ok) return outcome;
  return { ok: true, callerProvider, warnings: validation.warnings };
}

/** Discovery's algorithms that I-JWT-1 allows, in ALLOWED_ALGS order; RS256 when none. */
function discoveredAlgs(algs: string[] | null): string[] {
  const allowed = ALLOWED_ALGS.filter((alg) => algs?.includes(alg));
  return allowed.length > 0 ? [...allowed] : ['RS256'];
}

/**
 * UI rule on top of the validator: GitHub and GitLab pin values are numeric IDs (names can be
 * re-registered). The validator accepts any exact value, so this keeps a typo out of the pin.
 */
function numericPinErrors(profile: IssuerProfile, pin: readonly Condition[]): string[] {
  if (profile.id === 'generic' || !Array.isArray(pin)) return [];
  return pin.flatMap((condition) =>
    Array.isArray(condition?.values) &&
    condition.values.some((value: unknown) => typeof value !== 'string' || !DIGITS_RE.test(value))
      ? [`tenant pin: ${condition.claim} values must be numeric IDs`]
      : [],
  );
}

function labelErrors(labels: ReadonlyArray<{ value: string; label: string }>): string[] {
  return labels.flatMap((label) =>
    !DIGITS_RE.test(label.value)
      ? [`label value ${JSON.stringify(label.value)} must be a numeric ID`]
      : label.label === '' || label.label.length > 256
        ? [`the label of ${label.value} must be 1-256 characters`]
        : [],
  );
}

function labelDiff(
  next: readonly ClaimLabelInput[],
  current: readonly ClaimLabel[],
): { before: Record<string, string | null>; after: Record<string, string> } {
  const before: Record<string, string | null> = {};
  const after: Record<string, string> = {};
  for (const { input, before: old } of changedLabels(current, next)) {
    const key = `${input.claim}:${input.value}`;
    before[key] = old;
    after[key] = input.label;
  }
  return { before, after };
}

export interface CallerProviderUpdateInput {
  name?: string;
  /** Must equal the stored profile if given (profiles are immutable). */
  profile?: string;
  issuer?: string;
  /** Generic profile only. Empty: keep the stored URI, or rediscover when the issuer changes. */
  jwks_uri?: string | null;
  audience?: string;
  allowed_algs?: string[];
  max_token_age_seconds?: number;
  tenant_pin?: Condition[];
  anchor_claims?: string[];
  enabled?: boolean;
  /** Required when issuer or jwks_uri changes while enabled grants use this caller provider. */
  confirm_trust_change?: boolean;
  /** `updated_at` the edit form was opened at; a newer stored version is a conflict. */
  expected_updated_at?: number;
}

export async function updateCallerProvider(
  deps: Deps,
  actor: Actor,
  id: string,
  input: CallerProviderUpdateInput,
): Promise<CallerProviderOpResult> {
  return applyUpdate(deps, actor, id, input, {});
}

interface UpdateExtras {
  /** Labels to write in the same batch (under the same guard). */
  labels?: Array<{ claim: LabelledClaim; value: string; label: string }>;
  /** Re-derive the name when the stored one is the derived name of the old pin. */
  rederiveName?: boolean;
}

async function applyUpdate(
  deps: Deps,
  actor: Actor,
  id: string,
  input: CallerProviderUpdateInput,
  extras: UpdateExtras,
): Promise<CallerProviderOpResult> {
  const db = deps.env.DB;
  const flagErrors = booleanErrors('enabled', input.enabled);
  if (flagErrors.length > 0) return opFailure('invalid', flagErrors);
  const existing = await getCallerProvider(db, id);
  if (!existing) return opFailure('not_found', ['caller provider not found']);
  const stale = staleEdit('the caller provider', input.expected_updated_at, existing.updated_at);
  if (stale) return stale;
  if (input.profile !== undefined && input.profile !== existing.profile) {
    return opFailure('invalid', ['profile cannot be changed after the caller provider is created']);
  }
  const profile = getProfile(existing.profile);
  if (!profile) return opFailure('invalid', [`stored profile ${existing.profile} is unknown`]);

  const storedLabels =
    extras.labels !== undefined || extras.rederiveName ? await listClaimLabels(db, id) : [];
  const labelInputs: ClaimLabelInput[] = (extras.labels ?? []).map((label) => ({
    ...label,
    label: label.label.trim(),
    caller_provider_id: id,
  }));
  const labelChanges = changedLabels(storedLabels, labelInputs);

  const issuer = input.issuer !== undefined ? trimmed(input.issuer) : existing.issuer;
  const explicitJwks = explicitJwksUri(profile, input.jwks_uri);
  const rediscover = explicitJwks === null && issuer !== existing.issuer;
  const tenantPin =
    input.tenant_pin !== undefined ? normalizeConditions(input.tenant_pin) : existing.tenant_pin;
  let name = input.name !== undefined ? trimmed(input.name) : existing.name;
  if (extras.rederiveName && input.name === undefined) {
    const before = derivedNameOf(existing, storedLabels);
    if (existing.name === before) {
      const merged = [
        ...storedLabels.filter(
          (label) => !labelInputs.some((l) => l.claim === label.claim && l.value === label.value),
        ),
        ...labelInputs,
      ];
      const after = derivedNameOf({ ...existing, issuer, tenant_pin: tenantPin }, merged);
      name = after === before ? existing.name : await freeName(db, after, id);
    }
  }
  const valuesWith = (jwksUri: string): CallerProviderValues => ({
    name,
    issuer,
    jwks_uri: jwksUri,
    audience: input.audience !== undefined ? trimmed(input.audience) : existing.audience,
    allowed_algs: input.allowed_algs ?? existing.allowed_algs,
    max_token_age_seconds: input.max_token_age_seconds ?? existing.max_token_age_seconds,
    tenant_pin: tenantPin,
    anchor_claims: input.anchor_claims ?? existing.anchor_claims,
    enabled: input.enabled ?? existing.enabled,
  });

  const extraErrors = [
    ...(input.tenant_pin !== undefined ? numericPinErrors(profile, tenantPin) : []),
    ...labelErrors(labelInputs),
  ];
  if (extraErrors.length > 0) return opFailure('invalid', extraErrors);

  let jwksUri = explicitJwks ?? existing.jwks_uri;
  if (rediscover) {
    // Validate before the network call: discovery runs only for an acceptable configuration.
    const precheck = validateCallerProvider(
      { ...valuesWith(issuer), profile: existing.profile },
      profile,
      existing,
    );
    if (precheck.errors.length > 0) {
      return opFailure('invalid', precheck.errors, precheck.warnings);
    }
    const jwks = await resolveJwks(deps, issuer, null);
    if (!jwks.ok) return opFailure('invalid', [jwks.error]);
    jwksUri = jwks.jwksUri;
  }
  const values = valuesWith(jwksUri);
  const validation = validateCallerProvider(
    { ...values, profile: existing.profile },
    profile,
    existing,
  );
  if (validation.errors.length > 0) {
    return opFailure('invalid', validation.errors, validation.warnings);
  }

  const trustChanged = values.issuer !== existing.issuer || values.jwks_uri !== existing.jwks_uri;
  const confirmed = input.confirm_trust_change === true;
  const confirmationRequired = async (): Promise<OpFailure | null> => {
    const enabledGrants = await listGrants(db, { caller_provider_id: id, enabled: true });
    if (enabledGrants.length === 0) return null;
    const names = enabledGrants.map((grant) => JSON.stringify(grant.name)).join(', ');
    return opFailure(
      'confirmation_required',
      [
        `changing the issuer or JWKS URI changes who can call through ${enabledGrants.length} enabled grant(s): ${names}; confirm to continue`,
      ],
      validation.warnings,
    );
  };
  if (trustChanged && !confirmed) {
    const refusal = await confirmationRequired();
    if (refusal) return refusal;
  }

  const changed = (Object.keys(values) as Array<keyof CallerProviderValues>).filter(
    (key) => canonicalJson(values[key]) !== canonicalJson(existing[key]),
  );
  // A save that changes nothing writes nothing: no audit row, no version bump.
  if (changed.length === 0 && labelChanges.length === 0 && input.enabled === undefined) {
    return { ok: true, callerProvider: existing, warnings: validation.warnings, changed: false };
  }
  // An enable/disable request is recorded as such even when the flag already had that value.
  const onlyEnabled =
    input.enabled !== undefined &&
    labelChanges.length === 0 &&
    changed.every((key) => key === 'enabled');

  // I-AUTHZ-2: anchor_claims and tenant_pin feed validateGrant, so enabled grants must still
  // validate against the new values; the SQL guard pins the grant set that was checked.
  let grantsGuard: SqlGuard | null = null;
  if (changed.includes('anchor_claims') || changed.includes('tenant_pin')) {
    const enabledGrants = await listGrants(db, { caller_provider_id: id, enabled: true });
    const broken = brokenGrants(enabledGrants, profile, existing, { ...existing, ...values });
    if (broken.length > 0) {
      return opFailure(
        'invalid',
        [
          `these enabled grants would no longer be valid; edit or disable them first: ${broken.join('; ')}`,
        ],
        validation.warnings,
      );
    }
    grantsGuard = callerProviderEnabledGrantsUnchangedGuard(id, enabledGrants);
  }

  const now = deps.now();
  // An unconfirmed trust change also requires, in SQL, that no grant was enabled meanwhile.
  const guard = allOf(
    callerProviderVersionGuard(existing),
    ...(trustChanged && !confirmed ? [callerProviderWithoutEnabledGrantsGuard(id)] : []),
    ...(grantsGuard ? [grantsGuard] : []),
  );
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: onlyEnabled
        ? values.enabled
          ? 'caller_provider.enable'
          : 'caller_provider.disable'
        : 'caller_provider.update',
      targetType: 'caller_provider',
      targetId: id,
      summary: onlyEnabled
        ? `${values.enabled ? 'Enabled' : 'Disabled'} caller provider ${existing.name}`
        : `Updated caller provider ${existing.name}${changed.length ? ` (${changed.join(', ')})` : ''}`,
      diff: {
        before: pick(existing, changed),
        after: pick(values, changed),
        ...(trustChanged ? { trust_change_confirmed: confirmed } : {}),
        ...(labelChanges.length > 0 ? { labels: labelDiff(labelInputs, storedLabels) } : {}),
        warnings: validation.warnings,
      },
    },
    guard,
    [
      // Labels first: the update changes the version the guard checks.
      ...labelChanges.map(({ input: label }) =>
        upsertClaimLabelStatement(db, label, now, actor.id, guard),
      ),
      updateCallerProviderStatement(db, id, values, now, guard),
    ],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) {
    const refusal = trustChanged && !confirmed ? await confirmationRequired() : null;
    return refusal ?? concurrentChange('the caller provider');
  }
  return {
    ok: true,
    callerProvider: { ...existing, ...values, updated_at: nextVersion(existing.updated_at, now) },
    warnings: validation.warnings,
    changed: true,
  };
}

export interface TenantEntry {
  /** Numeric ID. */
  value: string;
  label: string;
}

/**
 * Adds organizations (GitHub), groups (GitLab) or values of a generic pin claim to the consumer's
 * pin, with their labels, as one `caller_provider.update`. Values already in the pin only update
 * their label. Refused (invalid) when nothing would change.
 */
export async function addTenantValue(
  deps: Deps,
  actor: Actor,
  id: string,
  input: { claim: string; entries: TenantEntry[] },
): Promise<CallerProviderOpResult> {
  const existing = await getCallerProvider(deps.env.DB, id);
  if (!existing) return opFailure('not_found', ['caller provider not found']);
  const labelled = tenantClaimOf(existing.profile);
  const claim = labelled ?? input.claim;
  if (labelled !== null && input.claim !== labelled) {
    return opFailure('invalid', [`this consumer pins ${labelled}, not ${input.claim}`]);
  }
  if (input.entries.length === 0) return opFailure('invalid', ['enter at least one value']);
  const current = pinValues(existing.tenant_pin, claim);
  const added = input.entries.filter((entry) => !current.includes(entry.value));
  const values = [...current, ...new Set(added.map((entry) => entry.value))];
  const result = await applyUpdate(
    deps,
    actor,
    id,
    { tenant_pin: withPinValues(existing.tenant_pin, claim, values) },
    {
      labels:
        labelled === null
          ? []
          : input.entries.map((entry) => ({
              claim: labelled,
              value: entry.value,
              label: entry.label,
            })),
      rederiveName: true,
    },
  );
  if (result.ok && result.changed === false) {
    const [first] = input.entries;
    return opFailure('invalid', [
      `${first ? `${first.label} (${first.value})` : 'This value'} is already allowed.`,
    ]);
  }
  return result;
}

/** Removes one pin value (I-AUTHZ-2: refused while enabled accesses depend on it). */
export async function removeTenantValue(
  deps: Deps,
  actor: Actor,
  id: string,
  input: { claim: string; value: string },
): Promise<CallerProviderOpResult> {
  const existing = await getCallerProvider(deps.env.DB, id);
  if (!existing) return opFailure('not_found', ['caller provider not found']);
  const current = pinValues(existing.tenant_pin, input.claim);
  if (!current.includes(input.value)) {
    return opFailure('invalid', [`${input.value} is not in this consumer's pin`]);
  }
  const values = current.filter((value) => value !== input.value);
  // UI rule: GitHub and GitLab consumers keep at least one organization or group, the source the
  // access form derives an access's owner from.
  if (values.length === 0 && tenantClaimOf(existing.profile) !== null) {
    return opFailure('invalid', [
      'A consumer needs at least one organization or group: add another one first, or delete the consumer.',
    ]);
  }
  return applyUpdate(
    deps,
    actor,
    id,
    { tenant_pin: withPinValues(existing.tenant_pin, input.claim, values) },
    { rederiveName: true },
  );
}

/** The pin with the exact conditions on `claim` replaced by one holding `values` (none: removed). */
function withPinValues(pin: readonly Condition[], claim: string, values: string[]): Condition[] {
  const others = pin.filter((c) => c.claim !== claim);
  const index = pin.findIndex((c) => c.claim === claim);
  if (values.length === 0) return others;
  const condition: Condition = { claim, match: 'exact', values };
  if (index === -1) return [...pin, condition];
  return [...others.slice(0, index), condition, ...others.slice(index)];
}

/** What the Add a consumer form produces (views/add-consumer-fields.tsx, parsed by the route). */
export interface ConsumerInput {
  profile: ProfileId;
  /** Empty: the profile's issuer (github.com, gitlab.com). Generic: required. */
  issuer: string;
  /** Organizations (GitHub) or groups (GitLab), at least one; generic: none. */
  tenants: TenantEntry[];
  /** GitHub Enterprise ID, an extra pin; empty for none. */
  enterprise_id?: string;
  /** Generic only. */
  anchor_claims?: string[];
  /** Generic only: one exact pin condition, or null. */
  pin?: { claim: string; value: string } | null;
}

export type ConsumerOpResult =
  | {
      ok: true;
      callerProvider: CallerProvider;
      /** True when the organizations were added to the existing consumer of this issuer. */
      merged: boolean;
      /** False for a merge that changed nothing (every value already pinned). */
      changed: boolean;
      warnings: string[];
    }
  | OpFailure;

/** The issuer of a consumer input: the platform default, a GHE slug issuer, or as typed. */
export function consumerIssuer(input: Pick<ConsumerInput, 'profile' | 'issuer'>): string {
  const issuer = input.issuer.trim();
  if (input.profile === 'github-actions') return issuer || GITHUB_ACTIONS_ISSUER;
  if (input.profile === 'gitlab-ci') return issuer.replace(/\/$/, '') || GITLAB_COM_ISSUER;
  return issuer;
}

/**
 * The consumer an "Add consumer" submit makes. A GitHub or GitLab consumer whose issuer already
 * has one adds its organizations or groups to it (`caller_provider.update`) instead of failing on
 * the UNIQUE issuer; otherwise a new consumer is created (`caller_provider.create`). A create that
 * loses a race on the issuer is retried once as a merge.
 */
export async function createOrMergeConsumer(
  deps: Deps,
  actor: Actor,
  input: ConsumerInput,
): Promise<ConsumerOpResult> {
  const claim = tenantClaimOf(input.profile);
  if (claim !== null && input.tenants.length === 0) {
    return opFailure('invalid', [
      input.profile === 'github-actions'
        ? 'Enter at least one organization as name (ID), for example acme (1234567).'
        : 'Enter at least one group as path (ID), for example acme-group (5678901).',
    ]);
  }
  const issuer = consumerIssuer(input);
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing =
      claim === null
        ? null
        : ((await listCallerProviders(deps.env.DB)).find(
            (provider) => provider.profile === input.profile && provider.issuer === issuer,
          ) ?? null);
    if (existing && claim !== null) {
      const merged = await addTenantValue(deps, actor, existing.id, {
        claim,
        entries: input.tenants,
      });
      if (!merged.ok) {
        // Every value is already there: the consumer is what was asked for.
        const unchanged = input.tenants.every((entry) =>
          pinValues(existing.tenant_pin, claim).includes(entry.value),
        );
        if (merged.reason === 'invalid' && unchanged) {
          return {
            ok: true,
            callerProvider: existing,
            merged: true,
            changed: false,
            warnings: [],
          };
        }
        return merged;
      }
      return { ...merged, merged: true, changed: true };
    }
    const pin: Condition[] = [];
    if (claim !== null) {
      pin.push({ claim, match: 'exact', values: [...new Set(input.tenants.map((t) => t.value))] });
    }
    if (input.profile === 'github-actions' && input.enterprise_id) {
      pin.push({ claim: 'enterprise_id', match: 'exact', values: [input.enterprise_id] });
    }
    if (input.profile === 'generic' && input.pin) {
      pin.push({ claim: input.pin.claim, match: 'exact', values: [input.pin.value] });
    }
    const created = await createCallerProvider(deps, actor, {
      profile: input.profile,
      issuer,
      tenant_pin: pin,
      tenant_labels:
        claim === null
          ? []
          : input.tenants.map((entry) => ({ claim, value: entry.value, label: entry.label })),
      ...(input.profile === 'generic' ? { anchor_claims: input.anchor_claims ?? ['sub'] } : {}),
    });
    const issuerTaken =
      !created.ok && created.errors.some((error) => error.includes('already has this issuer'));
    if (issuerTaken && claim !== null && attempt === 0) continue;
    if (!created.ok) return created;
    return { ...created, merged: false, changed: true };
  }
  return concurrentChange('the consumer');
}

/**
 * Enable or disable; takes effect on the next proxied request (no caching). Enabling validates
 * the stored configuration. Disabling changes only `enabled` and skips validation, so a caller
 * provider whose stored row no longer validates can still be switched off.
 */
export async function setCallerProviderEnabled(
  deps: Deps,
  actor: Actor,
  id: string,
  enabled: boolean,
): Promise<CallerProviderOpResult> {
  if (enabled !== false) return updateCallerProvider(deps, actor, id, { enabled });
  const db = deps.env.DB;
  const existing = await getCallerProvider(db, id);
  if (!existing) return opFailure('not_found', ['caller provider not found']);
  const now = deps.now();
  const guard = callerProviderExistsGuard(id);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'caller_provider.disable',
      targetType: 'caller_provider',
      targetId: id,
      summary: `Disabled caller provider ${existing.name}`,
      diff: { before: { enabled: existing.enabled }, after: { enabled: false } },
    },
    guard,
    [setCallerProviderEnabledStatement(db, id, false, now, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return concurrentChange('the caller provider');
  return {
    ok: true,
    callerProvider: {
      ...existing,
      enabled: false,
      updated_at: nextVersion(existing.updated_at, now),
    },
    warnings: [],
  };
}

/**
 * Deletes a consumer. Without `withAccesses` it is refused (conflict) while accesses reference it.
 * With it, the consumer, exactly the accesses in `accessIds` (the set the confirmation listed) and
 * the consumer's labels are deleted in one batch with one `caller_provider.delete` row that holds
 * every deleted access; a changed access set deletes nothing (conflict).
 */
export async function deleteCallerProvider(
  deps: Deps,
  actor: Actor,
  id: string,
  options: { withAccesses?: boolean; accessIds?: readonly string[] } = {},
): Promise<{ ok: true; deletedAccesses: number } | OpFailure> {
  const db = deps.env.DB;
  const existing = await getCallerProvider(db, id);
  if (!existing) return opFailure('not_found', ['caller provider not found']);
  const grants = await listGrants(db, { caller_provider_id: id });
  if (grants.length > 0 && options.withAccesses !== true) return referencedBy(grants);
  const accessIds = [...new Set(options.accessIds ?? [])];

  if (grants.length === 0 && accessIds.length === 0) {
    const guard = callerProviderUnreferencedGuard(id);
    const outcome = await commitOrConstraintFailure(
      deps,
      actor,
      {
        action: 'caller_provider.delete',
        targetType: 'caller_provider',
        targetId: id,
        summary: `Deleted caller provider ${existing.name}`,
        diff: { before: existing },
      },
      guard,
      [deleteClaimLabelsStatement(db, id, guard), deleteCallerProviderStatement(db, id, guard)],
    );
    if (!outcome.ok) return outcome;
    if (!outcome.committed) {
      const current = await listGrants(db, { caller_provider_id: id });
      return current.length > 0 ? referencedBy(current) : concurrentChange('the caller provider');
    }
    return { ok: true, deletedAccesses: 0 };
  }

  const exactSet = exactGrantSetGuard('caller_provider_id', id, accessIds);
  const guard = allOf(callerProviderExistsGuard(id), exactSet);
  const listed = new Set(accessIds);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'caller_provider.delete',
      targetType: 'caller_provider',
      targetId: id,
      summary: `Deleted caller provider ${existing.name} and ${accessIds.length} grant(s)`,
      diff: { before: { ...existing, grants: grants.filter((grant) => listed.has(grant.id)) } },
    },
    guard,
    [
      // The consumer goes before its grants (FK checked at commit), so that every statement still
      // sees the exact grant set the audit row was written for.
      deferForeignKeysStatement(db),
      deleteClaimLabelsStatement(db, id, guard),
      deleteCallerProviderStatement(db, id, guard),
      deleteGrantsByIdsStatement(db, accessIds, exactSet),
    ],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) {
    return opFailure('conflict', [
      'the consumer accesses changed since this page was opened; nothing was deleted. Review the list and delete again.',
    ]);
  }
  return { ok: true, deletedAccesses: accessIds.length };
}

/**
 * The JWKS URI named in the input, honoured only for the generic profile: platform profiles
 * (GitHub Actions, GitLab CI) always use the issuer's discovery document. Shape is checked by
 * validateCallerProvider.
 */
function explicitJwksUri(profile: IssuerProfile, raw: unknown): string | null {
  if (profile.id !== 'generic' || typeof raw !== 'string') return null;
  return raw.trim() || null;
}

/** `explicit` when given, else `jwks_uri` (and the algorithms) from OIDC discovery. */
async function resolveJwks(
  deps: Pick<Deps, 'fetch'>,
  issuer: string,
  explicit: string | null,
): Promise<
  { ok: true; jwksUri: string; signingAlgs: string[] | null } | { ok: false; error: string }
> {
  if (explicit !== null) return { ok: true, jwksUri: explicit, signingAlgs: null };
  const discovered = await discoverIssuer(issuer, deps.fetch);
  return discovered.ok
    ? discovered
    : { ok: false, error: `JWKS discovery failed: ${discovered.error}` };
}

function referencedBy(grants: Array<{ name: string }>): OpFailure {
  const names = grants.map((grant) => JSON.stringify(grant.name)).join(', ');
  return opFailure('conflict', [
    `the caller provider is used by ${grants.length} grant(s): ${names}; delete them first`,
  ]);
}

/**
 * Enabled grants that validate against `before` but not against `after`, each with the errors the
 * change introduces (errors a grant already had are not blamed on this change).
 */
export function brokenGrants(
  grants: Grant[],
  profile: IssuerProfile,
  before: CallerProvider,
  after: CallerProvider,
): string[] {
  return grants.flatMap((grant) => {
    const input = { conditions: grant.conditions, rules: grant.rules };
    const old = new Set(validateGrant(input, profile, before).errors);
    const introduced = validateGrant(input, profile, after).errors.filter((e) => !old.has(e));
    return introduced.length > 0
      ? [`${JSON.stringify(grant.name)} (${introduced.join(', ')})`]
      : [];
  });
}

/** The enabled grants that use `value` of the pin `claim` (blocking its removal), and the rest. */
export function grantsUsingPinValue(
  grants: readonly Grant[],
  profile: IssuerProfile,
  provider: CallerProvider,
  claim: string,
  value: string,
): { enabled: Grant[]; disabled: Grant[] } {
  const after: CallerProvider = {
    ...provider,
    tenant_pin: withPinValues(
      provider.tenant_pin,
      claim,
      pinValues(provider.tenant_pin, claim).filter((v) => v !== value),
    ),
  };
  const uses = (grant: Grant) =>
    brokenGrants([grant], profile, provider, after).length > 0 ||
    grant.conditions.some(
      (c) => c.claim === claim && c.negate !== true && c.values.includes(value),
    );
  return {
    enabled: grants.filter((grant) => grant.enabled && uses(grant)),
    disabled: grants.filter((grant) => !grant.enabled && uses(grant)),
  };
}
