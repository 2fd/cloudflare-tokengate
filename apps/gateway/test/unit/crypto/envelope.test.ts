import { describe, expect, it } from 'vitest';
import {
  credentialAad,
  openCredential,
  sealCredential,
  sealedKid,
} from '../../../src/crypto/envelope';
import { type Keyring, type KeyringEnv, loadKeyring } from '../../../src/crypto/keyring';
import { fromBase64Url, fromUtf8, toBase64, toBase64Url } from '../../../src/lib/encoding';
import vectors from '../../vectors/sealed.json';

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
const secureRandom = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** Returns the given outputs in order and records the requested lengths. */
function scriptedRandom(outputs: Uint8Array[]) {
  const queue = [...outputs];
  const requested: number[] = [];
  const random = (n: number) => {
    requested.push(n);
    const next = queue.shift();
    if (!next) throw new Error('scripted random exhausted');
    return next;
  };
  return { random, requested, remaining: () => queue.length };
}

async function keyringOf(env: KeyringEnv): Promise<Keyring> {
  const result = await loadKeyring(env);
  if (!result.ok) throw new Error(result.error);
  return result.keyring;
}

const K1 = toBase64(Uint8Array.from({ length: 32 }, (_, i) => i));
const K2 = toBase64(Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i));
const OTHER = toBase64(Uint8Array.from({ length: 32 }, () => 0x55));

const SLACK = { id: 'svc_slack', baseUrl: 'https://slack.com/api', injection: '{"kind":"bearer"}' };
const OPENAI = {
  id: 'svc_openai',
  baseUrl: 'https://api.openai.com/v1',
  injection: '{"kind":"bearer"}',
};
const aadOf = (s: typeof SLACK) => credentialAad(s.id, s.baseUrl, s.injection);

type SealedFields = Record<string, unknown>;
const edit = (sealed: string, change: (doc: SealedFields) => void) => {
  const doc = JSON.parse(sealed) as SealedFields;
  change(doc);
  return JSON.stringify(doc);
};
const resize = (field: string, delta: number) => (doc: SealedFields) => {
  const raw = fromBase64Url(doc[field] as string);
  const next =
    delta < 0
      ? raw.subarray(0, raw.length + delta)
      : new Uint8Array([...raw, ...new Uint8Array(delta)]);
  doc[field] = toBase64Url(next);
};

describe('sealed v1 known-answer vectors', () => {
  it.each(vectors.sealed)('$name', async (vector) => {
    const keyring = await keyringOf(vector.env);
    const aad = credentialAad(vector.service_id, vector.base_url, vector.injection_json);
    expect(fromUtf8(aad)).toBe(vector.aad_utf8);

    const scripted = scriptedRandom(vector.random_hex.map(fromHex));
    const sealed = await sealCredential(keyring, vector.plaintext, aad, scripted.random);
    expect(sealed).toBe(vector.sealed);
    expect(scripted.requested).toEqual([32, 12, 12]);
    expect(scripted.remaining()).toBe(0);

    expect(await openCredential(keyring, vector.sealed, aad)).toEqual({
      ok: true,
      plaintext: vector.plaintext,
    });
    expect(sealedKid(vector.sealed)).toBe(keyring.activeKid);
  });

  it.each(vectors.sealed.filter((vector) => 'legacy_sealed' in vector))(
    '$name: the value sealed before ADR 0027 under kid k1 still opens',
    async (vector) => {
      const keyring = await keyringOf(vector.env);
      const aad = credentialAad(vector.service_id, vector.base_url, vector.injection_json);
      const legacy = (vector as { legacy_sealed: string }).legacy_sealed;
      expect(sealedKid(legacy)).toBe('k1');
      expect(await openCredential(keyring, legacy, aad)).toEqual({
        ok: true,
        plaintext: vector.plaintext,
      });
    },
  );
});

