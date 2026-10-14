import { describe, expect, it } from 'vitest';
import devVarsExample from '../../../.dev.vars.example?raw';
import {
  boundKey,
  DEV_PLACEHOLDER_KEK,
  type KeyringEnv,
  type KeyringError,
  kekBindingInfo,
  keyCheckValue,
  loadKeyring,
} from '../../../src/crypto/keyring';
import { toBase64 } from '../../../src/lib/encoding';
import vectors from '../../vectors/sealed.json';

const bytes = (length: number, start = 0) =>
  Uint8Array.from({ length }, (_, i) => (start + i) & 0xff);
const K1 = toBase64(bytes(32, 0x00));
const K2 = toBase64(bytes(32, 0x80));
const ring = (doc: unknown) => JSON.stringify(doc);

describe('loadKeyring errors', () => {
  const cases: Array<
    [string, { TOKENGATE_KEK?: string; TOKENGATE_KEYRING?: string }, KeyringError]
  > = [
    ['neither set', {}, 'keyring_absent'],
    ['both empty strings', { TOKENGATE_KEK: '', TOKENGATE_KEYRING: '' }, 'keyring_absent'],
    ['KEK whitespace only', { TOKENGATE_KEK: ' \n' }, 'keyring_absent'],
    [
      'both set',
      { TOKENGATE_KEK: K1, TOKENGATE_KEYRING: ring({ active: 'k1', keys: { k1: K1 } }) },
      'both_kek_and_keyring_set',
    ],
    [
      'both set, both invalid',
      { TOKENGATE_KEK: 'x', TOKENGATE_KEYRING: 'y' },
      'both_kek_and_keyring_set',
    ],

    ['KEK not base64', { TOKENGATE_KEK: 'not base64!' }, 'keyring_malformed'],
    ['KEK with a base64url character', { TOKENGATE_KEK: `-${K1.slice(1)}` }, 'keyring_malformed'],
    ['KEK bad padding', { TOKENGATE_KEK: `${toBase64(bytes(31))}==` }, 'keyring_malformed'],
    [
      'KEK given keyring JSON',
      { TOKENGATE_KEK: ring({ active: 'k1', keys: { k1: K1 } }) },
      'keyring_malformed',
    ],
    ['KEK 16 bytes', { TOKENGATE_KEK: toBase64(bytes(16)) }, 'key_not_32_bytes'],
    ['KEK 31 bytes', { TOKENGATE_KEK: toBase64(bytes(31)) }, 'key_not_32_bytes'],
    ['KEK 33 bytes', { TOKENGATE_KEK: toBase64(bytes(33)) }, 'key_not_32_bytes'],
    ['KEK 64 bytes', { TOKENGATE_KEK: toBase64(bytes(64)) }, 'key_not_32_bytes'],

    ['keyring not JSON', { TOKENGATE_KEYRING: '{active: k1}' }, 'keyring_malformed'],
    ['keyring null', { TOKENGATE_KEYRING: 'null' }, 'keyring_malformed'],
    ['keyring array', { TOKENGATE_KEYRING: '[]' }, 'keyring_malformed'],
    ['keyring string', { TOKENGATE_KEYRING: '"k1"' }, 'keyring_malformed'],
    ['keyring bare base64', { TOKENGATE_KEYRING: K1 }, 'keyring_malformed'],
    ['missing active', { TOKENGATE_KEYRING: ring({ keys: { k1: K1 } }) }, 'keyring_malformed'],
    ['missing keys', { TOKENGATE_KEYRING: ring({ active: 'k1' }) }, 'keyring_malformed'],
    [
      'unknown field',
      { TOKENGATE_KEYRING: ring({ active: 'k1', keys: { k1: K1 }, extra: 1 }) },
      'keyring_malformed',
    ],
    [
      'active not a string',
      { TOKENGATE_KEYRING: ring({ active: 1, keys: { 1: K1 } }) },
      'keyring_malformed',
    ],
    [
      'keys is an array',
      { TOKENGATE_KEYRING: ring({ active: 'k1', keys: [K1] }) },
      'keyring_malformed',
    ],
    [
      'key value not a string',
      { TOKENGATE_KEYRING: ring({ active: 'k1', keys: { k1: 42 } }) },
      'keyring_malformed',
    ],
    [
      'kid with space',
      { TOKENGATE_KEYRING: ring({ active: 'k 1', keys: { 'k 1': K1 } }) },
      'keyring_malformed',
    ],
    [
      'kid __proto__',
      { TOKENGATE_KEYRING: `{"active":"k1","keys":{"k1":"${K1}","__proto__":"${K2}"}}` },
      'keyring_malformed',
    ],
    [
      'kid empty',
      { TOKENGATE_KEYRING: ring({ active: 'k1', keys: { k1: K1, '': K2 } }) },
      'keyring_malformed',
    ],
    [
      'kid 65 chars',
      { TOKENGATE_KEYRING: ring({ active: 'k1', keys: { k1: K1, ['k'.repeat(65)]: K2 } }) },
      'keyring_malformed',
    ],
    [
      'key not base64',
      { TOKENGATE_KEYRING: ring({ active: 'k1', keys: { k1: '***' } }) },
      'keyring_malformed',
    ],

    [
      'active kid not in keys',
      { TOKENGATE_KEYRING: ring({ active: 'k3', keys: { k1: K1, k2: K2 } }) },
      'active_kid_missing',
    ],
    [
      'no keys at all',
      { TOKENGATE_KEYRING: ring({ active: 'k1', keys: {} }) },
      'active_kid_missing',
    ],

    [
      'active key 16 bytes',
      { TOKENGATE_KEYRING: ring({ active: 'k1', keys: { k1: toBase64(bytes(16)) } }) },
      'key_not_32_bytes',
    ],
    [
      'inactive key 16 bytes',
      { TOKENGATE_KEYRING: ring({ active: 'k2', keys: { k1: toBase64(bytes(16)), k2: K2 } }) },
      'key_not_32_bytes',
    ],
  ];

  it.each(cases)('%s → %s', async (_name, env, error) => {
    expect(await loadKeyring(env)).toEqual({ ok: false, error });
  });
});

