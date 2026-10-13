import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hmacSha256,
  randomToken,
  sha256Hex,
  timingSafeEqualString,
} from '../../../src/crypto/hash';
import { toHex } from '../../../src/lib/encoding';

describe('sha256Hex', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ])('hashes %j (FIPS 180-2 vectors)', async (input, expected) => {
    expect(await sha256Hex(input)).toBe(expected);
  });
});

describe('hmacSha256', () => {
  it('matches RFC 4231 test case 2', async () => {
    const mac = await hmacSha256(new TextEncoder().encode('Jefe'), 'what do ya want for nothing?');
    expect(toHex(mac)).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
});

describe('timingSafeEqualString', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['equal strings', 'tgk_secret', 'tgk_secret', true],
    ['both empty', '', '', true],
    ['equal non-ASCII', 'clé-🔑', 'clé-🔑', true],
    ['last character differs', 'tgk_secret1', 'tgk_secret2', false],
    ['prefix of the other', 'tgk_secret', 'tgk_secret_longer', false],
    ['empty vs non-empty', '', 'x', false],
    ['case differs', 'Secret', 'secret', false],
    ['NFC vs NFD', 'é', 'é', false],
  ])('%s', async (_name, a, b, expected) => {
    expect(await timingSafeEqualString(a, b)).toBe(expected);
    expect(await timingSafeEqualString(b, a)).toBe(expected);
  });

  it('always compares two 32-byte digests, whatever the input lengths', async () => {
    const spy = vi.spyOn(crypto.subtle, 'timingSafeEqual');
    await timingSafeEqualString('a', 'a much longer string than the first one');
    await timingSafeEqualString('', 'x');
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [a, b] of spy.mock.calls) {
      expect((a as ArrayBuffer).byteLength).toBe(32);
      expect((b as ArrayBuffer).byteLength).toBe(32);
    }
  });
});

describe('randomToken', () => {
  const counting = (length: number) => Uint8Array.from({ length }, (_, i) => i);

  it('defaults to 32 bytes of unpadded base64url', () => {
    const token = randomToken(counting);
    expect(token).toBe('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('honours an explicit size', () => {
    expect(randomToken(counting, 16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it.each([0, 8, 15, 16.5, Number.NaN])('refuses %d bytes', (bytes) => {
    expect(() => randomToken(counting, bytes)).toThrow(RangeError);
  });

  it('refuses a random source that returns the wrong length', () => {
    expect(() => randomToken(() => new Uint8Array(4))).toThrow(/wrong length/);
  });
});