describe('sealCredential', () => {
  it('round-trips with real randomness and never repeats nonces or DEKs', async () => {
    const keyring = await keyringOf({ TOKENGATE_KEK: K1 });
    const a = await sealCredential(keyring, 'xoxb-secret', aadOf(SLACK), secureRandom);
    const b = await sealCredential(keyring, 'xoxb-secret', aadOf(SLACK), secureRandom);
    expect(a).not.toBe(b);
    expect(await openCredential(keyring, a, aadOf(SLACK))).toEqual({
      ok: true,
      plaintext: 'xoxb-secret',
    });
    expect(await openCredential(keyring, b, aadOf(SLACK))).toEqual({
      ok: true,
      plaintext: 'xoxb-secret',
    });
  });

  it('never contains the plaintext', async () => {
    const keyring = await keyringOf({ TOKENGATE_KEK: K1 });
    const sealed = await sealCredential(keyring, 'sk-live-PLAINTEXT', aadOf(SLACK), secureRandom);
    expect(sealed).not.toContain('PLAINTEXT');
    expect(sealed).not.toContain(toBase64Url(new TextEncoder().encode('sk-live-PLAINTEXT')));
  });

  it('seals under the next key, named by its key check value', async () => {
    const keyring = await keyringOf({ TOKENGATE_KEK: K1, TOKENGATE_KEYRING: K2 });
    const sealed = await sealCredential(keyring, 'v', aadOf(SLACK), secureRandom);
    expect(sealedKid(sealed)).toBe(vectors.kcv[1]?.kcv);
    expect(sealedKid(sealed)).toBe(keyring.activeKid);
  });

  it('refuses a random source that returns the wrong length', async () => {
    const keyring = await keyringOf({ TOKENGATE_KEK: K1 });
    await expect(
      sealCredential(keyring, 'v', aadOf(SLACK), () => new Uint8Array(8)),
    ).rejects.toThrow(/wrong length/);
  });

  it.each([
    ['a leading U+FEFF', '﻿token'],
    ['NUL and astral characters', 'a\u0000b\u{1F511}'],
    ['an NFD sequence', 'é'],
  ])('round-trips a plaintext with %s exactly', async (_name, plaintext) => {
    const keyring = await keyringOf({ TOKENGATE_KEK: K1 });
    const sealed = await sealCredential(keyring, plaintext, aadOf(SLACK), secureRandom);
    expect(await openCredential(keyring, sealed, aadOf(SLACK))).toEqual({ ok: true, plaintext });
  });

  it('refuses a plaintext with a lone surrogate instead of sealing a different value', async () => {
    const keyring = await keyringOf({ TOKENGATE_KEK: K1 });
    const error = await sealCredential(
      keyring,
      'sk-\uD800-SECRET',
      aadOf(SLACK),
      secureRandom,
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/well-formed/);
    expect(error?.message).not.toContain('SECRET');
  });

  it('refuses a hand-built keyring whose active kid openCredential would reject', async () => {
    const key = (await keyringOf({ TOKENGATE_KEK: K1 })).key('k1');
    const keyring: Keyring = {
      activeKid: 'k 1',
      kids: ['k 1'],
      kcv: {},
      key: () => key,
      resolve: () => 'k 1',
      currentKid: 'k 1',
      next: 'absent',
      nextKid: null,
    };
    await expect(sealCredential(keyring, 'v', aadOf(SLACK), secureRandom)).rejects.toThrow(
      /invalid active kid/,
    );
  });
});

describe('I-CRED-3: a change of the login variables makes stored credentials undecryptable', () => {
  const access = { AUTH_ACCESS_TEAM_DOMAIN: 'acme', AUTH_ACCESS_AUD: 'a'.repeat(64) };
  const others: Array<[string, KeyringEnv]> = [
    ['no login variable', {}],
    ['another AUD', { ...access, AUTH_ACCESS_AUD: 'b'.repeat(64) }],
    ['another team domain', { ...access, AUTH_ACCESS_TEAM_DOMAIN: 'other' }],
    [
      'the team domain written differently',
      { ...access, AUTH_ACCESS_TEAM_DOMAIN: 'acme.cloudflareaccess.com' },
    ],
    ['a development login', { AUTH_ACCESS_DEVELOPMENT: 'dev@example.com' }],
    ['Access plus a development login', { ...access, AUTH_ACCESS_DEVELOPMENT: 'dev@example.com' }],
  ];

  it.each(others)('sealed under Access, opened with %s', async (_, env) => {
    const sealed = await sealCredential(
      await keyringOf({ TOKENGATE_KEK: K1, ...access }),
      'xoxb-secret',
      aadOf(SLACK),
      secureRandom,
    );
    expect(
      await openCredential(await keyringOf({ TOKENGATE_KEK: K1, ...env }), sealed, aadOf(SLACK)),
    ).toEqual({
      ok: false,
      error: 'keyring_missing_key',
    });
    expect(
      await openCredential(await keyringOf({ TOKENGATE_KEK: K1, ...access }), sealed, aadOf(SLACK)),
    ).toEqual({ ok: true, plaintext: 'xoxb-secret' });
  });

  it.each(others)('sealed under Access with the legacy kid k1, opened with %s', async (_, env) => {
    const sealed = edit(
      await sealCredential(
        await keyringOf({ TOKENGATE_KEK: K1, ...access }),
        'xoxb-secret',
        aadOf(SLACK),
        secureRandom,
      ),
      (doc) => {
        doc.kid = 'k1';
      },
    );
    expect(
      await openCredential(await keyringOf({ TOKENGATE_KEK: K1, ...env }), sealed, aadOf(SLACK)),
    ).toEqual({ ok: false, error: 'credential_binding_mismatch' });
  });
});

