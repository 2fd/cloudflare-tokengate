// Proxy pipeline (docs/architecture.md, "Proxy pipeline"): verify the caller token, authorize it against grants, swap
// it for the service credential, stream the upstream response back. I-TOK-1/2, I-TEN-1, I-AUTHZ-1,
// I-PATH-1, I-INJ-1, I-CRED-2, I-SSRF-1, I-REDIR-1, I-RESP-1, I-LOG-1/2.
import { parseConfig } from '../config';
import { credentialAad, openCredential } from '../crypto/envelope';
import { loadKeyring } from '../crypto/keyring';
import { loadProxyContext } from '../db/proxy-context';
import type { CallerProvider, Service } from '../db/types';
import type { Deps } from '../deps';
import {
  buildCallerIdentity,
  decodeUnverified,
  headerAcceptable,
  tenantPinHolds,
  verifyCallerToken,
} from '../identity/jwt';
import { getProfile } from '../identity/profiles';
import type { CallerIdentity, IssuerProfile } from '../identity/types';
import { type GatewayErrorCode, gatewayError } from '../lib/errors';
import { newId } from '../lib/ids';
import { claimText } from '../policy/conditions';
import { evaluateGrants } from '../policy/evaluate';
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

/** What the pipeline learned; becomes the request record. */
interface Progress {
  untrustedIss: string | null;
  provider: CallerProvider | null;
  service: Service | null;
  /** Set only after signature verification AND the tenant pin passed. */
  caller: { identity: CallerIdentity; logClaims: readonly string[] } | null;
  grantId: string | null;
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
    provider: null,
    service: null,
    caller: null,
    grantId: null,
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

  // Step 4: control-plane state, one D1 batch.
  const context = await loadProxyContext(deps.env.DB, params.slug, deps.now());
  progress.sampleRate = context.settings.allowed_sample_rate;
  if (!extracted.ok) {
    extracted = extractCallerToken(request.headers, context.service?.injection ?? null);
    if (!extracted.ok) return fail(extracted.code);
  }
  const token = extracted.token;
  const unverified = decodeUnverified(token);
  if (unverified === null) return fail('token_malformed');
  progress.untrustedIss = unverified.iss;

  // Step 5. `iss` is untrusted here: it only selects which caller provider verifies the token.
  const provider = context.callerProviders.find((p) => p.issuer === unverified.iss);
  if (provider === undefined) {
    const hint =
      unverified.iss === null
        ? undefined
        : `the token issuer ${JSON.stringify(unverified.iss.slice(0, HINT_MAX_LENGTH))} is not a configured caller provider`;
    return fail('issuer_unknown', { hint });
  }
  progress.provider = provider;
  const profile = getProfile(provider.profile);
  if (profile === null) return fail('not_configured', { reason: 'profile_unknown' });

  // Step 6: unverified header (alg, kid) against the provider.
  if (!headerAcceptable(unverified, provider)) return fail('token_malformed');

  // Step 7: signature, issuer, audience, age and required claims.
  const verified = await verifyCallerToken(token, provider, profile, deps);
  if (!verified.ok) {
    const hint =
      verified.code === 'audience_mismatch'
        ? `the token audience must be ${JSON.stringify(provider.audience)}`
        : undefined;
    return fail(verified.code, { hint });
  }

  // Step 8. Caller claims are recorded only once the tenant pin holds (I-TEN-1, I-LOG-2).
  if (!tenantPinHolds(provider, verified.claims)) return fail('tenant_mismatch');
  const logClaims = profile.logClaimAllowlist(provider);
  progress.caller = {
    identity: buildCallerIdentity(provider, profile, verified.claims),
    logClaims,
  };

  // Step 9. Only now may the caller learn whether the service exists (I-TEN-1).
  const service = context.service;
  if (service === null) {
    return fail('service_not_found', {
      reason: context.serviceDisabled ? 'service_disabled' : 'service_not_found',
    });
  }
  progress.service = service;

  // Step 10: canonical path (I-PATH-1).
  const canonical = canonicalizePath(params.rawPath);
  if (!canonical.ok) return fail('path_invalid');

  // Step 11: grant evaluation (I-AUTHZ-1).
  const decision = evaluateGrants(
    context.grants.filter((grant) => grant.caller_provider_id === provider.id),
    {
      claims: verified.claims,
      profile,
      provider,
      method,
      path: canonical.path,
      matchPath: canonical.matchPath,
      revealClaims: new Set(logClaims),
    },
  );
  if (decision.decision === 'deny') {
    progress.trace = decision.trace;
    return fail(decision.code, {
      hint: decision.code === 'event_not_trusted' ? eventHint(profile, verified.claims) : undefined,
    });
  }
  progress.grantId = decision.grant.id;

  // Step 12. A failing limiter binding does not block traffic: it caps blast radius, it does not
  // authorize.
  const limiter = deps.env.PROXY_RATE_LIMITER;
  if (limiter) {
    let allowed = true;
    try {
      allowed = (await limiter.limit({ key: `grant:${decision.grant.id}` })).success;
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
  if (!storedBaseUrlValid(service.base_url, deps, requestUrl)) {
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
 * normalized form those rules produce. The gateway's own host is excluded both as configured
 * (PUBLIC_URL) and as reached by this request, when they differ.
 */
function storedBaseUrlValid(baseUrl: string, deps: Deps, requestUrl: URL): boolean {
  const config = parseConfig(deps.env);
  const ownHosts = new Set([config.publicUrl?.host ?? requestUrl.host, requestUrl.host]);
  return [...ownHosts].every((publicHost) => {
    const checked = validateBaseUrl(baseUrl, {
      publicHost,
      allowedUpstreamHosts: config.allowedUpstreamHosts,
    });
    return checked.ok && checked.normalized === baseUrl;
  });
}

/** Hint for event_not_trusted: may echo the event value only (docs/architecture.md). */
function eventHint(profile: IssuerProfile, claims: Record<string, unknown>): string | undefined {
  const event = profile.eventClaim ? claimText(claims, profile.eventClaim) : null;
  if (event === null) return undefined;
  return `the event ${JSON.stringify(event.slice(0, EVENT_HINT_MAX_LENGTH))} is not trusted by default and needs an explicit opt-in in the grant`;
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
      callerProviderId: progress.provider?.id ?? null,
      grantId: progress.grantId,
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
