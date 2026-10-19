// Builds and validates request records, redacted by construction (I-LOG-1, I-LOG-2): allowlisted
// claims only, and only for verified, tenant-pinned callers; the only request headers copied are
// cf-connecting-ip and, for verified callers, user-agent.
import type { CallerDisplay, Claims } from '../identity/types';
import { traceJson } from '../policy/access-rules';
import { claimText } from '../policy/conditions';
import type { TraceEntry } from '../policy/types';
import type { Outcome, RequestRecord } from './types';

/** Maximum length (UTF-16 code units) of each text column; longer values are cut. */
export const RECORD_TEXT_LIMITS = {
  reason: 64,
  method: 16,
  path: 1024,
  service_slug: 64,
  service_id: 64,
  credential_access_rule_id: 64,
  global_access_rule_id: 64,
  caller_subject: 256,
  caller_repository: 256,
  caller_claims: 8192,
  jti: 128,
  untrusted_iss: 256,
  eval_trace: 2048,
  ip: 64,
  user_agent: 256,
  colo: 16,
} as const satisfies Partial<Record<keyof RequestRecord, number>>;

/**
 * Tighter limits for pre-trust records (no verified, tenant-pinned caller). Anyone on the internet
 * can produce them, so they keep less attacker-chosen text, and no user-agent at all.
 */
export const PRETRUST_TEXT_LIMITS = {
  path: 256,
  untrusted_iss: 128,
} as const satisfies Partial<Record<keyof typeof RECORD_TEXT_LIMITS, number>>;

const CLAIM_VALUE_MAX_LENGTH = 256;

export interface RequestRecordInput {
  requestId: string;
  /** Request start (ms). */
  ts: number;
  /** Request start to response headers (ms). */
  durationMs: number;
  /** Source of method, user-agent, cf-connecting-ip and cf.colo. Nothing else is read. */
  request: Request;
  /** Path after /proxy/<slug>, without query. */
  path: string;
  /** Slug from the URL (the service may not exist). */
  slug: string;
  outcome: Outcome;
  reason: string | null;
  /** Status returned to the caller. */
  status: number;
  serviceId: string | null;
  credentialAccessRuleId: string | null;
  globalAccessRuleId: string | null;
  /** `iss` read from an unverified token; stored only when `caller` is null. */
  untrustedIss: string | null;
  /** Verified and tenant-pinned caller. Null for every pre-trust failure (I-LOG-2). */
  caller: {
    claims: Claims;
    display: CallerDisplay;
    /** The profile's log allowlist for this credential access rule (I-LOG-1). */
    logClaims: readonly string[];
  } | null;
  /** Policy trace, for requests denied by authorization. */
  trace: TraceEntry[] | null;
  upstream: { status: number; ms: number } | null;
  /** 1 / sample rate for allowed records, 1 otherwise. */
  weight: number;
}

export function buildRequestRecord(input: RequestRecordInput): RequestRecord {
  const { caller, request } = input;
  const cf = request.cf as { colo?: unknown } | undefined;
  return {
    id: input.requestId,
    ts: input.ts,
    outcome: input.outcome,
    reason: text(input.reason, 'reason'),
    status: input.status,
    upstream_status: input.upstream?.status ?? null,
    method: text(request.method, 'method') ?? '',
    path: clip(
      input.path === '' ? '/' : input.path,
      caller ? RECORD_TEXT_LIMITS.path : PRETRUST_TEXT_LIMITS.path,
    ),
    service_slug: text(input.slug, 'service_slug'),
    service_id: text(input.serviceId, 'service_id'),
    credential_access_rule_id: text(input.credentialAccessRuleId, 'credential_access_rule_id'),
    global_access_rule_id: text(input.globalAccessRuleId, 'global_access_rule_id'),
    claims_verified: caller ? 1 : 0,
    caller_subject: caller ? text(caller.display.subject || null, 'caller_subject') : null,
    caller_repository: caller ? text(caller.display.repository ?? null, 'caller_repository') : null,
    caller_claims: caller ? allowlistedClaimsJson(caller.claims, caller.logClaims) : null,
    jti: caller ? text(claimText(caller.claims, 'jti'), 'jti') : null,
    untrusted_iss:
      caller || input.untrustedIss === null
        ? null
        : clip(input.untrustedIss, PRETRUST_TEXT_LIMITS.untrusted_iss),
    eval_trace: input.trace ? traceJson(input.trace) : null,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    upstream_ms: input.upstream ? Math.max(0, Math.round(input.upstream.ms)) : null,
    weight: input.weight,
    ip: text(request.headers.get('cf-connecting-ip'), 'ip'),
    user_agent: caller ? text(request.headers.get('user-agent'), 'user_agent') : null,
    colo: text(typeof cf?.colo === 'string' ? cf.colo : null, 'colo'),
  };
}

