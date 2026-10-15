// Credential check run when a credential is saved or tested from the admin UI. Uses the proxy
// primitives (URL building, injection, redirect: 'manual', header timeout) so the check exercises
// the same path as proxied calls. Results never contain the credential (I-CRED-1).
import type { Deps } from '../../deps';
import type { Injection, VerifyCheck } from '../../policy/types';
import { fetchUpstream } from '../../proxy/forward';
import { findSecretRanges, injectCredentialHeaders, secretVariants } from '../../proxy/inject';
import { buildUpstreamUrl } from '../../proxy/path';

/** Verify checks run inside an admin request, so they get a shorter limit than proxied calls. */
export const VERIFY_TIMEOUT_MS = 10_000;
export const VERIFY_PREVIEW_BYTES = 200;
const VERIFY_READ_LIMIT_BYTES = 64 * 1024;
const VERIFY_USER_AGENT = 'cloudflare-tokengate-verify';
const MASK = '[credential]';

/** Result of calling a service's verify check with a credential. */
export interface VerifyOutcome {
  /** Upstream HTTP status, or null when no response arrived. */
  status: number | null;
  passed: boolean;
  /** At most VERIFY_PREVIEW_BYTES of the response body, every encoding of the credential masked. */
  bodyPreview: string;
  /** Token expiry reported by GitHub (`github-authentication-token-expiration`), ms. */
  expiresAt: number | null;
  /** Admin-facing reason when the check did not pass. */
  error: string | null;
}

/**
 * Calls `verify` on the upstream with `secret`, using the proxy primitives (same URL building,
 * injection and redirect handling as proxied requests). Never throws; never returns the secret.
 */
export async function runVerifyCheck(
  deps: Pick<Deps, 'fetch' | 'now'>,
  target: { base_url: string; injection: Injection; timeout_ms: number; verify: VerifyCheck },
  secret: string,
): Promise<VerifyOutcome> {
  const failed = (error: string): VerifyOutcome => ({
    status: null,
    passed: false,
    bodyPreview: '',
    expiresAt: null,
    error,
  });
  const { verify, injection } = target;
  const url = buildUpstreamUrl({
    baseUrl: target.base_url,
    path: verify.path,
    search: '',
    injection,
    secret,
  });
  if (!url.ok) return failed('the verify path and credential do not form a valid upstream URL');
  // Bounds the wait for headers and, separately, for the body.
  const timeoutMs = Math.min(target.timeout_ms, VERIFY_TIMEOUT_MS);
  const headers = new Headers({ accept: 'application/json', 'user-agent': VERIFY_USER_AGENT });
  try {
    // Template check headers (validated: never reserved, never the injected one) go first, so the
    // credential injected next always wins.
    for (const [name, value] of Object.entries(verify.headers ?? {})) headers.set(name, value);
    injectCredentialHeaders(headers, injection, secret);
  } catch {
    return failed('the credential is not a valid header value');
  }

  const result = await fetchUpstream({
    url: url.url,
    method: verify.method,
    headers,
    body: null,
    timeoutMs,
    fetch: deps.fetch,
    now: deps.now,
  });
  if (!result.ok) {
    return failed(
      result.code === 'upstream_timeout'
        ? 'the upstream did not respond in time'
        : `the upstream could not be reached (${result.errorName})`,
    );
  }

  const { response } = result;
  const body = await readBodyPrefix(response, VERIFY_READ_LIMIT_BYTES, timeoutMs);
  const statusOk = response.status === verify.expect_status;
  const okFieldOk = verify.expect_ok_field === true ? jsonOkField(body) : true;
  let error: string | null = null;
  if (!statusOk) error = `expected HTTP ${verify.expect_status}, got ${response.status}`;
  else if (!okFieldOk) error = 'the response body does not contain "ok": true';
  return {
    status: response.status,
    passed: error === null,
    bodyPreview: truncateUtf8(maskSecret(body, injection, secret), VERIFY_PREVIEW_BYTES),
    expiresAt: parseGithubTokenExpiration(
      response.headers.get('github-authentication-token-expiration'),
    ),
    error,
  };
}

/**
 * Replaces every encoding of the secret the proxy redacts in headers (secretVariants, matched
 * through percent-encoding by findSecretRanges), plus the forms those take inside JSON strings:
 * `\"`/`\\` escapes, `\/` (PHP, Slack) and `\uXXXX` escapes of `<>&'` (Go's encoding/json:
 * https://pkg.go.dev/encoding/json#Marshal).
 */
export function maskSecret(text: string, injection: Injection, secret: string): string {
  const variants = new Set<string>();
  for (const variant of secretVariants(injection, secret)) {
    const json = JSON.stringify(variant).slice(1, -1);
    const unicode = json.replace(
      /[<>&']/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    for (const form of [variant, json, unicode]) {
      variants.add(form);
      variants.add(form.replaceAll('/', '\\/'));
    }
  }
  // Overlapping matches are merged, so a variant that contains another is masked whole.
  let out = '';
  let cursor = 0;
  for (const [start, end] of findSecretRanges(text, [...variants])) {
    out += text.slice(cursor, start) + MASK;
    cursor = end;
  }
  return out + text.slice(cursor);
}

/**
 * Parses GitHub's token expiry header, e.g. "2026-11-30 18:00:00 UTC" or "… -0800".
 * https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api
 */
export function parseGithubTokenExpiration(value: string | null): number | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) (UTC|[+-]\d{4})$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const zone = match[7] as string;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  // Date.UTC rolls over out-of-range days (Feb 30 -> Mar 2); reject those.
  const date = new Date(utc);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (zone === 'UTC') return utc;
  const sign = zone.startsWith('-') ? -1 : 1;
  const offsetMinutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5));
  return utc - sign * offsetMinutes * 60_000;
}

/**
 * Reads at most `limit` bytes of the body as text, waiting at most `timeoutMs` (the header
 * timeout does not cover the body), then cancels the rest.
 */
async function readBodyPrefix(
  response: Response,
  limit: number,
  timeoutMs: number,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  let text = '';
  let read = 0;
  try {
    while (read < limit) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === null || next.done) break;
      const chunk = next.value.subarray(0, limit - read);
      read += chunk.length;
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  } catch {
    // A body that fails mid-stream still yields what was read.
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  return text;
}

function jsonOkField(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      typeof parsed === 'object' && parsed !== null && (parsed as { ok?: unknown }).ok === true
    );
  } catch {
    return false;
  }
}

/** Cuts `text` to at most `maxBytes` of UTF-8 without splitting a character. */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}
