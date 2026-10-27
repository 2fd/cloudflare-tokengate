// Credential access rule mutations (ADR 0026). One row holds the issuer and its token verification settings
// (I-TEN-1 tenant pin, I-JWT-1 algorithms, audience and token age), the jobs it admits (anchored,
// I-AUTHZ-2) and the operations it allows. Warnings need acknowledgement and go in the audit row with
// the risks the admin accepted (I-AUTHZ-3). Display labels of numeric IDs (claim_labels) are written
// in the batch of the save that typed them (I-AUDIT-1). The global access rules of the issuer are
// reported as a warning (AR-8): they decide at request time, never at save time. Disabling and
// deleting skip validation, so revocation always works (I-AUTHZ-1).
import {
  accessRuleExistsGuard,
  accessRuleUnchangedGuard,
  type AccessRuleValues,
  deleteAccessRuleStatement,
  getCredentialAccessRule,
  insertAccessRuleStatement,
  listCredentialAccessRules,
  listGlobalAccessRules,
  setAccessRuleEnabledStatement,
  updateAccessRuleStatement,
} from '../../db/access-rules';
import {
  type ClaimLabelInput,
  changedLabels,
  listClaimLabels,
  upsertClaimLabelStatement,
} from '../../db/claim-labels';
import { getService, serviceExistsGuard } from '../../db/credentials';
import type {
  Actor,
  ClaimLabel,
  CredentialAccessRule,
  LabelledClaim,
  Service,
} from '../../db/types';
import type { Deps } from '../../deps';
import { discoverIssuer } from '../../identity/jwt';
import { getProfile, PROFILES } from '../../identity/profiles';
import { GITHUB_ACTIONS_ISSUER } from '../../identity/profiles/github-actions';
import { GITLAB_COM_ISSUER } from '../../identity/profiles/gitlab-ci';
import { VERCEL_OIDC_ISSUER } from '../../identity/profiles/vercel';
import type { IssuerProfile, ProfileId } from '../../identity/types';
import { newId } from '../../lib/ids';
import { canonicalJson } from '../../lib/json';
import { type GlobalStatus, globalStatus } from '../../policy/global-status';
import { issuerKey } from '../../policy/limits';
import type { Condition, Rule } from '../../policy/types';
import { ALLOWED_ALGS } from '../../policy/validate';
import {
  type AccessRuleWarningDetail,
  type CredentialAccessRuleInput,
  validateCredentialAccessRule,
} from '../../policy/validate-rules';
import {
  booleanErrors,
  commitOrConstraintFailure,
  concurrentChange,
  NAME_MAX_LENGTH,
  nextVersion,
  normalizeConditions,
  normalizeRules,
  type OpFailure,
  opFailure,
  pick,
  staleEdit,
  timestampErrors,
  trimmed,
} from './shared';

const AUDIENCE_PREFIX = 'tokengate:';
const AUDIENCE_RANDOM_CHARS = 26;
/** RFC 4648 base32 alphabet, lower case. */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const DIGITS_RE = /^[0-9]{1,20}$/;
const VERCEL_TEAM_ID_RE = /^team_[A-Za-z0-9]{1,64}$/;
const VERCEL_PROJECT_ID_RE = /^prj_[A-Za-z0-9]{1,64}$/;

/** Profiles whose pin values are IDs with display labels (claim_labels). */
const TENANT_CLAIM: Readonly<Partial<Record<ProfileId, LabelledClaim>>> = {
  'github-actions': 'repository_owner_id',
  'gitlab-ci': 'namespace_id',
  vercel: 'owner_id',
};

/** The labelled pin claim of a profile (organizations, groups or a team), or null (generic). */
export function tenantClaimOf(profile: ProfileId): LabelledClaim | null {
  return TENANT_CLAIM[profile] ?? null;
}

/** What one tenant pin value is called: organization (GitHub), group (GitLab) or team (Vercel). */
export function tenantWord(profile: string): 'organization' | 'group' | 'team' {
  return profile === 'gitlab-ci' ? 'group' : profile === 'vercel' ? 'team' : 'organization';
}

/**
 * The ID shape of a claim a profile pins or labels: GitHub and GitLab IDs are numeric, Vercel IDs
 * are prefixed (`team_…`, `prj_…`). Null: the profile labels no IDs (generic).
 */
export function claimIdPattern(profile: ProfileId, claim: string): RegExp | null {
  if (profile === 'generic') return null;
  if (profile === 'vercel') {
    return claim === 'project_id' ? VERCEL_PROJECT_ID_RE : VERCEL_TEAM_ID_RE;
  }
  return DIGITS_RE;
}

/**
 * Default audience for the first credential access rule of a credential and issuer: `tokengate:` + 26
 * random base32 characters (130 bits). Random rather than derived from the hostname, so it is
 * unique per deployment and tokens minted for another gateway are never accepted here.
 */
