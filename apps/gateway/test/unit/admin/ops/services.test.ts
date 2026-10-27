import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setCredentialAccessRuleEnabled } from '../../../../src/admin/ops/credential-access-rules';
import {
  checkServiceCreate,
  createService,
  deleteService,
  freeNameAmong,
  freeSlugAmong,
  opContextFor,
  rotateServiceSecret,
  serviceFieldErrors,
  setServiceCredential,
  slugBaseFor,
  testServiceCredential,
  typeConflict,
  typeSlugAmong,
  updateServiceFields,
} from '../../../../src/admin/ops/credentials';
import { credentialAad, openCredential, sealedKid } from '../../../../src/crypto/envelope';
import { loadKeyring } from '../../../../src/crypto/keyring';
import { getAccessRuleRow } from '../../../../src/db/access-rules';
import { getService } from '../../../../src/db/credentials';
import { setUpstreamHosts, TEST_ACCESS_ENV } from '../../../helpers/app';
import {
  ACTOR,
  auditCount,
  auditRows,
  CONTEXT,
  fakeNetwork,
  KEK_1,
  opsDeps,
  racingDeps,
  resetControlPlane,
  ROTATION_ENV,
  seedCredentialRule,
  seedGlobalRule,
  seedService,
  serviceInput,
} from './helpers';

const SECRET = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
const VERIFY = { method: 'GET' as const, path: '/rate_limit', expect_status: 200 };

