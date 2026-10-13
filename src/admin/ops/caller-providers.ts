// Caller provider mutations, validated per profile (I-TEN-1 tenant pin, I-JWT-1 algorithms and
// audience). Trust changes under enabled grants need confirmation; anchor/pin changes that would
// invalidate an enabled grant are refused (I-AUTHZ-2). One audit row per change (I-AUDIT-1).
import {
  type CallerProviderValues,
  callerProviderEnabledGrantsUnchangedGuard,
  callerProviderExistsGuard,
  callerProviderUnreferencedGuard,
  callerProviderVersionGuard,
  callerProviderWithoutEnabledGrantsGuard,
  deleteCallerProviderStatement,
  getCallerProvider,
  insertCallerProviderStatement,
  setCallerProviderEnabledStatement,
  updateCallerProviderStatement,
} from '../../db/caller-providers';
import { listGrants } from '../../db/grants';
import type { Actor, CallerProvider, Grant } from '../../db/types';
import type { Deps } from '../../deps';
import { discoverJwksUri } from '../../identity/jwt';
import { getProfile } from '../../identity/profiles';
import type { IssuerProfile } from '../../identity/types';
import { newId } from '../../lib/ids';
import { canonicalJson } from '../../lib/json';
import type { Condition } from '../../policy/types';
import { validateCallerProvider, validateGrant } from '../../policy/validate';
import {
  allOf,
  booleanErrors,
  commitOrConstraintFailure,
  concurrentChange,
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

export interface CallerProviderCreateInput {
  name: string;
  profile: string;
  /** Default: the profile's issuer (GitHub Actions, GitLab.com). */
  issuer?: string;
  /** Generic profile only: explicit JWKS URI; otherwise discovered from the issuer. */
  jwks_uri?: string | null;
  /** Default: defaultAudience(). */
  audience?: string | null;
  allowed_algs?: string[];
  max_token_age_seconds?: number;
  tenant_pin?: Condition[];
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

  const issuer = trimmed(input.issuer) || profile.defaults.issuer || '';
  const explicitJwks = explicitJwksUri(profile, input.jwks_uri);
  const audience = trimmed(input.audience) || defaultAudience(deps.random);
  const valuesWith = (jwksUri: string): CallerProviderValues => ({
    name: trimmed(input.name),
    issuer,
    jwks_uri: jwksUri,
    audience,
    allowed_algs: input.allowed_algs ?? [...profile.defaults.allowedAlgs],
    max_token_age_seconds: input.max_token_age_seconds ?? profile.defaults.maxTokenAgeSeconds,
    tenant_pin: normalizeConditions(input.tenant_pin ?? []),
    anchor_claims: input.anchor_claims ?? [],
    enabled: input.enabled ?? true,
  });

  // Validate before any network call; discovery runs only for an acceptable configuration.
  const precheck = validateCallerProvider(
    { ...valuesWith(explicitJwks ?? issuer), profile: profile.id },
    profile,
    null,
  );
  if (precheck.errors.length > 0) {
    return opFailure('invalid', precheck.errors, precheck.warnings);
  }
  const jwks = await resolveJwksUri(deps, issuer, explicitJwks);
  if (!jwks.ok) return opFailure('invalid', [jwks.error]);
  const values = valuesWith(jwks.jwksUri);
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
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'caller_provider.create',
      targetType: 'caller_provider',
      targetId: callerProvider.id,
      summary: `Created caller provider ${callerProvider.name} (${profile.id})`,
      diff: { after: callerProvider, warnings: validation.warnings },
    },
    null,
    [insertCallerProviderStatement(deps.env.DB, callerProvider)],
  );
  if (!outcome.ok) return outcome;
  return { ok: true, callerProvider, warnings: validation.warnings };
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

  const issuer = input.issuer !== undefined ? trimmed(input.issuer) : existing.issuer;
  const explicitJwks = explicitJwksUri(profile, input.jwks_uri);
  const rediscover = explicitJwks === null && issuer !== existing.issuer;
  const valuesWith = (jwksUri: string): CallerProviderValues => ({
    name: input.name !== undefined ? trimmed(input.name) : existing.name,
    issuer,
    jwks_uri: jwksUri,
    audience: input.audience !== undefined ? trimmed(input.audience) : existing.audience,
    allowed_algs: input.allowed_algs ?? existing.allowed_algs,
    max_token_age_seconds: input.max_token_age_seconds ?? existing.max_token_age_seconds,
    tenant_pin:
      input.tenant_pin !== undefined ? normalizeConditions(input.tenant_pin) : existing.tenant_pin,
    anchor_claims: input.anchor_claims ?? existing.anchor_claims,
    enabled: input.enabled ?? existing.enabled,
  });

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
    const jwks = await resolveJwksUri(deps, issuer, null);
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
  if (changed.length === 0 && input.enabled === undefined) {
    return { ok: true, callerProvider: existing, warnings: validation.warnings, changed: false };
  }
  // An enable/disable request is recorded as such even when the flag already had that value.
  const onlyEnabled = input.enabled !== undefined && changed.every((key) => key === 'enabled');

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
        warnings: validation.warnings,
      },
    },
    guard,
    [updateCallerProviderStatement(db, id, values, now, guard)],
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

/** Refused (conflict) while grants reference the caller provider. */
export async function deleteCallerProvider(
  deps: Deps,
  actor: Actor,
  id: string,
): Promise<{ ok: true } | OpFailure> {
  const db = deps.env.DB;
  const existing = await getCallerProvider(db, id);
  if (!existing) return opFailure('not_found', ['caller provider not found']);
  const grants = await listGrants(db, { caller_provider_id: id });
  if (grants.length > 0) return referencedBy(grants);

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
    [deleteCallerProviderStatement(db, id, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) {
    const current = await listGrants(db, { caller_provider_id: id });
    return current.length > 0 ? referencedBy(current) : concurrentChange('the caller provider');
  }
  return { ok: true };
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

/** `explicit` when given, else `jwks_uri` from the issuer's OIDC discovery document. */
async function resolveJwksUri(
  deps: Pick<Deps, 'fetch'>,
  issuer: string,
  explicit: string | null,
): Promise<{ ok: true; jwksUri: string } | { ok: false; error: string }> {
  if (explicit !== null) return { ok: true, jwksUri: explicit };
  const discovered = await discoverJwksUri(issuer, deps.fetch);
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
function brokenGrants(
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
