// Authorization with credential and global access rules (ADR 0026, docs/policies.md). A request is allowed
// when one credential access rule C of the credential matches it and either C's issuer has no global access
// rule, or one global access rule of that issuer holds too (I-AUTHZ-1). C must satisfy its anchor rules
// (I-AUTHZ-2); untrusted events need an exact opt-in in C (I-AUTHZ-3); conditions fail closed (I-AUTHZ-4);
// trace details hide claims outside C's log allowlist (I-LOG-1). Pure: the proxy handler loops over the
// candidates, verifies tokens and applies the tenant gate before it calls these functions.
import type { IssuerProfile } from '../identity/types';
import { claimText, satisfiesAnchorRule } from './conditions';
import {
  conditionsHold,
  globalRuleHolds,
  type PolicyCredentialRule,
  type PolicyGlobalRule,
  type RequestFacts,
  someRuleMatches,
} from './limits';
import type { Condition, DenyCode, TraceEntry } from './types';

export { ruleMatches } from './limits';

/** Public 403 codes of a policy refusal (AR-13). */
export type RuleDenyCode = DenyCode;

/** One step of request evaluation, stored in request_log.eval_trace. */
export type RuleTraceEntry = TraceEntry;

export type OwnResult =
  | { result: 'matched' }
  | { result: 'invalid_rule' | 'condition_failed' | 'no_rule'; detail: string }
  /** `rulesMatched`: fixing the event alone would let C match. */
  | { result: 'event_not_trusted'; detail: string; rulesMatched: boolean };

/**
 * C's own policy: anchors (I-AUTHZ-2), conditions (I-AUTHZ-4), event guard (I-AUTHZ-3) and rules.
 * Save-time validation enforces anchors, but a row written around validation can be unanchored;
 * it must not authorize.
 */
export function credentialRuleDecision(
  c: PolicyCredentialRule,
  profile: IssuerProfile,
  f: RequestFacts,
): OwnResult {
  const anchorRules =
    c.profile === profile.id && Array.isArray(c.anchor_claims) ? profile.anchorRules(c) : [];
  if (!satisfiesAnchorRule(c.conditions, anchorRules)) {
    return {
      result: 'invalid_rule',
      detail: 'the access rule does not satisfy the anchor rules of its issuer type',
    };
  }

  const conditions = conditionsHold(c.conditions, f);
  if (!conditions.ok) return { result: 'condition_failed', detail: conditions.detail };

  const rules = someRuleMatches(c.rules, f);
  const guard = eventGuard(c.conditions, profile, f);
  if (!guard.ok) {
    const detail = rules.ok ? guard.detail : `${guard.detail}; no rule matches either`;
    return { result: 'event_not_trusted', detail, rulesMatched: rules.ok };
  }
  if (!rules.ok) return { result: 'no_rule', detail: rules.detail };
  return { result: 'matched' };
}

/**
 * The first global access rule that holds for C, in the given order (created_at, id), or every
 * failure. `globals` must be every global access rule of C's issuer key, in every state: an empty
 * list means that the issuer is not limited (`global: null`); a disabled or expired rule still
 * exists and holds for nothing (AR-4). A row of another issuer key never holds.
 */
export function globalDecision<G extends PolicyGlobalRule>(
  c: PolicyCredentialRule,
  globals: readonly G[],
  f: RequestFacts,
):
  | { ok: true; global: G | null }
  | { ok: false; failures: Array<{ global_rule_id: string; detail: string }> } {
  if (globals.length === 0) return { ok: true, global: null };
  const failures: Array<{ global_rule_id: string; detail: string }> = [];
  for (const global of globals) {
    const result = globalRuleHolds(global, c, f);
    if (result.ok) return { ok: true, global };
    failures.push({ global_rule_id: global.id, detail: result.detail });
  }
  return { ok: false, failures };
}

/**
 * Candidates with the same key verify the token the same way, so the proxy verifies once per key
 * (AR-10): profile, issuer, JWKS URI, audience, algorithms, maximum token age and the claims jose
 * requires. Save-time validation caps the distinct keys of one credential and issuer key.
 */
export function verificationGroupKey(c: PolicyCredentialRule, profile: IssuerProfile): string {
  const algs = Array.isArray(c.allowed_algs) ? [...new Set(c.allowed_algs)].sort() : null;
  const required = [...new Set(profile.verifyRequiredClaims(c))].sort();
  return JSON.stringify([
    c.profile,
    c.issuer,
    c.jwks_uri,
    c.audience,
    algs,
    c.max_token_age_seconds,
    required,
  ]);
}

