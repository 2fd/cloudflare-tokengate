// Caller path canonicalization and upstream URL construction (I-PATH-1, I-INJ-1).
// Caller paths are checked as text and never resolved with `new URL(path, base)`. The upstream URL
// is concatenated from the fixed base URL, then re-parsed to prove the parser did not move it.
import type { Injection } from '../policy/types';

export const MAX_PATH_LENGTH = 2048;

/**
 * Characters allowed literally in a caller path: RFC 3986 `pchar` plus "/", without ";".
 * Excludes "\" (WHATWG reads it as "/"), ";" (path parameters such as `;jsessionid` and Tomcat's
 * `..;`), whitespace, control chars, "?", "#" and characters RFC 3986 does not allow in paths.
 * https://www.rfc-editor.org/rfc/rfc3986#section-3.3
 */
const PATH_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,=:@/%]*$/;

/** A "%" that does not start a two-hex-digit escape (`%zz`, `%u002e`, trailing `%`). */
const BROKEN_ESCAPE = /%(?![0-9A-Fa-f]{2})/;

/**
 * Escapes rejected because upstreams decode them into something dangerous:
 * `%2e` dot (traversal), `%5c` backslash, `%3b` semicolon, `%25` percent (double encoding),
 * `%00`-`%1f` and `%7f` control characters.
 */
const FORBIDDEN_ESCAPE = /%(?:2e|5c|3b|25|[01][0-9a-f]|7f)/i;

/** Segment separators: "/" and its escape `%2F`, which some upstreams decode before routing. */
const SEPARATOR = /\/|%2f/i;

/** Characters allowed in the credential path segment of `path` injection (pchar without "%"). */
const SEGMENT_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,=:@]+$/;

/** A query string as `URL.search` produces it: empty, or "?" + visible ASCII except "#". */
const SEARCH_CHARS = /^(?:\?[\x21\x22\x24-\x7e]*)?$/;

export type CanonicalPath = { ok: true; path: string; matchPath: string } | { ok: false };

/**
 * Validates the path after `/proxy/<slug>`. `path` is forwarded unchanged; `matchPath` (with
 * `%2F` read as "/") is what grant rules are matched against.
 */
export function canonicalizePath(rawPath: string): CanonicalPath {
  const path = rawPath === '' ? '/' : rawPath;
  if (path.length > MAX_PATH_LENGTH) return { ok: false };
  if (!path.startsWith('/')) return { ok: false };
  if (!PATH_CHARS.test(path)) return { ok: false };
  if (BROKEN_ESCAPE.test(path) || FORBIDDEN_ESCAPE.test(path)) return { ok: false };
  // Escapes must decode to valid UTF-8. Overlong forms such as `%c0%ae` (".") and `%c0%af` ("/")
  // are decoded as dots and slashes by some servers.
  if (decodeComponent(path) === null) return { ok: false };

  // Empty segments ("//", "/%2F") and dot segments are rejected; only a final literal "/" may
  // leave an empty last segment.
  const segments = path.slice(1).split(SEPARATOR);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isTrailingSlash = i === segments.length - 1 && path.endsWith('/');
    if (segment === '' && !isTrailingSlash) return { ok: false };
    if (segment === '.' || segment === '..') return { ok: false };
  }

  return { ok: true, path, matchPath: path.replace(/%2f/gi, '/') };
}

/**
 * The path text inserted after the base path for `path` injection: "/" + prefix + secret, with
 * the secret appended directly to the prefix's last segment. Telegram's `/bot<token>` is prefix
 * "/bot"; webhooks use no prefix ("/<token>"); Slack incoming webhooks have a multi-segment
 * secret ("T0/B0/XYZ"). A leading "/" in prefix is optional.
 * Returns "" for other injection kinds, and null unless every resulting segment is a non-empty,
 * non-dot run of unreserved/sub-delim characters (no "%", so nothing decodes to "/" or "..").
 */