export function defaultAudience(random: (length: number) => Uint8Array): string {
  const bytes = random(AUDIENCE_RANDOM_CHARS);
  let out = AUDIENCE_PREFIX;
  // 256 is a multiple of 32, so `byte % 32` is uniform.
  for (const byte of bytes) out += BASE32[byte % 32];
  return out;
}

/** The issuer of a rule input: the platform default when empty, otherwise as typed. */
export function ruleIssuer(profile: ProfileId, typed: string | undefined): string {
  const issuer = (typed ?? '').trim();
  if (profile === 'github-actions') return issuer || GITHUB_ACTIONS_ISSUER;
  if (profile === 'gitlab-ci') return issuer || GITLAB_COM_ISSUER;
  if (profile === 'vercel') return issuer || VERCEL_OIDC_ISSUER;
  return issuer;
}

/**
 * The values of `claim` the pin admits, in order. Pin conditions are ANDed (tenantPinHolds,
 * I-TEN-1), so with several conditions on one claim only the values every one of them lists are
 * admitted; a condition that is not exact and non-negated admits nothing (it fails closed).
 * Rewriting the claim as one condition with these values keeps the pin's meaning.
 */
export function pinValues(pin: readonly Condition[], claim: string): string[] {
  const onClaim = pin.filter((c) => c?.claim === claim);
  const [first, ...rest] = onClaim;
  if (first === undefined) return [];
  const admits = (c: Condition, value: string) =>
    c.match === 'exact' && c.negate !== true && c.values.includes(value);
  return [...new Set(first.values)].filter(
    (value) => admits(first, value) && rest.every((c) => admits(c, value)),
  );
}

/**
 * The pin with every condition on `claim` replaced by one holding `values` (none: removed).
 * Callers pass values derived with pinValues (intersection), so the rewrite never widens the pin.
 */
export function withPinValues(
  pin: readonly Condition[],
  claim: string,
  values: string[],
): Condition[] {
  const others = pin.filter((c) => c.claim !== claim);
  const index = pin.findIndex((c) => c.claim === claim);
  if (values.length === 0) return others;
  const condition: Condition = { claim, match: 'exact', values };
  if (index === -1) return [...pin, condition];
  return [...others.slice(0, index), condition, ...others.slice(index)];
}

