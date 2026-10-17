import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStoredCredential } from '../../../../src/admin/ops/credentials';
import { keyringStatus, rewrapCredentials } from '../../../../src/admin/ops/keyring';
import { sealedKid } from '../../../../src/crypto/envelope';
import { loadKeyring } from '../../../../src/crypto/keyring';
import { getService } from '../../../../src/db/credentials';
import { TEST_ACCESS_ENV } from '../../../helpers/app';
import {
  ACTOR,
  auditCount,
  auditRows,
  KEK_1,
  KEK_2,
  KEYRING_1_2,
  opsDeps,
  resetControlPlane,
  seedService,
} from './helpers';

const rotated = () => opsDeps({ env: { TOKENGATE_KEK: '', TOKENGATE_KEYRING: KEYRING_1_2 } });

async function kidOf(id: string): Promise<string | null> {
  return sealedKid((await getService(env.DB, id))?.credential_sealed ?? null);
}

beforeEach(resetControlPlane);

describe('keyringStatus', () => {
  it('reports keys, KCVs and credentials per kid', async () => {
    const old = opsDeps();
    await seedService(old, { slug: 'a', secret: 'secret-a-0123456789' });
    await seedService(old, { slug: 'b', secret: 'secret-b-0123456789' });
    await seedService(old, { slug: 'c' });
    const keyring = await loadKeyring({ ...TEST_ACCESS_ENV, TOKENGATE_KEYRING: KEYRING_1_2 });
    if (!keyring.ok) throw new Error(keyring.error);

    const status = await keyringStatus(rotated());
    expect(status).toEqual({
      error: null,
      activeKid: 'k2',
      keys: [
        { kid: 'k1', kcv: keyring.keyring.kcv.k1, active: false, credentials: 2 },
        { kid: 'k2', kcv: keyring.keyring.kcv.k2, active: true, credentials: 0 },
      ],
      credentialsByKid: { k1: 2 },
      missingKids: [],
      unreadableCredentials: 0,
      needsRewrap: 2,
    });
  });

  it('reports missing kids, unreadable values and keyring errors', async () => {
    const id = await seedService(opsDeps(), { slug: 'a', secret: 'secret-a-0123456789' });
    await seedService(opsDeps(), { slug: 'b', secret: 'secret-b-0123456789' });
    await env.DB.prepare("UPDATE credentials SET credential_sealed = 'garbage' WHERE id = ?")
      .bind(id)
      .run();
    const status = await keyringStatus(
      opsDeps({
        env: {
          TOKENGATE_KEK: '',
          TOKENGATE_KEYRING: JSON.stringify({ active: 'k2', keys: { k2: KEK_2 } }),
        },
      }),
    );
    expect(status).toMatchObject({ missingKids: ['k1'], unreadableCredentials: 1, needsRewrap: 1 });

    const broken = await keyringStatus(opsDeps({ env: { TOKENGATE_KEK: '' } }));
    expect(broken).toMatchObject({
      error: 'keyring_absent',
      activeKid: null,
      keys: [],
      missingKids: ['k1'],
    });
  });
});

describe('rewrapCredentials', () => {
  it('re-seals every credential under the active key with one audit row', async () => {
    const a = await seedService(opsDeps(), { slug: 'a', secret: 'secret-a-0123456789' });
    const b = await seedService(opsDeps(), { slug: 'b', secret: 'secret-b-0123456789' });
    const deps = rotated();
    const before = await auditCount();

    const result = await rewrapCredentials(deps, ACTOR);
    expect(result).toEqual({
      ok: true,
      activeKid: 'k2',
      rewrapped: 2,
      skipped: 0,
      confirmedKids: [],
    });
    expect(await kidOf(a)).toBe('k2');
    expect(await kidOf(b)).toBe('k2');
    expect(await auditCount()).toBe(before + 1);
    const audit = (await auditRows('k2')).at(-1);
    expect(audit).toMatchObject({ action: 'keyring.rewrap', target_type: 'keyring' });
    expect(audit?.diff).toEqual({ active_kid: 'k2', candidates: 2, from_kids: { k1: 2 } });

    // The rewrapped credential opens with k2 alone, with the unchanged AAD.
    const k2Only = await loadKeyring({
      ...TEST_ACCESS_ENV,
      TOKENGATE_KEYRING: JSON.stringify({ active: 'k2', keys: { k2: KEK_2 } }),
    });
    if (!k2Only.ok) throw new Error(k2Only.error);
    const service = await getService(env.DB, a);
    if (!service) throw new Error('missing');
    expect(await openStoredCredential(k2Only.keyring, service)).toEqual({
      ok: true,
      plaintext: 'secret-a-0123456789',
    });

    // Idempotent: nothing left to rewrap, so nothing is written or audited.
    expect(await rewrapCredentials(deps, ACTOR)).toMatchObject({ rewrapped: 0, skipped: 0 });
    expect(await auditCount()).toBe(before + 1);
  });

  it('refuses and writes nothing when a referenced kid is missing', async () => {
    await seedService(opsDeps(), { slug: 'a', secret: 'secret-a-0123456789' });
    const id = await seedService(
      opsDeps({
        env: {
          TOKENGATE_KEK: '',
          TOKENGATE_KEYRING: JSON.stringify({ active: 'k0', keys: { k0: KEK_2 } }),
        },
      }),
      { slug: 'b', secret: 'secret-b-0123456789' },
    );
    const before = await auditCount();
    const result = await rewrapCredentials(rotated(), ACTOR);
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    if (result.ok) return;
    expect(result.errors).toEqual([
      'The credential of service b was encrypted with key "k0", which is not in the keyring. Add the key back, or set the credential again.',
      'Nothing was re-encrypted.',
    ]);
    expect(await kidOf(id)).toBe('k0');
    expect(await auditCount()).toBe(before);
  });

  it('refuses when a credential fails to open (tampered binding)', async () => {
    const id = await seedService(opsDeps(), { slug: 'a', secret: 'secret-a-0123456789' });
    await env.DB.prepare(
      "UPDATE credentials SET base_url = 'https://evil.example.net' WHERE id = ?",
    )
      .bind(id)
      .run();
    const result = await rewrapCredentials(rotated(), ACTOR);
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    if (result.ok) return;
    expect(result.errors.join()).toMatch(
      /The stored credential of service a cannot be opened: it does not match the service's current base URL or injection/,
    );
    expect(result.errors.join()).not.toMatch(/credential_binding_mismatch/);
  });

  it('refuses without a valid keyring', async () => {
    const result = await rewrapCredentials(opsDeps({ env: { TOKENGATE_KEK: 'bad' } }), ACTOR);
    expect(result).toMatchObject({
      ok: false,
      reason: 'unavailable',
      errors: [
        'A configured key is not exactly 32 bytes encoded as base64.',
        'Nothing was re-encrypted.',
      ],
    });
    expect(KEK_1).not.toBe(KEK_2);
  });
});