async function openStored(serviceId: string): Promise<string | null> {
  const service = await getService(env.DB, serviceId);
  const keyring = await loadKeyring({ ...TEST_ACCESS_ENV, TOKENGATE_KEK: KEK_1 });
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
      serviceInput({ base_url: 'https://api.github.com/' }),
      CONTEXT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.service).toMatchObject({
      slug: 'github',
      base_url: 'https://api.github.com',
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

  it('enforces the upstream host allowlist setting', async () => {
    const deps = opsDeps();
    await setUpstreamHosts(['*.slack.com']);
    const result = await createService(deps, ACTOR, serviceInput(), CONTEXT);
    await setUpstreamHosts(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join()).toMatch(/not in the upstream host allowlist/);
  });

  it('maps a slug of another destination to a conflict without an audit row', async () => {
    const deps = opsDeps();
    await seedService(deps);
    const before = await auditCount();
    const result = await createService(
      deps,
      ACTOR,
      serviceInput({ base_url: 'https://api.example.com' }),
      CONTEXT,
    );
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    if (result.ok) return;
    // Pre-checked before the keyring and the credential check (A7.4), with the free slug.
    expect(result.errors).toEqual([
      'credentials of type github call https://api.github.com; leave empty to use github-2',
    ]);
    expect(result.fieldErrors?.[0]?.field).toBe('slug');
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

  it('sends the check to the destination with the credential, without following redirects', async () => {
    const network = fakeNetwork(() => new Response('{}', { status: 200 }));
    const result = await createService(
      opsDeps({ fetch: network.fetch }),
      ACTOR,
      serviceInput({ secret: SECRET, verify: VERIFY }),
      CONTEXT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
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
    // A custom credential: only a credential without a type can change its destination.
    const id = await seedService(deps, {
      slug: 'custom',
      base_url: 'https://api.example.com',
      secret: SECRET,
    });
    expect((await getService(env.DB, id))?.template_id).toBeNull();
    const result = await setServiceCredential(
      deps,
      ACTOR,
      id,
      {
        base_url: 'https://uploads.example.com',
        injection: { kind: 'header', name: 'x-token', prefix: 'token ' },
        secret: 'second-secret-value-123456',
      },
      CONTEXT,
    );
    expect(result.ok).toBe(true);
    const stored = await getService(env.DB, id);
    expect(stored).toMatchObject({
      base_url: 'https://uploads.example.com',
      injection_json: '{"kind":"header","name":"x-token","prefix":"token "}',
      credential_hint: '…3456 (26 chars)',
    });
    expect(await openStored(id)).toBe('second-secret-value-123456');
    const audit = (await auditRows(id)).at(-1);
    expect(audit?.action).toBe('service.credential.set');
    expect(audit?.summary).toMatch(/changed its destination/);
    expect(audit?.diff?.before).toMatchObject({ base_url: 'https://api.example.com' });
    expect(audit?.diff?.after).toMatchObject({
      base_url: 'https://uploads.example.com',
      credential_kid: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  it('keeps a template credential on its own destination and injection', async () => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    const id = await seedService(deps, { secret: SECRET });
    const before = await getService(env.DB, id);
    expect(before?.template_id).toBe('github');
    const calls = network.calls.length;
    const audits = await auditCount();
    for (const destination of [
      { base_url: 'https://uploads.github.com', injection: { kind: 'bearer' } },
      { base_url: 'https://api.github.com', injection: { kind: 'header', name: 'x-token' } },
    ]) {
      const refused = await setServiceCredential(
        deps,
        ACTOR,
        id,
        { ...destination, secret: 'second-secret-value-123456' },
        CONTEXT,
      );
      expect(refused, destination.base_url).toMatchObject({ ok: false, reason: 'invalid' });
      if (refused.ok) return;
      expect(refused.errors).toContain(
        'base URL: a GitHub REST API credential always calls https://api.github.com',
      );
    }
    expect(network.calls.length).toBe(calls);
    expect(await auditCount()).toBe(audits);
    expect(await getService(env.DB, id)).toEqual(before);
    // The template's own destination still takes a new secret.
    const kept = await setServiceCredential(
      deps,
      ACTOR,
      id,
      { base_url: 'https://api.github.com', injection: { kind: 'bearer' }, secret: `${SECRET}x` },
      CONTEXT,
    );
    expect(kept.ok).toBe(true);
    expect(await openStored(id)).toBe(`${SECRET}x`);
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

  it('uses the next key during a rotation', async () => {
    const deps = opsDeps({ env: ROTATION_ENV });
    const loaded = await loadKeyring(deps.env);
    if (!loaded.ok) throw new Error(loaded.error);
    const id = await seedService(deps);
    await setServiceCredential(
      deps,
      ACTOR,
      id,
      {
        base_url: 'https://api.github.com',
        injection: { kind: 'bearer' },
        secret: SECRET,
        // No credential is stored yet: the destination is confirmed by typing its host (I-CRED-2).
        confirm_destination: 'api.github.com',
      },
      CONTEXT,
    );
    expect(sealedKid((await getService(env.DB, id))?.credential_sealed ?? null)).toBe(
      loaded.keyring.nextKid,
    );
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
    await env.DB.prepare(
      "UPDATE credentials SET base_url = 'https://evil.example.net' WHERE id = ?",
    )
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
  const ruleCount = async () =>
    Number(
      (await env.DB.prepare('SELECT count(*) AS n FROM access_rules').first<{ n: number }>())?.n,
    );

  it('deletes and keeps the full non-secret configuration in the audit row', async () => {
    const deps = opsDeps();
    const id = await seedService(deps, { secret: SECRET });
    expect(await deleteService(deps, ACTOR, id)).toEqual({ ok: true, deletedRules: 0 });
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

  it('refuses while credential access rules belong to the credential', async () => {
    const deps = opsDeps();
    const id = await seedService(deps);
    await seedCredentialRule(deps, { credential_id: id, name: 'ci deploy' });
    const before = await auditCount();
    const result = await deleteService(deps, ACTOR, id);
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    if (result.ok) return;
    expect(result.errors.join()).toContain('"ci deploy"');
    expect(result.rules?.map((rule) => rule.name)).toEqual(['ci deploy']);
    expect(await getService(env.DB, id)).not.toBeNull();
    expect(await auditCount()).toBe(before);
  });

  it('with its rules, deletes exactly the confirmed set and lists every rule in one audit row (I-AUDIT-1)', async () => {
    const deps = opsDeps();
    const id = await seedService(deps);
    const a = await seedCredentialRule(deps, {
      credential_id: id,
      name: 'a',
      labels: [{ claim: 'repository_id', value: '987654321', label: 'acme/api' }],
    });
    const b = await seedCredentialRule(deps, { credential_id: id, name: 'b' });
    await setCredentialAccessRuleEnabled(deps, ACTOR, b.id, false);
    const global = await seedGlobalRule(deps);
    const before = await auditCount();

    const stale = await deleteService(deps, ACTOR, id, { withRules: true, ruleIds: [a.id] });
    expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await auditCount()).toBe(before);

    const result = await deleteService(deps, ACTOR, id, {
      withRules: true,
      ruleIds: [b.id, a.id],
    });
    expect(result).toEqual({ ok: true, deletedRules: 2 });
    expect(await getService(env.DB, id)).toBeNull();
    // The rules and their labels cascade; global access rules stay.
    expect(await ruleCount()).toBe(1);
    expect(await getAccessRuleRow(env.DB, global.id)).not.toBeNull();
    const labels = await env.DB.prepare('SELECT count(*) AS n FROM claim_labels').first<{
      n: number;
    }>();
    expect(labels?.n).toBe(0);
    const audit = (await auditRows(id)).at(-1);
    expect(audit).toMatchObject({
      action: 'service.delete',
      summary: 'Deleted credential github and its 2 access rules',
    });
    expect(audit?.diff?.before).toMatchObject({
      access_rules: [
        { id: a.id, name: 'a', issuer: a.issuer, enabled: true },
        { id: b.id, name: 'b', issuer: b.issuer, enabled: false },
      ],
    });
    expect(await auditCount()).toBe(before + 1);
  });

  it('a rule added after the confirmation makes the delete write nothing', async () => {
    const deps = opsDeps();
    const id = await seedService(deps);
    const a = await seedCredentialRule(deps, { credential_id: id, name: 'a' });
    const before = await auditCount();
    const racing = racingDeps(deps, () =>
      seedCredentialRule(deps, { credential_id: id, name: 'late' }),
    );
    const result = await deleteService(racing, ACTOR, id, { withRules: true, ruleIds: [a.id] });
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    if (result.ok) return;
    expect(result.rules?.map((rule) => rule.name)).toEqual(['a', 'late']);
    expect(await getService(env.DB, id)).not.toBeNull();
    expect(await ruleCount()).toBe(2);
    // Only the racing rule's own audit row was added.
    expect(await auditCount()).toBe(before + 1);
  });

  it('refuses the cascade for an actor whose permissions lack access:write', async () => {
    const deps = opsDeps();
    const id = await seedService(deps);
    const a = await seedCredentialRule(deps, { credential_id: id });
    const actor = {
      ...ACTOR,
      authority: {
        userId: ACTOR.id,
        loginProvider: 'access',
        subject: 'sub',
        permissions: ['tokens:write'],
      },
    } as never;
    const result = await deleteService(deps, actor, id, { withRules: true, ruleIds: [a.id] });
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await getService(env.DB, id)).not.toBeNull();
  });
});

describe('token helpers', () => {
  it('derives free slugs and names, and a custom slug from the host', () => {
    expect(freeSlugAmong('slack', [])).toBe('slack');
    expect(freeSlugAmong('slack', ['slack', 'slack-2'])).toBe('slack-3');
    expect(freeSlugAmong('a'.repeat(63), ['a'.repeat(63)])).toBe(`${'a'.repeat(61)}-2`);
    expect(freeNameAmong('Slack', ['Slack'])).toBe('Slack 2');
    expect(slugBaseFor('https://api.example.com/v1')).toBe('example');
    expect(slugBaseFor('https://www.Acme.io')).toBe('acme');
    expect(slugBaseFor('https://hooks.slack.com/services')).toBe('hooks');
    expect(slugBaseFor('not a url')).toBe('custom');
  });

  it('maps validation messages to their form fields', () => {
    expect(
      serviceFieldErrors([
        'base URL must use https',
        'slug must be 1-63 characters',
        'credential is empty',
        'injection: header name must be a lower-case HTTP token (max 64 characters)',
        'forward header "authorization" is never forwarded',
        'something else',
      ]).map((error) => error.field),
    ).toEqual(['base_url', 'slug', 'credential', 'injection_header_name', 'forward_headers', null]);
  });

  it('keeps template check headers and refuses reserved or injected ones', async () => {
    const deps = opsDeps();
    const ok = await createService(
      deps,
      ACTOR,
      serviceInput({
        slug: 'anthropic',
        base_url: 'https://api.anthropic.com',
        injection: { kind: 'header', name: 'x-api-key' },
        forward_headers: [],
        verify: {
          method: 'GET',
          path: '/v1/models',
          expect_status: 200,
          headers: { 'anthropic-version': '2023-06-01' },
        },
      }),
      CONTEXT,
    );
    expect(ok.ok && ok.service.verify?.headers).toEqual({ 'anthropic-version': '2023-06-01' });
    expect(ok.ok && ok.service.template_id).toBe('anthropic');
    const badHeaders: Array<Record<string, string>> = [
      { 'x-api-key': 'k' },
      { authorization: 'x' },
      { 'x-ok': 'line\nbreak' },
      { a: '1', b: '2', c: '3', d: '4', e: '5' },
    ];
    for (const headers of badHeaders) {
      const bad = await createService(
        deps,
        ACTOR,
        serviceInput({
          slug: 'bad-headers',
          injection: { kind: 'header', name: 'x-api-key' },
          forward_headers: [],
          verify: { method: 'GET', path: '/x', expect_status: 200, headers },
        }),
        CONTEXT,
      );
      expect(bad, JSON.stringify(headers)).toMatchObject({ ok: false, reason: 'invalid' });
    }
  });

  it('checkServiceCreate sends nothing and writes nothing; hostAllowed skips only the allowlist', async () => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    await setUpstreamHosts(['api.github.com']);
    const input = serviceInput({
      slug: 'openai',
      base_url: 'https://api.openai.com/v1',
      secret: SECRET,
      verify: { method: 'GET', path: '/models', expect_status: 200 },
    });
    expect(await checkServiceCreate(deps, input, CONTEXT)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(await checkServiceCreate(deps, input, CONTEXT, { hostAllowed: true })).toMatchObject({
      ok: true,
    });
    expect(network.calls).toEqual([]);
    expect(await auditCount()).toBe(0);
  });

  it('rotateServiceSecret keeps the stored destination and refuses an unattested one', async () => {
    const deps = opsDeps();
    const id = await seedService(deps, { secret: SECRET });
    const rotated = await rotateServiceSecret(deps, ACTOR, id, { secret: `${SECRET}x` }, CONTEXT);
    expect(rotated).toMatchObject({ ok: true, siblings: [] });
    expect((await getService(env.DB, id))?.base_url).toBe('https://api.github.com');
    await env.DB.prepare(
      "UPDATE credentials SET base_url = 'https://uploads.github.com' WHERE id = ?",
    )
      .bind(id)
      .run();
    expect(await rotateServiceSecret(deps, ACTOR, id, { secret: SECRET }, CONTEXT)).toMatchObject({
      ok: false,
      reason: 'confirmation_required',
    });
  });
});

describe('Slack bot name from the check', () => {
  // Other tests leave an allowlist behind; slack.com is not on it.
  beforeEach(() => setUpstreamHosts(null));

  const SLACK_SECRET = 'xoxb-1111-2222-abcdefghijklmnop';
  const SLACK_VERIFY = {
    method: 'POST' as const,
    path: '/auth.test',
    expect_status: 200,
    expect_ok_field: true,
  };

  /** Slack's auth.test and bots.info; `bot.name` is what Slack shows, and can change. */
  function slackNetwork() {
    const state = { botName: 'Deploy Bot' };
    const network = fakeNetwork((url) =>
      url.pathname === '/api/bots.info'
        ? Response.json({ ok: true, bot: { id: 'B0123ABC', name: state.botName } })
        : Response.json({ ok: true, user: 'deploy-bot', bot_id: 'B0123ABC' }),
    );
    return { state, network, deps: opsDeps({ fetch: network.fetch }) };
  }

  function slackInput(overrides: Parameters<typeof serviceInput>[0] = {}) {
    return serviceInput({
      slug: 'slack',
      name: 'Slack',
      base_url: 'https://slack.com/api',
      injection: { kind: 'bearer' },
      forward_headers: [],
      verify: SLACK_VERIFY,
      secret: SLACK_SECRET,
      ...overrides,
    });
  }

  it('create: an empty name takes the bot name and follows the check', async () => {
    const { deps } = slackNetwork();
    const result = await createService(deps, ACTOR, slackInput({ name_from_check: true }), CONTEXT);
    expect(result).toMatchObject({
      ok: true,
      service: { name: 'Deploy Bot', name_from_check: true, template_id: 'slack' },
    });
  });

  it('create: a typed name is kept', async () => {
    const { deps } = slackNetwork();
    const result = await createService(deps, ACTOR, slackInput({ name: 'Alerts' }), CONTEXT);
    expect(result).toMatchObject({
      ok: true,
      service: { name: 'Alerts', name_from_check: false },
    });
  });

  it('create: keeps the made-up name when the check reads no identity', async () => {
    const network = fakeNetwork(() => Response.json({ ok: true }));
    const result = await createService(
      opsDeps({ fetch: network.fetch }),
      ACTOR,
      slackInput({ name_from_check: true }),
      CONTEXT,
    );
    expect(result).toMatchObject({
      ok: true,
      service: { name: 'Slack', name_from_check: false },
    });
  });

  it('Test renames a name read from the check, as its own service.update', async () => {
    const { state, deps } = slackNetwork();
    const id = await seedService(deps, slackInput({ name_from_check: true }));
    state.botName = 'Release Bot';
    expect(await testServiceCredential(deps, ACTOR, id, CONTEXT)).toMatchObject({
      ok: true,
      verify: { passed: true, identity: 'Release Bot' },
      nameSaved: true,
    });
    expect(await getService(env.DB, id)).toMatchObject({
      name: 'Release Bot',
      name_from_check: true,
    });
    const rows = await auditRows(id);
    expect(rows.map((row) => row.action).slice(-2)).toEqual([
      'service.credential.test',
      'service.update',
    ]);
    expect(rows.at(-1)?.diff).toEqual({
      before: { name: 'Deploy Bot' },
      after: { name: 'Release Bot' },
    });
    // Same name: nothing to save, no second row.
    expect(await testServiceCredential(deps, ACTOR, id, CONTEXT)).toMatchObject({
      nameSaved: false,
    });
    expect((await auditRows(id)).at(-1)?.action).toBe('service.credential.test');
  });

  it('Test keeps a name renamed by hand', async () => {
    const { state, deps } = slackNetwork();
    const id = await seedService(deps, slackInput({ name_from_check: true }));
    const renamed = await updateServiceFields(deps, ACTOR, id, { name: 'Alerts' });
    expect(renamed.ok).toBe(true);
    expect((await getService(env.DB, id))?.name_from_check).toBe(false);
    state.botName = 'Release Bot';
    expect(await testServiceCredential(deps, ACTOR, id, CONTEXT)).toMatchObject({
      ok: true,
      verify: { identity: 'Release Bot' },
      nameSaved: false,
    });
    expect(await getService(env.DB, id)).toMatchObject({ name: 'Alerts', name_from_check: false });
  });

  it('Test keeps a typed name', async () => {
    const { state, deps } = slackNetwork();
    const id = await seedService(deps, slackInput({ name: 'Alerts' }));
    state.botName = 'Release Bot';
    expect(await testServiceCredential(deps, ACTOR, id, CONTEXT)).toMatchObject({
      nameSaved: false,
    });
    expect((await getService(env.DB, id))?.name).toBe('Alerts');
  });

  it('a new secret renames a name read from the check', async () => {
    const { state, deps } = slackNetwork();
    const id = await seedService(deps, slackInput({ name_from_check: true }));
    state.botName = 'Release Bot';
    const rotated = await rotateServiceSecret(
      deps,
      ACTOR,
      id,
      { secret: `${SLACK_SECRET}x` },
      CONTEXT,
    );
    expect(rotated).toMatchObject({ ok: true, service: { name: 'Release Bot' } });
    expect(await getService(env.DB, id)).toMatchObject({
      name: 'Release Bot',
      name_from_check: true,
    });
  });
});

describe('ADR 0031: credential types', () => {
  const github = { base_url: 'https://api.github.com', injection_json: '{"kind":"bearer"}' };
  const example = { base_url: 'https://api.example.com', injection_json: '{"kind":"bearer"}' };
  const stored = [{ slug: 'github', ...github }];

  it('typeConflict: one destination per slug, one slug per destination, at most 8 per type', () => {
    expect(typeConflict('github', stored, github)).toBeNull();
    expect(typeConflict('github', stored, example)).toBe(
      'credentials of type github call https://api.github.com',
    );
    expect(typeConflict('github', stored, { ...github, injection_json: '{"kind":"basic"}' })).toBe(
      'credentials of type github send the secret another way',
    );
    expect(typeConflict('gh', stored, github)).toBe(
      'credentials that call https://api.github.com have the type github',
    );
    const full = Array.from({ length: 8 }, () => stored[0] as (typeof stored)[number]);
    expect(typeConflict('github', full, github)).toBe('the type github already has 8 credentials');
  });

  it('typeSlugAmong: the slug of the destination type, else the first unused one', () => {
    expect(typeSlugAmong('gh', stored, github)).toBe('github');
    expect(typeSlugAmong('github', stored, example)).toBe('github-2');
    expect(typeSlugAmong('github', stored, null)).toBe('github-2');
    expect(typeSlugAmong('example', stored, example)).toBe('example');
  });

  it('a second credential of a destination joins its type', async () => {
    const deps = opsDeps();
    const first = await seedService(deps);
    const second = await seedService(deps, { name: 'GitHub 2' });
    expect((await getService(env.DB, second))?.slug).toBe((await getService(env.DB, first))?.slug);
  });

  it('a credential that shares its type cannot change its destination', async () => {
    const deps = opsDeps();
    const id = await seedService(deps, { slug: 'custom', base_url: 'https://api.example.com' });
    await seedService(deps, {
      slug: 'custom',
      name: 'custom 2',
      base_url: 'https://api.example.com',
    });
    const result = await setServiceCredential(
      deps,
      ACTOR,
      id,
      {
        base_url: 'https://uploads.example.com',
        injection: { kind: 'bearer' },
        secret: 'second-secret-value-123456',
      },
      CONTEXT,
    );
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (result.ok) return;
    expect(result.errors).toEqual([
      'base URL: credentials of type custom call https://api.example.com; add a new credential instead',
    ]);
    expect((await getService(env.DB, id))?.base_url).toBe('https://api.example.com');
  });
});