/** `base`, or `base (2)`, `base (3)`… : the first name no other rule of the credential uses. */
export async function freeName(
  db: D1Database,
  credentialId: string,
  base: string,
  excludeId?: string,
): Promise<string> {
  const taken = new Set(
    (await listCredentialAccessRules(db, { credential_id: credentialId }))
      .filter((rule) => rule.id !== excludeId)
      .map((rule) => rule.name.toLowerCase()),
  );
  const trimmedBase = base.slice(0, NAME_MAX_LENGTH);
  if (!taken.has(trimmedBase.toLowerCase())) return trimmedBase;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`;
    const candidate = `${base.slice(0, NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return trimmedBase;
}

/** A display label typed with a rule (organization, group, repository or project). */
export interface RuleLabel {
  claim: LabelledClaim;
  value: string;
  label: string;
}

export interface CredentialRuleInput {
  credential_id: string;
  /** Empty or absent: "Rule", made unique per credential with " (2)". Routes derive a better one. */
  name?: string;
  description?: string;
  profile: string;
  /** Default: the profile's issuer (GitHub Actions, GitLab.com). */
  issuer?: string;
  /** Generic profile only: explicit JWKS URI; otherwise reused or discovered from the issuer. */
  jwks_uri?: string | null;
  /** Default: the audience of the newest rule of the credential and issuer, else defaultAudience(). */
  audience?: string | null;
  /** Default: the profile's; generic: what discovery lists, within ALLOWED_ALGS, else RS256. */
  allowed_algs?: string[];
  max_token_age_seconds?: number;
  tenant_pin?: Condition[];
  anchor_claims?: string[];
  conditions: Condition[];
  rules: Rule[];
  enabled?: boolean;
  expires_at?: number | null;
  /** Labels of IDs in the pin and the conditions, upserted in the same batch. */
  labels?: RuleLabel[];
  /** Set after the admin has seen (or explicitly chose) the warnings. */
  acknowledge_warnings?: boolean;
  /** The risk codes the admin accepted by selection or acknowledgement; recorded in the audit. */
  accepted_risks?: string[];
}

export type CredentialRuleOpResult =
  | {
      ok: true;
      rule: CredentialAccessRule;
      warnings: string[];
      /** Every warning with its code, the global access rule status last (AR-8). */
      warningDetails: AccessRuleWarningDetail[];
      /** The rule against the global access rules of its issuer now (AR-8). */
      globalStatus: GlobalStatus<GlobalRuleOf>;
      /** Updates only: false when the submitted values matched and nothing was written. */
      changed?: boolean;
      /** True when the save changed a stored label (notice `label_changed`). */
      labelsChanged?: boolean;
    }
  | OpFailure;

type GlobalRuleOf = Awaited<ReturnType<typeof listGlobalAccessRules>>[number];

export async function createCredentialAccessRule(
  deps: Deps,
  actor: Actor,
  input: CredentialRuleInput,
): Promise<CredentialRuleOpResult> {
  return insertRule(deps, actor, input, { action: 'credential_access_rule.create', source: null });
}

async function insertRule(
  deps: Deps,
  actor: Actor,
  input: CredentialRuleInput,
  meta: {
    action: 'credential_access_rule.create' | 'credential_access_rule.duplicate';
    source: { rule: CredentialAccessRule; credential: Service } | null;
  },
): Promise<CredentialRuleOpResult> {
  const db = deps.env.DB;
  const service = await getService(db, input.credential_id ?? '');
  if (!service) return opFailure('invalid', ['Select a credential for this access rule.']);
  const profile = getProfile(String(input.profile));
  if (!profile)
    return opFailure('invalid', [`profile must be one of ${Object.keys(PROFILES).join(', ')}`]);
  const flagErrors = [
    ...booleanErrors('enabled', input.enabled),
    ...booleanErrors('acknowledge_warnings', input.acknowledge_warnings),
    ...timestampErrors('expiry', input.expires_at),
  ];
  if (flagErrors.length > 0) return opFailure('invalid', flagErrors);
  if (input.expires_at != null && input.expires_at <= deps.now()) {
    return opFailure('invalid', ['expiry must be in the future']);
  }

  const issuer = ruleIssuer(profile.id, trimmed(input.issuer));
  const others = await listCredentialAccessRules(db, { credential_id: service.id });
  // Callers keep one audience and one JWKS per credential and issuer, so one snippet (AR-10).
  const sibling = [...others].reverse().find((rule) => rule.issuer_key === issuerKey(issuer));
  const explicitJwks = explicitJwksUri(profile, input.jwks_uri);
  const audience = trimmed(input.audience) || sibling?.audience || defaultAudience(deps.random);
  const tenantPin = normalizeConditions(input.tenant_pin ?? []);
  const labels = normalizeLabels(input.labels);
  const defaultAlgs = input.allowed_algs ??
    sibling?.allowed_algs ?? [...profile.defaults.allowedAlgs];
  const valuesWith = (jwksUri: string, algs: string[], name: string): AccessRuleValues => ({
    name,
    description: input.description === undefined ? '' : trimmed(input.description),
    issuer,
    jwks_uri: jwksUri,
    audience,
    allowed_algs: algs,
    max_token_age_seconds:
      input.max_token_age_seconds ??
      sibling?.max_token_age_seconds ??
      profile.defaults.maxTokenAgeSeconds,
    tenant_pin: tenantPin,
    anchor_claims: input.anchor_claims ?? (profile.id === 'generic' ? ['sub'] : []),
    conditions: normalizeConditions(input.conditions),
    rules: normalizeRules(input.rules),
    enabled: input.enabled ?? true,
    expires_at: input.expires_at ?? null,
  });
  const typedName = trimmed(input.name ?? '');
  const context = { injection: service.injection, rules: others };

  // Validate before any network call; discovery runs only for an acceptable configuration.
  const knownJwks = explicitJwks ?? (sibling?.issuer === issuer ? sibling.jwks_uri : null);
  const precheck = validateCredentialAccessRule(
    asInput(valuesWith(knownJwks ?? issuer, defaultAlgs, typedName || 'Rule'), profile.id),
    profile,
    null,
    context,
  );
  const extra = [...pinIdErrors(profile, tenantPin), ...labelErrors(profile, labels)];
  if (precheck.errors.length > 0 || extra.length > 0) {
    return opFailure('invalid', [...precheck.errors, ...extra], precheck.warnings);
  }
  let jwksUri = knownJwks;
  let algs = defaultAlgs;
  if (jwksUri === null) {
    const jwks = await resolveJwks(deps, issuer, null);
    if (!jwks.ok) return opFailure('invalid', [jwks.error]);
    jwksUri = jwks.jwksUri;
    if (input.allowed_algs === undefined && profile.id === 'generic') {
      algs = discoveredAlgs(jwks.signingAlgs);
    }
  }
  const name = await freeName(db, service.id, typedName || 'Rule');
  const values = valuesWith(jwksUri, algs, name);
  const validation = validateCredentialAccessRule(
    asInput(values, profile.id),
    profile,
    null,
    context,
  );
  if (validation.errors.length > 0) {
    return opFailure('invalid', validation.errors, validation.warnings);
  }
  if (validation.warnings.length > 0 && input.acknowledge_warnings !== true) {
    return opFailure(
      'acknowledgement_required',
      ['review the warnings and confirm to save this access rule'],
      validation.warnings,
    );
  }

  const now = deps.now();
  const rule: CredentialAccessRule = {
    ...(values as CredentialRuleValues),
    kind: 'credential',
    id: newId('acr', now, deps.random),
    credential_id: service.id,
    profile: profile.id,
    issuer_key: issuerKey(issuer),
    created_by: actor.email ?? actor.id,
    created_at: now,
    updated_at: now,
  };
  const labelChanges = changedLabels(
    [],
    labels.map((label) => ({ ...label, access_rule_id: rule.id })),
  );
  const guard = serviceExistsGuard(service.id);
  const exists = accessRuleExistsGuard(rule.id);
  const status = await statusOf(db, rule, now);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: meta.action,
      targetType: 'credential_access_rule',
      targetId: rule.id,
      summary:
        meta.source === null
          ? `Added credential access rule ${rule.name} to ${service.name}`
          : `Copied credential access rule ${meta.source.rule.name} from ${meta.source.credential.name} to ${service.name}`,
      diff: {
        after: auditView(rule),
        warnings: validation.warnings,
        ...riskDiff(input.accepted_risks),
        ...labelsDiff(labelChanges),
        ...(meta.source === null ? {} : { source_id: meta.source.rule.id }),
      },
    },
    guard,
    [
      insertAccessRuleStatement(db, rule, guard),
      ...labelChanges.map(({ input: label }) =>
        upsertClaimLabelStatement(db, label, now, actor.id, exists),
      ),
    ],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return concurrentChange('the credential');
  return success(rule, validation.warningDetails, status, {
    labelsChanged: false,
  });
}

/** The editable fields of a credential access rule; every limit is set. */
type CredentialRuleValues = AccessRuleValues &
  Pick<
    CredentialAccessRule,
    | 'jwks_uri'
    | 'audience'
    | 'allowed_algs'
    | 'max_token_age_seconds'
    | 'tenant_pin'
    | 'anchor_claims'
    | 'conditions'
    | 'rules'
  >;

function asInput(values: AccessRuleValues, profile: ProfileId): CredentialAccessRuleInput {
  const v = values as CredentialRuleValues;
  return {
    name: v.name,
    description: v.description,
    profile,
    issuer: v.issuer,
    jwks_uri: v.jwks_uri,
    audience: v.audience,
    allowed_algs: v.allowed_algs,
    max_token_age_seconds: v.max_token_age_seconds,
    tenant_pin: v.tenant_pin,
    anchor_claims: v.anchor_claims,
    conditions: v.conditions,
    rules: v.rules,
  };
}

export interface CredentialRuleUpdateInput {
  name?: string;
  description?: string;
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
  conditions?: Condition[];
  rules?: Rule[];
  enabled?: boolean;
  expires_at?: number | null;
  labels?: RuleLabel[];
  acknowledge_warnings?: boolean;
  accepted_risks?: string[];
  /** `updated_at` the edit form was opened at; a newer stored version is a conflict. */
  expected_updated_at?: number;
}

/** Updates a credential access rule. Its credential and profile never change. */
export async function updateCredentialAccessRule(
  deps: Deps,
  actor: Actor,
  id: string,
  input: CredentialRuleUpdateInput,
): Promise<CredentialRuleOpResult> {
  const flagErrors = [
    ...booleanErrors('enabled', input.enabled),
    ...booleanErrors('acknowledge_warnings', input.acknowledge_warnings),
    ...timestampErrors('expiry', input.expires_at),
  ];
  if (flagErrors.length > 0) return opFailure('invalid', flagErrors);
  const db = deps.env.DB;
  const existing = await getCredentialAccessRule(db, id);
  if (!existing) return opFailure('not_found', ['credential access rule not found']);
  const stale = staleEdit(
    'the credential access rule',
    input.expected_updated_at,
    existing.updated_at,
  );
  if (stale) return stale;
  if (input.profile !== undefined && input.profile !== existing.profile) {
    return opFailure('invalid', [
      'profile cannot be changed after the credential access rule is created',
    ]);
  }
  const profile = getProfile(existing.profile);
  if (!profile) return opFailure('invalid', [`stored profile ${existing.profile} is unknown`]);
  const service = await getService(db, existing.credential_id);
  if (!service) return opFailure('not_found', ['credential not found']);

  const issuer =
    input.issuer !== undefined ? ruleIssuer(profile.id, trimmed(input.issuer)) : existing.issuer;
  const explicitJwks = explicitJwksUri(profile, input.jwks_uri);
  const rediscover = explicitJwks === null && issuer !== existing.issuer;
  const valuesWith = (jwksUri: string): CredentialRuleValues => ({
    name: input.name !== undefined ? trimmed(input.name) : existing.name,
    description:
      input.description !== undefined ? trimmed(input.description) : existing.description,
    issuer,
    jwks_uri: jwksUri,
    audience: input.audience !== undefined ? trimmed(input.audience) : existing.audience,
    allowed_algs: input.allowed_algs ?? existing.allowed_algs,
    max_token_age_seconds: input.max_token_age_seconds ?? existing.max_token_age_seconds,
    tenant_pin:
      input.tenant_pin !== undefined ? normalizeConditions(input.tenant_pin) : existing.tenant_pin,
    anchor_claims: input.anchor_claims ?? existing.anchor_claims,
    conditions:
      input.conditions !== undefined ? normalizeConditions(input.conditions) : existing.conditions,
    rules: input.rules !== undefined ? normalizeRules(input.rules) : existing.rules,
    enabled: input.enabled ?? existing.enabled,
    expires_at: input.expires_at !== undefined ? input.expires_at : existing.expires_at,
  });
  if (
    input.expires_at != null &&
    input.expires_at !== existing.expires_at &&
    input.expires_at <= deps.now()
  ) {
    return opFailure('invalid', ['expiry must be in the future']);
  }
  const labels = normalizeLabels(input.labels);
  const extraErrors = [
    ...(input.tenant_pin !== undefined
      ? pinIdErrors(profile, valuesWith(existing.jwks_uri).tenant_pin)
      : []),
    ...labelErrors(profile, labels),
  ];
  if (extraErrors.length > 0) return opFailure('invalid', extraErrors);
  const context = {
    injection: service.injection,
    rules: await listCredentialAccessRules(db, { credential_id: service.id }),
  };

  let jwksUri = explicitJwks ?? existing.jwks_uri;
  if (rediscover) {
    // Validate before the network call: discovery runs only for an acceptable configuration.
    const precheck = validateCredentialAccessRule(
      asInput(valuesWith(issuer), existing.profile),
      profile,
      existing,
      context,
    );
    if (precheck.errors.length > 0) {
      return opFailure('invalid', precheck.errors, precheck.warnings);
    }
    const jwks = await resolveJwks(deps, issuer, null);
    if (!jwks.ok) return opFailure('invalid', [jwks.error]);
    jwksUri = jwks.jwksUri;
  }
  const values = valuesWith(jwksUri);
  const validation = validateCredentialAccessRule(
    asInput(values, existing.profile),
    profile,
    existing,
    context,
  );
  if (validation.errors.length > 0) {
    return opFailure('invalid', validation.errors, validation.warnings);
  }

  const storedLabels = labels.length > 0 ? await listClaimLabels(db, id) : [];
  const labelChanges = changedLabels(
    storedLabels,
    labels.map((label) => ({ ...label, access_rule_id: id })),
  );
  const changed = (Object.keys(values) as Array<keyof CredentialRuleValues>).filter(
    (key) => canonicalJson(values[key]) !== canonicalJson(existing[key]),
  );
  const status = await statusOf(
    db,
    { ...existing, ...values, issuer_key: issuerKey(issuer) },
    deps.now(),
  );
  // A save that changes nothing writes nothing: no audit row, no version bump.
  if (changed.length === 0 && labelChanges.length === 0 && input.enabled === undefined) {
    return success(existing, validation.warningDetails, status, { changed: false });
  }
  // Risks need acknowledgement only when the jobs or operations change (an enable re-validates).
  const contentChanged = changed.some((key) => key === 'conditions' || key === 'rules');
  if (contentChanged && validation.warnings.length > 0 && input.acknowledge_warnings !== true) {
    return opFailure(
      'acknowledgement_required',
      ['review the warnings and confirm to save this access rule'],
      validation.warnings,
    );
  }
  // An enable/disable request is recorded as such even when the flag already had that value.
  const onlyEnabled =
    input.enabled !== undefined &&
    labelChanges.length === 0 &&
    changed.every((key) => key === 'enabled');

  const now = deps.now();
  const guard = accessRuleUnchangedGuard(id, existing.updated_at);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: onlyEnabled
        ? values.enabled
          ? 'credential_access_rule.enable'
          : 'credential_access_rule.disable'
        : 'credential_access_rule.update',
      targetType: 'credential_access_rule',
      targetId: id,
      summary: onlyEnabled
        ? `${values.enabled ? 'Enabled' : 'Disabled'} credential access rule ${existing.name}`
        : `Changed credential access rule ${existing.name}${changed.length ? `: ${changed.map(fieldText).join(', ')}` : ''}`,
      diff: {
        before: pick(existing, changed),
        after: pick(values, changed),
        warnings: validation.warnings,
        ...riskDiff(input.accepted_risks),
        ...labelsDiff(labelChanges),
      },
    },
    guard,
    [
      // Labels first: the update changes the version the guard checks.
      ...labelChanges.map(({ input: label }) =>
        upsertClaimLabelStatement(db, label, now, actor.id, guard),
      ),
      updateAccessRuleStatement(db, id, values, now, guard),
    ],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return concurrentChange('the credential access rule');
  return success(
    {
      ...existing,
      ...values,
      issuer_key: issuerKey(issuer),
      updated_at: nextVersion(existing.updated_at, now),
    },
    validation.warningDetails,
    status,
    {
      changed: true,
      labelsChanged: labelChanges.some((change) => change.before !== null),
    },
  );
}

