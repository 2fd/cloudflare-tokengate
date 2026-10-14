import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createService,
  deleteService,
  opContextFor,
  setServiceCredential,
  testServiceCredential,
  updateServiceFields,
} from '../../../../src/admin/ops/services';
import { credentialAad, openCredential, sealedKid } from '../../../../src/crypto/envelope';
import { loadKeyring } from '../../../../src/crypto/keyring';
import { getService } from '../../../../src/db/services';
import { setAdminHosts, setUpstreamHosts } from '../../../helpers/app';
import {
  ACTOR,
  auditCount,
  auditRows,
  CONTEXT,
  fakeNetwork,
  KEK_1,
  opsDeps,
  resetControlPlane,
  seedGithubProvider,
  seedGrant,
  seedService,
  serviceInput,
} from './helpers';

const SECRET = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
const VERIFY = { method: 'GET' as const, path: '/rate_limit', expect_status: 200 };

async function openStored(serviceId: string): Promise<string | null> {
  const service = await getService(env.DB, serviceId);
  const keyring = await loadKeyring({ TOKENGATE_KEK: KEK_1 });
  if (!service?.credential_sealed || !keyring.ok) return null;
  const aad = credentialAad(service.id, service.base_url, service.injection_json);
  const opened = await openCredential(keyring.keyring, service.credential_sealed, aad);
  return opened.ok ? opened.plaintext : null;
}

beforeEach(resetControlPlane);

describe('opContextFor', () => {
  it('takes the request hostname without the port', () => {
    expect(opContextFor(new URL('https://A.example:8443/admin'))).toEqual({
      requestHost: 'a.example',
    });
  });
});

