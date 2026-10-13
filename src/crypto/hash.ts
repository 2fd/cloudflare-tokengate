// Hashing, MAC, constant-time comparison and random token helpers on WebCrypto.
// Comparisons never branch on secret length or content.
import { toBase64Url, toHex, utf8 } from '../lib/encoding';

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text))));
}

/**
 * Compares two strings without leaking where they differ or how long they are.
 * Both inputs are hashed first so the buffers passed to `timingSafeEqual` always have the same
 * length (it throws on unequal lengths).
 * https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/
 */
export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', utf8(a)),
    crypto.subtle.digest('SHA-256', utf8(b)),
  ]);
  return crypto.subtle.timingSafeEqual(digestA, digestB);
}

const MIN_TOKEN_BYTES = 16;

/** Unpadded base64url of `bytes` random bytes (default 32). Refuses fewer than 128 bits. */
export function randomToken(random: (n: number) => Uint8Array, bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < MIN_TOKEN_BYTES) {
    throw new RangeError(`randomToken needs an integer of at least ${MIN_TOKEN_BYTES} bytes`);
  }
  const value = random(bytes);
  if (value.length !== bytes) throw new Error('random source returned the wrong length');
  return toBase64Url(value);
}

export async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, utf8(data)));
}
