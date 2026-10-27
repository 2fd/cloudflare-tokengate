import { describe, expect, it } from 'vitest';
import devVarsExample from '../../../.dev.vars.example?raw';
import {
  boundKey,
  checkNextKey,
  DEV_PLACEHOLDER_KEK,
  type Keyring,
  type KeyringEnv,
  type KeyringError,
  kekBindingInfo,
  keyCheckValue,
  loadKeyring,
  type NextKeyStatus,
} from '../../../src/crypto/keyring';
import { toBase64 } from '../../../src/lib/encoding';
import vectors from '../../vectors/sealed.json';

const bytes = (length: number, start = 0) =>
  Uint8Array.from({ length }, (_, i) => (start + i) & 0xff);
const K1 = toBase64(bytes(32, 0x00));
const K2 = toBase64(bytes(32, 0x80));
const ring = (doc: unknown) => JSON.stringify(doc);

const KID1 = vectors.kcv[0]?.kcv as string;
const KID2 = vectors.kcv[1]?.kcv as string;
/** 32 printable ASCII bytes: a passphrase, not a random key. */
const TEXT_KEY = toBase64(new TextEncoder().encode('correct-horse-battery-staple-123'));
/** 32 bytes with only two distinct values. */
const FEW_BYTES = toBase64(Uint8Array.from({ length: 32 }, (_, i) => (i % 2 === 0 ? 0 : 0xff)));

async function keyringOf(env: KeyringEnv): Promise<Keyring> {
  const result = await loadKeyring(env);
  if (!result.ok) throw new Error(result.error);
  return result.keyring;
}

describe('loadKeyring errors', () => {
  const cases: Array<
    [string, { TOKENGATE_KEK?: string; TOKENGATE_KEYRING?: string }, KeyringError]
  > = [
    ['neither set', {}, 'keyring_absent'],
    ['both empty strings', { TOKENGATE_KEK: '', TOKENGATE_KEYRING: '' }, 'keyring_absent'],
    ['KEK whitespace only', { TOKENGATE_KEK: ' \n' }, 'keyring_absent'],

    ['KEK not base64', { TOKENGATE_KEK: 'not base64!' }, 'keyring_malformed'],
    ['KEK with a base64url character', { TOKENGATE_KEK: `-${K1.slice(1)}` }, 'keyring_malformed'],
    ['KEK bad padding', { TOKENGATE_KEK: `${toBase64(bytes(31))}==` }, 'keyring_malformed'],
    [
      'KEK given the old keyring JSON',
      { TOKENGATE_KEK: ring({ active: 'k1', keys: { k1: K1 } }) },
      'keyring_malformed',
    ],
    ['KEK 16 bytes', { TOKENGATE_KEK: toBase64(bytes(16)) }, 'key_not_32_bytes'],
    ['KEK 31 bytes', { TOKENGATE_KEK: toBase64(bytes(31)) }, 'key_not_32_bytes'],
    ['KEK 33 bytes', { TOKENGATE_KEK: toBase64(bytes(33)) }, 'key_not_32_bytes'],
    ['KEK 64 bytes', { TOKENGATE_KEK: toBase64(bytes(64)) }, 'key_not_32_bytes'],
    [
      'KEK invalid, even with a valid KEYRING',
      { TOKENGATE_KEK: 'x', TOKENGATE_KEYRING: K2 },
      'keyring_malformed',
    ],

    [
      'KEYRING alone, the old JSON format',
      { TOKENGATE_KEYRING: ring({ active: 'k1', keys: { k1: K1 } }) },
      'keyring_malformed',
    ],
    ['KEYRING alone, not base64', { TOKENGATE_KEYRING: '***' }, 'keyring_malformed'],
    ['KEYRING alone, 16 bytes', { TOKENGATE_KEYRING: toBase64(bytes(16)) }, 'key_not_32_bytes'],
    ['KEYRING alone, text', { TOKENGATE_KEYRING: TEXT_KEY }, 'key_not_random'],
    ['KEYRING alone, few byte values', { TOKENGATE_KEYRING: FEW_BYTES }, 'key_not_random'],
    [
      'KEYRING alone, the development key',
      { TOKENGATE_KEYRING: DEV_PLACEHOLDER_KEK },
      'dev_placeholder_key',
    ],
  ];

  it.each(cases)('%s → %s', async (_name, env, error) => {
    expect(await loadKeyring(env)).toEqual({ ok: false, error });
  });
});