describe('createService', () => {
  it('stores a normalized service without a credential', async () => {
    const result = await createService(
      opsDeps(),
      ACTOR,
      serviceInput({ base_url: 'https://api.github.com/', description: '  GitHub API ' }),
      CONTEXT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.service).toMatchObject({
      slug: 'github',
      base_url: 'https://api.github.com',
      description: 'GitHub API',
      timeout_ms: 120_000,
      enabled: true,
      credential_set: false,
      credential_hint: null,
    });
    const stored = await getService(env.DB, result.service.id);
    expect(stored?.injection_json).toBe('{"kind":"bearer"}');
    const [audit] = await auditRows(result.service.id);
    expect(audit?.action).toBe('service.create');
    expect(audit?.actor_email).toBe(ACTOR.email);
  });

  it('seals the initial credential bound to id, base URL and injection', async () => {
    const result = await createService(
      opsDeps(),
      ACTOR,
      serviceInput({ secret: `  ${SECRET} ` }),
      CONTEXT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.service.credential_hint).toBe('…wxyz (40 chars)');
    expect(result.service.credential_set).toBe(true);
    expect(await openStored(result.service.id)).toBe(SECRET);
  });

  it('rejects invalid input with every error and writes nothing', async () => {
    const result = await createService(
      opsDeps(),
      ACTOR,
      serviceInput({
        slug: 'Bad Slug',
        base_url: 'http://127.0.0.1/api',
        injection: { kind: 'header', name: 'authorization' },
        timeout_ms: 5,
        description: 'a\u0000b',
      }),
      CONTEXT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid');
    expect(result.errors.join('\n')).toMatch(/slug/);
    expect(result.errors.join('\n')).toMatch(/base URL/);
    expect(result.errors.join('\n')).toMatch(/injection/);
    expect(result.errors.join('\n')).toMatch(/timeout/);
    expect(result.errors.join('\n')).toMatch(/description/);
    expect(await auditCount()).toBe(0);
  });

  it('refuses a base URL pointing at the gateway itself', async () => {
    const result = await createService(
      opsDeps(),
      ACTOR,
      serviceInput({ base_url: 'https://gw.example.com/api' }),
      CONTEXT,
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a base URL pointing at a stored admin host', async () => {
    await setAdminHosts(['gw.example.com', '*.admin.example.org']);
    const result = await createService(
      opsDeps(),
      ACTOR,
      serviceInput({ base_url: 'https://eu.admin.example.org/api' }),
      { requestHost: 'other.example.net' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join()).toMatch(/must not point at this gateway/);
  });

  it('enforces the upstream host allowlist setting', async () => {
    const deps = opsDeps();
    await setUpstreamHosts(['*.slack.com']);
    const result = await createService(deps, ACTOR, serviceInput(), CONTEXT);
    await setUpstreamHosts(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join()).toMatch(/not in the upstream host allowlist/);
  });

  it('maps a duplicate slug to a conflict without an audit row', async () => {
    const deps = opsDeps();
    await seedService(deps);
    const before = await auditCount();
    const result = await createService(deps, ACTOR, serviceInput(), CONTEXT);
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    if (result.ok) return;
    expect(result.errors).toEqual([
      'another service already uses this slug; choose a different slug',
    ]);
    expect(await auditCount()).toBe(before);
  });

  it('refuses to store a credential without a valid keyring', async () => {
    const deps = opsDeps({ env: { TOKENGATE_KEK: '' } });
    const result = await createService(deps, ACTOR, serviceInput({ secret: SECRET }), CONTEXT);
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await auditCount()).toBe(0);
  });

  it('runs the verify check and refuses a failing credential unless save_anyway', async () => {
    const network = fakeNetwork(
      () => new Response('{"message":"Bad credentials"}', { status: 401 }),
    );
    const deps = opsDeps({ fetch: network.fetch });
    const refused = await createService(
      deps,
      ACTOR,
      serviceInput({ secret: SECRET, verify: VERIFY }),
      CONTEXT,
    );
    expect(refused).toMatchObject({ ok: false, reason: 'verify_failed' });
    if (refused.ok) return;
    expect(refused.verify).toMatchObject({ status: 401, passed: false });
    expect(await auditCount()).toBe(0);

    const saved = await createService(
      deps,
      ACTOR,
      serviceInput({ secret: SECRET, verify: VERIFY, save_anyway: true }),
      CONTEXT,
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const [audit] = await auditRows(saved.service.id);
    expect(audit?.diff?.verify).toEqual({
      status: 401,
      passed: false,
      error: 'expected HTTP 200, got 401',
    });
  });

  it('takes the credential expiry from GitHub when the check passes', async () => {
    const network = fakeNetwork(
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'github-authentication-token-expiration': '2026-12-01 00:00:00 UTC' },
        }),
    );
    const result = await createService(
      opsDeps({ fetch: network.fetch }),
      ACTOR,
      serviceInput({ secret: SECRET, verify: VERIFY }),
      CONTEXT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.service.credential_expires_at).toBe(Date.UTC(2026, 11, 1));
    expect(network.calls.at(-1)).toMatchObject({
      url: 'https://api.github.com/rate_limit',
      redirect: 'manual',
    });
    expect(network.calls.at(-1)?.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
  });
});

describe('updateServiceFields', () => {
  it('updates non-binding fields and audits only the changed ones', async () => {
    const deps = opsDeps();
    const id = await seedService(deps);
    const result = await updateServiceFields(deps, ACTOR, id, {
      name: 'GitHub API',
      timeout_ms: 30_000,
    });
    expect(result.ok).toBe(true);
    const stored = await getService(env.DB, id);
    expect(stored).toMatchObject({ name: 'GitHub API', timeout_ms: 30_000 });
    const audit = (await auditRows(id)).at(-1);
    expect(audit?.action).toBe('service.update');
    expect(audit?.diff).toEqual({
      before: { name: 'GitHub', timeout_ms: 120_000 },
      after: { name: 'GitHub API', timeout_ms: 30_000 },
    });
  });

  it('records enable/disable as their own actions', async () => {
    const deps = opsDeps();
    const id = await seedService(deps);
    await updateServiceFields(deps, ACTOR, id, { enabled: false });
    expect((await getService(env.DB, id))?.enabled).toBe(false);
    expect((await auditRows(id)).at(-1)?.action).toBe('service.disable');
  });

  it('rejects unknown and binding fields', async () => {
    const deps = opsDeps();
    const id = await seedService(deps);
    const result = await updateServiceFields(deps, ACTOR, id, {
      slug: 'other',
    } as unknown as Parameters<typeof updateServiceFields>[3]);
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('validates forward headers against the stored injection', async () => {
    const deps = opsDeps();
    const id = await seedService(deps);
    const result = await updateServiceFields(deps, ACTOR, id, {
      forward_headers: ['authorization'],
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('refuses a save from a form opened at an older version', async () => {
    const deps = opsDeps();
    const id = await seedService(deps);
    const opened = (await getService(env.DB, id))?.updated_at;
    const first = await updateServiceFields(deps, ACTOR, id, {
      name: 'first',
      expected_updated_at: opened,
    });
    expect(first.ok).toBe(true);
    const stale = await updateServiceFields(deps, ACTOR, id, {
      name: 'second',
      expected_updated_at: opened,
    });
    expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
    if (stale.ok) return;
    expect(stale.errors.join()).toContain('changed by someone else since you opened this page');
    expect((await getService(env.DB, id))?.name).toBe('first');
  });

  it('returns not_found for an unknown service', async () => {
    const result = await updateServiceFields(opsDeps(), ACTOR, 'svc_missing', { name: 'x' });
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('setServiceCredential', () => {
  it('sets credential and destination together, re-sealed with the new AAD', async () => {
    const deps = opsDeps();
    const id = await seedService(deps, { secret: SECRET });
    const result = await setServiceCredential(
      deps,
      ACTOR,
      id,
      {
        base_url: 'https://uploads.github.com',
        injection: { kind: 'header', name: 'x-token', prefix: 'token ' },
        secret: 'second-secret-value-123456',
      },
      CONTEXT,
    );
    expect(result.ok).toBe(true);
    const stored = await getService(env.DB, id);
    expect(stored).toMatchObject({
      base_url: 'https://uploads.github.com',
      injection_json: '{"kind":"header","name":"x-token","prefix":"token "}',
      credential_hint: '…3456 (26 chars)',
    });
    expect(await openStored(id)).toBe('second-secret-value-123456');
    const audit = (await auditRows(id)).at(-1);
    expect(audit?.action).toBe('service.credential.set');
    expect(audit?.summary).toMatch(/changed its destination/);
    expect(audit?.diff?.before).toMatchObject({ base_url: 'https://api.github.com' });
    expect(audit?.diff?.after).toMatchObject({
      base_url: 'https://uploads.github.com',
      credential_kid: 'k1',
    });
  });

  it('requires a valid credential', async () => {
    const deps = opsDeps();
    const id = await seedService(deps);
    const result = await setServiceCredential(
      deps,
      ACTOR,
      id,
      { base_url: 'https://api.github.com', injection: { kind: 'bearer' }, secret: 'a b' },
      CONTEXT,
    );
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect((await getService(env.DB, id))?.credential_sealed).toBeNull();
  });

  it('uses the active key of a keyring', async () => {
    const deps = opsDeps({
      env: {
        TOKENGATE_KEK: '',
        TOKENGATE_KEYRING: JSON.stringify({ active: 'k9', keys: { k9: KEK_1 } }),
      },
    });
    const id = await seedService(deps);
    await setServiceCredential(
      deps,
      ACTOR,
      id,
      { base_url: 'https://api.github.com', injection: { kind: 'bearer' }, secret: SECRET },
      CONTEXT,
    );
    expect(sealedKid((await getService(env.DB, id))?.credential_sealed ?? null)).toBe('k9');
  });
});

describe('testServiceCredential', () => {
  it('audits the test before it sends the stored credential, then logs the result', async () => {
    let auditsAtSend: number[] = [];
    const deps = opsDeps();
    const network = fakeNetwork(async (_url, init) => {
      auditsAtSend.push((await auditRows()).length);
      return new Headers(init.headers).get('authorization') === `Bearer ${SECRET}`
        ? new Response('{"ok":true}', { status: 200 })
        : new Response('{}', { status: 401 });
    });
    deps.fetch = network.fetch;
    const id = await seedService(deps, { secret: SECRET, verify: VERIFY });
    const before = (await auditRows()).length;
    auditsAtSend = [];
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const result = await testServiceCredential(deps, ACTOR, id, CONTEXT);
      expect(result).toMatchObject({ ok: true, verify: { status: 200, passed: true } });
      expect(auditsAtSend).toEqual([before + 1]);
      const audit = (await auditRows(id)).at(-1);
      expect(audit).toMatchObject({ action: 'service.credential.test' });
      expect(audit?.diff).toEqual({ base_url: 'https://api.github.com', verify: VERIFY });
      const lines = info.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(lines).toContainEqual({
        type: 'service.credential.test_result',
        audit_id: audit?.id,
        service_id: id,
        status: 200,
        passed: true,
        error: null,
      });
    } finally {
      info.mockRestore();
    }
  });

  it('fails closed when the stored base URL was edited in D1', async () => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    const id = await seedService(deps, { secret: SECRET, verify: VERIFY });
    await env.DB.prepare("UPDATE services SET base_url = 'https://evil.example.net' WHERE id = ?")
      .bind(id)
      .run();
    const calls = network.calls.length;
    const result = await testServiceCredential(deps, ACTOR, id, CONTEXT);
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    if (result.ok) return;
    expect(result.errors.join()).toMatch(/credential_binding_mismatch/);
    expect(network.calls.length).toBe(calls);
  });

  it('needs a verify check and a credential', async () => {
    const deps = opsDeps();
    const noVerify = await seedService(deps, { secret: SECRET });
    expect(await testServiceCredential(deps, ACTOR, noVerify, CONTEXT)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    const noCredential = await seedService(deps, { slug: 'other', verify: VERIFY });
    expect(await testServiceCredential(deps, ACTOR, noCredential, CONTEXT)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('deleteService', () => {
  it('deletes and keeps the full non-secret configuration in the audit row', async () => {
    const deps = opsDeps();
    const id = await seedService(deps, { secret: SECRET });
    expect(await deleteService(deps, ACTOR, id)).toEqual({ ok: true });
    expect(await getService(env.DB, id)).toBeNull();
    const audit = (await auditRows(id)).at(-1);
    expect(audit?.action).toBe('service.delete');
    expect(audit?.diff?.before).toMatchObject({
      slug: 'github',
      base_url: 'https://api.github.com',
      injection: { kind: 'bearer' },
      credential_set: true,
    });
    expect(JSON.stringify(audit)).not.toContain('credential_sealed');
  });

  it('refuses while grants reference the service', async () => {
    const deps = opsDeps();
    const id = await seedService(deps);
    const provider = await seedGithubProvider(deps);
    await seedGrant(deps, provider.id, id, 'ci deploy');
    const before = await auditCount();
    const result = await deleteService(deps, ACTOR, id);
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    if (result.ok) return;
    expect(result.errors.join()).toContain('"ci deploy"');
    expect(await getService(env.DB, id)).not.toBeNull();
    expect(await auditCount()).toBe(before);
  });
});
