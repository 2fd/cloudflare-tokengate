// The limit registry of access rules (ADR 0026, docs/policies.md). Credential access rules and global access
// rules share one table and its columns; every column that limits a request has exactly one predicate here,
// and both kinds call it (AR-19). A global access rule adds a limit only when its column is not NULL, and an
// empty or malformed value matches nothing (I-AUTHZ-5). The tenant gate is the credential access rule's own
// pin (identity/jwt.ts tenantPinHolds); a global tenant pin is an ordinary limit here (AR-9).
//
// Contract for a new limit column: add the column to `access_rules`; decide how a credential row stores
// "no restriction" for it (the CHECK says which); add one GlobalLimit entry whose `holds` uses the same
// predicate the credential side uses; call that predicate in credentialRuleDecision (policy/access-rules.ts);
// add its empty-array sentinel to accessRuleFromRow (db/rows.ts).
import { CLOCK_TOLERANCE_SECONDS } from '../identity/jwt';
import type { Claims, ProfileId } from '../identity/types';
import { conditionShapeError, evaluateCondition, satisfiesAnchorRule } from './conditions';
import { globMatch } from './glob';
import { type Condition, PROXY_METHODS, type Rule } from './types';

/**
 * The fields of a credential access rule that policy reads. Every limit is set (CHECK). The rows
 * of db/rows.ts satisfy it; a value that did not parse is a sentinel that matches nothing.
 */
export interface PolicyCredentialRule {
  id: string;
  profile: ProfileId;
  /** Exact; jose compares it with `iss`. */
  issuer: string;
  /** Stored `lower(rtrim(issuer, '/'))`; global access rules match on it (AR-3). */
  issuer_key: string;
  jwks_uri: string;
  audience: string;
  allowed_algs: string[];
  max_token_age_seconds: number;
  tenant_pin: Condition[];
  anchor_claims: string[];
  conditions: Condition[];
  rules: Rule[];
}

/**
 * The fields of a global access rule that policy reads. A limit column is null for "no limit".
 * Disabled or expired rules still exist: they hold for nothing but still cap their issuer (AR-4).
 */
export interface PolicyGlobalRule {
  id: string;
  profile: ProfileId;
  issuer: string;
  issuer_key: string;
  enabled: boolean;
  /** Milliseconds since the epoch, or null for no expiry. */
  expires_at: number | null;
  jwks_uri: string | null;
  audience: string | null;
  allowed_algs: string[] | null;
  max_token_age_seconds: number | null;
  tenant_pin: Condition[] | null;
  anchor_claims: string[] | null;
  conditions: Condition[] | null;
  rules: Rule[] | null;
}

/** What the request established, after verification and the tenant gate. */
export interface RequestFacts {
  /** Verified token claims (raw, never the display form). */
  claims: Claims;
  /** Header `alg` of the verified token. */
  alg: string;
  /** Milliseconds since the epoch. */
  now: number;
  /** Request method as received (upper case). */
  method: string;
  /** Canonical path from proxy/path.ts as forwarded upstream (`%2F` kept). */
  path: string;
  /** Canonical match path from proxy/path.ts (`%2F` already turned into `/`). */
  matchPath: string;
  /** Claims whose values may appear in trace details: the credential access rule's log allowlist (I-LOG-1). */
  revealClaims: ReadonlySet<string>;
}

export type LimitResult = { ok: true } | { ok: false; detail: string };

const OK: LimitResult = Object.freeze({ ok: true });
const NO_REVEAL: ReadonlySet<string> = new Set();
const EMPTY_LIMIT = 'the limit is empty or malformed and matches nothing';

function fail(detail: string): LimitResult {
  return { ok: false, detail };
}

/**
 * The matching key of an issuer: trailing slashes removed and ASCII letters in lower case, the same
 * as SQL `lower(rtrim(issuer, '/'))`. It writes `access_rules.issuer_key`, where a CHECK refuses any
 * row on which JS and SQL disagree. It never decides a request: decisions compare stored keys (AR-3).
 */
