// Identifiers: "<prefix>_<ULID>". ULID = 48-bit ms timestamp + 80 random bits, Crockford base32
// (https://github.com/ulid/spec). Time-ordered, so request ids double as a time index.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type IdPrefix = 'usr' | 'cpr' | 'svc' | 'grt' | 'req' | 'aud' | 'tea';

function encodeTime(ms: number): string {
  let out = '';
  let value = Math.floor(ms);
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits -> 16 base32 characters, 5 bits at a time.
  let bits = 0;
  let buffer = 0;
  let out = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export function newId(
  prefix: IdPrefix,
  now: number,
  random: (length: number) => Uint8Array,
): string {
  return `${prefix}_${encodeTime(now)}${encodeRandom(random(10))}`;
}

/** Smallest id of `prefix` created at or after `ms`; ids below it are older. */
export function idLowerBound(prefix: IdPrefix, ms: number): string {
  return `${prefix}_${encodeTime(ms)}${'0'.repeat(16)}`;
}

/** Creation time encoded in an id, or null when the id is not a well-formed ULID id. */
export function idTimestamp(id: string): number | null {
  const match = /^[a-z]{3}_([0-9A-HJKMNP-TV-Z]{26})$/.exec(id);
  if (!match?.[1]) return null;
  let ms = 0;
  for (const char of match[1].slice(0, 10)) ms = ms * 32 + ALPHABET.indexOf(char);
  return ms;
}