const FIELD_TEXT: Readonly<Record<string, string>> = {
  name: 'name',
  description: 'description',
  issuer: 'issuer',
  jwks_uri: 'JWKS URI',
  audience: 'audience',
  allowed_algs: 'algorithms',
  max_token_age_seconds: 'maximum token age',
  tenant_pin: 'tenants',
  anchor_claims: 'anchor claims',
  conditions: 'jobs',
  rules: 'operations',
  enabled: 'state',
  expires_at: 'expiry',
};

function fieldText(key: string): string {
  return FIELD_TEXT[key] ?? key;
}

export interface TenantEntry {
  /** Numeric ID (GitHub, GitLab) or the pinned claim value (generic). */
  value: string;
  label: string;
}

/**
 * Adds organizations (GitHub), groups (GitLab) or values of a generic pin claim to the rule's pin,
 * with their labels, as one `credential_access_rule.update`. Values already in the pin only update
 * their label. Refused (invalid) when nothing would change.
 */
export async function addTenantValue(
  deps: Deps,
  actor: Actor,
  id: string,
  input: { claim: string; entries: TenantEntry[]; expected_updated_at?: number },
): Promise<CredentialRuleOpResult> {
  const existing = await getCredentialAccessRule(deps.env.DB, id);
  if (!existing) return opFailure('not_found', ['credential access rule not found']);
  const labelled = tenantClaimOf(existing.profile);
  const claim = labelled ?? input.claim;
  if (labelled !== null && input.claim !== labelled) {
    return opFailure('invalid', [`this access rule pins ${labelled}, not ${input.claim}`]);
  }
  if (input.entries.length === 0) return opFailure('invalid', ['enter at least one value']);
  const current = pinValues(existing.tenant_pin, claim);
  const added = input.entries.filter((entry) => !current.includes(entry.value));
  const values = [...current, ...new Set(added.map((entry) => entry.value))];
  const result = await updateCredentialAccessRule(deps, actor, id, {
    tenant_pin: withPinValues(existing.tenant_pin, claim, values),
    labels:
      labelled === null
        ? []
        : input.entries.map((entry) => ({
            claim: labelled,
            value: entry.value,
            label: entry.label,
          })),
    ...(input.expected_updated_at === undefined
      ? {}
      : { expected_updated_at: input.expected_updated_at }),
  });
  if (result.ok && result.changed === false) {
    const [first] = input.entries;
    return opFailure('invalid', [
      `${first ? `${first.label} (${first.value})` : 'This value'} is already allowed.`,
    ]);
  }
  return result;
}