describe('loadKeyring success', () => {
  it('names a bare TOKENGATE_KEK by its key check value, and resolves the legacy kid k1 to it', async () => {
    const keyring = await keyringOf({ TOKENGATE_KEK: K1 });
    expect(keyring.activeKid).toBe(KID1);
    expect(keyring.currentKid).toBe(KID1);
    expect(keyring.kids).toEqual([KID1]);
    expect(keyring.kcv).toEqual({ [KID1]: KID1, k1: KID1 });
    expect(keyring.next).toBe('absent');
    expect(keyring.nextKid).toBeNull();
    expect(keyring.resolve('k1')).toBe(KID1);
    expect(keyring.resolve(KID1)).toBe(KID1);
    expect(keyring.resolve(KID2)).toBeNull();
    expect(keyring.key('k1')).toBe(keyring.key(KID1));
    expect(keyring.key('k1')).toBeDefined();
  });

  it('trims surrounding whitespace (secrets pasted with a newline) and accepts unpadded base64', async () => {
    const padded = await loadKeyring({ TOKENGATE_KEK: `  ${K1}\n` });
    const unpadded = await loadKeyring({ TOKENGATE_KEK: K1.replace(/=+$/, '') });
    expect(padded.ok && padded.keyring.activeKid).toBe(KID1);
    expect(unpadded.ok && unpadded.keyring.activeKid).toBe(KID1);
  });

  it('makes a ready TOKENGATE_KEYRING the active key while TOKENGATE_KEK still opens', async () => {
    const keyring = await keyringOf({ TOKENGATE_KEK: K1, TOKENGATE_KEYRING: ` ${K2}\n` });
    expect(keyring.next).toBe('ready');
    expect(keyring.activeKid).toBe(KID2);
    expect(keyring.nextKid).toBe(KID2);
    expect(keyring.currentKid).toBe(KID1);
    expect(keyring.kids).toEqual([KID1, KID2].sort());
    expect(keyring.key(KID1)).toBeDefined();
    expect(keyring.key(KID2)).toBeDefined();
    expect(keyring.resolve('k1')).toBe(KID1);
    expect(keyring.key('k3')).toBeUndefined();
    expect(keyring.key('toString')).toBeUndefined();
    // These match KID_PATTERN, so a tampered sealed kid could name them.
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(inherited in keyring.kcv).toBe(false);
      expect(keyring.kcv[inherited]).toBeUndefined();
      expect(keyring.resolve(inherited)).toBeNull();
    }
  });

  it('reports TOKENGATE_KEYRING equal to TOKENGATE_KEK as the same key', async () => {
    const keyring = await keyringOf({ TOKENGATE_KEK: K1, TOKENGATE_KEYRING: K1 });
    expect(keyring.next).toBe('same');
    expect(keyring.activeKid).toBe(KID1);
    expect(keyring.nextKid).toBe(KID1);
    expect(keyring.kids).toEqual([KID1]);
  });

  it.each<[string, string, NextKeyStatus]>([
    ['not base64', '***', 'malformed'],
    ['the old JSON format', ring({ active: 'k2', keys: { k2: K2 } }), 'malformed'],
    ['16 bytes', toBase64(bytes(16)), 'not_32_bytes'],
    ['the development key', DEV_PLACEHOLDER_KEK, 'dev_placeholder'],
    ['printable text', TEXT_KEY, 'not_random'],
    ['few distinct byte values', FEW_BYTES, 'not_random'],
  ])(
    'ignores a TOKENGATE_KEYRING that is %s: TOKENGATE_KEK stays active',
    async (_, value, status) => {
      const keyring = await keyringOf({ TOKENGATE_KEK: K1, TOKENGATE_KEYRING: value });
      expect(keyring.next).toBe(status);
      expect(keyring.nextKid).toBeNull();
      expect(keyring.activeKid).toBe(KID1);
      expect(keyring.kids).toEqual([KID1]);
    },
  );

  it('refuses the development key as TOKENGATE_KEYRING even in development mode', async () => {
    const keyring = await keyringOf({
      TOKENGATE_KEK: DEV_PLACEHOLDER_KEK,
      TOKENGATE_KEYRING: DEV_PLACEHOLDER_KEK,
      AUTH_ACCESS_DEVELOPMENT: 'dev@example.com',
    });
    expect(keyring.next).toBe('dev_placeholder');
  });

  it('uses a ready TOKENGATE_KEYRING alone as the only key', async () => {
    const keyring = await keyringOf({ TOKENGATE_KEYRING: K2 });
    expect(keyring.currentKid).toBeNull();
    expect(keyring.next).toBe('ready');
    expect(keyring.activeKid).toBe(KID2);
    expect(keyring.kids).toEqual([KID2]);
    expect(keyring.resolve('k1')).toBeNull();
    expect(keyring.key('k1')).toBeUndefined();
    expect(keyring.kcv).toEqual({ [KID2]: KID2 });
  });

  it('imports keys as non-extractable AES-256-GCM encrypt/decrypt keys', async () => {
    const keyring = await keyringOf({ TOKENGATE_KEK: K1, TOKENGATE_KEYRING: K2 });
    for (const kid of keyring.kids) {
      const key = keyring.key(kid);
      expect(key).toBeDefined();
      expect(key?.extractable).toBe(false);
      expect(key?.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
      expect([...(key?.usages ?? [])].sort()).toEqual(['decrypt', 'encrypt']);
      await expect(crypto.subtle.exportKey('raw', key as CryptoKey)).rejects.toThrow();
    }
  });

  it('returns frozen objects', async () => {
    const keyring = await keyringOf({ TOKENGATE_KEK: K1 });
    expect(Object.isFrozen(keyring)).toBe(true);
    expect(Object.isFrozen(keyring.kids)).toBe(true);
    expect(Object.isFrozen(keyring.kcv)).toBe(true);
  });

  it('caches per raw secret strings', async () => {
    const env = { TOKENGATE_KEK: K1, TOKENGATE_KEYRING: K2 };
    const first = await loadKeyring(env);
    const second = await loadKeyring({ ...env });
    expect(second).toBe(first);
    const other = await loadKeyring({ TOKENGATE_KEK: K2 });
    expect(other).not.toBe(first);
    expect(other.ok && other.keyring.activeKid).toBe(KID2);
  });
});

