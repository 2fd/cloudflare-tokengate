// Authorization (docs/policies.md): the first grant whose conditions, event guard and rules all match wins,
// otherwise deny (I-AUTHZ-1). Skips unanchored issuer_access_rules (I-AUTHZ-2); untrusted events need an exact
// opt-in (I-AUTHZ-3); conditions fail closed (I-AUTHZ-4); trace details hide claims (I-LOG-1).
import type { Claims, IssuerProfile } from '../identity/types';
import { claimText, evaluateCondition, satisfiesAnchorRule } from './conditions';
import { globMatch } from './glob';
import { type Condition, type Decision, PROXY_METHODS, type Rule, type TraceEntry } from './types';

export interface EvaluationInput {
  /** Verified token claims (raw, never the display form). */
  claims: Claims;
  profile: IssuerProfile;
  /** The token's credential access rule; generic anchor rules come from its anchor_claims. */
  provider: { anchor_claims: string[] };
  /** Request method as received (upper case). */
  method: string;
  /** Canonical path from proxy/path.ts as forwarded upstream (`%2F` kept). */
  path: string;
  /** Canonical match path from proxy/path.ts (`%2F` already turned into `/`). */
  matchPath: string;
  /** Claims whose values may appear in trace details (the profile's log allowlist). */
  revealClaims: ReadonlySet<string>;
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
function pathMatches(pattern: string, path: string): boolean {
  if (!globMatch(pattern, path)) return false;
  if (path.length > 1 && path.endsWith('/') && !pattern.endsWith('/')) {
    return globMatch(pattern, path.slice(0, -1));
  }
  return true;
}

/**
 * Evaluates issuer_access_rules in the given order (created_at, id); the first match wins. Order affects
 * attribution only, because issuer_access_rules are allow-only.
 * Deny code is `event_not_trusted` when some grant would have matched except for the event
 * guard, otherwise `no_matching_grant`.
 */
export function evaluateIssuerAccessRules<
  G extends { id: string; conditions: Condition[]; rules: Rule[] },
>(issuer_access_rules: G[], input: EvaluationInput): Decision<G> {
  const trace: TraceEntry[] = [];
  let blockedOnlyByEventGuard = false;
  const anchorRules = input.profile.anchorRules(input.provider);

  for (const grant of issuer_access_rules) {
    // Save-time validation enforces anchors, but a later provider edit (generic anchor_claims) or
    // a row written around validation can leave a grant unanchored; it must not authorize.
    if (!satisfiesAnchorRule(grant.conditions, anchorRules)) {
      trace.push({
        grant_id: grant.id,
        result: 'invalid_grant',
        detail: "grant does not satisfy the credential access rule's anchor rules (I-AUTHZ-2)",
      });
      continue;
    }

    const failed = firstFailingCondition(grant.conditions, input);
    if (failed !== null) {
      trace.push({ grant_id: grant.id, result: 'condition_failed', detail: failed });
      continue;
    }

    const anyRule = Array.isArray(grant.rules)
      ? grant.rules.some((rule) => ruleMatches(rule, input.method, input))
      : false;

    const guard = eventGuard(grant.conditions, input);
    if (!guard.ok) {
      if (anyRule) blockedOnlyByEventGuard = true;
      const detail = anyRule ? guard.detail : `${guard.detail}; no rule matches either`;
      trace.push({ grant_id: grant.id, result: 'event_not_trusted', detail });
      continue;
    }

    if (!anyRule) {
      trace.push({
        grant_id: grant.id,
        result: 'no_rule',
        detail: `no rule allows ${input.method} ${clip(input.matchPath, 128)}`,
      });
      continue;
    }

    trace.push({ grant_id: grant.id, result: 'matched', detail: '' });
    return { decision: 'allow', grant, trace };
  }

  return {
    decision: 'deny',
    code: blockedOnlyByEventGuard ? 'event_not_trusted' : 'no_matching_grant',
    trace,
  };
}

/**
 * Detail of the first condition that does not hold, or null when all hold. Callers check the
 * anchor rules first, so `conditions` is a non-empty array.
 */
function firstFailingCondition(conditions: Condition[], input: EvaluationInput): string | null {
  for (const [index, condition] of conditions.entries()) {
    const result = evaluateCondition(condition, input.claims, input.revealClaims);
    if (!result.ok) return `condition[${index}] ${result.detail}`;
  }
  return null;
}

/**
 * I-AUTHZ-3. Passes when the profile has no event claim, when the token's event is trusted,
 * or when the grant has a non-negated `exact` condition on the event claim listing that event.
 * A missing or non-scalar event claim fails.
 */
function eventGuard(
  conditions: Condition[],
  input: EvaluationInput,
): { ok: true } | { ok: false; detail: string } {
  const eventClaim = input.profile.eventClaim;
  if (eventClaim === undefined) return { ok: true };

  const event = claimText(input.claims, eventClaim);
  if (event === null) {
    const detail = `${eventClaim}: claim missing or not a string, boolean or safe integer`;
    return { ok: false, detail };
  }
  if (input.profile.trustedEvents.includes(event)) return { ok: true };

  const optedIn = conditions.some(
    (c) =>
      c.claim === eventClaim &&
      c.match === 'exact' &&
      c.negate !== true &&
      c.values.includes(event),
  );
  if (optedIn) return { ok: true };

  const shown = input.revealClaims.has(eventClaim) ? JSON.stringify(clip(event, 64)) : '(hidden)';
  return {
    ok: false,
    detail: `${eventClaim}=${shown} is not trusted; the grant needs an exact ${eventClaim} condition listing it`,
  };
}

/** Upper bound for the serialized trace stored in request_log.eval_trace (docs/architecture.md). */
export const TRACE_MAX_BYTES = 2048;

/** Element of `traceJson` output: a trace entry, or a final marker counting omitted entries. */
export type TraceJsonItem = TraceEntry | { omitted: number };

/**
 * JSON array of trace entries, at most TRACE_MAX_BYTES of UTF-8. Details are clipped; entries
 * that do not fit are dropped and replaced by one final `{"omitted": n}` element.
 * Lone surrogates are replaced first: JSON.stringify writes each as a 6-byte `\uXXXX` escape,
 * which could make even the first entry too large to keep.
 */
export function traceJson(trace: TraceEntry[]): string {
  const encoder = new TextEncoder();
  const markerReserve = encoder.encode(`,${JSON.stringify({ omitted: trace.length })}`).length;
  const parts: string[] = [];
  let bytes = 2; // "[" and "]"
  for (const [index, entry] of trace.entries()) {
    const part = JSON.stringify({
      grant_id: clip(entry.grant_id, 64).toWellFormed(),
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
