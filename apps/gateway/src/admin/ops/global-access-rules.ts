// Global access rule mutations (ADR 0026, I-AUTHZ-5). A global access rule is a ceiling on every credential
// access rule of its issuer key; it never lets a request in by itself. Every change that can widen a
// ceiling needs `confirm_widening`, and the first ceiling of an issuer needs `confirm_new_ceiling`
// (AR-21). Both are decided from the global rows alone (ceilingChange), which every admin can see, so
// no hidden row ever changes whether a confirmation appears. Without a confirmation, the batch carries
// a guard that keeps the classification true at commit. Audit rows never name credentials (AR-16).
import {
  accessRuleExistsGuard,
  accessRuleUnchangedGuard,
  type AccessRuleValues,
  deleteAccessRuleStatement,
  getGlobalAccessRule,
  insertAccessRuleStatement,
  listCredentialAccessRules,
  listGlobalAccessRules,
  noGlobalRuleGuard,
  otherEnabledGlobalRuleGuard,
  otherGlobalRuleExistsGuard,
  setAccessRuleEnabledStatement,
  updateAccessRuleStatement,
} from '../../db/access-rules';
import { changedLabels, listClaimLabels, upsertClaimLabelStatement } from '../../db/claim-labels';
import type { Actor, GlobalAccessRule } from '../../db/types';
import type { Deps } from '../../deps';
import { getProfile } from '../../identity/profiles';
import { newId } from '../../lib/ids';
import { canonicalJson } from '../../lib/json';
import { type CeilingChange, ceilingChange } from '../../policy/global-status';
import { globalRuleUsable, issuerKey } from '../../policy/limits';
import type { Condition, Rule } from '../../policy/types';
import {
  type AccessRuleWarningDetail,
  validateGlobalAccessRule,
} from '../../policy/validate-rules';
import { type RuleLabel, ruleIssuer } from './credential-access-rules';
import {
  allOf,
  booleanErrors,
  commitOrConstraintFailure,
  concurrentChange,
  nextVersion,
  normalizeConditions,
  normalizeRules,
  type OpFailure,
  opFailure,
  pick,
  type SqlGuard,
  staleEdit,
  timestampErrors,
  trimmed,
} from './shared';

/** A limit set to null (or left out) is not a limit. */
export interface GlobalRuleInput {
  name: string;
  description?: string;
  profile: string;
  /** Default: the profile's issuer (GitHub Actions, GitLab.com). */
  issuer?: string;
  jwks_uri?: string | null;
  audience?: string | null;
  allowed_algs?: string[] | null;
  max_token_age_seconds?: number | null;
  tenant_pin?: Condition[] | null;
  anchor_claims?: string[] | null;
  conditions?: Condition[] | null;
  rules?: Rule[] | null;
  enabled?: boolean;
  expires_at?: number | null;
  /** Labels of the tenant pin's numeric IDs (organizations, groups), written with the save. */
  labels?: RuleLabel[];
}

/** Which confirmation dialog a refused change needs (AR-21, AR-4). */
export type GlobalConfirmation = 'new_ceiling' | 'widening' | 'last_disable' | 'last_delete';

export type GlobalRuleFailure = OpFailure & { confirm?: GlobalConfirmation };

export type GlobalRuleOpResult =
  | {
      ok: true;
      rule: GlobalAccessRule;
      warnings: string[];
      warningDetails: AccessRuleWarningDetail[];
      /** The classification of the change for the issuer's ceiling (AR-21). */
      change: CeilingChange;
      /** Updates only: false when the submitted values matched and nothing was written. */
      changed?: boolean;
    }
  | GlobalRuleFailure;

/** The fixed texts of the confirmation dialogs (§A7.4, §A7.5). */
export function confirmationText(confirm: GlobalConfirmation, issuer: string): string {
  switch (confirm) {
    case 'new_ceiling':
      return `This is the first global access rule of ${issuer}. From the next request on, its credential access rules admit only what this rule allows.`;
    case 'widening':
      return `This lets more requests in. Every credential access rule of ${issuer} may again allow what this change no longer limits, on every credential.`;
    case 'last_disable':
      return `While no global access rule of ${issuer} is enabled, its credential access rules admit nothing.`;
    case 'last_delete':
      return `This is the last global access rule of ${issuer}. After you delete it, its credential access rules are no longer limited by a global access rule.`;
  }
}

