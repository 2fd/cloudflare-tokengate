// Attaches the service credential to the outbound request headers (I-INJ-1) and lists the
// encodings in which the credential could be echoed back, for response redaction (I-CRED-1).
// `query` and `path` injection are applied to the URL by src/proxy/path.ts.
import { toBase64, utf8 } from '../lib/encoding';
import type { Injection } from '../policy/types';

/** Printable ASCII and spaces only, so a credential can never split or add a header. */
const HEADER_VALUE = /^[\x20-\x7e]+$/;

/** Lowercase name of the request header that carries the credential, or null for URL injection. */
export function injectedHeaderName(injection: Injection): string | null {
  switch (injection.kind) {
    case 'bearer':
    case 'basic':
      return 'authorization';
    case 'header':
      return injection.name.toLowerCase();
    case 'query':
    case 'path':
      return null;
    default:
      return unknownKind(injection);
  }
}

/** Stored rows are parsed defensively (src/db/rows.ts); an unknown kind must never inject. */
function unknownKind(_injection: never): never {
  throw new Error('tokengate: unknown injection kind');
}

/**
 * Base64 RFC 7617 user-pass: `username:secret`, or the secret itself ("user:pass") when no
 * username is set.
 */
function basicCredentials(injection: { username?: string }, secret: string): string {
  const userPass = injection.username === undefined ? secret : `${injection.username}:${secret}`;
  return toBase64(utf8(userPass));
}

function injectedHeaderValue(injection: Injection, secret: string): string | null {
  switch (injection.kind) {
    case 'bearer':
      return `Bearer ${secret}`;
    case 'header':
      return `${injection.prefix ?? ''}${secret}`;
    case 'basic':
      return `Basic ${basicCredentials(injection, secret)}`;
    case 'query':
    case 'path':
      return null;
    default:
      return unknownKind(injection);
  }
}

/**
 * Sets the credential header on `headers` (outbound headers built by buildUpstreamHeaders, which
 * already excludes caller copies of this header). No-op for `query` and `path` injection.
 * Throws a fixed message, never the value, when the credential is not a valid header value.
 */
export function injectCredentialHeaders(
  headers: Headers,
  injection: Injection,
  secret: string,
): void {
  const name = injectedHeaderName(injection);
  const value = injectedHeaderValue(injection, secret);
  if (name === null || value === null) return;
  if (secret === '' || !HEADER_VALUE.test(value)) {
    throw new Error('tokengate: service credential is not a valid header value');
  }
  headers.set(name, value);
}

/**
 * Shorter path-secret segments are identifiers (Slack `T0…`/`B0…`). Long identifiers (Discord
 * webhook IDs) are redacted too, which only hides a public value.
 */
const MIN_SECRET_SEGMENT = 16;
/** Shorter base64 cores would match unrelated base64 data. */
const MIN_BASE64_CORE = 12;

/**
 * Forms in which the credential may be echoed back, matched by findSecretRanges: raw, URL-encoded
 * (`encodeURIComponent`, lowercase-hex and form-encoded variants), URL-path-parsed (`\` as `/`),
 * base64/base64url at any byte alignment (base64Cores) and, for `basic`, the whole base64
 * user-pass without padding. Also covers the secret part of a `basic` "user:pass" credential
 * and, for `path`, each long segment on its own. Empty secret → no variants.
 */
