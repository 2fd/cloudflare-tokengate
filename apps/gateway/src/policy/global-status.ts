// Static comparisons of access rules (ADR 0026), from the rows alone; pure, no request. Two uses:
// * globalStatus: how the global access rules of an issuer cap one credential access rule. The pages and
//   the save warnings show it; the request-time intersection (policy/access-rules.ts) is the authority (AR-8).
// * ceilingChange: whether a change to the global access rules of one issuer key can admit more requests.
//   Every widening needs a confirmation (AR-21). It never reads statuses: a status can stay `limited`
//   while its ceiling widens.
// Containment is conservative: when it cannot be shown, the answer is "not within".
import { conditionShapeError, evaluateCondition, satisfiesAnchorRule } from './conditions';
import {
  GLOBAL_LIMITS,
  type GlobalLimitColumn,
  globalRuleUsable,
  pathMatches,
  type PolicyCredentialRule,
  type PolicyGlobalRule,
} from './limits';
import { type Condition, PROXY_METHODS, type Rule } from './types';
import { ruleShapeError, tenantPinValues } from './validate';

export type GlobalStatus<G extends PolicyGlobalRule = PolicyGlobalRule> =
  /** The issuer has no global access rule. */
  | { kind: 'not_limited' }
  /** Some usable global access rule provably contains C. */
  | { kind: 'within'; global: G }
  /** Some usable global access rule may admit part of C. */
  | { kind: 'limited'; globals: G[] }
  /** No global access rule can ever hold for C. */
  | { kind: 'blocked'; reasons: Array<{ global: G; detail: string }> };

/**
 * The status of C under `globals`, every global access rule of C's issuer key in every state.
 * `not_limited` without rows; `within` when some G contains C; `blocked` when every G is blocked;
 * otherwise `limited` with the G that are not blocked.
 */
export function globalStatus<G extends PolicyGlobalRule>(
  c: PolicyCredentialRule,
  globals: readonly G[],
  now: number,
): GlobalStatus<G> {
  if (globals.length === 0) return { kind: 'not_limited' };
  const reasons: Array<{ global: G; detail: string }> = [];
  const limited: G[] = [];
  for (const global of globals) {
    const blocked = blockedReason(c, global, now);
    if (blocked !== null) reasons.push({ global, detail: blocked });
    else if (contains(global, c)) return { kind: 'within', global };
    else limited.push(global);
  }
  return limited.length > 0 ? { kind: 'limited', globals: limited } : { kind: 'blocked', reasons };
}

/** Why G can never hold for C, or null. */
function blockedReason(c: PolicyCredentialRule, g: PolicyGlobalRule, now: number): string | null {
  if (g.enabled !== true) return 'The global access rule is disabled.';
  if (!globalRuleUsable(g, now)) return 'The global access rule has expired.';
  if (g.profile !== c.profile) return 'The global access rule is for another issuer type.';
  if (g.issuer_key !== c.issuer_key) return 'The global access rule is for another issuer.';
  for (const limit of GLOBAL_LIMITS) {
    if (g[limit.column] !== null && !LIMIT_WELL_FORMED[limit.column](g)) {
      return `The ${LIMIT_LABELS[limit.column]} limit is empty or malformed and matches nothing.`;
    }
  }
  if (g.jwks_uri !== null && g.jwks_uri !== c.jwks_uri) return 'The JWKS URI pin differs.';
  if (g.audience !== null && g.audience !== c.audience) return 'The audience pin differs.';
  if (g.allowed_algs !== null && !intersects(g.allowed_algs, c.allowed_algs)) {
    return 'No signing algorithm is in both rules.';
  }
  if (
    g.anchor_claims !== null &&
    !satisfiesAnchorRule(
      c.conditions,
      list(g.anchor_claims).map((claim) => [claim]),
    )
  ) {
    return `The conditions pin none of the anchor claims ${list(g.anchor_claims).join(', ')}.`;
  }
  if (g.tenant_pin !== null) {
    const outside = tenantOutside(c, g.tenant_pin);
    if (outside !== null) return outside;
  }
  return null;
}

