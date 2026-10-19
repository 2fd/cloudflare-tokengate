// Proxy pipeline (docs/architecture.md, "Proxy pipeline"): verify the caller token, authorize it against the
// credential and global access rules, swap it for the service credential, stream the upstream response back.
// I-TOK-1/2, I-TEN-1, I-AUTHZ-1, I-AUTHZ-5,
// I-PATH-1, I-INJ-1, I-CRED-2, I-SSRF-1, I-REDIR-1, I-RESP-1, I-LOG-1/2.
import { credentialAad, openCredential } from '../crypto/envelope';
import { loadKeyring } from '../crypto/keyring';
import { loadProxyContext, type ProxyContext } from '../db/proxy-context';
import type { CredentialAccessRule, GlobalAccessRule, Service } from '../db/types';
import type { Deps } from '../deps';
import {
  buildCallerIdentity,
  decodeUnverified,
  headerAcceptable,
  tenantPinHolds,
  type VerifyResult,
  verifyCallerToken,
} from '../identity/jwt';
import { getProfile } from '../identity/profiles';
import type { CallerIdentity, IssuerProfile } from '../identity/types';
import { type GatewayErrorCode, gatewayError } from '../lib/errors';
import { newId } from '../lib/ids';
import {
  credentialRuleDecision,
  globalDecision,
  verificationGroupKey,
} from '../policy/access-rules';
import { claimText } from '../policy/conditions';
import type { RequestFacts } from '../policy/limits';
import type { Injection, TraceEntry } from '../policy/types';
import { PROXY_METHODS } from '../policy/types';
import { normalizeInjection, validateBaseUrl } from '../policy/validate';
import { buildRequestRecord } from '../telemetry/record';
import { admitPretrustRecord, recordRequest } from '../telemetry/sinks';
import { extractCallerToken } from './caller-token';
import { buildUpstreamHeaders, fetchUpstream, filterResponseHeaders } from './forward';
import { injectCredentialHeaders } from './inject';
import { buildUpstreamUrl, canonicalizePath } from './path';

export interface ProxyParams {
  /** Slug segment of `/proxy/<slug>/...`, as it appears in the URL. */
  slug: string;
  /** Pathname after `/proxy/<slug>`, not decoded ("" when absent). */
  rawPath: string;
}

const HINT_MAX_LENGTH = 256;
const EVENT_HINT_MAX_LENGTH = 64;
/** Distinct verification groups (AR-10) and JWKS URIs one request may verify against. */
export const MAX_VERIFY_GROUPS = 8;
export const MAX_JWKS_URIS = 4;

/** Stages of a candidate, in the order the refusal precedence ranks them (AR-14). */
const STAGE = { profile: 0, header: 1, verification: 2, tenant: 3, policy: 4 } as const;
type Stage = (typeof STAGE)[keyof typeof STAGE];

/** What the pipeline learned; becomes the request record. */
interface Progress {
  untrustedIss: string | null;
  /** The credential access rule that matched; on a refusal, the first that passed the tenant gate. */
  rule: CredentialAccessRule | null;
  service: Service | null;
  /** Set only after signature verification AND the tenant pin passed. */
  caller: { identity: CallerIdentity; logClaims: readonly string[] } | null;
  /** The global access rule that held on an allowed call; null when the issuer has none. */
  globalRuleId: string | null;
  trace: TraceEntry[] | null;
  upstream: { status: number; ms: number } | null;
  sampleRate: number;
}

interface Result {
  response: Response;
  /** Machine reason stored in the record; null when the upstream answered. */
  reason: string | null;
}

export async function handleProxy(
  request: Request,
  params: ProxyParams,
  deps: Deps,
): Promise<Response> {
  // Step 1: request id.
  const t0 = deps.now();
  const requestId = newId('req', t0, deps.random);
  const progress: Progress = {
    untrustedIss: null,
    rule: null,
    service: null,
    caller: null,
    globalRuleId: null,
    trace: null,
    upstream: null,
    sampleRate: 1,
  };

  let result: Result;
  try {
    result = await runPipeline(request, params, deps, requestId, progress);
  } catch (error) {
    // Unexpected failure (e.g. D1 unavailable). Only the error name is logged.
    console.error(
      JSON.stringify({ type: 'proxy.internal_error', request_id: requestId, error: nameOf(error) }),
    );
    result = { response: gatewayError('internal_error', requestId), reason: 'internal_error' };
  }

  // Step 16: the record never delays or changes the response.
  scheduleRecord(deps, {
    request,
    params,
    requestId,
    t0,
    durationMs: deps.now() - t0,
    progress,
    result,
  });
  return result.response;
}

