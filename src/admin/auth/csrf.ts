// Cross-site request forgery defense for unsafe admin requests and logout (I-CSRF-1). Two
// independent layers must both pass: fetch metadata / Origin says the request came from this
// site, AND the `_csrf` form field equals the session's synchronizer token.
import { timingSafeEqualString } from '../../crypto/hash';

export const CSRF_FIELD = '_csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
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

/** Constant-time comparison of the submitted token with the session's token. */
export async function csrfTokenMatches(submitted: unknown, sessionToken: string): Promise<boolean> {
  if (typeof submitted !== 'string' || submitted === '' || sessionToken === '') return false;
  return timingSafeEqualString(submitted, sessionToken);
}

export async function csrfCheck(input: {
  headers: Headers;
  canonicalOrigin: string;
  submittedToken: unknown;
  sessionToken: string;
}): Promise<boolean> {
  if (!requestFromSameSite(input.headers, input.canonicalOrigin)) return false;
  return csrfTokenMatches(input.submittedToken, input.sessionToken);
}