describe('checkNextKey', () => {
  it.each<[string, string, ReturnType<typeof checkNextKey>]>([
    ['a random key', toBase64(crypto.getRandomValues(new Uint8Array(32))), null],
    ['K1 (0x00..0x1f)', K1, null],
    ['not base64', 'not base64!', 'malformed'],
    ['33 bytes', toBase64(bytes(33)), 'not_32_bytes'],
    ['the development key', DEV_PLACEHOLDER_KEK, 'dev_placeholder'],
    ['printable text', TEXT_KEY, 'not_random'],
    ['32 zero bytes', toBase64(new Uint8Array(32)), 'not_random'],
    ['few distinct byte values', FEW_BYTES, 'not_random'],
  ])('%s → %s', (_, value, expected) => {
    expect(checkNextKey(value)).toBe(expected);
  });
});

describe('I-CRED-3: keys are bound to the login variables', () => {
  const access = { AUTH_ACCESS_TEAM_DOMAIN: 'acme', AUTH_ACCESS_AUD: 'a'.repeat(64) };
  const kcvOf = async (env: KeyringEnv) => {
    const result = await loadKeyring({ TOKENGATE_KEK: K1, ...env });
    if (!result.ok) throw new Error(result.error);
    return result.keyring.activeKid;
  };

  it('every change to AUTH_ACCESS_* yields a different key', async () => {
    const variants: KeyringEnv[] = [
      {},
      access,
      { ...access, AUTH_ACCESS_AUD: 'b'.repeat(64) },
      { ...access, AUTH_ACCESS_TEAM_DOMAIN: 'https://acme.cloudflareaccess.com' },
      { AUTH_ACCESS_DEVELOPMENT: 'dev@example.com' },
      { AUTH_ACCESS_DEVELOPMENT: 'Dev@example.com' },
      { ...access, AUTH_ACCESS_DEVELOPMENT: 'dev@example.com' },
    ];
    const kcvs = await Promise.all(variants.map(kcvOf));
    expect(new Set(kcvs).size).toBe(variants.length);
  });

  it('ignores surrounding whitespace and treats blank as unset', async () => {
    expect(
      await kcvOf({ AUTH_ACCESS_TEAM_DOMAIN: ' acme\n', AUTH_ACCESS_AUD: ` ${'a'.repeat(64)}` }),
    ).toBe(await kcvOf(access));
    expect(await kcvOf({ AUTH_ACCESS_DEVELOPMENT: '  ' })).toBe(await kcvOf({}));
  });

  it('binds with HKDF-SHA256 over kekBindingInfo', async () => {
    const raw = Uint8Array.from(atob(K1), (c) => c.charCodeAt(0));
    const bound = await boundKey(raw, kekBindingInfo(access));
    expect(await keyCheckValue(bound)).toBe(await kcvOf(access));
  });
});