function needsConfirmation(confirm: GlobalConfirmation, issuer: string): GlobalRuleFailure {
  return { ...opFailure('confirmation_required', [confirmationText(confirm, issuer)]), confirm };
}

const NO_ISSUER_RULE = (key: string) =>
  `No credential access rule uses this issuer yet. Check the spelling: this global access rule limits only rules whose issuer is ${key}.`;

export async function createGlobalAccessRule(
  deps: Deps,
  actor: Actor,
  input: GlobalRuleInput & { confirm_new_ceiling?: boolean; confirm_widening?: boolean },
): Promise<GlobalRuleOpResult> {
  const db = deps.env.DB;
  const profile = getProfile(String(input.profile));
  if (!profile)
    return opFailure('invalid', ['profile must be github-actions, gitlab-ci or generic']);
  const flagErrors = [
    ...booleanErrors('enabled', input.enabled),
    ...timestampErrors('expiry', input.expires_at),
  ];
  if (flagErrors.length > 0) return opFailure('invalid', flagErrors);
  if (input.expires_at != null && input.expires_at <= deps.now()) {
    return opFailure('invalid', ['expiry must be in the future']);
  }
  const values = valuesOf(input, ruleIssuer(profile.id, trimmed(input.issuer)), null);
  const validation = validateGlobalAccessRule({ ...values, profile: profile.id }, profile, null);
  if (validation.errors.length > 0) {
    return opFailure('invalid', validation.errors, validation.warnings);
  }

  const now = deps.now();
  const key = issuerKey(values.issuer);
  const rule: GlobalAccessRule = {
    ...values,
    kind: 'global',
    id: newId('gar', now, deps.random),
    credential_id: null,
    profile: profile.id,
    issuer_key: key,
    created_by: actor.email ?? actor.id,
    created_at: now,
    updated_at: now,
  };
  const before = await listGlobalAccessRules(db, { issuer_key: key });
  const change = ceilingChange(before, [...before, rule], now);
  const first = before.length === 0;
  if (first && input.confirm_new_ceiling !== true) {
    return needsConfirmation('new_ceiling', values.issuer);
  }
  if (!first && isWidening(change) && input.confirm_widening !== true) {
    return needsConfirmation('widening', values.issuer);
  }
  // A concurrent create would make this one a sibling, which can widen the ceiling.
  const guard: SqlGuard | null =
    first && input.confirm_widening !== true ? noGlobalRuleGuard(key) : null;
  const details = [...validation.warningDetails, ...(await spellingWarning(db, key))];
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'global_access_rule.create',
      targetType: 'global_access_rule',
      targetId: rule.id,
      summary: `Added global access rule ${rule.name} for ${rule.issuer}`,
      diff: { after: auditView(rule), warnings: details.map((d) => d.message), ceiling: change },
    },
    guard,
    [
      insertAccessRuleStatement(db, rule, guard ?? { sql: '1', binds: [] }),
      ...changedLabels(
        [],
        (input.labels ?? []).map((label) => ({ ...label, access_rule_id: rule.id })),
      ).map(({ input: label }) =>
        upsertClaimLabelStatement(db, label, now, actor.id, accessRuleExistsGuard(rule.id)),
      ),
    ],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) {
    return opFailure('conflict', [
      'Another change added a global access rule of this issuer. Reload the page.',
    ]);
  }
  return success(rule, details, change);
}