describe('credentialAad', () => {
  it('is the label, service id, base URL and injection JSON joined by newlines', () => {
    expect(fromUtf8(credentialAad('svc_1', 'https://x.test/api', '{"kind":"bearer"}'))).toBe(
      'tokengate/v1/service-credential\nsvc_1\nhttps://x.test/api\n{"kind":"bearer"}',
    );
  });

  it.each([
    ['svc\n1', 'https://x.test', '{}'],
    ['svc_1', 'https://x.test\nhttps://y.test', '{}'],
  ])('rejects newlines in the id or base URL (%j, %j)', (id, baseUrl, injection) => {
    expect(() => credentialAad(id, baseUrl, injection)).toThrow(/newlines/);
  });
});

describe('I-CRED-2: sealed credentials are bound to service id, base URL and injection', () => {
  const setup = async () => {
    const keyring = await keyringOf({ TOKENGATE_KEK: K1, TOKENGATE_KEYRING: K2 });
    const slack = await sealCredential(keyring, 'xoxb-slack', aadOf(SLACK), secureRandom);
    const openai = await sealCredential(keyring, 'sk-openai', aadOf(OPENAI), secureRandom);
    return { keyring, slack, openai };
  };
  const mismatch = { ok: false, error: 'credential_binding_mismatch' };

  it.each([
    ['service id', { ...SLACK, id: 'svc_other' }],
    ['base URL repointed', { ...SLACK, baseUrl: 'https://attacker.example/api' }],
    ['base URL with trailing slash', { ...SLACK, baseUrl: 'https://slack.com/api/' }],
    ['injection kind', { ...SLACK, injection: '{"kind":"query","param":"token"}' }],
    ['injection header name', { ...SLACK, injection: '{"kind":"header","name":"x-leak"}' }],
  ])('AAD mismatch on %s fails closed', async (_name, binding) => {
    const { keyring, slack } = await setup();
    expect(await openCredential(keyring, slack, aadOf(binding))).toEqual(mismatch);
  });

  it('a sealed value copied to another service row does not open', async () => {
    const { keyring, slack } = await setup();
    expect(await openCredential(keyring, slack, aadOf(OPENAI))).toEqual(mismatch);
  });

  it.each([['ct'], ['wdek'], ['iv'], ['dek_iv'], ['ct', 'iv'], ['wdek', 'dek_iv']])(
    'swapping %s between two credentials fails closed',
    async (...fields) => {
      const { keyring, slack, openai } = await setup();
      const donor = JSON.parse(openai) as SealedFields;
      const spliced = edit(slack, (doc) => {
        for (const field of fields) doc[field] = donor[field];
      });
      expect(await openCredential(keyring, spliced, aadOf(SLACK))).toEqual(mismatch);
      expect(await openCredential(keyring, spliced, aadOf(OPENAI))).toEqual(mismatch);
    },
  );

  it('relabelling the kid to another loaded key fails closed', async () => {
    const { keyring, slack } = await setup();
    for (const kid of [keyring.currentKid as string, 'k1']) {
      const relabelled = edit(slack, (doc) => {
        doc.kid = kid;
      });
      expect(await openCredential(keyring, relabelled, aadOf(SLACK))).toEqual(mismatch);
    }
  });

  it('a kid that is not loaded reports keyring_missing_key', async () => {
    const { keyring, slack } = await setup();
    for (const kid of ['k9', 'constructor', 'hasOwnProperty']) {
      const unknown = edit(slack, (doc) => {
        doc.kid = kid;
      });
      expect(await openCredential(keyring, unknown, aadOf(SLACK))).toEqual({
        ok: false,
        error: 'keyring_missing_key',
      });
    }
    const withoutK2 = await keyringOf({ TOKENGATE_KEK: K1 });
    expect(await openCredential(withoutK2, slack, aadOf(SLACK))).toEqual({
      ok: false,
      error: 'keyring_missing_key',
    });
  });

  it('different key material under the legacy kid k1 fails closed', async () => {
    const original = await keyringOf({ TOKENGATE_KEK: K1 });
    const legacy = edit(await sealCredential(original, 'v', aadOf(SLACK), secureRandom), (doc) => {
      doc.kid = 'k1';
    });
    expect(await openCredential(original, legacy, aadOf(SLACK))).toEqual({
      ok: true,
      plaintext: 'v',
    });
    const replaced = await keyringOf({ TOKENGATE_KEK: OTHER });
    expect(await openCredential(replaced, legacy, aadOf(SLACK))).toEqual(mismatch);
  });

  it('flipping a bit in any byte of ct, wdek, iv or dek_iv fails closed', async () => {
    const { keyring, slack } = await setup();
    for (const field of ['ct', 'wdek', 'iv', 'dek_iv']) {
      const length = fromBase64Url((JSON.parse(slack) as SealedFields)[field] as string).length;
      for (let i = 0; i < length; i++) {
        const flipped = edit(slack, (doc) => {
          const raw = fromBase64Url(doc[field] as string);
          raw[i] = (raw[i] ?? 0) ^ 0x01;
          doc[field] = toBase64Url(raw);
        });
        expect(await openCredential(keyring, flipped, aadOf(SLACK))).toEqual(mismatch);
      }
    }
  });

  it.each([
    ['ct shortened by one byte', resize('ct', -1)],
    [
      'ct shortened to the tag length',
      (doc: SealedFields) => {
        doc.ct = toBase64Url(fromBase64Url(doc.ct as string).subarray(-16));
      },
    ],
    ['ct extended by one byte', resize('ct', 1)],
  ])('%s fails closed', async (_name, change) => {
    const { keyring, slack } = await setup();
    expect(await openCredential(keyring, edit(slack, change), aadOf(SLACK))).toEqual(mismatch);
  });
});

