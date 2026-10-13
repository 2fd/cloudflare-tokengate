// Grant mutations. Saving or enabling validates against the caller provider version the write is
// guarded on (I-AUTHZ-2); warnings need acknowledgement and go in the audit row (I-AUDIT-1).
// Disabling and deleting skip validation, so revocation always works (I-AUTHZ-1).
import { callerProviderVersionGuard, getCallerProvider } from '../../db/caller-providers';
import {
  deleteGrantStatement,
  type GrantValues,
  getGrant,
  grantExistsGuard,
  grantVersionGuard,
  insertGrantStatement,
  setGrantEnabledStatement,
  updateGrantStatement,
} from '../../db/grants';
import { getService, serviceExistsGuard } from '../../db/services';
import type { Actor, CallerProvider, Grant } from '../../db/types';
import type { Deps } from '../../deps';
import { getProfile } from '../../identity/profiles';
import { newId } from '../../lib/ids';
import { canonicalJson } from '../../lib/json';
import type { Condition, Rule } from '../../policy/types';
import { validateGrant } from '../../policy/validate';
import {
  allOf,
  booleanErrors,
  commitOrConstraintFailure,
  concurrentChange,
  descriptionErrors,
  NAME_MAX_LENGTH,
  nameErrors,
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

export interface GrantCreateInput {
  name: string;
  description?: string;
  caller_provider_id: string;
  service_id: string;
  conditions: Condition[];
  rules: Rule[];
  enabled?: boolean;
  expires_at?: number | null;
  /** Set after the operator has seen the warnings returned by a previous attempt. */
  acknowledge_warnings?: boolean;
}

export type GrantOpResult =
  | {
      ok: true;
      grant: Grant;
      warnings: string[];
      /** updateGrant only: false when the submitted values matched and nothing was written. */
      changed?: boolean;
    }
  | OpFailure;

export async function createGrant(
  deps: Deps,
  actor: Actor,
  input: GrantCreateInput,
): Promise<GrantOpResult> {
  return insertGrant(deps, actor, input, { action: 'grant.create', sourceId: null });
}

export interface GrantUpdateInput {
  name?: string;
  description?: string;
  conditions?: Condition[];
  rules?: Rule[];
  enabled?: boolean;
  expires_at?: number | null;
  acknowledge_warnings?: boolean;
  /** `updated_at` the edit form was opened at; a newer stored version is a conflict. */
  expected_updated_at?: number;
}

const UPDATABLE_KEYS: ReadonlyArray<keyof GrantUpdateInput> = [
  'name',
  'description',
  'conditions',
  'rules',
  'enabled',
  'expires_at',
  'acknowledge_warnings',
  'expected_updated_at',
];

/** Updates grant content. The caller provider and service of a grant cannot change. */
export async function updateGrant(
  deps: Deps,
  actor: Actor,
  id: string,
  input: GrantUpdateInput,
): Promise<GrantOpResult> {
  const rejected = Object.keys(input).filter(
    (key) => !(UPDATABLE_KEYS as readonly string[]).includes(key),
  );
  if (rejected.length > 0) {
    return opFailure('invalid', [
      `${rejected.join(', ')} cannot be changed; create a new grant for another caller provider or service`,
    ]);
  }
  const flagErrors = [
    ...booleanErrors('enabled', input.enabled),
    ...booleanErrors('acknowledge_warnings', input.acknowledge_warnings),
  ];
  if (flagErrors.length > 0) return opFailure('invalid', flagErrors);
  // A pure enable/disable goes through setGrantEnabled, so disabling never depends on validation.
  const keys = Object.keys(input).filter(
    (key) =>
      key !== 'acknowledge_warnings' &&
      key !== 'expected_updated_at' &&
      input[key as keyof GrantUpdateInput] !== undefined,
  );
  if (keys.length === 1 && input.enabled !== undefined) {
    return setGrantEnabled(deps, actor, id, input.enabled);
  }
  const db = deps.env.DB;
  const existing = await getGrant(db, id);
  if (!existing) return opFailure('not_found', ['grant not found']);
  const stale = staleEdit('the grant', input.expected_updated_at, existing.updated_at);
  if (stale) return stale;

  const next: GrantValues = {
    name: input.name !== undefined ? trimmed(input.name) : existing.name,
    description:
      input.description !== undefined ? trimmed(input.description) : existing.description,
    conditions:
      input.conditions !== undefined ? normalizeConditions(input.conditions) : existing.conditions,
    rules: input.rules !== undefined ? normalizeRules(input.rules) : existing.rules,
    enabled: input.enabled ?? existing.enabled,
    expires_at: input.expires_at !== undefined ? input.expires_at : existing.expires_at,
  };
  const checked = await checkGrant(deps, existing.caller_provider_id, existing.service_id, next, {
    expiryChanged: next.expires_at !== existing.expires_at,
    acknowledged: input.acknowledge_warnings === true,
  });
  if (!checked.ok) return checked;

  const changed = (Object.keys(next) as Array<keyof GrantValues>).filter(
    (key) => canonicalJson(next[key]) !== canonicalJson(existing[key]),
  );
  // A save that changes nothing writes nothing: no audit row, no version bump.
  if (changed.length === 0 && input.enabled === undefined) {
    return { ok: true, grant: existing, warnings: checked.warnings, changed: false };
  }
  const now = deps.now();
  const guard = allOf(grantVersionGuard(existing), callerProviderVersionGuard(checked.provider));
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'grant.update',
      targetType: 'grant',
      targetId: id,
      summary: `Updated grant ${existing.name}${changed.length ? ` (${changed.join(', ')})` : ''}`,
      diff: {
        before: pick(existing, changed),
        after: pick(next, changed),
        warnings: checked.warnings,
      },
    },
    guard,
    [updateGrantStatement(db, id, next, now, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return concurrentChange('the grant or its caller provider');
  return {
    ok: true,
    grant: { ...existing, ...next, updated_at: nextVersion(existing.updated_at, now) },
    warnings: checked.warnings,
    changed: true,
  };
}

/**
 * Enabling re-validates the grant against the current caller provider (errors block; warnings
 * were acknowledged when it was saved). Disabling always succeeds and takes effect on the next
 * proxied request.
 */
export async function setGrantEnabled(
  deps: Deps,
  actor: Actor,
  id: string,
  enabled: boolean,
): Promise<GrantOpResult> {
  if (typeof enabled !== 'boolean') return opFailure('invalid', ['enabled must be true or false']);
  const db = deps.env.DB;
  const existing = await getGrant(db, id);
  if (!existing) return opFailure('not_found', ['grant not found']);

  let guard = grantExistsGuard(id);
  let warnings: string[] = [];
  if (enabled) {
    const checked = await checkGrant(
      deps,
      existing.caller_provider_id,
      existing.service_id,
      existing,
      {
        expiryChanged: false,
        acknowledged: true,
      },
    );
    if (!checked.ok) return checked;
    guard = allOf(grantVersionGuard(existing), callerProviderVersionGuard(checked.provider));
    warnings = checked.warnings;
  }

  const now = deps.now();
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: enabled ? 'grant.enable' : 'grant.disable',
      targetType: 'grant',
      targetId: id,
      summary: `${enabled ? 'Enabled' : 'Disabled'} grant ${existing.name}`,
      diff: { before: { enabled: existing.enabled }, after: { enabled }, warnings },
    },
    guard,
    [setGrantEnabledStatement(db, id, enabled, now, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return concurrentChange('the grant or its caller provider');
  return {
    ok: true,
    grant: { ...existing, enabled, updated_at: nextVersion(existing.updated_at, now) },
    warnings,
  };
}

export async function deleteGrant(
  deps: Deps,
  actor: Actor,
  id: string,
): Promise<{ ok: true } | OpFailure> {
  const db = deps.env.DB;
  const existing = await getGrant(db, id);
  if (!existing) return opFailure('not_found', ['grant not found']);
  const guard = grantExistsGuard(id);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'grant.delete',
      targetType: 'grant',
      targetId: id,
      summary: `Deleted grant ${existing.name}`,
      diff: { before: existing },
    },
    guard,
    [deleteGrantStatement(db, id, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return concurrentChange('the grant');
  return { ok: true };
}

/**
 * Copies a grant as a new, disabled grant named "<name> (copy)", so the operator reviews the copy
 * before it allows anything. The copy is validated like a new grant; its warnings were already
 * acknowledged on the source and are recorded again in the audit row.
 */
export async function duplicateGrant(
  deps: Deps,
  actor: Actor,
  id: string,
  options: { name?: string } = {},
): Promise<GrantOpResult> {
  const source = await getGrant(deps.env.DB, id);
  if (!source) return opFailure('not_found', ['grant not found']);
  const name = options.name?.trim() || `${source.name} (copy)`.slice(0, NAME_MAX_LENGTH);
  return insertGrant(
    deps,
    actor,
    {
      name,
      description: source.description,
      caller_provider_id: source.caller_provider_id,
      service_id: source.service_id,
      conditions: source.conditions,
      rules: source.rules,
      enabled: false,
      expires_at: source.expires_at,
      acknowledge_warnings: true,
    },
    { action: 'grant.duplicate', sourceId: source.id },
  );
}

async function insertGrant(
  deps: Deps,
  actor: Actor,
  input: GrantCreateInput,
  meta: { action: 'grant.create' | 'grant.duplicate'; sourceId: string | null },
): Promise<GrantOpResult> {
  const flagErrors = booleanErrors('enabled', input.enabled);
  if (flagErrors.length > 0) return opFailure('invalid', flagErrors);
  const values: GrantValues = {
    name: trimmed(input.name),
    description: input.description === undefined ? '' : trimmed(input.description),
    conditions: normalizeConditions(input.conditions),
    rules: normalizeRules(input.rules),
    enabled: input.enabled ?? true,
    expires_at: input.expires_at ?? null,
  };
  const checked = await checkGrant(deps, input.caller_provider_id, input.service_id, values, {
    expiryChanged: values.expires_at !== null,
    acknowledged: input.acknowledge_warnings === true,
  });
  if (!checked.ok) return checked;

  const now = deps.now();
  const grant: Grant = {
    ...values,
    id: newId('grt', now, deps.random),
    caller_provider_id: input.caller_provider_id,
    service_id: input.service_id,
    created_by: actor.email ?? actor.id,
    created_at: now,
    updated_at: now,
  };
  const guard = allOf(
    callerProviderVersionGuard(checked.provider),
    serviceExistsGuard(input.service_id),
  );
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: meta.action,
      targetType: 'grant',
      targetId: grant.id,
      summary:
        meta.sourceId === null
          ? `Created grant ${grant.name}`
          : `Duplicated grant ${meta.sourceId} as ${grant.name} (disabled)`,
      diff: {
        after: grant,
        warnings: checked.warnings,
        ...(meta.sourceId === null ? {} : { source_id: meta.sourceId }),
      },
    },
    guard,
    [insertGrantStatement(deps.env.DB, grant, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return concurrentChange('the caller provider or service');
  return { ok: true, grant, warnings: checked.warnings };
}

/**
 * Loads the grant's caller provider and service and validates `values` against them. Returns the
 * provider so the write can be guarded on the version that was validated against.
 */
async function checkGrant(
  deps: Deps,
  callerProviderId: string,
  serviceId: string,
  values: GrantValues,
  options: { expiryChanged: boolean; acknowledged: boolean },
): Promise<{ ok: true; provider: CallerProvider; warnings: string[] } | OpFailure> {
  const db = deps.env.DB;
  const [provider, service] = await Promise.all([
    getCallerProvider(db, callerProviderId),
    getService(db, serviceId),
  ]);
  const errors: string[] = [];
  if (!provider) errors.push('caller provider not found');
  if (!service) errors.push('service not found');
  const profile = provider ? getProfile(provider.profile) : null;
  if (provider && !profile) errors.push(`caller provider profile ${provider.profile} is unknown`);

  errors.push(...nameErrors(values.name));
  errors.push(...descriptionErrors(values.description));
  const expiryErrors = timestampErrors('expiry', values.expires_at);
  errors.push(...expiryErrors);
  if (
    options.expiryChanged &&
    expiryErrors.length === 0 &&
    values.expires_at !== null &&
    values.expires_at <= deps.now()
  ) {
    errors.push('expiry must be in the future');
  }
  if (!provider || !profile) return opFailure('invalid', errors);

  const validation = validateGrant(
    { conditions: values.conditions, rules: values.rules },
    profile,
    provider,
    service,
  );
  errors.push(...validation.errors);
  if (errors.length > 0) return opFailure('invalid', errors, validation.warnings);
  if (validation.warnings.length > 0 && !options.acknowledged) {
    return opFailure(
      'acknowledgement_required',
      ['review the warnings and confirm to save this grant'],
      validation.warnings,
    );
  }
  return { ok: true, provider, warnings: validation.warnings };
}