export async function updateGlobalAccessRule(
  deps: Deps,
  actor: Actor,
  id: string,
  input: Partial<GlobalRuleInput> & {
    expected_updated_at?: number;
    confirm_widening?: boolean;
    confirm_last_disable?: boolean;
  },
): Promise<GlobalRuleOpResult> {
  const db = deps.env.DB;
  const flagErrors = [
    ...booleanErrors('enabled', input.enabled),
    ...timestampErrors('expiry', input.expires_at),
  ];
  if (flagErrors.length > 0) return opFailure('invalid', flagErrors);
  const existing = await getGlobalAccessRule(db, id);
  if (!existing) return opFailure('not_found', ['global access rule not found']);
  const stale = staleEdit('the global access rule', input.expected_updated_at, existing.updated_at);
  if (stale) return stale;
  const profile = getProfile(existing.profile);
  if (!profile) return opFailure('invalid', [`stored profile ${existing.profile} is unknown`]);
  if (input.profile !== undefined && input.profile !== existing.profile) {
    return opFailure('invalid', [
      'The issuer and the issuer type of a global access rule cannot change. Add a new global access rule and delete this one.',
    ]);
  }
  if (
    input.expires_at != null &&
    input.expires_at !== existing.expires_at &&
    input.expires_at <= deps.now()
  ) {
    return opFailure('invalid', ['expiry must be in the future']);
  }
  const issuer =
    input.issuer !== undefined ? ruleIssuer(profile.id, trimmed(input.issuer)) : existing.issuer;
  const values = valuesOf(input, issuer, existing);
  const validation = validateGlobalAccessRule(
    { ...values, profile: existing.profile },
    profile,
    existing,
  );
  if (validation.errors.length > 0) {
    return opFailure('invalid', validation.errors, validation.warnings);
  }
  const changed = (Object.keys(values) as Array<keyof AccessRuleValues>).filter(
    (k) => canonicalJson(values[k]) !== canonicalJson(existing[k]),
  );
  const labelChanges =
    input.labels && input.labels.length > 0
      ? changedLabels(
          await listClaimLabels(db, id),
          input.labels.map((label) => ({ ...label, access_rule_id: id })),
        )
      : [];
  const now = deps.now();
  const after: GlobalAccessRule = { ...existing, ...values };
  const others = (await listGlobalAccessRules(db, { issuer_key: existing.issuer_key })).filter(
    (rule) => rule.id !== id,
  );
  const change = ceilingChange([...others, existing], [...others, after], now);
  if (changed.length === 0 && labelChanges.length === 0) {
    return success(existing, validation.warningDetails, 'none', { changed: false });
  }
  if (isWidening(change) && input.confirm_widening !== true) {
    return needsConfirmation('widening', existing.issuer);
  }
  // A disable through an update follows the rule of setGlobalAccessRuleEnabled (AR-4).
  const disabling = existing.enabled && !values.enabled;
  const lastEnabled = disabling && !others.some((rule) => rule.enabled);
  if (lastEnabled && input.confirm_last_disable !== true) {
    return needsConfirmation('last_disable', existing.issuer);
  }
  // The classification depends on this row only, which the version guard pins.
  const unchanged = accessRuleUnchangedGuard(id, existing.updated_at);
  const guard =
    disabling && input.confirm_last_disable !== true
      ? allOf(unchanged, otherEnabledGlobalRuleGuard(existing.issuer_key, id))
      : unchanged;
  const onlyEnabled =
    changed.length > 0 && labelChanges.length === 0 && changed.every((k) => k === 'enabled');
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: onlyEnabled
        ? values.enabled
          ? 'global_access_rule.enable'
          : 'global_access_rule.disable'
        : 'global_access_rule.update',
      targetType: 'global_access_rule',
      targetId: id,
      summary: onlyEnabled
        ? `${values.enabled ? 'Enabled' : 'Disabled'} global access rule ${existing.name}`
        : `Changed global access rule ${existing.name}: ${changed.map(fieldText).join(', ')}`,
      diff: {
        before: pick(existing, changed),
        after: pick(values, changed),
        warnings: validation.warnings,
        ceiling: change,
        ...(isWidening(change) ? { widening_confirmed: true } : {}),
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
  if (!outcome.committed) return concurrentChange('the global access rule');
  return success(
    { ...after, updated_at: nextVersion(existing.updated_at, now) },
    validation.warningDetails,
    change,
    { changed: true },
  );
}

/**
 * Enabling is a widening (AR-21) and needs `confirm_widening`. Disabling the last enabled global
 * access rule of an issuer leaves its credential access rules admitting nothing (AR-4): it needs
 * `confirm_last_disable`, and without it the batch is guarded on another enabled rule existing.
 * Disabling skips validation, so it always works.
 */
export async function setGlobalAccessRuleEnabled(
  deps: Deps,
  actor: Actor,
  id: string,
  enabled: boolean,
  input: {
    expected_updated_at?: number;
    confirm_widening?: boolean;
    confirm_last_disable?: boolean;
  },
): Promise<GlobalRuleOpResult> {
  if (typeof enabled !== 'boolean') return opFailure('invalid', ['enabled must be true or false']);
  if (enabled) {
    return updateGlobalAccessRule(deps, actor, id, {
      enabled: true,
      ...(input.expected_updated_at === undefined
        ? {}
        : { expected_updated_at: input.expected_updated_at }),
      ...(input.confirm_widening === undefined ? {} : { confirm_widening: input.confirm_widening }),
    });
  }
  const db = deps.env.DB;
  const existing = await getGlobalAccessRule(db, id);
  if (!existing) return opFailure('not_found', ['global access rule not found']);
  const stale = staleEdit('the global access rule', input.expected_updated_at, existing.updated_at);
  if (stale) return stale;
  const now = deps.now();
  const others = (await listGlobalAccessRules(db, { issuer_key: existing.issuer_key })).filter(
    (rule) => rule.id !== id,
  );
  const lastEnabled = existing.enabled && !others.some((rule) => rule.enabled);
  if (lastEnabled && input.confirm_last_disable !== true) {
    return needsConfirmation('last_disable', existing.issuer);
  }
  const guard =
    existing.enabled && input.confirm_last_disable !== true
      ? otherEnabledGlobalRuleGuard(existing.issuer_key, id)
      : accessRuleExistsGuard(id);
  const after = { ...existing, enabled: false };
  const change = ceilingChange([...others, existing], [...others, after], now);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'global_access_rule.disable',
      targetType: 'global_access_rule',
      targetId: id,
      summary: `Disabled global access rule ${existing.name}`,
      diff: { before: { enabled: existing.enabled }, after: { enabled: false }, ceiling: change },
    },
    guard,
    [setAccessRuleEnabledStatement(db, id, false, now, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) {
    return input.confirm_last_disable === true
      ? concurrentChange('the global access rule')
      : opFailure('conflict', [
          'Another change disabled a global access rule of this issuer. Reload the page.',
        ]);
  }
  return success({ ...after, updated_at: nextVersion(existing.updated_at, now) }, [], change);
}

/**
 * Deleting the last global access rule of an issuer lifts its ceiling (AR-7): it needs
 * `confirm_widening`. Without it, the batch is guarded on another global rule of the issuer
 * existing, so two concurrent deletes cannot both pass.
 */
export async function deleteGlobalAccessRule(
  deps: Deps,
  actor: Actor,
  id: string,
  input: { expected_updated_at?: number; confirm_widening?: boolean },
): Promise<{ ok: true; last: boolean } | GlobalRuleFailure> {
  const db = deps.env.DB;
  const existing = await getGlobalAccessRule(db, id);
  if (!existing) return opFailure('not_found', ['global access rule not found']);
  const stale = staleEdit('the global access rule', input.expected_updated_at, existing.updated_at);
  if (stale) return stale;
  const others = (await listGlobalAccessRules(db, { issuer_key: existing.issuer_key })).filter(
    (rule) => rule.id !== id,
  );
  const last = others.length === 0;
  if (last && input.confirm_widening !== true) {
    return needsConfirmation('last_delete', existing.issuer);
  }
  const guard =
    input.confirm_widening === true
      ? accessRuleExistsGuard(id)
      : otherGlobalRuleExistsGuard(existing.issuer_key, id);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'global_access_rule.delete',
      targetType: 'global_access_rule',
      targetId: id,
      summary: last
        ? `Deleted global access rule ${existing.name}, the last one of ${existing.issuer}: its credential access rules are no longer limited by a global access rule`
        : `Deleted global access rule ${existing.name}`,
      diff: {
        before: auditView(existing),
        ceiling: last ? 'widening' : 'tightening',
      },
    },
    guard,
    [deleteAccessRuleStatement(db, id, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) {
    return input.confirm_widening === true
      ? concurrentChange('the global access rule')
      : opFailure('conflict', [
          'Another change removed a global access rule of this issuer. Reload the page.',
        ]);
  }
  return { ok: true, last };
}

// ---------------------------------------------------------------------------------------------
// Helpers

function isWidening(change: CeilingChange): boolean {
  return change === 'widening' || change === 'mixed';
}

/** The stored values of an input; on update, a field left out keeps its stored value. */
function valuesOf(
  input: Partial<GlobalRuleInput>,
  issuer: string,
  existing: GlobalAccessRule | null,
): AccessRuleValues & Pick<GlobalAccessRule, keyof AccessRuleValues> {
  const keep = <K extends keyof GlobalAccessRule>(
    key: K,
    value: GlobalAccessRule[K] | undefined,
  ) => (value !== undefined ? value : existing !== null ? existing[key] : null);
  const list = <T>(value: T[] | null | undefined, normalize: (items: T[]) => T[] = (x) => x) =>
    value === undefined || value === null ? value : normalize(value);
  return {
    name: input.name !== undefined ? trimmed(input.name) : (existing?.name ?? ''),
    description:
      input.description !== undefined ? trimmed(input.description) : (existing?.description ?? ''),
    issuer,
    jwks_uri: keep(
      'jwks_uri',
      input.jwks_uri === undefined ? undefined : trimmedOrNull(input.jwks_uri),
    ),
    audience: keep(
      'audience',
      input.audience === undefined ? undefined : trimmedOrNull(input.audience),
    ),
    allowed_algs: keep('allowed_algs', input.allowed_algs),
    max_token_age_seconds: keep('max_token_age_seconds', input.max_token_age_seconds),
    tenant_pin: keep('tenant_pin', list(input.tenant_pin, normalizeConditions)),
    anchor_claims: keep('anchor_claims', input.anchor_claims),
    conditions: keep('conditions', list(input.conditions, normalizeConditions)),
    rules: keep('rules', list(input.rules, normalizeRules)),
    enabled: input.enabled ?? existing?.enabled ?? true,
    expires_at: input.expires_at !== undefined ? input.expires_at : (existing?.expires_at ?? null),
  } as AccessRuleValues & Pick<GlobalAccessRule, keyof AccessRuleValues>;
}

function trimmedOrNull(value: string | null): string | null {
  return value === null ? null : value.trim();
}

/** The issuer-spelling warning: no credential access rule has this issuer key (§A4). */
async function spellingWarning(db: D1Database, key: string): Promise<AccessRuleWarningDetail[]> {
  const rules = await listCredentialAccessRules(db, { issuer_key: key });
  return rules.length > 0 ? [] : [{ code: 'no_issuer_rule', message: NO_ISSUER_RULE(key) }];
}

const FIELD_TEXT: Readonly<Record<string, string>> = {
  name: 'name',
  description: 'description',
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

/** Global access rules hold no credential data, so the audit view is the whole row. */
function auditView(rule: GlobalAccessRule): Record<string, unknown> {
  const { kind: _kind, credential_id: _credential, ...view } = rule;
  return view;
}

function success(
  rule: GlobalAccessRule,
  details: readonly AccessRuleWarningDetail[],
  change: CeilingChange,
  extra: { changed?: boolean } = {},
): GlobalRuleOpResult {
  return {
    ok: true,
    rule,
    warnings: details.map((detail) => detail.message),
    warningDetails: [...details],
    change,
    ...extra,
  };
}

/** True when the rule holds for nothing at `now` (disabled or expired), but still caps its issuer. */
export function globalRuleIdle(rule: GlobalAccessRule, now: number): boolean {
  return !globalRuleUsable(rule, now);
}