describe('openCredential rejects malformed sealed values', () => {
  const vector = vectors.sealed[2];
  if (!vector) throw new Error('missing vector');
  const aad = credentialAad(vector.service_id, vector.base_url, vector.injection_json);
  const malformed = { ok: false, error: 'sealed_malformed' };

  it.each<[string, string]>([
    ['empty string', ''],
    ['not JSON', 'sealed'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['iv truncated to 11 bytes', edit(vector.sealed, resize('iv', -1))],
    ['iv extended to 13 bytes', edit(vector.sealed, resize('iv', 1))],
    ['dek_iv truncated', edit(vector.sealed, resize('dek_iv', -1))],
    ['wdek truncated', edit(vector.sealed, resize('wdek', -1))],
    ['wdek without its tag', edit(vector.sealed, resize('wdek', -16))],
    ['ct shorter than the tag', edit(vector.sealed, resize('ct', -1))],
    [
      'ct empty',
      edit(vector.sealed, (d) => {
        d.ct = '';
      }),
    ],
    [
      'version 2',
      edit(vector.sealed, (d) => {
        d.v = 2;
      }),
    ],
    [
      'version as string',
      edit(vector.sealed, (d) => {
        d.v = '1';
      }),
    ],
    [
      'missing field',
      edit(vector.sealed, (d) => {
        delete d.dek_iv;
      }),
    ],
    [
      'extra field',
      edit(vector.sealed, (d) => {
        d.alg = 'none';
      }),
    ],
    [
      'kid not a string',
      edit(vector.sealed, (d) => {
        d.kid = 1;
      }),
    ],
    [
      'kid with invalid characters',
      edit(vector.sealed, (d) => {
        d.kid = 'k1/../k2';
      }),
    ],
    [
      'field with standard base64 characters',
      edit(vector.sealed, (d) => {
        d.wdek = `+${(d.wdek as string).slice(1)}`;
      }),
    ],
    [
      'field with padding',
      edit(vector.sealed, (d) => {
        d.ct = `${d.ct as string}==`;
      }),
    ],
    // ct is 16 bytes in this vector, so its last base64url character carries 4 unused bits.
    [
      'non-canonical base64url',
      edit(vector.sealed, (d) => {
        d.ct = (d.ct as string).replace(/g$/, 'h');
      }),
    ],
    [
      'field as number',
      edit(vector.sealed, (d) => {
        d.iv = 0;
      }),
    ],
  ])('%s', async (_name, sealed) => {
    const keyring = await keyringOf(vector.env);
    expect(sealed).not.toBe(vector.sealed);
    expect(await openCredential(keyring, sealed, aad)).toEqual(malformed);
    expect(sealedKid(sealed)).toBeNull();
  });
});

describe('sealedKid', () => {
  it('returns null for null and the kid for well-formed values', () => {
    expect(sealedKid(null)).toBeNull();
    for (const vector of vectors.sealed) {
      expect(sealedKid(vector.sealed)).toBe((JSON.parse(vector.sealed) as { kid: string }).kid);
    }
  });
});