/**
 * JSON object of the allowlisted claims that are strings, booleans or safe integers (the same
 * scalar rule as conditions). Claims that would push the JSON past its column limit are omitted.
 */
function allowlistedClaimsJson(claims: Claims, allowlist: readonly string[]): string {
  // No prototype: a claim named "__proto__" is stored as data like any other allowlisted name.
  const out: Record<string, string | number | boolean> = Object.create(null);
  let json = '{}';
  for (const name of allowlist) {
    if (!Object.hasOwn(claims, name) || Object.hasOwn(out, name)) continue;
    const value = claims[name];
    if (claimText(claims, name) === null) continue;
    out[name] =
      typeof value === 'string' ? clip(value, CLAIM_VALUE_MAX_LENGTH) : (value as number | boolean);
    const next = JSON.stringify(out);
    if (next.length > RECORD_TEXT_LIMITS.caller_claims) {
      delete out[name];
      continue;
    }
    json = next;
  }
  return json;
}

function text(value: string | null, column: keyof typeof RECORD_TEXT_LIMITS): string | null {
  return value === null ? null : clip(value, RECORD_TEXT_LIMITS[column]);
}

/** Cuts to `max` code units and replaces lone surrogates, so the value is valid UTF-8 text. */
function clip(value: string, max: number): string {
  return (value.length > max ? value.slice(0, max) : value).toWellFormed();
}

// ---------------------------------------------------------------------------------------------
// Validation of records received from the queue (or any other untrusted transport).

const REQUEST_ID = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;
const OUTCOMES: readonly string[] = ['allowed', 'denied', 'error'];

/** True when `value` has every RequestRecord column with the right type and within limits. */
export function isRequestRecord(value: unknown): value is RequestRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string' || !REQUEST_ID.test(r.id)) return false;
  if (typeof r.outcome !== 'string' || !OUTCOMES.includes(r.outcome)) return false;
  if (r.claims_verified !== 0 && r.claims_verified !== 1) return false;
  if (typeof r.method !== 'string' || typeof r.path !== 'string') return false;
  if (!isCount(r.ts) || !isCount(r.duration_ms)) return false;
  if (!isStatus(r.status)) return false;
  // Any status fetch can report: workerd parses the status line into an int32, so a raw upstream
  // can yield 1000, 42, 0 or a negative value (`HTTP/1.1 4294967295` gives -1). The record of a 502
  // upstream_invalid_status keeps it (docs/errors.md); int32 is also the archive schema type.
  if (r.upstream_status !== null && !isInt32(r.upstream_status)) return false;
  if (r.upstream_ms !== null && !isCount(r.upstream_ms)) return false;
  if (typeof r.weight !== 'number' || !Number.isFinite(r.weight) || r.weight <= 0) return false;
  for (const [column, max] of Object.entries(RECORD_TEXT_LIMITS)) {
    const field = r[column];
    if (column === 'method' || column === 'path') {
      if ((field as string).length > max) return false;
    } else if (field !== null && (typeof field !== 'string' || field.length > max)) {
      return false;
    }
  }
  return true;
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isStatus(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 999;
}

function isInt32(value: unknown): boolean {
  return (
    Number.isInteger(value) && (value as number) >= -0x8000_0000 && (value as number) <= 0x7fff_ffff
  );
}
