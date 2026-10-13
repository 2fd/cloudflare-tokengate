// Outbound request headers, the upstream fetch and upstream response header filtering
// (I-TOK-1, I-INJ-1, I-REDIR-1, I-RESP-1, I-CRED-1). Bodies are never read or buffered here.
import type { Service } from '../db/types';
import type { Injection } from '../policy/types';
import { headerListed, NEVER_FORWARD, REQUEST_ALLOWLIST, RESPONSE_DROP } from './headers';
import { findSecretRanges, injectedHeaderName, secretVariants } from './inject';
import { canonicalizePath, credentialPathSegment, parseBaseUrl, removeQueryParam } from './path';

/**
 * Builds outbound headers from a fresh `Headers`: REQUEST_ALLOWLIST + service.forward_headers,
 * minus NEVER_FORWARD and minus the header the credential is injected into, so caller tokens
 * and caller copies of the credential header are never forwarded.
 */
export function buildUpstreamHeaders(
  incoming: Headers,
  service: Pick<Service, 'forward_headers' | 'injection'>,
): Headers {
  const injected = injectedHeaderName(service.injection);
  const names = new Set([
    ...REQUEST_ALLOWLIST,
    ...service.forward_headers.map((name) => name.toLowerCase()),
  ]);
  const outbound = new Headers();
  for (const name of names) {
    if (headerListed(NEVER_FORWARD, name) || name === injected) continue;
    const value = incoming.get(name);
    if (value !== null) outbound.set(name, value);
  }
  return outbound;
}

export interface ResponseContext {
  /** The URL that was fetched (includes the credential for `path`/`query` injection). */
  upstreamUrl: URL;
  /** Normalized service base URL. */
  baseUrl: string;
  /** Absolute gateway URL that maps to the base URL, e.g. `https://gw.example/proxy/slack`. */
  gatewayProxyBase: string;
  injection: Injection;
  secret: string;
  requestId: string;
}

type UrlRewrite = { action: 'pass' | 'rewrite'; value: string } | { action: 'drop' };

/**
 * Maps a URL from an upstream response (Location, Link) to what the caller sees:
 * - same origin and under base path (+ credential segment): `rewrite` to the gateway URL, with
 *   the credential segment and injected query parameter removed;
 * - other http(s) origin: `pass` as an absolute URL (the gateway never follows it);
 * - anything else (same origin outside base, other schemes, unparsable): `drop`.
 */