export function credentialPathSegment(injection: Injection, secret: string): string | null {
  if (injection.kind !== 'path') return '';
  const inserted = (injection.prefix ?? '').replace(/^\//, '') + secret;
  const segments = inserted.split('/');
  const safe = segments.every((s) => SEGMENT_CHARS.test(s) && s !== '.' && s !== '..');
  return safe ? `/${inserted}` : null;
}

/**
 * Removes every query parameter whose decoded name equals `param` (ASCII case-insensitive), so a
 * caller cannot smuggle `%6Bey=` past a `key` filter. Other pairs keep their original bytes.
 * Returns "" or "?..." on success; null (fail closed) when a parameter name cannot be decoded or
 * contains a control character, or when `param` follows a ";" inside a pair (`a=1;key=x`): some
 * servers split on ";" and would read that as a second copy.
 */
export function removeQueryParam(search: string, param: string): string | null {
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (query === '') return '';
  const target = param.toLowerCase();
  const kept: string[] = [];
  for (const pair of query.split('&')) {
    const names = pairNames(pair);
    if (names === null) return null;
    if (names.slice(1).includes(target)) return null;
    if (names[0] !== target) kept.push(pair);
  }
  return kept.length === 0 ? '' : `?${kept.join('&')}`;
}

/**
 * Query parameter names that frameworks read as a method override (Symfony/Laravel `_method`,
 * Express method-override, the X-HTTP-Method-Override family). Grant rules match the request
 * method only, so forwarding one would bypass them, like the headers in NEVER_FORWARD (I-AUTHZ-1).
 */
export const METHOD_OVERRIDE_PARAMS: readonly string[] = [
  '_method',
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
];

/**
 * True when some parameter name, decoded and lowercased, is a method override; also true (fail
 * closed) when a name cannot be decoded or contains a control character. Names are also compared
 * the way PHP builds `$_GET` (leading spaces dropped, " " and "." read as "_", `name[...]` read as
 * `name`), and names after ";" count.
 */
export function hasMethodOverrideParam(search: string): boolean {
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (query === '') return false;
  for (const pair of query.split('&')) {
    const names = pairNames(pair);
    if (names === null) return true;
    for (const name of names) {
      const php = (name.trimStart().split('[', 1)[0] ?? '').replace(/[ .]/g, '_');
      if (METHOD_OVERRIDE_PARAMS.includes(name) || METHOD_OVERRIDE_PARAMS.includes(php)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Decoded, lowercased names in one `&`-separated pair, split on ";". Null (fail closed) if any is
 * undecodable or contains a control character: PHP cuts names at NUL, so `_method%00x` would be
 * read as `_method` (and `key%00` as `key`).
 */
function pairNames(pair: string): string[] | null {
  const names: string[] = [];
  for (const part of pair.split(';')) {
    const name = decodeComponent(queryName(part));
    // oxlint-disable-next-line eslint/no-control-regex -- control characters are the target
    if (name === null || /[\u0000-\u001f\u007f]/.test(name)) return null;
    names.push(name.toLowerCase());
  }
  return names;
}

/** The name of a query pair in `application/x-www-form-urlencoded` form ("+" is a space). */
function queryName(pair: string): string {
  return (pair.split('=', 1)[0] ?? '').replace(/\+/g, ' ');
}

/** decodeURIComponent, or null for broken escapes and invalid UTF-8. */
function decodeComponent(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Origin and pathname (without trailing "/") of a stored service base URL, or null if unusable.
 * Only https is accepted, so a tampered base URL cannot send the credential in clear text.
 */
export function parseBaseUrl(baseUrl: string): { origin: string; path: string } | null {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== 'https:' || base.username !== '' || base.password !== '') return null;
  if (base.search !== '' || base.hash !== '') return null;
  return { origin: base.origin, path: base.pathname.replace(/\/$/, '') };
}

export interface UpstreamUrlInput {
  /** Normalized service base URL (origin + path, no query or fragment). */
  baseUrl: string;
  /** Caller path; validated again with canonicalizePath. */
  path: string;
  /** Raw caller query string ("" or "?..."). */
  search: string;
  injection: Injection;
  /** Plaintext credential; used only for `path` and `query` injection. */
  secret: string;
}

/**
 * Builds `base origin + base path + [credential segment] + path + search` and asserts that the
 * parsed result has the base origin and exactly the concatenated pathname (I-PATH-1). For
 * `query` injection, caller copies of the parameter are removed before the credential is appended
 * (I-INJ-1). Queries carrying a method-override parameter are refused (I-AUTHZ-1).
 */
export function buildUpstreamUrl(input: UpstreamUrlInput): { ok: true; url: URL } | { ok: false } {
  const base = parseBaseUrl(input.baseUrl);
  if (base === null) return { ok: false };
  const canonical = canonicalizePath(input.path);
  if (!canonical.ok) return { ok: false };
  const segment = credentialPathSegment(input.injection, input.secret);
  if (segment === null) return { ok: false };
  if (!SEARCH_CHARS.test(input.search)) return { ok: false };
  if (hasMethodOverrideParam(input.search)) return { ok: false };

  let search = input.search === '?' ? '' : input.search;
  if (input.injection.kind === 'query') {
    if (input.injection.param === '' || input.secret === '') return { ok: false };
    const stripped = removeQueryParam(search, input.injection.param);
    if (stripped === null) return { ok: false };
    const pair = `${encodeURIComponent(input.injection.param)}=${encodeURIComponent(input.secret)}`;
    search = stripped === '' ? `?${pair}` : `${stripped}&${pair}`;
  }

  // For path injection the bare root maps to the secret itself: webhook URLs have no trailing "/".
  const callerPath = segment !== '' && canonical.path === '/' ? '' : canonical.path;
  const pathname = base.path + segment + callerPath;
  let url: URL;
  try {
    url = new URL(base.origin + pathname + search);
  } catch {
    return { ok: false };
  }
  if (url.origin !== base.origin || url.pathname !== pathname) return { ok: false };
  return { ok: true, url };
}