export function secretVariants(injection: Injection, secret: string): string[] {
  if (secret === '') return [];
  const sensitive = new Set([secret]);
  if (injection.kind === 'basic' && injection.username === undefined) {
    const part = basicSecretPart(secret);
    if (part !== null) sensitive.add(part);
  }
  if (injection.kind === 'path') {
    // I-CRED-1: webhook APIs return the token segment alone (Discord's `token` field of
    // GET /webhooks/{id}/{token}), so each long "/"-separated segment is a secret by itself.
    for (const segment of secret.split('/')) {
      if (segment.length >= MIN_SECRET_SEGMENT) sensitive.add(segment);
    }
  }
  const variants = new Set<string>();
  for (const value of sensitive) {
    const encoded = encodeURIComponent(value);
    variants.add(value);
    variants.add(encoded);
    variants.add(encoded.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()));
    variants.add(new URLSearchParams({ v: value }).toString().slice('v='.length));
    // I-RESP-1: URL parsing turns `\` into `/` in http(s) paths (e.g. a rewritten Location),
    // which percent-decoding cannot undo.
    if (value.includes('\\')) variants.add(value.replaceAll('\\', '/'));
    // base64 of the value and of its query-injection wire form (WHATWG encodes `'` as %27).
    for (const core of base64Cores(value)) variants.add(core);
    for (const core of base64Cores(encoded.replaceAll("'", '%27'))) variants.add(core);
  }
  if (injection.kind === 'basic') {
    variants.add(basicCredentials(injection, secret).replace(/=+$/, ''));
  }
  return [...variants];
}

/**
 * Substrings that every base64 and base64url encoding of `value` contains, wherever `value`
 * starts in the encoded data (e.g. `btoa("Bearer " + secret)`): for each of the three byte
 * alignments, the 4-char groups that encode only bytes of `value`.
 */
function base64Cores(value: string): string[] {
  const cores: string[] = [];
  for (let shift = 0; shift < 3; shift++) {
    const encoded = toBase64(utf8('\0'.repeat(shift) + value));
    // The first group (shift > 0) mixes in preceding bytes; the last, following bytes or padding.
    const core = encoded.slice(shift === 0 ? 0 : 4, -4);
    if (core.length < MIN_BASE64_CORE) continue;
    cores.push(core, core.replaceAll('+', '-').replaceAll('/', '_'));
  }
  return cores;
}

/**
 * Sorted, merged `[start, end)` ranges of `text` that hold one of `variants`, matched as written
 * and after percent-decoding every valid `%XX` escape, so any mix of raw and percent-encoded
 * characters matches (WHATWG URL re-serialization such as `%27` or `%7B`, lowercase hex).
 * Used for response header redaction (I-RESP-1) and verify preview masking (I-CRED-1).
 */
export function findSecretRanges(
  text: string,
  variants: readonly string[],
): Array<[number, number]> {
  const decoded = percentDecodeWithOffsets(text);
  const found: Array<[number, number]> = [];
  for (const variant of variants) {
    if (variant === '') continue;
    for (let i = text.indexOf(variant); i !== -1; i = text.indexOf(variant, i + 1)) {
      found.push([i, i + variant.length]);
    }
    if (decoded === null) continue;
    const { value, offsets } = decoded;
    for (let i = value.indexOf(variant); i !== -1; i = value.indexOf(variant, i + 1)) {
      found.push([offsets[i] as number, offsets[i + variant.length] as number]);
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of found) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const PERCENT_ESCAPE = /^%[0-9A-Fa-f]{2}$/;

/**
 * Decodes each valid `%XX` to the character with that code (never throws, malformed escapes kept);
 * `offsets[k]` is where decoded character k starts in `text`, `offsets[value.length]` is its end.
 * Null when `text` has no "%".
 */
function percentDecodeWithOffsets(text: string): { value: string; offsets: number[] } | null {
  if (!text.includes('%')) return null;
  let value = '';
  const offsets: number[] = [];
  let i = 0;
  while (i < text.length) {
    offsets.push(i);
    const triplet = text.slice(i, i + 3);
    if (PERCENT_ESCAPE.test(triplet)) {
      value += String.fromCharCode(Number.parseInt(triplet.slice(1), 16));
      i += 3;
    } else {
      value += text[i];
      i += 1;
    }
  }
  offsets.push(text.length);
  return { value, offsets };
}

/**
 * The secret inside a "user:pass" credential: the password, or the user part when the password
 * is empty (Stripe sends the API key as the user). Same rule as normalizeCredential in
 * src/policy/validate.ts.
 */
function basicSecretPart(userPass: string): string | null {
  const colon = userPass.indexOf(':');
  if (colon <= 0) return null;
  const password = userPass.slice(colon + 1);
  return password !== '' ? password : userPass.slice(0, colon);
}