function mapUpstreamUrl(raw: string, ctx: ResponseContext): UrlRewrite {
  const base = parseBaseUrl(ctx.baseUrl);
  const segment = credentialPathSegment(ctx.injection, ctx.secret);
  if (base === null || segment === null) return { action: 'drop' };

  let target: URL;
  try {
    target = new URL(raw, ctx.upstreamUrl);
  } catch {
    return { action: 'drop' };
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return { action: 'drop' };
  if (target.origin !== base.origin) return { action: 'pass', value: target.href };

  const scope = base.path + segment;
  let rest: string;
  if (target.pathname === scope) rest = '/';
  else if (target.pathname.startsWith(`${scope}/`)) rest = target.pathname.slice(scope.length);
  else return { action: 'drop' };
  if (!canonicalizePath(rest).ok) return { action: 'drop' };

  let search = target.search;
  if (ctx.injection.kind === 'query') {
    const stripped = removeQueryParam(search, ctx.injection.param);
    if (stripped === null) return { action: 'drop' };
    search = stripped;
  }
  const gateway = ctx.gatewayProxyBase.replace(/\/+$/, '');
  return { action: 'rewrite', value: gateway + rest + search + target.hash };
}

interface LinkValue {
  uri: string;
  /** Raw parameters including the leading ";", or "". */
  params: string;
}

/** Splits an RFC 8288 Link header into link-values; null when malformed. */
export function parseLinkHeader(header: string): LinkValue[] | null {
  const values: LinkValue[] = [];
  let i = 0;
  while (i < header.length) {
    const char = header[i];
    if (char === ',' || char === ' ' || char === '\t') {
      i++;
      continue;
    }
    if (char !== '<') return null;
    const close = header.indexOf('>', i + 1);
    if (close === -1) return null;
    const uri = header.slice(i + 1, close);
    i = close + 1;
    const paramsStart = i;
    let inQuotes = false;
    for (; i < header.length; i++) {
      const c = header[i];
      if (inQuotes) {
        if (c === '\\') i++;
        else if (c === '"') inQuotes = false;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') break;
    }
    if (inQuotes) return null;
    const params = header.slice(paramsStart, i).trim();
    if (params !== '' && !params.startsWith(';')) return null;
    values.push({ uri, params });
  }
  return values;
}

/**
 * Keeps only link-values that rewrite to the gateway; values outside base, including other
 * origins, are removed (docs/architecture.md). A malformed header is dropped whole.
 */
function rewriteLinkHeader(header: string, ctx: ResponseContext): string | null {
  const values = parseLinkHeader(header);
  if (values === null) return null;
  const kept: string[] = [];
  for (const { uri, params } of values) {
    const mapped = mapUpstreamUrl(uri, ctx);
    if (mapped.action !== 'rewrite') continue;
    kept.push(params === '' ? `<${mapped.value}>` : `<${mapped.value}>${params}`);
  }
  return kept.length === 0 ? null : kept.join(', ');
}

/**
 * Filters upstream response headers in order: drop RESPONSE_DROP; rewrite or drop Location and
 * Link; drop any header whose value contains the credential in any encoding findSecretRanges
 * recognizes (listed in `x-tokengate-redacted`); then set cache-control no-store,
 * x-tokengate-source and x-tokengate-request-id.
 */
export function filterResponseHeaders(upstream: Headers, ctx: ResponseContext): Headers {
  const variants = secretVariants(ctx.injection, ctx.secret);
  const holdsSecret = (value: string) => findSecretRanges(value, variants).length > 0;
  const filtered = new Headers();
  const redacted: string[] = [];
  for (const [name, value] of upstream) {
    if (headerListed(RESPONSE_DROP, name) || name === 'cache-control') continue;
    if (name === 'location') {
      const mapped = mapUpstreamUrl(value, ctx);
      if (mapped.action === 'drop') filtered.set('x-tokengate-redirect-blocked', '1');
      // I-RESP-1: URL parsing re-serializes a cross-origin value (e.g. removes `.`/`..` segments),
      // which can hide an echoed credential from the check below, so it is checked as sent.
      else if (mapped.action === 'pass' && holdsSecret(value)) redacted.push('location');
      else filtered.set('location', mapped.value);
      continue;
    }
    if (name === 'link') {
      const rewritten = rewriteLinkHeader(value, ctx);
      if (rewritten !== null) filtered.set('link', rewritten);
      continue;
    }
    filtered.set(name, value);
  }

  for (const [name, value] of [...filtered]) {
    if (holdsSecret(value)) {
      filtered.delete(name);
      redacted.push(name);
    }
  }
  if (redacted.length > 0) filtered.set('x-tokengate-redacted', redacted.join(', '));

  filtered.set('cache-control', 'no-store');
  filtered.set('x-tokengate-source', 'upstream');
  filtered.set('x-tokengate-request-id', ctx.requestId);
  return filtered;
}

export interface FetchUpstreamInput {
  url: URL;
  method: string;
  headers: Headers;
  body: ReadableStream | null;
  /** Limit on the time until response headers arrive; the body is never timed. */
  timeoutMs: number;
  fetch: typeof fetch;
  /** Clock for `upstreamMs`; defaults to `performance.now`. */
  now?: () => number;
}

export type FetchUpstreamResult =
  | { ok: true; response: Response; upstreamMs: number }
  | { ok: false; code: 'upstream_timeout' | 'upstream_unreachable'; errorName: string };

/** Error names are reported; messages are not, since they can contain URLs or the credential. */
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function errorName(error: unknown): string {
  const name = error instanceof Error || error instanceof DOMException ? error.name : null;
  return name !== null && SAFE_ERROR_NAME.test(name) ? name : 'Error';
}

/**
 * Sends the request with `redirect: 'manual'` (redirects are returned, never followed, so the
 * credential cannot travel to another host). The timeout aborts only while waiting for headers
 * and is cleared once they arrive. GET and HEAD never send a body.
 */
export async function fetchUpstream(input: FetchUpstreamInput): Promise<FetchUpstreamResult> {
  const now = input.now ?? (() => performance.now());
  const method = input.method.toUpperCase();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);

  const started = now();
  try {
    const response = await input.fetch(input.url.href, {
      method,
      headers: input.headers,
      body: method === 'GET' || method === 'HEAD' ? null : input.body,
      redirect: 'manual',
      signal: controller.signal,
    });
    return { ok: true, response, upstreamMs: Math.max(0, Math.round(now() - started)) };
  } catch (error) {
    return {
      ok: false,
      code: timedOut ? 'upstream_timeout' : 'upstream_unreachable',
      errorName: errorName(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
