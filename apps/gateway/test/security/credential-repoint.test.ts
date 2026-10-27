// I-CRED-2: a credential is bound to (service id, base_url, injection). The admin ops cannot change
// the binding without re-entering the credential, re-sealing uses the new AAD, and rows edited
// directly in D1 fail closed. A sealed draft of a secret (A13.6) opens only for its own token and
// destination, so it never follows a repoint.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  destinationFingerprint,
  openStoredCredential,
  setServiceCredential,
  testServiceCredential,
  updateServiceFields,
} from '../../src/admin/ops/credentials';
import { rewrapCredentials } from '../../src/admin/ops/keyring';
import { credentialAad, openCredential } from '../../src/crypto/envelope';
import { loadKeyring } from '../../src/crypto/keyring';
import {
  getService,
  serviceCredentialGuard,
  updateServiceCredentialStatement,
} from '../../src/db/credentials';
import type { Service } from '../../src/db/types';
import { resetAdminWorld } from '../fixtures/admin-forms';
import { adminPost, createUser, loginAs } from '../helpers/admin-auth';
import { createTestApp, TEST_ACCESS_ENV } from '../helpers/app';
import {
  ACTOR,
  CONTEXT,
  fakeNetwork,
  KEK_1,
  ROTATION_ENV,
  opsDeps,
  resetControlPlane,
  seedService,
} from '../unit/admin/ops/helpers';

const SECRET = 'repoint-secret-0123456789abcdef';
const VERIFY = { method: 'GET' as const, path: '/rate_limit', expect_status: 200 };
/** A credential without a type: only these can change their destination. */
const CUSTOM = { slug: 'custom', base_url: 'https://api.example.com', secret: SECRET };

async function keyring() {
  const loaded = await loadKeyring({ ...TEST_ACCESS_ENV, TOKENGATE_KEK: KEK_1 });
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.keyring;
}

async function stored(id: string): Promise<Service> {
  const service = await getService(env.DB, id);
  if (!service) throw new Error('service missing');
  return service;
}

/** The rotate form's digest of the destination stored now (a page loaded at this point). */
async function rotateFields(id: string): Promise<{ expected_destination: string }> {
  return { expected_destination: await destinationFingerprint(await stored(id)) };
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
    const id = await seedService(deps, CUSTOM);
    const old = await stored(id);

    const result = await setServiceCredential(
      deps,
      ACTOR,
      id,
      { base_url: 'https://uploads.example.com', injection: { kind: 'bearer' }, secret: SECRET },
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
    const id = await seedService(deps, CUSTOM);
    const snapshot = await stored(id);
    await setServiceCredential(
      deps,
      ACTOR,
      id,
      { base_url: 'https://uploads.example.com', injection: { kind: 'bearer' }, secret: SECRET },
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
        template_id: null,
      },
      Date.now(),
      serviceCredentialGuard(snapshot),
    );
    expect((await statement.run()).meta.changes).toBe(0);
    expect((await stored(id)).base_url).toBe('https://uploads.example.com');
  });
});

describe('I-CRED-2: rows edited in D1 fail closed', () => {
  it.each([
    ['base_url', "UPDATE credentials SET base_url = 'https://evil.example.net' WHERE id = ?"],
    [
      'injection',
      `UPDATE credentials SET injection = '{"kind":"query","param":"key"}' WHERE id = ?`,
    ],
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
    const rotated = opsDeps({ env: { ...ROTATION_ENV } });
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
      'UPDATE credentials SET credential_sealed = (SELECT credential_sealed FROM credentials WHERE id = ?) WHERE id = ?',
    )
      .bind(a, b)
      .run();
    expect(await openStoredCredential(await keyring(), await stored(b))).toEqual({
      ok: false,
      error: 'credential_binding_mismatch',
    });
  });
});