async function runPipeline(
  request: Request,
  params: ProxyParams,
  deps: Deps,
  requestId: string,
  progress: Progress,
): Promise<Result> {
  const fail = (
    code: GatewayErrorCode,
    options: { hint?: string; reason?: string; headers?: Record<string, string> } = {},
  ): Result => ({
    response: gatewayError(code, requestId, options),
    reason: options.reason ?? code,
  });

  // Step 2: method allowlist.
  const method = request.method.toUpperCase();
  if (!(PROXY_METHODS as readonly string[]).includes(method)) return fail('method_not_allowed');

  // Step 3. The service's injection header is a token source only when the standard headers are
  // absent, so a missing token is resolved after the service is loaded.
  let extracted = extractCallerToken(request.headers, null);
  if (!extracted.ok && extracted.code !== 'token_missing') return fail(extracted.code);

  // Step 4: control-plane state, one D1 batch (docs/architecture.md, "Query budget"). The issuer of a
  // standard-header token selects the candidate and global rows; that token always wins over the
  // injection header, which is read only when the standard headers carry no token.
  const preIss = extracted.ok ? (decodeUnverified(extracted.token)?.iss ?? null) : null;
  const context = await loadProxyContext(deps.env.DB, params.slug, deps.now(), {
    preIss,
    standard: extracted.ok,
  });
  progress.sampleRate = context.settings.allowed_sample_rate;
  if (!extracted.ok) {
    extracted = extractCallerToken(request.headers, context.service?.injection ?? null);
    if (!extracted.ok) return fail(extracted.code);
  }
  const token = extracted.token;
  const unverified = decodeUnverified(token);
  if (unverified === null) return fail('token_malformed');
  progress.untrustedIss = unverified.iss;
  // The batch read rows for preIss; any other issuer would make "no global row" mean nothing.
  if (preIss !== null && unverified.iss !== preIss) return fail('internal_error');

  // An issuer is a value in each credential access rule. Several rules may trust the same issuer,
  // with different settings and filters; never choose only the first one.
  const iss = unverified.iss;
  const candidates = context.candidateRules
    .filter(
      (rule) =>
        rule.issuer === iss &&
        (context.service === null || rule.credential_id === context.service.id),
    )
    .sort(
      (a, b) =>
        Number(b.credential_id === context.disabledServiceId) -
          Number(a.credential_id === context.disabledServiceId) ||
        a.created_at - b.created_at ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  if (candidates.length === 0)
    return fail('issuer_unknown', {
      hint:
        iss === null
          ? undefined
          : `the token issuer ${JSON.stringify(iss.slice(0, HINT_MAX_LENGTH))} has no credential access rule for this destination`,
    });
  const canonical = canonicalizePath(params.rawPath);
  // Refusal precedence (AR-14): the most advanced stage wins; ties go to the first candidate.
  let best: { stage: number; result: Result } = { stage: -1, result: fail('no_matching_rule') };
  const note = (stage: Stage, result: Result) => {
    if (stage > best.stage) best = { stage, result };
  };
  const verified = new Map<string, VerifyResult>();
  const jwksUris = new Set<string>();
  const trace: TraceEntry[] = [];
  let eventOnly: { hint: string | undefined } | null = null;
  let globalBlocked = false;
  let selected: { rule: CredentialAccessRule; global: GlobalAccessRule | null } | null = null;
  for (const rule of candidates) {
    const profile = getProfile(rule.profile);
    if (!profile) {
      note(STAGE.profile, fail('not_configured', { reason: 'profile_unknown' }));
      continue;
    }
    if (!headerAcceptable(unverified, rule)) {
      note(STAGE.header, fail('token_malformed'));
      continue;
    }
    // Rules with the same settings verify the token once (AR-10); the bounds cap the JWKS fetches
    // and signature checks of rows written around validation.
    const key = verificationGroupKey(rule, profile);
    let result = verified.get(key);
    if (result === undefined) {
      if (
        verified.size >= MAX_VERIFY_GROUPS ||
        (!jwksUris.has(rule.jwks_uri) && jwksUris.size >= MAX_JWKS_URIS)
      ) {
        note(STAGE.verification, fail('jwks_unavailable'));
        continue;
      }
      jwksUris.add(rule.jwks_uri);
      result = await verifyCallerToken(token, rule, profile, deps);
      verified.set(key, result);
    }
    if (!result.ok) {
      note(
        STAGE.verification,
        fail(result.code, {
          hint:
            result.code === 'audience_mismatch'
              ? `the token audience must be ${JSON.stringify(rule.audience)}`
              : undefined,
        }),
      );
      continue;
    }
    const claims = result.claims;
    // The tenant gate is the rule's own pin only (AR-9); a global tenant pin is a policy limit.
    if (!tenantPinHolds(rule, claims)) {
      note(STAGE.tenant, fail('tenant_mismatch'));
      continue;
    }
    const logClaims = profile.logClaimAllowlist(rule);
    // I-TEN-1: the caller learns whether the credential exists only after its own pin held.
    if (progress.rule === null) {
      progress.rule = rule;
      progress.caller = { identity: buildCallerIdentity(rule, profile, claims), logClaims };
    }
    if (context.service === null)
      return fail('service_not_found', {
        reason: context.serviceDisabled ? 'service_disabled' : 'service_not_found',
      });
    progress.service = context.service;
    if (!canonical.ok) return fail('path_invalid');
    const facts: RequestFacts = {
      claims,
      alg: unverified.alg,
      now: deps.now(),
      method,
      path: canonical.path,
      matchPath: canonical.matchPath,
      revealClaims: new Set(logClaims),
    };
    // Stored keys only (AR-3); rows of every state (AR-4); none = the issuer is not limited.
    const globals = context.globalRules.filter((global) => global.issuer_key === rule.issuer_key);
    const own = credentialRuleDecision(rule, profile, facts);
    if (own.result !== 'matched') {
      trace.push({ rule_id: rule.id, result: own.result, detail: own.detail });
      if (
        eventOnly === null &&
        own.result === 'event_not_trusted' &&
        own.rulesMatched &&
        globalDecision(rule, globals, facts).ok
      ) {
        eventOnly = { hint: eventHint(profile, claims) };
      }
      note(STAGE.policy, fail('no_matching_rule'));
      continue;
    }
    const decision = globalDecision(rule, globals, facts);
    if (decision.ok) {
      selected = { rule, global: decision.global };
      break;
    }
    for (const failure of decision.failures) {
      trace.push({
        rule_id: rule.id,
        global_rule_id: failure.global_rule_id,
        result: 'global_blocked',
        detail: failure.detail,
      });
    }
    globalBlocked = true;
    note(STAGE.policy, fail('no_matching_rule'));
  }
  if (selected === null) {
    if (best.stage !== STAGE.policy) return best.result;
    progress.trace = trace;
    if (eventOnly !== null) return fail('event_not_trusted', { hint: eventOnly.hint });
    return fail('no_matching_rule', {
      reason: globalBlocked ? 'outside_global_rules' : 'no_matching_rule',
    });
  }
  if (!canonical.ok) return fail('path_invalid');
  const service = context.service;
  if (service === null) return fail('service_not_found');
  progress.service = service;
  progress.rule = selected.rule;
  progress.globalRuleId = selected.global?.id ?? null;

  // Step 12. A failing limiter binding does not block traffic: it caps blast radius, it does not
  // authorize.
  const limiter = deps.env.PROXY_RATE_LIMITER;
  if (limiter) {
    let allowed = true;
    try {
      allowed = (await limiter.limit({ key: `rule:${selected.rule.id}` })).success;
    } catch (error) {
      console.error(
        JSON.stringify({
          type: 'proxy.rate_limiter_failed',
          request_id: requestId,
          error: nameOf(error),
        }),
      );
    }
    if (!allowed) return fail('rate_limited', { headers: { 'retry-after': '60' } });
  }

  // Step 13. The stored base URL and injection must be exactly what the admin operations write:
  // validated and in normalized/canonical form (I-SSRF-1). The credential only opens with the AAD
  // they form, so a D1-level edit of either fails closed (I-CRED-2).
  if (service.credential_sealed === null) {
    return fail('credential_unavailable', { reason: 'credential_missing' });
  }
  const keyring = await loadKeyring(deps.env);
  if (!keyring.ok) return fail('not_configured', { reason: keyring.error });
  const requestUrl = new URL(request.url);
  if (!storedBaseUrlValid(service.base_url, requestUrl, context)) {
    return fail('not_configured', { reason: 'base_url_invalid' });
  }
  const normalized = normalizeInjection(service.injection);
  if (!normalized.ok || normalized.json !== service.injection_json) {
    return fail('credential_unavailable', { reason: 'injection_invalid' });
  }
  const injection: Injection = normalized.injection;
  let aad: Uint8Array;
  try {
    aad = credentialAad(service.id, service.base_url, service.injection_json);
  } catch {
    return fail('credential_unavailable', { reason: 'credential_binding_mismatch' });
  }
  const opened = await openCredential(keyring.keyring, service.credential_sealed, aad);
  if (!opened.ok) return fail('credential_unavailable', { reason: opened.error });
  const secret = opened.plaintext;

  // Step 14: upstream URL, headers and fetch.
  const built = buildUpstreamUrl({
    baseUrl: service.base_url,
    path: canonical.path,
    search: requestUrl.search,
    injection,
    secret,
  });
  if (!built.ok) {
    // The path is already canonical and the base URL validated, so the failure comes from either
    // the caller's query string or the credential. Rebuilding with a placeholder secret tells
    // them apart without exposing the secret.
    const callerCaused = !buildUpstreamUrl({
      baseUrl: service.base_url,
      path: canonical.path,
      search: requestUrl.search,
      injection,
      secret: 'x',
    }).ok;
    return callerCaused
      ? fail('path_invalid', { reason: 'query_invalid' })
      : fail('credential_unavailable', { reason: 'credential_invalid' });
  }
  // Rebuilt from an allowlist: caller token headers and caller copies of the credential header
  // are never forwarded (I-TOK-1, I-INJ-1).
  const headers = buildUpstreamHeaders(request.headers, {
    forward_headers: service.forward_headers,
    injection,
  });
  try {
    injectCredentialHeaders(headers, injection, secret);
  } catch {
    return fail('credential_unavailable', { reason: 'credential_invalid' });
  }
  const fetched = await fetchUpstream({
    url: built.url,
    method,
    headers,
    body: request.body,
    timeoutMs: service.timeout_ms,
    fetch: deps.fetch,
    now: deps.now,
  });
  if (!fetched.ok) {
    console.warn(
      JSON.stringify({
        type: 'proxy.upstream_failed',
        request_id: requestId,
        code: fetched.code,
        error: fetched.errorName,
      }),
    );
    return fail(fetched.code);
  }
  progress.upstream = { status: fetched.response.status, ms: fetched.upstreamMs };

  // workerd passes through final statuses the Response constructor rejects (1xx, 600+). The
  // upstream already processed the request, so this is a 502 with its own reason, not a 500
  // "retry later". progress.upstream keeps the raw status for the record.
  if (!isForwardableStatus(fetched.response.status)) {
    fetched.response.body?.cancel().catch(() => {});
    console.warn(
      JSON.stringify({
        type: 'proxy.upstream_failed',
        request_id: requestId,
        code: 'upstream_unreachable',
        error: 'InvalidStatus',
      }),
    );
    return fail('upstream_unreachable', {
      reason: 'upstream_invalid_status',
      hint: 'the upstream API returned an invalid HTTP status; it may have processed the request',
    });
  }

  // Step 15. Body streamed through untouched; headers filtered, redirects rewritten or dropped
  // (I-REDIR-1), echoed credentials redacted (I-RESP-1). The upstream reason phrase is not
  // forwarded: it is upstream-controlled text that can echo the credential (I-CRED-1).
  const responseHeaders = filterResponseHeaders(fetched.response.headers, {
    upstreamUrl: built.url,
    baseUrl: service.base_url,
    gatewayProxyBase: `${requestUrl.origin}/proxy/${service.slug}`,
    injection,
    secret,
    requestId,
  });
  return {
    response: new Response(fetched.response.body, {
      status: fetched.response.status,
      headers: responseHeaders,
    }),
    reason: null,
  };
}

/**
 * I-SSRF-1 at request time: the stored base URL passes the save-time rules and is already in the
 * normalized form those rules produce. The gateway's own hosts are excluded: the admin hosts and
 * the host this request reached.
 */
function storedBaseUrlValid(
  baseUrl: string,
  requestUrl: URL,
  context: Pick<ProxyContext, 'adminHosts' | 'allowedUpstreamHosts'>,
): boolean {
  const checked = validateBaseUrl(baseUrl, {
    gatewayHosts: [...(context.adminHosts ?? []), requestUrl.hostname],
    allowedUpstreamHosts: context.allowedUpstreamHosts,
  });
  return checked.ok && checked.normalized === baseUrl;
}

/** Hint for event_not_trusted: may echo the event value only (docs/architecture.md). */
function eventHint(profile: IssuerProfile, claims: Record<string, unknown>): string | undefined {
  const event = profile.eventClaim ? claimText(claims, profile.eventClaim) : null;
  if (event === null) return undefined;
  return `the event ${JSON.stringify(event.slice(0, EVENT_HINT_MAX_LENGTH))} is not trusted by default and needs an explicit opt-in in the credential access rule`;
}

function nameOf(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'Error';
}

// ---------------------------------------------------------------------------------------------
// Step 16: request record.

interface RecordContext {
  request: Request;
  params: ProxyParams;
  requestId: string;
  t0: number;
  durationMs: number;
  progress: Progress;
  result: Result;
}

function scheduleRecord(deps: Deps, ctx: RecordContext): void {
  try {
    const { progress, result } = ctx;
    // 'allowed' means the upstream response was returned; gateway answers are denied or error.
    const status = result.response.status;
    const outcome = result.reason === null ? 'allowed' : status >= 500 ? 'error' : 'denied';

    let weight = 1;
    if (outcome === 'allowed') {
      if (!sampled(progress.sampleRate, deps.random)) return;
      weight = 1 / progress.sampleRate;
    } else if (progress.caller === null && !admitPretrustRecord(deps.now())) {
      return;
    }

    const record = buildRequestRecord({
      requestId: ctx.requestId,
      ts: ctx.t0,
      durationMs: ctx.durationMs,
      request: ctx.request,
      path: ctx.params.rawPath,
      slug: ctx.params.slug,
      outcome,
      reason: result.reason,
      status,
      serviceId: progress.service?.id ?? null,
      credentialAccessRuleId: progress.rule?.id ?? null,
      globalAccessRuleId: progress.globalRuleId,
      untrustedIss: progress.untrustedIss,
      caller: progress.caller
        ? {
            claims: progress.caller.identity.claims,
            display: progress.caller.identity.display,
            logClaims: progress.caller.logClaims,
          }
        : null,
      trace: progress.trace,
      upstream: progress.upstream,
      weight,
    });
    deps.waitUntil(recordRequest(deps, record));
  } catch (error) {
    console.error(
      JSON.stringify({
        type: 'proxy.record_failed',
        request_id: ctx.requestId,
        error: nameOf(error),
      }),
    );
  }
}

/** Keeps an allowed record with probability `rate` (0..1), from 32 random bits. */
function sampled(rate: number, random: Deps['random']): boolean {
  if (rate >= 1) return true;
  if (!(rate > 0)) return false;
  const bytes = random(4);
  const value = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  return value / 2 ** 32 < rate;
}

/** Statuses `new Response()` accepts (Fetch spec "null body status" aside): 200-599. */
function isForwardableStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status <= 599;
}