describe('loadKeyring success', () => {
  it('maps a bare TOKENGATE_KEK to kid k1', async () => {
    const result = await loadKeyring({ TOKENGATE_KEK: K1 });
    if (!result.ok) throw new Error(result.error);
    expect(result.keyring.activeKid).toBe('k1');
    expect(result.keyring.kids).toEqual(['k1']);
    expect(result.keyring.kcv).toEqual({ k1: vectors.kcv[0]?.kcv });
  });

  it('trims surrounding whitespace (secrets pasted with a newline) and accepts unpadded base64', async () => {
    const padded = await loadKeyring({ TOKENGATE_KEK: `  ${K1}\n` });
    const unpadded = await loadKeyring({ TOKENGATE_KEK: K1.replace(/=+$/, '') });
    expect(padded.ok && padded.keyring.kcv).toEqual({ k1: vectors.kcv[0]?.kcv });
    expect(unpadded.ok && unpadded.keyring.kcv).toEqual({ k1: vectors.kcv[0]?.kcv });
  });

  it('loads a multi-key keyring with sorted kids and a KCV per kid', async () => {
    const result = await loadKeyring({
      TOKENGATE_KEYRING: ring({ active: 'k2', keys: { k2: K2, k1: K1 } }),
    });
    if (!result.ok) throw new Error(result.error);
    const { keyring } = result;
    expect(keyring.activeKid).toBe('k2');
    expect(keyring.kids).toEqual(['k1', 'k2']);
    expect(keyring.kcv).toEqual({ k1: vectors.kcv[0]?.kcv, k2: vectors.kcv[1]?.kcv });
    expect(keyring.key('k3')).toBeUndefined();
    expect(keyring.key('toString')).toBeUndefined();
    expect(Object.keys(keyring.kcv)).toEqual(['k1', 'k2']);
    // These match KID_PATTERN, so a tampered sealed kid could name them.
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(inherited in keyring.kcv).toBe(false);
      expect(keyring.kcv[inherited]).toBeUndefined();
    }
  });

  it('imports keys as non-extractable AES-256-GCM encrypt/decrypt keys', async () => {
    const result = await loadKeyring({ TOKENGATE_KEK: K2 });
    if (!result.ok) throw new Error(result.error);
    const key = result.keyring.key('k1');
    expect(key).toBeDefined();
    expect(key?.extractable).toBe(false);
    expect(key?.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect([...(key?.usages ?? [])].sort()).toEqual(['decrypt', 'encrypt']);
    await expect(crypto.subtle.exportKey('raw', key as CryptoKey)).rejects.toThrow();
  });

  it('returns frozen objects', async () => {
    const result = await loadKeyring({ TOKENGATE_KEK: K1 });
    if (!result.ok) throw new Error(result.error);
    expect(Object.isFrozen(result.keyring)).toBe(true);
    expect(Object.isFrozen(result.keyring.kids)).toBe(true);
    expect(Object.isFrozen(result.keyring.kcv)).toBe(true);
  });

  it('caches per raw secret strings', async () => {
    const env = { TOKENGATE_KEYRING: ring({ active: 'k1', keys: { k1: K1, k2: K2 } }) };
    const first = await loadKeyring(env);
    const second = await loadKeyring({ ...env });
    expect(second).toBe(first);
    const other = await loadKeyring({ TOKENGATE_KEK: K2 });
    expect(other).not.toBe(first);
    expect(other.ok && other.keyring.kcv).toEqual({ k1: vectors.kcv[1]?.kcv });
  });
});

describe('I-CRED-3: keys are bound to the login variables', () => {
  const access = { AUTH_ACCESS_TEAM_DOMAIN: 'acme', AUTH_ACCESS_AUD: 'a'.repeat(64) };
  const kcvOf = async (env: KeyringEnv) => {
    const result = await loadKeyring({ TOKENGATE_KEK: K1, ...env });
    if (!result.ok) throw new Error(result.error);
    return result.keyring.kcv.k1;
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
    expect(
      await loadKeyring({
        TOKENGATE_KEYRING: ring({ active: 'k1', keys: { k1: K1, dev: DEV_PLACEHOLDER_KEK } }),
        ...env,
      }),
    ).toEqual({ ok: false, error: 'dev_placeholder_key' });
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