describe('I-CRED-2: a sealed draft never follows a repoint or another token', () => {
  const ATTACKER = 'https://attacker.example';
  const draftOf = (html: string) => /name="credential_draft" value="([^"]+)"/.exec(html)?.[1] ?? '';

  /**
   * Two attested tokens of one type, so at the same destination (GitHub, or `custom`'s base URL;
   * ADR 0031); every upstream refuses, so a rotate re-renders.
   */
  async function world(custom: { base_url: string; credential: string } | null = null) {
    const network = fakeNetwork(() =>
      Response.json({ message: 'Bad credentials' }, { status: 401 }),
    );
    const app = createTestApp({ fetch: network.fetch, env: { TOKENGATE_KEK: KEK_1 } });
    const type = custom ? { slug: 'custom', base_url: custom.base_url } : { slug: 'github' };
    const a = await seedService(app.deps, { name: 'A', secret: SECRET, ...type });
    const b = await seedService(app.deps, { name: 'B', secret: SECRET, ...type });
    await env.DB.prepare('UPDATE credentials SET verify = ?').bind(JSON.stringify(VERIFY)).run();
    const session = await loginAs(app, await createUser({ email: 'o@example.com', role: 'owner' }));
    const first = await adminPost(app, session, `/admin/credentials/${a}/secret`, {
      ...(await rotateFields(a)),
      credential: custom?.credential ?? 'ghp_draftedSecret0123456789abcdefWXYZ',
    });
    expect(first.status).toBe(422);
    const draft = draftOf(await first.text());
    expect(draft).toMatch(/^cd1\./);
    return { network, app, session, a, b, draft, sent: network.calls.length };
  }

  beforeEach(resetAdminWorld);

  it("a draft made on one token's rotate form does not open on another token", async () => {
    const { network, app, session, b, draft, sent } = await world();
    const before = await stored(b);
    const res = await adminPost(app, session, `/admin/credentials/${b}/secret`, {
      ...(await rotateFields(b)),
      credential_draft: draft,
      save_anyway: '1',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Enter the personal access token again');
    expect((await stored(b)).credential_sealed).toBe(before.credential_sealed);
    expect(network.calls.length).toBe(sent);
  });

  it('a D1 repoint after the re-render makes the draft refuse: nothing goes to the new host', async () => {
    const { network, app, session, a, b, draft } = await world();
    const loaded = await rotateFields(a);
    // Only a credential alone in its type can move (ADR 0031), so the D1 writer removes the other one.
    await env.DB.prepare('DELETE FROM credentials WHERE id = ?').bind(b).run();
    await env.DB.prepare('UPDATE credentials SET base_url = ? WHERE id = ?')
      .bind(ATTACKER, a)
      .run();
    const before = await stored(a);
    // The form loaded before the repoint names the old destination: refused before the draft opens.
    const stale = await adminPost(app, session, `/admin/credentials/${a}/secret`, {
      ...loaded,
      credential_draft: draft,
      save_anyway: '1',
    });
    expect(stale.status).toBe(409);
    expect(await stale.text()).not.toContain('name="credential_draft"');
    // A form loaded after it: the draft is bound to the old destination and refuses.
    const res = await adminPost(app, session, `/admin/credentials/${a}/secret`, {
      ...(await rotateFields(a)),
      credential_draft: draft,
      save_anyway: '1',
    });
    expect([400, 422]).toContain(res.status);
    expect((await stored(a)).credential_sealed).toBe(before.credential_sealed);
    expect(network.calls.filter((call) => call.url.startsWith(ATTACKER))).toEqual([]);
  });

  it('a rotate draft does not open on Change destination with another base URL', async () => {
    // Only a custom credential has Change destination.
    const { network, app, session, a, draft } = await world({
      base_url: 'https://api.example.com',
      credential: 'drafted-secret-0123456789abcdefWXYZ',
    });
    const before = await stored(a);
    const res = await adminPost(app, session, `/admin/credentials/${a}/destination`, {
      base_url: 'https://uploads.example.com',
      injection_kind: 'bearer',
      credential_draft: draft,
      save_anyway: '1',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('again: the destination changed');
    expect((await stored(a)).base_url).toBe(before.base_url);
    expect(network.calls.filter((call) => call.url.includes('uploads.example.com'))).toEqual([]);
  });
});

describe('I-CRED-2: a template credential keeps its destination', () => {
  beforeEach(resetAdminWorld);

  it('setServiceCredential refuses another base URL or injection, sends and writes nothing', async () => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    const id = await seedService(deps, { secret: SECRET, verify: VERIFY });
    const before = await stored(id);
    expect(before.template_id).toBe('github');
    const sent = network.calls.length;
    for (const destination of [
      { base_url: 'https://uploads.github.com', injection: { kind: 'bearer' } },
      { base_url: 'https://evil.example.net', injection: { kind: 'bearer' } },
      { base_url: 'https://api.github.com', injection: { kind: 'query', param: 'token' } },
    ]) {
      const result = await setServiceCredential(
        deps,
        ACTOR,
        id,
        { ...destination, secret: SECRET, save_anyway: true },
        CONTEXT,
      );
      expect(result, JSON.stringify(destination)).toMatchObject({ ok: false, reason: 'invalid' });
      if (result.ok) return;
      expect(result.errors).toContain(
        'base URL: a GitHub REST API credential always calls https://api.github.com',
      );
    }
    expect(network.calls.length).toBe(sent);
    expect(await stored(id)).toEqual(before);
  });

  it('the destination route ignores a posted base URL: the secret goes to the type only', async () => {
    const network = fakeNetwork();
    const app = createTestApp({ fetch: network.fetch, env: { TOKENGATE_KEK: KEK_1 } });
    const id = await seedService(app.deps, { verify: VERIFY });
    const session = await loginAs(app, await createUser({ email: 'o@example.com', role: 'owner' }));
    const res = await adminPost(app, session, `/admin/credentials/${id}/destination`, {
      base_url: 'https://evil.example.net',
      injection_kind: 'query',
      injection_param: 'token',
      credential: 'ghp_settingTheSecret0123456789abcdefWXYZ',
      confirm_destination: 'api.github.com',
    });
    expect(res.status).toBe(303);
    const after = await stored(id);
    expect(after).toMatchObject({
      base_url: 'https://api.github.com',
      injection_json: '{"kind":"bearer"}',
      template_id: 'github',
    });
    expect(await openStoredCredential(await keyring(), after)).toEqual({
      ok: true,
      plaintext: 'ghp_settingTheSecret0123456789abcdefWXYZ',
    });
    expect(network.calls.map((call) => new URL(call.url).host)).not.toContain('evil.example.net');
    expect(network.calls.at(-1)?.url).toBe('https://api.github.com/rate_limit');
  });
});