describe('the development placeholder key', () => {
  it('is the TOKENGATE_KEK in .dev.vars.example', () => {
    expect(devVarsExample).toContain(`\nTOKENGATE_KEK=${DEV_PLACEHOLDER_KEK}\n`);
  });

  it.each<[string, KeyringEnv]>([
    ['no login variable', {}],
    ['Access', { AUTH_ACCESS_TEAM_DOMAIN: 'acme', AUTH_ACCESS_AUD: 'a'.repeat(64) }],
    ['Access team domain only', { AUTH_ACCESS_TEAM_DOMAIN: 'acme' }],
    [
      'development and Access',
      { AUTH_ACCESS_DEVELOPMENT: 'dev@example.com', AUTH_ACCESS_AUD: 'x' },
    ],
  ])('is refused with %s', async (_, env) => {
    expect(await loadKeyring({ TOKENGATE_KEK: DEV_PLACEHOLDER_KEK, ...env })).toEqual({
      ok: false,
      error: 'dev_placeholder_key',
    });
    expect(await loadKeyring({ TOKENGATE_KEYRING: DEV_PLACEHOLDER_KEK, ...env })).toEqual({
      ok: false,
      error: 'dev_placeholder_key',
    });
    const withKek = await keyringOf({
      TOKENGATE_KEK: K1,
      TOKENGATE_KEYRING: DEV_PLACEHOLDER_KEK,
      ...env,
    });
    expect(withKek.next).toBe('dev_placeholder');
  });

  it('is accepted in development mode only', async () => {
    const result = await loadKeyring({
      TOKENGATE_KEK: DEV_PLACEHOLDER_KEK,
      AUTH_ACCESS_DEVELOPMENT: 'dev@example.com',
    });
    expect(result.ok).toBe(true);
  });
});

describe('keyCheckValue', () => {
  it.each(vectors.kcv)('KCV of $key_b64 is $kcv', async ({ key_b64, binding_info, kcv }) => {
    const raw = Uint8Array.from(atob(key_b64), (c) => c.charCodeAt(0));
    expect(await keyCheckValue(await boundKey(raw, binding_info))).toBe(kcv);
  });

  it('is 16 lowercase hex characters and differs per key', async () => {
    const a = await keyCheckValue(bytes(32, 1));
    const b = await keyCheckValue(bytes(32, 2));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});
