// Key check value bookkeeping for credentials sealed before ADR 0027 under the legacy kid k1: a
// TOKENGATE_KEK replaced under it stays reported until every credential under k1 is known to open
// with the new key. New seals name their key by its check value, which cannot change.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteService,
  openStoredCredential,
  setServiceCredential,
} from '../../../../src/admin/ops/credentials';
import { rewrapCredentials } from '../../../../src/admin/ops/keyring';
import { loadKeyring } from '../../../../src/crypto/keyring';
import { getService } from '../../../../src/db/credentials';
import { keyringHealth } from '../../../../src/health';
import {
  ACTOR,
  auditRows,
  CONTEXT,
  KEK_2,
  opsDeps,
  resetControlPlane,
  seedService,
} from './helpers';

const keyA = () => opsDeps();
const keyB = () => opsDeps({ env: { TOKENGATE_KEK: KEK_2 } });

/** A credential sealed before ADR 0027: kid k1, with k1's check value recorded. */
async function seedLegacy(slug: string, secret: string): Promise<string> {
  const id = await seedService(keyA(), { slug, secret });
  const loaded = await loadKeyring(keyA().env);
  if (!loaded.ok) throw new Error(loaded.error);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE credentials SET credential_sealed = json_set(credential_sealed, '$.kid', 'k1') WHERE id = ?",
    ).bind(id),
    env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('keyring_kcv', json_object('k1', ?), 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).bind(loaded.keyring.activeKid),
  ]);
  return id;
}

async function opens(id: string): Promise<boolean> {
  const loaded = await loadKeyring(keyB().env);
  const service = await getService(env.DB, id);
  if (!loaded.ok || !service) throw new Error('setup');
  return (await openStoredCredential(loaded.keyring, service)).ok;
}

beforeEach(async () => {
  await resetControlPlane();
  await env.DB.prepare("DELETE FROM settings WHERE key = 'keyring_kcv'").run();
});

describe('keyring_kcv after the KEK is replaced under kid k1', () => {
  it('a credential saved with the new key does not clear the alert for older ones', async () => {
    const one = await seedLegacy('one', 'secret-one-0123456789');
    expect((await keyringHealth(keyB())).changedKids).toEqual(['k1']);

    await seedService(keyB(), { slug: 'two', secret: 'secret-two-0123456789' });

    const health = await keyringHealth(keyB());
    expect(health).toMatchObject({ ok: false, changedKids: ['k1'] });
    expect(await opens(one)).toBe(false);
  });

  it('rewrap names the credentials that need the old key and writes nothing', async () => {
    await seedLegacy('one', 'secret-one-0123456789');
    await seedService(keyB(), { slug: 'two', secret: 'secret-two-0123456789' });
    const audits = (await auditRows()).length;

    const result = await rewrapCredentials(keyB(), ACTOR);

    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(
      /credential one was encrypted with an earlier key "k1"/,
    );
    expect(result.errors.join(' ')).not.toMatch(/credential two/);
    expect((await auditRows()).length).toBe(audits);
    expect((await keyringHealth(keyB())).changedKids).toEqual(['k1']);
  });

  it('once every k1 credential is set again, the alert clears: new seals use the key check value', async () => {
    const one = await seedLegacy('one', 'secret-one-0123456789');
    await seedService(keyB(), { slug: 'two', secret: 'secret-two-0123456789' });
    const reset = await setServiceCredential(
      keyB(),
      ACTOR,
      one,
      {
        base_url: 'https://api.github.com',
        injection: { kind: 'bearer' },
        secret: 'secret-one-new-0123456789',
        // The old key is gone, so the stored destination is unattested (I-CRED-2).
        confirm_destination: 'api.github.com',
      },
      CONTEXT,
    );
    expect(reset.ok).toBe(true);
    // No credential uses k1 any more, so nothing can need the old key.
    expect(await keyringHealth(keyB())).toMatchObject({ ok: true, changedKids: [] });
    expect(await rewrapCredentials(keyB(), ACTOR)).toMatchObject({
      ok: true,
      queued: 0,
      confirmedKids: [],
    });
  });

  it('records the new value when no other credential uses the kid', async () => {
    const one = await seedLegacy('one', 'secret-one-0123456789');
    expect((await deleteService(keyA(), ACTOR, one)).ok).toBe(true);
    await seedService(keyB(), { slug: 'two', secret: 'secret-two-0123456789' });
    expect(await keyringHealth(keyB())).toMatchObject({ ok: true, changedKids: [] });
  });
});
