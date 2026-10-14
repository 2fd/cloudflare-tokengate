// Cross-site request forgery defense for unsafe admin requests (I-CSRF-1). Two independent layers
// must both pass: fetch metadata / Origin says the request came from this site, AND the `_csrf`
// form field equals the browser's `__Host-` CSRF cookie (double submit). Another site can neither
// read that cookie nor set it: the `__Host-` prefix forbids a Domain attribute, so a sibling
// subdomain cannot plant one either.
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppContext } from '../../app';
import { randomToken, timingSafeEqualString } from '../../crypto/hash';
import type { Deps } from '../../deps';

export const CSRF_FIELD = '_csrf';
export const CSRF_COOKIE = '__Host-tokengate_csrf';

/** base64url of 32 bytes, as written by randomToken. */
const CSRF_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** The browser's CSRF token, or null when the cookie is absent or not a token we write. */
export function readCsrfCookie(c: Context<AppContext>): string | null {
  const value = getCookie(c, CSRF_COOKIE);
  return value !== undefined && CSRF_TOKEN_RE.test(value) ? value : null;
}

/**
 * The browser's CSRF token, issuing a new cookie when it has none. Strict: no flow needs the cookie
 * on a cross-site navigation, and the token only matters on same-site form posts.
 */
export function ensureCsrfCookie(c: Context<AppContext>, deps: Pick<Deps, 'random'>): string {
  const existing = readCsrfCookie(c);
  if (existing !== null) return existing;
  const token = randomToken(deps.random);
  setCookie(c, CSRF_COOKIE, token, { path: '/', secure: true, httpOnly: true, sameSite: 'Strict' });
  return token;
}

/**
 * `Sec-Fetch-Site`, when sent, must be `same-origin` or `none` (user-initiated navigation). When a
 * browser omits it, `Origin` must equal the canonical origin. Neither header → reject: every
 * browser that renders this UI sends at least one of them on a form POST.
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site
 */
export function requestFromSameSite(headers: Headers, canonicalOrigin: string): boolean {
  const site = headers.get('sec-fetch-site');
  if (site !== null) return site === 'same-origin' || site === 'none';
  const origin = headers.get('origin');
  return origin !== null && origin === canonicalOrigin;
}

/** Constant-time comparison of the submitted token with the cookie's token. */
export async function csrfTokenMatches(
  submitted: unknown,
  cookieToken: string | null,
): Promise<boolean> {
  if (typeof submitted !== 'string' || submitted === '' || !cookieToken) return false;
  return timingSafeEqualString(submitted, cookieToken);
}

export async function csrfCheck(input: {
  headers: Headers;
  canonicalOrigin: string;
  submittedToken: unknown;
  /** The token the request's cookie carried; null when it carried none. */
  cookieToken: string | null;
}): Promise<boolean> {
  if (!requestFromSameSite(input.headers, input.canonicalOrigin)) return false;
  return csrfTokenMatches(input.submittedToken, input.cookieToken);
}