export function issuerKey(issuer: string): string {
  return issuer.replace(/\/+$/, '').replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// ---------------------------------------------------------------------------------------------
// Shared predicates: credential rules and global rules call the same function for the same column.

/**
 * True when every pin condition holds exactly on the claims (I-TEN-1). Pin conditions are exact and
 * non-negated by construction; anything else (wrong match, negate, malformed shape) fails closed.
 * An empty pin holds: the caller decides what it means (tenantPinHolds refuses it on shared
 * issuers; a global access rule never stores one, and its limit refuses one).
 */
export function pinHolds(pin: readonly Condition[], claims: Claims): boolean {
  return pinFailure(pin, claims, NO_REVEAL) === null;
}

function pinFailure(
  pin: readonly Condition[],
  claims: Claims,
  revealClaims: ReadonlySet<string>,
): string | null {
  if (!Array.isArray(pin)) return 'tenant pin malformed';
  for (const [index, condition] of pin.entries()) {
    if (
      conditionShapeError(condition) !== null ||
      condition.match !== 'exact' ||
      condition.negate === true
    ) {
      return `tenant_pin[${index}] malformed: must be an exact, non-negated condition`;
    }
    const result = evaluateCondition(condition, claims, revealClaims);
    if (!result.ok) return `tenant_pin[${index}] ${result.detail}`;
  }
  return null;
}

/**
 * Every condition holds on the claims (AND). Conditions fail closed (I-AUTHZ-4); details never echo
 * a claim outside `f.revealClaims` (I-LOG-1). An empty list holds: the anchor check of the
 * credential side and the empty-limit check of the global side run first.
 */
export function conditionsHold(conditions: readonly Condition[], f: RequestFacts): LimitResult {
  if (!Array.isArray(conditions)) return fail('conditions malformed');
  for (const [index, condition] of conditions.entries()) {
    const result = evaluateCondition(condition, f.claims, f.revealClaims);
    if (!result.ok) return fail(`condition[${index}] ${result.detail}`);
  }
  return OK;
}

/** Some rule allows the method on both readings of the path (`ruleMatches`). */
export function someRuleMatches(rules: readonly Rule[], f: RequestFacts): LimitResult {
  if (Array.isArray(rules) && rules.some((rule) => ruleMatches(rule, f.method, f))) return OK;
  return fail(`no rule allows ${clip(f.method, 16)} ${clip(f.matchPath, 128)}`);
}

/**
 * True when `method` is a proxy method the rule lists (explicitly, or via `*`) and the rule's
 * glob matches the path. Rules come from stored JSON: a malformed rule matches nothing.
 * `target.path` is the forwarded path, `target.matchPath` the same path with `%2F` read as "/".
 * The rule must match both readings: upstreams such as GitLab treat `%2F` as part of an
 * identifier, others as a separator, and the gateway cannot tell which (I-AUTHZ-1).
 */
export function ruleMatches(
  rule: Rule,
  method: string,
  target: { path: string; matchPath: string },
): boolean {
  if (!(PROXY_METHODS as readonly string[]).includes(method)) return false;
  if (typeof rule !== 'object' || rule === null) return false;
  if (!Array.isArray(rule.methods) || typeof rule.path !== 'string') return false;
  if (!rule.methods.some((m) => m === '*' || m === method)) return false;
  return (
    pathMatches(rule.path, target.matchPath) &&
    (target.path === target.matchPath || pathMatches(rule.path, target.path))
  );
}

/**
 * Glob match where a trailing "/" in the path counts only if the pattern ends with a literal "/"
 * or also matches the path without it. Otherwise `/x/*` and `/x/**` would authorize `/x/`,
 * which many upstreams route to the parent resource `/x` (I-AUTHZ-1).
 */
export function pathMatches(pattern: string, path: string): boolean {
  if (!globMatch(pattern, path)) return false;
  if (path.length > 1 && path.endsWith('/') && !pattern.endsWith('/')) {
    return globMatch(pattern, path.slice(0, -1));
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Global limits

export type GlobalLimitColumn =
  | 'jwks_uri'
  | 'audience'
  | 'allowed_algs'
  | 'max_token_age_seconds'
  | 'tenant_pin'
  | 'anchor_claims'
  | 'conditions'
  | 'rules';

export interface GlobalLimit {
  /** An `access_rules` column. */
  column: GlobalLimitColumn;
  side: 'trust' | 'identity' | 'target';
  /** G's non-NULL value against C and the request. Never called with null. */
  holds(g: PolicyGlobalRule, c: PolicyCredentialRule, f: RequestFacts): LimitResult;
}

/** A non-empty list, or null when the value is empty or not a list (it then matches nothing). */
function limitList<T>(value: readonly T[] | null): readonly T[] | null {
  return Array.isArray(value) && value.length > 0 ? value : null;
}

/** Every limit column, in the order globalRuleHolds checks them. */
export const GLOBAL_LIMITS: readonly GlobalLimit[] = Object.freeze([
  {
    column: 'jwks_uri',
    side: 'trust',
    // Closes "a generic rule for issuer X with an attacker's JWKS" for every capped issuer.
    holds: (g, c) => (c.jwks_uri === g.jwks_uri ? OK : fail('JWKS URI pin differs')),
  },
  {
    column: 'audience',
    side: 'trust',
    holds: (g, c) => (c.audience === g.audience ? OK : fail('audience pin differs')),
  },
  {
    column: 'allowed_algs',
    side: 'trust',
    holds: (g, _c, f) => {
      const algs = limitList(g.allowed_algs);
      if (algs === null) return fail(EMPTY_LIMIT);
      return algs.includes(f.alg)
        ? OK
        : fail(`signing algorithm ${JSON.stringify(clip(f.alg, 16))} is not allowed`);
    },
  },
  {
    column: 'max_token_age_seconds',
    side: 'trust',
    // `f.now` is milliseconds, `iat` seconds. A missing or non-integer `iat` refuses.
    holds: (g, _c, f) => {
      const max = g.max_token_age_seconds;
      if (typeof max !== 'number' || !Number.isSafeInteger(max) || max <= 0) {
        return fail(EMPTY_LIMIT);
      }
      const iat = f.claims.iat;
      if (typeof iat !== 'number' || !Number.isSafeInteger(iat)) {
        return fail('iat: claim missing or not an integer');
      }
      return Math.floor(f.now / 1000) - iat <= max + CLOCK_TOLERANCE_SECONDS
        ? OK
        : fail(`token older than ${max} s`);
    },
  },
  {
    column: 'tenant_pin',
    side: 'identity',
    holds: (g, _c, f) => {
      const pin = limitList(g.tenant_pin);
      if (pin === null) return fail(EMPTY_LIMIT);
      const failure = pinFailure(pin, f.claims, f.revealClaims);
      return failure === null ? OK : fail(failure);
    },
  },
  {
    column: 'anchor_claims',
    side: 'identity',
    // Static on C: some anchor claim of G has an exact, non-negated condition in C (I-AUTHZ-2).
    holds: (g, c) => {
      const claims = limitList(g.anchor_claims);
      if (claims === null) return fail(EMPTY_LIMIT);
      return satisfiesAnchorRule(
        c.conditions,
        claims.map((claim) => [claim]),
      )
        ? OK
        : fail(`conditions pin none of the anchor claims ${clip(JSON.stringify(claims), 160)}`);
    },
  },
  {
    column: 'conditions',
    side: 'identity',
    // The event guard reads only C's conditions: G never opts in to an untrusted event (I-AUTHZ-3).
    holds: (g, _c, f) => {
      const conditions = limitList(g.conditions);
      return conditions === null ? fail(EMPTY_LIMIT) : conditionsHold(conditions, f);
    },
  },
  {
    column: 'rules',
    side: 'target',
    holds: (g, _c, f) => {
      const rules = limitList(g.rules);
      return rules === null ? fail(EMPTY_LIMIT) : someRuleMatches(rules, f);
    },
  },
] satisfies GlobalLimit[]);

/** Columns that are not limits. Every other access_rules column must be in GLOBAL_LIMITS (AR-19). */
export const NON_LIMIT_COLUMNS: readonly string[] = Object.freeze([
  'id',
  'credential_id',
  'name',
  'description',
  'profile',
  'issuer',
  'issuer_key',
  'enabled',
  'expires_at',
  'created_by',
  'created_at',
  'updated_at',
]);

/** Enabled and not expired at `now` (ms). A malformed expiry counts as expired. */
export function globalRuleUsable(
  g: Pick<PolicyGlobalRule, 'enabled' | 'expires_at'>,
  now: number,
): boolean {
  if (g.enabled !== true) return false;
  return g.expires_at === null || (typeof g.expires_at === 'number' && g.expires_at > now);
}

/**
 * True when G holds for C and the request: enabled, unexpired, the same profile (AR-6) and issuer
 * key (stored values only, AR-3), then every non-NULL limit in GLOBAL_LIMITS order. The tenant pin
 * is a limit here, never part of the tenant gate (AR-9).
 */
export function globalRuleHolds(
  g: PolicyGlobalRule,
  c: PolicyCredentialRule,
  f: RequestFacts,
): LimitResult {
  if (g.enabled !== true) return fail('global access rule disabled');
  if (!globalRuleUsable(g, f.now)) return fail('global access rule expired');
  if (g.profile !== c.profile) return fail('issuer type differs');
  if (g.issuer_key !== c.issuer_key) return fail('issuer differs');
  for (const limit of GLOBAL_LIMITS) {
    if (g[limit.column] === null) continue;
    const result = limit.holds(g, c, f);
    if (!result.ok) return result;
  }
  return OK;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
