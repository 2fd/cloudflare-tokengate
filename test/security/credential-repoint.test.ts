// I-CRED-2: a credential is bound to (service id, base_url, injection). The admin ops cannot change
// the binding without re-entering the credential, re-sealing uses the new AAD, and rows edited
// directly in D1 fail closed.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { rewrapCredentials } from '../../src/admin/ops/keyring';
import {
  openStoredCredential,
  setServiceCredential,
  testServiceCredential,
  updateServiceFields,
} from '../../src/admin/ops/services';
import { credentialAad, openCredential } from '../../src/crypto/envelope';
import { loadKeyring } from '../../src/crypto/keyring';
import {
  getService,
  serviceCredentialGuard,
  updateServiceCredentialStatement,
} from '../../src/db/services';
import type { Service } from '../../src/db/types';
import {
  ACTOR,
  CONTEXT,
  fakeNetwork,
  KEK_1,
  KEYRING_1_2,
  opsDeps,
  resetControlPlane,
  seedService,
} from '../unit/admin/ops/helpers';

const SECRET = 'repoint-secret-0123456789abcdef';
const VERIFY = { method: 'GET' as const, path: '/rate_limit', expect_status: 200 };

async function keyring() {
  const loaded = await loadKeyring({ TOKENGATE_KEK: KEK_1 });
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.keyring;
}

async function stored(id: string): Promise<Service> {
  const service = await getService(env.DB, id);
  if (!service) throw new Error('service missing');
  return service;
}

beforeEach(resetControlPlane);

describe('I-CRED-2: updateServiceFields cannot change the binding', () => {
  it.each([
    ['base_url', { base_url: 'https://evil.example.net' }],
    ['injection', { injection: { kind: 'query', param: 'token' } }],
    ['both', { name: 'x', base_url: 'https://evil.example.net', injection: { kind: 'basic' } }],
  ])('refuses %s', async (_, patch) => {
    const deps = opsDeps();
    const id = await seedService(deps, { secret: SECRET });
    const before = await stored(id);
    const result = await updateServiceFields(deps, ACTOR, id, patch as never);
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await stored(id)).toEqual(before);
    expect(await openStoredCredential(await keyring(), before)).toEqual({
      ok: true,
      plaintext: SECRET,
    });
  });
});

describe('I-CRED-2: setServiceCredential re-seals with the new AAD', () => {
  it('binds the new ciphertext to the new configuration only', async () => {
    const deps = opsDeps();
    const id = await seedService(deps, { secret: SECRET });
    const old = await stored(id);

    const result = await setServiceCredential(
      deps,
      ACTOR,
      id,
      { base_url: 'https://uploads.github.com', injection: { kind: 'bearer' }, secret: SECRET },
      CONTEXT,
    );
    expect(result.ok).toBe(true);
    const next = await stored(id);
    expect(next.credential_sealed).not.toBe(old.credential_sealed);
    const ring = await keyring();
    const newAad = credentialAad(id, next.base_url, next.injection_json);
    const oldAad = credentialAad(id, old.base_url, old.injection_json);

    expect(await openCredential(ring, next.credential_sealed as string, newAad)).toEqual({
      ok: true,
      plaintext: SECRET,
    });
    // New ciphertext under the old binding, and old ciphertext under the new binding: both fail.
    expect(await openCredential(ring, next.credential_sealed as string, oldAad)).toEqual({
      ok: false,
      error: 'credential_binding_mismatch',
    });
    expect(await openCredential(ring, old.credential_sealed as string, newAad)).toEqual({
      ok: false,
      error: 'credential_binding_mismatch',
    });
  });

  it('writes only if the binding is unchanged since it was read (compare-and-swap)', async () => {
    const deps = opsDeps();
    const id = await seedService(deps, { secret: SECRET });
    const snapshot = await stored(id);
    await setServiceCredential(
      deps,
      ACTOR,
      id,
      { base_url: 'https://uploads.github.com', injection: { kind: 'bearer' }, secret: SECRET },
      CONTEXT,
    );
    const statement = updateServiceCredentialStatement(
      env.DB,
      id,
      {
        base_url: snapshot.base_url,
        injection_json: snapshot.injection_json,
        credential_sealed: snapshot.credential_sealed as string,
        credential_hint: null,
        credential_expires_at: null,
      },
      Date.now(),
      serviceCredentialGuard(snapshot),
    );
    expect((await statement.run()).meta.changes).toBe(0);
    expect((await stored(id)).base_url).toBe('https://uploads.github.com');
  });
});

describe('I-CRED-2: rows edited in D1 fail closed', () => {
  it.each([
    ['base_url', "UPDATE services SET base_url = 'https://evil.example.net' WHERE id = ?"],
    ['injection', `UPDATE services SET injection = '{"kind":"query","param":"key"}' WHERE id = ?`],
  ])('an edited %s makes the credential unusable without any upstream call', async (_, sql) => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    const id = await seedService(deps, { secret: SECRET, verify: VERIFY });
    await env.DB.prepare(sql).bind(id).run();
    const calls = network.calls.length;

    expect(await openStoredCredential(await keyring(), await stored(id))).toEqual({
      ok: false,
      error: 'credential_binding_mismatch',
    });
    expect(await testServiceCredential(deps, ACTOR, id, CONTEXT)).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
    const rotated = opsDeps({ env: { TOKENGATE_KEK: '', TOKENGATE_KEYRING: KEYRING_1_2 } });
    expect(await rewrapCredentials(rotated, ACTOR)).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
    expect(network.calls.length).toBe(calls);
  });

  it('ciphertext copied to another service does not open', async () => {
    const deps = opsDeps();
    const a = await seedService(deps, { slug: 'a', secret: SECRET });
    const b = await seedService(deps, { slug: 'b', secret: 'other-secret-0123456789' });
    await env.DB.prepare(
      'UPDATE services SET credential_sealed = (SELECT credential_sealed FROM services WHERE id = ?) WHERE id = ?',
    )
      .bind(a, b)
      .run();
    expect(await openStoredCredential(await keyring(), await stored(b))).toEqual({
      ok: false,
      error: 'credential_binding_mismatch',
    });
  });
});