/**
 * A tenant pin claim of G that C allows only with values outside G's pin, as a reason. C's
 * values for a claim are those that every exact, non-negated condition of its own tenant pin and
 * conditions accepts. A G pin condition that is not exact and non-negated never holds.
 */
function tenantOutside(c: PolicyCredentialRule, pin: Condition[]): string | null {
  if (!Array.isArray(pin) || !pin.every(isExactPin)) {
    return 'The tenant pin of the global access rule is malformed.';
  }
  const own = [...list(c.tenant_pin), ...list(c.conditions)].filter(isExactPin);
  for (const claim of new Set(pin.map((condition) => condition.claim))) {
    if (!own.some((condition) => condition.claim === claim)) continue;
    const allowed = tenantPinValues(pin, claim);
    const values = tenantPinValues(own, claim);
    if (![...values].some((value) => allowed.has(value))) {
      return `The rule allows no ${claim} value of the tenant pin of the global access rule.`;
    }
  }
  return null;
}

/** True when every request that C admits, G also admits (G is usable and not blocked). */
function contains(g: PolicyGlobalRule, c: PolicyCredentialRule): boolean {
  const identity = [...list(c.tenant_pin), ...list(c.conditions)];
  return (
    (g.allowed_algs === null || subset(list(c.allowed_algs), g.allowed_algs)) &&
    (g.max_token_age_seconds === null ||
      (Number.isSafeInteger(c.max_token_age_seconds) &&
        g.max_token_age_seconds >= c.max_token_age_seconds)) &&
    (g.tenant_pin === null || conditionsWithin(identity, g.tenant_pin)) &&
    (g.conditions === null || conditionsWithin(identity, g.conditions)) &&
    (g.rules === null || rulesWithin(c.rules, g.rules))
  );
}

// ---------------------------------------------------------------------------------------------
// Ceiling changes (AR-21)

export type CeilingChange = 'none' | 'tightening' | 'widening' | 'mixed';

/**
 * Classifies a change to the global access rules of ONE issuer key, from the rows before and
 * after it. Rows are matched by id. The first global access rule of an issuer is a tightening
 * (it needs `confirm_new_ceiling`); `widening` and `mixed` need `confirm_widening`.
 */
export function ceilingChange(
  before: readonly PolicyGlobalRule[],
  after: readonly PolicyGlobalRule[],
  now: number,
): CeilingChange {
  if (before.length === 0) return after.length === 0 ? 'none' : 'tightening';
  if (after.length === 0) return 'widening';
  const changes: CeilingChange[] = [];
  const old = new Map(before.map((rule) => [rule.id, rule]));
  const kept = new Set(after.map((rule) => rule.id));
  for (const rule of after) {
    const previous = old.get(rule.id);
    if (previous === undefined) {
      // A sibling: any one global access rule suffices, so a usable sibling can only add.
      changes.push(globalRuleUsable(rule, now) ? 'widening' : 'none');
    } else if (sameCeiling(previous, rule)) {
      changes.push('none');
    } else if (ceilingWithin(rule, previous, now)) {
      changes.push('tightening');
    } else if (ceilingWithin(previous, rule, now)) {
      changes.push('widening');
    } else {
      changes.push('mixed');
    }
  }
  // A delete that leaves another global access rule of the issuer.
  if (before.some((rule) => !kept.has(rule.id))) changes.push('tightening');
  return combine(changes);
}

function combine(changes: readonly CeilingChange[]): CeilingChange {
  const has = (change: CeilingChange) => changes.includes(change);
  if (has('mixed') || (has('widening') && has('tightening'))) return 'mixed';
  if (has('widening')) return 'widening';
  if (has('tightening')) return 'tightening';
  return 'none';
}