/**
 * Removes one pin value. Refused when the rule's own jobs use it (they could never match again),
 * and when a GitHub or GitLab rule would keep no organization or group.
 */
export async function removeTenantValue(
  deps: Deps,
  actor: Actor,
  id: string,
  input: { claim: string; value: string; label?: string; expected_updated_at?: number },
): Promise<CredentialRuleOpResult> {
  const existing = await getCredentialAccessRule(deps.env.DB, id);
  if (!existing) return opFailure('not_found', ['credential access rule not found']);
  const current = pinValues(existing.tenant_pin, input.claim);
  if (!current.includes(input.value)) {
    return opFailure('invalid', [`${input.value} is not in the tenant pin of this access rule`]);
  }
  const used = existing.conditions.some(
    (c) =>
      c?.claim === input.claim &&
      c.negate !== true &&
      Array.isArray(c.values) &&
      c.values.includes(input.value),
  );
  if (used) {
    const word = tenantWord(existing.profile);
    return opFailure('invalid', [
      `Remove the jobs that use ${word} ${input.label ?? input.value} first.`,
    ]);
  }
  const values = current.filter((value) => value !== input.value);
  if (values.length === 0 && tenantClaimOf(existing.profile) !== null) {
    return opFailure('invalid', [
      'An access rule needs at least one organization, group or team: add another one first, or delete the access rule.',
    ]);
  }
  return updateCredentialAccessRule(deps, actor, id, {
    tenant_pin: withPinValues(existing.tenant_pin, input.claim, values),
    ...(input.expected_updated_at === undefined
      ? {}
      : { expected_updated_at: input.expected_updated_at }),
  });
}

