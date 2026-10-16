// Key check value bookkeeping: a KEK replaced under the same kid stays reported until every
// credential under that kid is known to open with the new key.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { rewrapCredentials } from '../../../../src/admin/ops/keyring';
import {
  deleteService,
  openStoredCredential,
  setServiceCredential,
} from '../../../../src/admin/ops/services';
import { loadKeyring } from '../../../../src/crypto/keyring';
import { getService } from '../../../../src/db/services';
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
    const one = await seedService(keyA(), { slug: 'one', secret: 'secret-one-0123456789' });
    expect((await keyringHealth(keyB())).changedKids).toEqual(['k1']);

    await seedService(keyB(), { slug: 'two', secret: 'secret-two-0123456789' });

    const health = await keyringHealth(keyB());
    expect(health).toMatchObject({ ok: false, changedKids: ['k1'] });
    expect(await opens(one)).toBe(false);
  });

  it('rewrap names the credentials that need the old key and writes nothing', async () => {
    await seedService(keyA(), { slug: 'one', secret: 'secret-one-0123456789' });
    await seedService(keyB(), { slug: 'two', secret: 'secret-two-0123456789' });
    const audits = (await auditRows()).length;

    const result = await rewrapCredentials(keyB(), ACTOR);

    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/service one was encrypted with an earlier key "k1"/);
    expect(result.errors.join(' ')).not.toMatch(/service two/);
    expect((await auditRows()).length).toBe(audits);
    expect((await keyringHealth(keyB())).changedKids).toEqual(['k1']);
  });

  it('once every credential is set again, rewrap accepts the new key and clears the alert', async () => {
    const one = await seedService(keyA(), { slug: 'one', secret: 'secret-one-0123456789' });
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
    // The recorded value is kept: from the counts alone, "two" could still need the old key.
    expect((await keyringHealth(keyB())).changedKids).toEqual(['k1']);

    const result = await rewrapCredentials(keyB(), ACTOR);

    expect(result).toMatchObject({ ok: true, rewrapped: 0, confirmedKids: ['k1'] });
    expect(await keyringHealth(keyB())).toMatchObject({ ok: true, changedKids: [] });
    expect((await auditRows()).at(-1)).toMatchObject({
      action: 'keyring.rewrap',
      diff: { confirmed_kids: ['k1'] },
    });
  });

  it('records the new value when no other credential uses the kid', async () => {
    const one = await seedService(keyA(), { slug: 'one', secret: 'secret-one-0123456789' });
    expect((await deleteService(keyA(), ACTOR, one)).ok).toBe(true);
    await seedService(keyB(), { slug: 'two', secret: 'secret-two-0123456789' });
    expect(await keyringHealth(keyB())).toMatchObject({ ok: true, changedKids: [] });
  });
});