/** The same ceiling: every field that decides a request is equal. */
function sameCeiling(a: PolicyGlobalRule, b: PolicyGlobalRule): boolean {
  const fields = (rule: PolicyGlobalRule) =>
    JSON.stringify([
      rule.profile,
      rule.issuer_key,
      rule.enabled,
      rule.expires_at,
      ...GLOBAL_LIMITS.map((limit) => rule[limit.column]),
    ]);
  return fields(a) === fields(b);
}

/**
 * One rule changed in place: true when `after` admits nothing that `before` refuses. `after` that
 * is not usable at `now` admits nothing. Otherwise `before` must be usable, the expiry must not
 * move later or be cleared, and each limit of `before` must stay, contained: the pins equal,
 * algorithms ⊆, maximum token age ≤, tenant pin and conditions within, anchor claims ⊆ (each
 * anchor claim is an alternative, so fewer is narrower) and rules within. Clearing a limit is
 * never within.
 */
export function ceilingWithin(
  after: PolicyGlobalRule,
  before: PolicyGlobalRule,
  now: number,
): boolean {
  if (!globalRuleUsable(after, now)) return true;
  if (!globalRuleUsable(before, now)) return false;
  if (
    before.expires_at !== null &&
    (after.expires_at === null || after.expires_at > before.expires_at)
  ) {
    return false;
  }
  if (after.profile !== before.profile || after.issuer_key !== before.issuer_key) return false;
  return GLOBAL_LIMITS.every((limit) => {
    if (before[limit.column] === null) return true;
    if (after[limit.column] === null) return false;
    return LIMIT_WITHIN[limit.column](after, before);
  });
}

/** Per limit column: `after`'s value admits nothing that `before`'s value refuses. Both are set. */
const LIMIT_WITHIN: Readonly<
  Record<GlobalLimitColumn, (after: PolicyGlobalRule, before: PolicyGlobalRule) => boolean>
> = Object.freeze({
  jwks_uri: (after, before) => after.jwks_uri === before.jwks_uri,
  audience: (after, before) => after.audience === before.audience,
  allowed_algs: (after, before) => subset(list(after.allowed_algs), list(before.allowed_algs)),
  max_token_age_seconds: (after, before) => {
    const [a, b] = [after.max_token_age_seconds, before.max_token_age_seconds];
    return a !== null && b !== null && Number.isSafeInteger(a) && Number.isSafeInteger(b) && a <= b;
  },
  tenant_pin: (after, before) => conditionsWithin(list(after.tenant_pin), list(before.tenant_pin)),
  anchor_claims: (after, before) => subset(list(after.anchor_claims), list(before.anchor_claims)),
  conditions: (after, before) => conditionsWithin(list(after.conditions), list(before.conditions)),
  rules: (after, before) => rulesWithin(list(after.rules), list(before.rules)),
});

// ---------------------------------------------------------------------------------------------
// Containment

const HIDDEN = new Set<string>();

/**
 * True when every claim set that satisfies all of `child` also satisfies all of `ceiling`.
 * Conservative: exact values can narrow a pattern; patterns must be identical. Unknown
 * containment is refused instead of treating a glob string as a concrete claim value.
 */
export function conditionsWithin(child: Condition[], ceiling: Condition[]): boolean {
  if (!Array.isArray(child) || !Array.isArray(ceiling)) return false;
  if ([...child, ...ceiling].some((condition) => conditionShapeError(condition) !== null)) {
    return false;
  }
  return ceiling.every((limit) =>
    child.some((condition) => {
      if (condition.claim !== limit.claim) return false;
      if (condition.match === 'exact' && condition.negate !== true) {
        return condition.values.every(
          (value) => evaluateCondition(limit, { [limit.claim]: value }, HIDDEN).ok,
        );
      }
      return (
        condition.match === limit.match &&
        (condition.negate === true) === (limit.negate === true) &&
        condition.values.every((value) => limit.values.includes(value)) &&
        limit.values.every((value) => condition.values.includes(value))
      );
    }),
  );
}