/**
 * Evaluation order of credential access rules (ADR 0031): the most specific rule first, so a
 * request that several rules of a credential type admit uses the credential of the narrowest one.
 * Specificity is the number of identity conditions (own conditions plus tenant pin), then the
 * number of those that are `exact` and not negated. Operations do not count: the request already
 * passed them. Ties go to the oldest rule (created_at, id). A malformed list counts as empty.
 */
export function bySpecificity<
  R extends Pick<PolicyCredentialRule, 'id' | 'tenant_pin' | 'conditions'> & { created_at: number },
>(a: R, b: R): number {
  const sa = specificity(a);
  const sb = specificity(b);
  return (
    sb.conditions - sa.conditions ||
    sb.exact - sa.exact ||
    a.created_at - b.created_at ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function specificity(c: Pick<PolicyCredentialRule, 'tenant_pin' | 'conditions'>): {
  conditions: number;
  exact: number;
} {
  const all = [
    ...(Array.isArray(c.tenant_pin) ? c.tenant_pin : []),
    ...(Array.isArray(c.conditions) ? c.conditions : []),
  ];
  return {
    conditions: all.length,
    exact: all.filter(
      (condition) =>
        typeof condition === 'object' &&
        condition !== null &&
        condition.match === 'exact' &&
        condition.negate !== true,
    ).length,
  };
}

/**
 * I-AUTHZ-3. Passes when the profile has no event claim, when the token's event is trusted,
 * or when C has a non-negated `exact` condition on the event claim listing that event.
 * A missing or non-scalar event claim fails. Only C's conditions count: a global access rule
 * never opts in to an untrusted event.
 */
function eventGuard(
  conditions: Condition[],
  profile: IssuerProfile,
  f: RequestFacts,
): { ok: true } | { ok: false; detail: string } {
  const eventClaim = profile.eventClaim;
  if (eventClaim === undefined) return { ok: true };

  const event = claimText(f.claims, eventClaim);
  if (event === null) {
    const detail = `${eventClaim}: claim missing or not a string, boolean or safe integer`;
    return { ok: false, detail };
  }
  if (profile.trustedEvents.includes(event)) return { ok: true };

  const optedIn =
    Array.isArray(conditions) &&
    conditions.some(
      (c) =>
        typeof c === 'object' &&
        c !== null &&
        c.claim === eventClaim &&
        c.match === 'exact' &&
        c.negate !== true &&
        Array.isArray(c.values) &&
        c.values.includes(event),
    );
  if (optedIn) return { ok: true };

  const shown = f.revealClaims.has(eventClaim) ? JSON.stringify(clip(event, 64)) : '(hidden)';
  return {
    ok: false,
    detail: `${eventClaim}=${shown} is not trusted; the access rule needs an exact ${eventClaim} condition listing it`,
  };
}

/** Upper bound for the serialized trace stored in request_log.eval_trace (docs/architecture.md). */
export const TRACE_MAX_BYTES = 2048;

/** Element of `traceJson` output: a trace entry, or a final marker counting omitted entries. */
export type RuleTraceJsonItem = RuleTraceEntry | { omitted: number };

/**
 * JSON array of trace entries, at most TRACE_MAX_BYTES of UTF-8. Ids and details are clipped;
 * entries that do not fit are dropped and replaced by one final `{"omitted": n}` element.
 * Lone surrogates are replaced first: JSON.stringify writes each as a 6-byte `\uXXXX` escape,
 * which could make even the first entry too large to keep.
 */
export function traceJson(trace: RuleTraceEntry[]): string {
  const encoder = new TextEncoder();
  const markerReserve = encoder.encode(`,${JSON.stringify({ omitted: trace.length })}`).length;
  const parts: string[] = [];
  let bytes = 2; // "[" and "]"
  for (const [index, entry] of trace.entries()) {
    const part = JSON.stringify({
      rule_id: clip(entry.rule_id, 64).toWellFormed(),
      ...(entry.global_rule_id === undefined
        ? {}
        : { global_rule_id: clip(entry.global_rule_id, 64).toWellFormed() }),
      result: entry.result,
      detail: clip(entry.detail, 300).toWellFormed(),
    });
    const cost = encoder.encode(part).length + (parts.length > 0 ? 1 : 0);
    const isLast = index === trace.length - 1;
    if (bytes + cost + (isLast ? 0 : markerReserve) > TRACE_MAX_BYTES) {
      parts.push(JSON.stringify({ omitted: trace.length - index }));
      break;
    }
    parts.push(part);
    bytes += cost;
  }
  return `[${parts.join(',')}]`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
