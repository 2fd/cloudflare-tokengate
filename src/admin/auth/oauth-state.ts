// Pending OAuth/OIDC logins kept only in the browser, in one `__Host-` HttpOnly SameSite=Lax cookie
// holding up to OAUTH_PENDING_MAX entries keyed by `state` (I-OAUTH-1). Other sites can neither
// read nor set it, so the callback's `state` must come from the browser that started the login. A
// callback consumes only the entry whose state it returns; an unknown or missing state changes
// nothing, so concurrent logins (two tabs) and forged callbacks do not cancel each other.
import { timingSafeEqualString } from '../../crypto/hash';
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from '../../lib/encoding';
import { parseJson } from '../../lib/json';

export const OAUTH_COOKIE = '__Host-tokengate_oauth';
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** Logins that can be in progress at once in one browser; the oldest is dropped first. */
export const OAUTH_PENDING_MAX = 3;
/**
 * Largest cookie value written. Browsers guarantee only 4096 bytes per cookie, name included, and
 * drop larger ones (https://www.rfc-editor.org/rfc/rfc6265#section-6.1). return_to is at most
 * RETURN_TO_MAX characters with no JSON escapes (sanitizeReturnTo), so OAUTH_PENDING_MAX entries
 * encode to at most about 3 KB and the entry cap, not this size cap, decides which entry is dropped.
 */
export const OAUTH_COOKIE_VALUE_MAX = 3800;

export interface PendingLogin {
  state: string;
  code_verifier: string;
  nonce: string;
  /** Already sanitized at /start; sanitized again at the callback. */
  return_to: string;
  login_provider: 'github' | 'oidc';
  expires_at: number;
}

/** Cookie value: base64url(JSON array), so it needs no cookie escaping. */
export function encodePendingLogins(pending: PendingLogin[]): string {
  return toBase64Url(utf8(JSON.stringify(pending)));
}

/**
 * The pending logins in a cookie value, oldest first. Absent or malformed values yield [];
 * malformed entries are skipped; at most OAUTH_PENDING_MAX (newest) are read. Never throws.
 */
export function decodePendingLogins(raw: string | null | undefined): PendingLogin[] {
  if (typeof raw !== 'string' || raw === '') return [];
  let value: unknown;
  try {
    value = parseJson(fromUtf8(fromBase64Url(raw)));
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .slice(-OAUTH_PENDING_MAX)
    .map(pendingLoginOf)
    .filter((entry): entry is PendingLogin => entry !== null);
}

/**
 * `pending` with `entry` appended: expired entries removed, then the oldest dropped until at most
 * OAUTH_PENDING_MAX remain and the encoded value fits OAUTH_COOKIE_VALUE_MAX. `entry` is kept.
 */
export function addPendingLogin(
  pending: PendingLogin[],
  entry: PendingLogin,
  now: number,
): PendingLogin[] {
  let out = [...pending.filter((p) => p.expires_at > now), entry].slice(-OAUTH_PENDING_MAX);
  while (out.length > 1 && encodePendingLogins(out).length > OAUTH_COOKIE_VALUE_MAX) {
    out = out.slice(1);
  }
  return out;
}

/**
 * The entry whose `state` equals `state` (constant-time comparison against every entry), and the
 * entries to keep: all others except expired ones. null when no entry matches, in which case the
 * caller must leave the cookie unchanged. The match is returned even if expired; the caller
 * checks expiry and login provider.
 */
export async function takePendingLogin(
  pending: PendingLogin[],
  state: string,
  now: number,
): Promise<{ match: PendingLogin; rest: PendingLogin[] } | null> {
  let match: PendingLogin | null = null;
  const rest: PendingLogin[] = [];
  for (const entry of pending) {
    if ((await timingSafeEqualString(entry.state, state)) && match === null) match = entry;
    else if (entry.expires_at > now) rest.push(entry);
  }
  return match === null ? null : { match, rest };
}

function pendingLoginOf(value: unknown): PendingLogin | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const strings = ['state', 'code_verifier', 'nonce', 'return_to'] as const;
  if (!strings.every((key) => typeof v[key] === 'string' && v[key] !== '')) return null;
  if (v.login_provider !== 'github' && v.login_provider !== 'oidc') return null;
  if (typeof v.expires_at !== 'number' || !Number.isFinite(v.expires_at)) return null;
  return {
    state: v.state as string,
    code_verifier: v.code_verifier as string,
    nonce: v.nonce as string,
    return_to: v.return_to as string,
    login_provider: v.login_provider,
    expires_at: v.expires_at,
  };
}