/**
 * Enable or disable; takes effect on the next proxied request (no caching). Enabling validates
 * the stored row. Disabling changes only `enabled` and skips validation, so a rule whose stored
 * row no longer validates can still be switched off.
 */
export async function setCredentialAccessRuleEnabled(
  deps: Deps,
  actor: Actor,
  id: string,
  enabled: boolean,
  expectedUpdatedAt?: number,
): Promise<CredentialRuleOpResult> {
  if (typeof enabled !== 'boolean') return opFailure('invalid', ['enabled must be true or false']);
  if (enabled) {
    return updateCredentialAccessRule(deps, actor, id, {
      enabled,
      ...(expectedUpdatedAt === undefined ? {} : { expected_updated_at: expectedUpdatedAt }),
    });
  }
  const db = deps.env.DB;
  const existing = await getCredentialAccessRule(db, id);
  if (!existing) return opFailure('not_found', ['credential access rule not found']);
  const stale = staleEdit('the credential access rule', expectedUpdatedAt, existing.updated_at);
  if (stale) return stale;
  const now = deps.now();
  const guard = accessRuleExistsGuard(id);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'credential_access_rule.disable',
      targetType: 'credential_access_rule',
      targetId: id,
      summary: `Disabled credential access rule ${existing.name}`,
      diff: { before: { enabled: existing.enabled }, after: { enabled: false } },
    },
    guard,
    [setAccessRuleEnabledStatement(db, id, false, now, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return concurrentChange('the credential access rule');
  const rule = { ...existing, enabled: false, updated_at: nextVersion(existing.updated_at, now) };
  return success(rule, [], await statusOf(db, rule, now), {});
}

/** Deletes a credential access rule and its labels. Skips validation, like a disable. */
export async function deleteCredentialAccessRule(
  deps: Deps,
  actor: Actor,
  id: string,
  expectedUpdatedAt?: number,
): Promise<{ ok: true } | OpFailure> {
  const db = deps.env.DB;
  const existing = await getCredentialAccessRule(db, id);
  if (!existing) return opFailure('not_found', ['credential access rule not found']);
  const stale = staleEdit('the credential access rule', expectedUpdatedAt, existing.updated_at);
  if (stale) return stale;
  const service = await getService(db, existing.credential_id);
  const guard = accessRuleExistsGuard(id);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'credential_access_rule.delete',
      targetType: 'credential_access_rule',
      targetId: id,
      summary: `Deleted credential access rule ${existing.name}${service ? ` of ${service.name}` : ''}`,
      diff: { before: auditView(existing) },
    },
    guard,
    [deleteAccessRuleStatement(db, id, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return concurrentChange('the credential access rule');
  return { ok: true };
}

/**
 * Copies a credential access rule to the same credential (empty `credentialId`) or another one
 * (`credential_access_rule.duplicate`): every field except the credential and the name, a new id,
 * the labels. The copy is validated against its target like a new rule. Warnings the source
 * already carries count as accepted; a new one (path injection on the target) needs acknowledgement.
 */
export async function duplicateCredentialAccessRule(
  deps: Deps,
  actor: Actor,
  id: string,
  input: { credentialId?: string; name?: string; acknowledge_warnings?: boolean } = {},
): Promise<CredentialRuleOpResult> {
  const db = deps.env.DB;
  const source = await getCredentialAccessRule(db, id);
  if (!source) return opFailure('not_found', ['credential access rule not found']);
  const from = await getService(db, source.credential_id);
  if (!from) return opFailure('not_found', ['credential not found']);
  const targetId = input.credentialId || source.credential_id;
  const target = targetId === from.id ? from : await getService(db, targetId);
  if (!target) return opFailure('invalid', ['Select a credential to copy the access rule to.']);
  const profile = getProfile(source.profile);
  if (!profile) return opFailure('invalid', [`stored profile ${source.profile} is unknown`]);
  const accepted = validateCredentialAccessRule(asInput(source, source.profile), profile, source, {
    injection: from.injection,
    rules: [],
  }).warningDetails.map((detail) => detail.code);
  const copied = validateCredentialAccessRule(asInput(source, source.profile), profile, null, {
    injection: target.injection,
    rules: [],
  }).warningDetails.map((detail) => detail.code);
  const covered = copied.every((code) => accepted.includes(code));
  const labels = (await listClaimLabels(db, source.id)).map(({ claim, value, label }) => ({
    claim,
    value,
    label,
  }));
  const base =
    input.name?.trim() ||
    (target.id === from.id ? `${source.name} (copy)` : source.name).slice(0, NAME_MAX_LENGTH);
  return insertRule(
    deps,
    actor,
    {
      credential_id: target.id,
      name: base,
      description: source.description,
      profile: source.profile,
      issuer: source.issuer,
      jwks_uri: source.jwks_uri,
      audience: source.audience,
      allowed_algs: source.allowed_algs,
      max_token_age_seconds: source.max_token_age_seconds,
      tenant_pin: source.tenant_pin,
      anchor_claims: source.anchor_claims,
      conditions: source.conditions,
      rules: source.rules,
      enabled: true,
      expires_at:
        source.expires_at !== null && source.expires_at > deps.now() ? source.expires_at : null,
      labels,
      acknowledge_warnings: input.acknowledge_warnings === true || covered,
    },
    { action: 'credential_access_rule.duplicate', source: { rule: source, credential: from } },
  );
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** The rule against the global access rules of its issuer key (AR-8), and its warning. */
async function statusOf(
  db: D1Database,
  rule: CredentialAccessRule,
  now: number,
): Promise<GlobalStatus<GlobalRuleOf>> {
  return globalStatus(rule, await listGlobalAccessRules(db, { issuer_key: rule.issuer_key }), now);
}

/** The AR-8 warning of a global access rule status, or null. Never blocks a save. */
export function globalStatusWarning(status: GlobalStatus): AccessRuleWarningDetail | null {
  if (status.kind === 'limited') {
    return {
      code: 'global_limited',
      message:
        'Some requests this rule allows are outside the global access rules of this issuer and will be refused.',
    };
  }
  if (status.kind === 'blocked') {
    const detail = status.reasons.map((reason) => reason.detail).join('; ');
    return {
      code: 'global_blocked',
      message: `The global access rules of this issuer refuse every request of this rule: ${detail}.`,
    };
  }
  return null;
}

function success(
  rule: CredentialAccessRule,
  details: readonly AccessRuleWarningDetail[],
  status: GlobalStatus<GlobalRuleOf>,
  extra: { changed?: boolean; labelsChanged?: boolean },
): CredentialRuleOpResult {
  const globalWarning = globalStatusWarning(status);
  const warningDetails = globalWarning ? [...details, globalWarning] : [...details];
  return {
    ok: true,
    rule,
    warnings: warningDetails.map((detail) => detail.message),
    warningDetails,
    globalStatus: status,
    ...extra,
  };
}

/** The audit view of a rule: every stored field (no secret lives in a rule). */
function auditView(rule: CredentialAccessRule): Record<string, unknown> {
  const { kind: _kind, ...view } = rule;
  return view;
}

function normalizeLabels(labels: RuleLabel[] | undefined): RuleLabel[] {
  return (labels ?? []).map((label) => ({
    ...label,
    label: typeof label.label === 'string' ? label.label.trim() : '',
  }));
}

/** Discovery's algorithms that I-JWT-1 allows, in ALLOWED_ALGS order; RS256 when none. */
function discoveredAlgs(algs: string[] | null): string[] {
  const allowed = ALLOWED_ALGS.filter((alg) => algs?.includes(alg));
  return allowed.length > 0 ? [...allowed] : ['RS256'];
}

/** What the IDs of `claim` look like, for errors: "numeric IDs". */
function idWords(profile: ProfileId, claim: string): string {
  if (profile !== 'vercel') return 'numeric IDs';
  return claim === 'project_id' ? 'project IDs like prj_…' : 'team IDs like team_…';
}

/**
 * UI rule on top of the validator: pin values are IDs (names can be re-registered), numeric for
 * GitHub and GitLab, prefixed for Vercel. The validator accepts any exact value, so this keeps a
 * typo out of the pin.
 */
function pinIdErrors(profile: IssuerProfile, pin: readonly Condition[]): string[] {
  if (!Array.isArray(pin)) return [];
  return pin.flatMap((condition) => {
    const pattern = claimIdPattern(profile.id, String(condition?.claim));
    return pattern !== null &&
      Array.isArray(condition?.values) &&
      condition.values.some((value: unknown) => typeof value !== 'string' || !pattern.test(value))
      ? [`tenant pin: ${condition.claim} values must be ${idWords(profile.id, condition.claim)}`]
      : [];
  });
}

/** The claims whose IDs a profile labels: the tenant and the repository or project. */
const LABELLED: Readonly<Partial<Record<ProfileId, readonly LabelledClaim[]>>> = {
  'github-actions': ['repository_owner_id', 'repository_id'],
  'gitlab-ci': ['namespace_id', 'project_id'],
  vercel: ['owner_id', 'project_id'],
};

function labelErrors(profile: IssuerProfile, labels: readonly RuleLabel[]): string[] {
  return labels.flatMap((label) => {
    const pattern = claimIdPattern(profile.id, label.claim);
    return !(LABELLED[profile.id] ?? []).includes(label.claim) || pattern === null
      ? [`${label.claim} cannot carry a label`]
      : !pattern.test(label.value)
        ? [
            `label value ${JSON.stringify(label.value)} must be one of the ${idWords(profile.id, label.claim)}`,
          ]
        : label.label === '' || label.label.length > 256
          ? [`the label of ${label.value} must be 1-256 characters`]
          : [];
  });
}

function labelsDiff(changes: ReadonlyArray<{ input: ClaimLabelInput; before: string | null }>) {
  if (changes.length === 0) return {};
  const before: Record<string, string | null> = {};
  const after: Record<string, string> = {};
  for (const { input, before: old } of changes) {
    before[`${input.claim}:${input.value}`] = old;
    after[`${input.claim}:${input.value}`] = input.label;
  }
  return { labels: { before, after } };
}

function riskDiff(accepted: string[] | undefined) {
  return accepted && accepted.length > 0 ? { accepted_risks: [...new Set(accepted)].sort() } : {};
}

/**
 * The JWKS URI named in the input, honoured only for the generic profile: platform profiles
 * (GitHub Actions, GitLab CI) always use the issuer's discovery document.
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

/** Exported for tests and pages: the stored labels with the typed ones on top. */
export function labelsWithTyped(
  stored: readonly ClaimLabel[],
  ruleId: string,
  typed: readonly RuleLabel[],
): ClaimLabel[] {
  const extra: ClaimLabel[] = typed.map((label) => ({
    access_rule_id: ruleId,
    claim: label.claim,
    value: label.value,
    label: label.label,
    updated_at: 0,
    updated_by: null,
  }));
  return [
    ...extra,
    ...stored.filter(
      (label) => !extra.some((e) => e.claim === label.claim && e.value === label.value),
    ),
  ];
}