/**
 * True when every rule of `child` is within some rule of `ceiling`: its methods are a subset, and
 * its path is the same glob or a literal path that the ceiling's glob matches. Malformed rules
 * are never within.
 */
export function rulesWithin(child: Rule[], ceiling: Rule[]): boolean {
  if (!Array.isArray(child) || !Array.isArray(ceiling)) return false;
  return child.every((rule) => ceiling.some((limit) => ruleWithin(rule, limit)));
}

function ruleWithin(rule: Rule, limit: Rule): boolean {
  if (ruleShapeError(rule) !== null || ruleShapeError(limit) !== null) return false;
  const allowed = methodSet(limit);
  if (![...methodSet(rule)].every((method) => allowed.has(method))) return false;
  if (rule.path === limit.path) return true;
  // A literal path matches exactly that path on both readings, so the ceiling's glob decides.
  return !rule.path.includes('*') && pathMatches(limit.path, rule.path);
}

function methodSet(rule: Rule): Set<string> {
  return new Set(rule.methods.includes('*') ? PROXY_METHODS : rule.methods);
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** Names of the limits in status texts. */
const LIMIT_LABELS: Readonly<Record<GlobalLimitColumn, string>> = Object.freeze({
  jwks_uri: 'JWKS URI',
  audience: 'audience',
  allowed_algs: 'signing algorithm',
  max_token_age_seconds: 'maximum token age',
  tenant_pin: 'tenant pin',
  anchor_claims: 'anchor claim',
  conditions: 'conditions',
  rules: 'operations',
});

/**
 * Per limit column: a set value that can hold for some request. Anything else is a value that
 * rows.ts read as a sentinel, or a row written around the CHECK; it matches nothing.
 */
const LIMIT_WELL_FORMED: Readonly<Record<GlobalLimitColumn, (g: PolicyGlobalRule) => boolean>> =
  Object.freeze({
    jwks_uri: (g) => typeof g.jwks_uri === 'string',
    audience: (g) => typeof g.audience === 'string',
    allowed_algs: (g) => nonEmpty(g.allowed_algs),
    max_token_age_seconds: (g) =>
      Number.isSafeInteger(g.max_token_age_seconds) && (g.max_token_age_seconds ?? 0) > 0,
    tenant_pin: (g) => nonEmpty(g.tenant_pin),
    anchor_claims: (g) =>
      nonEmpty(g.anchor_claims) &&
      g.anchor_claims.every((claim) => typeof claim === 'string' && claim !== ''),
    conditions: (g) =>
      nonEmpty(g.conditions) && g.conditions.every((c) => conditionShapeError(c) === null),
    // Rules are alternatives: the list matches nothing only when no rule has a usable shape
    // (the `[null]` sentinel of rows.ts). ruleMatches reads the same two fields.
    rules: (g) =>
      nonEmpty(g.rules) &&
      g.rules.some(
        (rule) =>
          typeof rule === 'object' &&
          rule !== null &&
          Array.isArray(rule.methods) &&
          typeof rule.path === 'string',
      ),
  });

function nonEmpty<T>(value: T[] | null): value is T[] {
  return Array.isArray(value) && value.length > 0;
}

/** The list, or an empty list for a value that is not one (it then contains nothing). */
function list<T>(value: T[] | null): T[] {
  return Array.isArray(value) ? value : [];
}

function isExactPin(condition: Condition): boolean {
  return (
    conditionShapeError(condition) === null &&
    condition.match === 'exact' &&
    condition.negate !== true
  );
}

function subset<T>(items: readonly T[], of: readonly T[]): boolean {
  return Array.isArray(items) && Array.isArray(of) && items.every((item) => of.includes(item));
}

function intersects<T>(a: readonly T[], b: readonly T[]): boolean {
  return Array.isArray(a) && Array.isArray(b) && a.some((item) => b.includes(item));
}
