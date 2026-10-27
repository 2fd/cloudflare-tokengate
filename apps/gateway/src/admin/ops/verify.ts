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

/** What the check reads about the credential's owner: `slack-bot` is the bot behind a Slack token. */
export type VerifyIdentity = 'slack-bot';

/** Result of calling a service's verify check with a credential. */
export interface VerifyOutcome {
  /** Upstream HTTP status, or null when no response arrived. */
  status: number | null;
  passed: boolean;
  /** At most VERIFY_PREVIEW_BYTES of the response body, every encoding of the credential masked. */
  bodyPreview: string;
  /** Display name of the credential's owner (the Slack bot name), when the check reads one. */
  identity: string | null;
  /** Admin-facing reason when the check did not pass. */
  error: string | null;
}

/**
 * Calls `verify` on the upstream with `secret`, using the proxy primitives (same URL building,
 * injection and redirect handling as proxied requests). Never throws; never returns the secret.
 */
export async function runVerifyCheck(
  deps: Pick<Deps, 'fetch' | 'now'>,
  target: {
    base_url: string;
    injection: Injection;
    timeout_ms: number;
    verify: VerifyCheck;
    identity?: VerifyIdentity | null;
  },
  secret: string,
): Promise<VerifyOutcome> {
  const failed = (error: string): VerifyOutcome => ({
    status: null,
    passed: false,
    bodyPreview: '',
    identity: null,
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
    identity:
      error === null && target.identity === 'slack-bot'
        ? await slackBotName(deps, { ...target, headers, timeoutMs }, secret, body)
        : null,
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
 * The Slack bot's display name: auth.test gives the bot user's name and the bot id; bots.info
 * (needs the users:read scope) gives the name shown in Slack. Falls back to the user name.
 * https://docs.slack.dev/reference/methods/auth.test https://docs.slack.dev/reference/methods/bots.info
 */
async function slackBotName(
  deps: Pick<Deps, 'fetch' | 'now'>,
  target: { base_url: string; injection: Injection; headers: Headers; timeoutMs: number },
  secret: string,
  authTest: string,
): Promise<string | null> {
  const auth = jsonObject(authTest);
  const user = displayName(auth?.user);
  const botId = typeof auth?.bot_id === 'string' ? auth.bot_id : null;
  if (botId === null || !/^B[A-Z0-9]{2,30}$/.test(botId)) return user;
  const url = buildUpstreamUrl({
    baseUrl: target.base_url,
    path: '/bots.info',
    search: `?bot=${botId}`,
    injection: target.injection,
    secret,
  });
  if (!url.ok) return user;
  const result = await fetchUpstream({
    url: url.url,
    method: 'GET',
    headers: target.headers,
    body: null,
    timeoutMs: target.timeoutMs,
    fetch: deps.fetch,
    now: deps.now,
  });
  if (!result.ok || result.response.status !== 200) return user;
  const info = jsonObject(
    await readBodyPrefix(result.response, VERIFY_READ_LIMIT_BYTES, target.timeoutMs),
  );
  const bot = info?.ok === true ? jsonObject(info.bot) : null;
  return displayName(bot?.name) ?? user;
}

/** A name fit for the credential name: printable, trimmed, at most 100 characters. */
function displayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, 100)
    .trim();
  return name === '' ? null : name;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
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
