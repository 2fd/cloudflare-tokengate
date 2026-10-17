// Attempts to break the admin ops: races between read and write (guards must be SQL-enforced),
// revocation that depends on validation, stalled upstreams and credential echoes in odd encodings.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCredentialAccessRule,
  setCredentialAccessRuleEnabled,
  updateCredentialAccessRule,
} from '../../../../src/admin/ops/credential-access-rules';
import {
  createService,
  deleteService,
  updateServiceFields,
} from '../../../../src/admin/ops/credentials';
import {
  createIssuerAccessRule,
  setIssuerAccessRuleEnabled,
  updateIssuerAccessRule,
} from '../../../../src/admin/ops/issuer_access_rules';
import { maskSecret, runVerifyCheck } from '../../../../src/admin/ops/verify';
import { getCredentialAccessRule } from '../../../../src/db/credential-access-rules';
import { getService } from '../../../../src/db/credentials';
import {
  getIssuerAccessRule,
  grantVersionGuard,
  updateIssuerAccessRuleStatement,
} from '../../../../src/db/issuer_access_rules';
import { testCredentialId } from './helpers';
import {
  ACTOR,
  auditCount,
  auditRows,
  CONTEXT,
  fakeNetwork,
  opsDeps,
  racingDeps,
  resetControlPlane,
  seedGithubProvider,
  seedIssuerAccessRule,
  seedService,
  serviceInput,
} from './helpers';

const ACME_ISSUER = 'https://idp.acme.example';

beforeEach(resetControlPlane);

describe('revocation never depends on validation', () => {
  it('disables a credential access rule whose stored row no longer validates', async () => {
    const deps = opsDeps();
    const provider = await seedGithubProvider(deps);
    // Out of range for github-actions (max 900 s): e.g. written by an older version or by hand.
    await env.DB.prepare(
      'UPDATE credential_access_rules SET max_token_age_seconds = 3600 WHERE id = ?',
    )
      .bind(provider.id)
      .run();
    const result = await setCredentialAccessRuleEnabled(deps, ACTOR, provider.id, false);
    expect(result.ok).toBe(true);
    expect((await getCredentialAccessRule(env.DB, provider.id))?.enabled).toBe(false);
    expect((await auditRows(provider.id)).at(-1)?.action).toBe('credential_access_rule.disable');
    // Enabling it again validates and is refused.
    const enabled = await setCredentialAccessRuleEnabled(deps, ACTOR, provider.id, true);
    expect(enabled).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('disables a service whose stored row no longer validates', async () => {
    const deps = opsDeps();
    const id = await seedService(deps);
    await env.DB.prepare(
      `UPDATE credentials SET forward_headers = '["Authorization"]' WHERE id = ?`,
    )
      .bind(id)
      .run();
    const result = await updateServiceFields(deps, ACTOR, id, { enabled: false });
    expect(result.ok).toBe(true);
    expect((await getService(env.DB, id))?.enabled).toBe(false);
    expect((await auditRows(id)).at(-1)?.action).toBe('service.disable');
    expect(await updateServiceFields(deps, ACTOR, id, { enabled: true })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('optimistic concurrency holds within one millisecond', () => {
  it('a stale snapshot cannot overwrite a change made in the same millisecond', async () => {
    const now = 1_800_000_000_000;
    const deps = opsDeps({ now: () => now });
    const provider = await seedGithubProvider(deps);
    const serviceId = await seedService(deps);
    const grant = await seedIssuerAccessRule(deps, provider.id, serviceId);
    const snapshot = await getIssuerAccessRule(env.DB, grant.id);
    if (!snapshot) throw new Error('grant missing');

    expect((await setIssuerAccessRuleEnabled(deps, ACTOR, grant.id, false)).ok).toBe(true);
    // An edit based on the snapshot (still enabled) must not re-enable the grant.
    const stale = updateIssuerAccessRuleStatement(
      env.DB,
      grant.id,
      { ...snapshot, name: 'stale edit' },
      now,
      grantVersionGuard(snapshot),
    );
    expect((await stale.run()).meta.changes).toBe(0);
    expect((await getIssuerAccessRule(env.DB, grant.id))?.enabled).toBe(false);
  });

  it('returns the stored version so the next op can use it as a guard', async () => {
    const now = 1_800_000_000_000;
    const deps = opsDeps({ now: () => now });
    const provider = await seedGithubProvider(deps);
    const serviceId = await seedService(deps);
    const grant = await seedIssuerAccessRule(deps, provider.id, serviceId);
    const first = await updateIssuerAccessRule(deps, ACTOR, grant.id, { name: 'one' });
    const second = await updateIssuerAccessRule(deps, ACTOR, grant.id, { name: 'two' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.grant.updated_at).toBeGreaterThan(first.grant.updated_at);
    expect(await getIssuerAccessRule(env.DB, grant.id)).toEqual(second.grant);
  });
});

describe('read-then-write races are decided in SQL', () => {
  it('a grant enabled after the trust-change check still requires confirmation', async () => {
    const network = fakeNetwork(undefined, {
      [ACME_ISSUER]: `${ACME_ISSUER}/keys`,
      'https://idp2.acme.example': 'https://idp2.acme.example/keys',
    });
    const deps = opsDeps({ fetch: network.fetch });
    const created = await createCredentialAccessRule(deps, ACTOR, {
      credential_id: await testCredentialId(deps),
      name: 'Acme',
      profile: 'generic',
      issuer: ACME_ISSUER,
      anchor_claims: ['sub'],
    });
    if (!created.ok) throw new Error(created.errors.join());
    const serviceId = await seedService(deps);
    const grant = await createIssuerAccessRule(deps, ACTOR, {
      name: 'ci',
      credential_access_rule_id: created.credentialAccessRule.id,
      service_id: serviceId,
      conditions: [{ claim: 'sub', match: 'exact', values: ['ci-bot'] }],
      rules: [{ methods: ['GET'], path: '/**' }],
      enabled: false,
      acknowledge_warnings: true,
    });
    if (!grant.ok) throw new Error(grant.errors.join());

    const audits = await auditCount();
    const racing = racingDeps(deps, () =>
      env.DB.prepare('UPDATE issuer_access_rules SET enabled = 1 WHERE id = ?')
        .bind(grant.grant.id)
        .run(),
    );
    const result = await updateCredentialAccessRule(
      racing,
      ACTOR,
      created.credentialAccessRule.id,
      {
        issuer: 'https://idp2.acme.example',
      },
    );
    expect(result).toMatchObject({ ok: false, reason: 'confirmation_required' });
    expect((await getCredentialAccessRule(env.DB, created.credentialAccessRule.id))?.issuer).toBe(
      ACME_ISSUER,
    );
    expect(await auditCount()).toBe(audits);
  });

  it('a grant created after the reference check blocks the service delete', async () => {
    const deps = opsDeps();
    const provider = await seedGithubProvider(deps);
    const serviceId = await seedService(deps);
    const audits = await auditCount();
    const racing = racingDeps(deps, () =>
      seedIssuerAccessRule(deps, provider.id, serviceId, 'late'),
    );
    const result = await deleteService(racing, ACTOR, serviceId);
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await getService(env.DB, serviceId)).not.toBeNull();
    // Only the racing grant's own audit row was added.
    expect(await auditCount()).toBe(audits + 1);
  });
});

describe('input hardening', () => {
  it('stores only the known verify check fields', async () => {
    const deps = opsDeps();
    const result = await createService(
      deps,
      ACTOR,
      serviceInput({
        verify: { method: 'GET', path: '/rate_limit', expect_status: 200, extra: 'x' } as never,
      }),
      CONTEXT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await env.DB.prepare('SELECT verify FROM credentials WHERE id = ?')
      .bind(result.service.id)
      .first<{ verify: string }>();
    expect(JSON.parse(row?.verify ?? 'null')).toEqual({
      expect_status: 200,
      method: 'GET',
      path: '/rate_limit',
    });
  });

  it('rejects non-boolean enabled values instead of treating them as truthy', async () => {
    const deps = opsDeps();
    const id = await seedService(deps);
    await updateServiceFields(deps, ACTOR, id, { enabled: false });
    const result = await updateServiceFields(deps, ACTOR, id, { enabled: 'false' as never });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect((await getService(env.DB, id))?.enabled).toBe(false);
  });

  it('reports non-text names as validation errors, not exceptions', async () => {
    const deps = opsDeps();
    const id = await seedService(deps);
    await expect(updateServiceFields(deps, ACTOR, id, { name: 7 as never })).resolves.toMatchObject(
      { ok: false, reason: 'invalid' },
    );
    const provider = await seedGithubProvider(deps);
    await expect(
      updateCredentialAccessRule(deps, ACTOR, provider.id, { audience: null as never }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid' });
    const grant = await seedIssuerAccessRule(deps, provider.id, id);
    await expect(
      updateIssuerAccessRule(deps, ACTOR, grant.id, { name: ['x'] as never }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('verify check', () => {
  const target = {
    base_url: 'https://hooks.slack.com/services',
    injection: { kind: 'path' as const },
    timeout_ms: 120_000,
    verify: { method: 'POST' as const, path: '/', expect_status: 200 },
  };

  it('masks a credential echoed inside JSON with escaped slashes', () => {
    const secret = 'T0001/B0002/abcdefghijklmnop';
    const body = JSON.stringify({ url: `https://hooks.slack.com/services/${secret}` }).replaceAll(
      '/',
      '\\/',
    );
    const masked = maskSecret(body, target.injection, secret);
    expect(masked).not.toContain('abcdefghijklmnop');
  });

  it('masks a credential echoed with JSON unicode escapes', () => {
    const secret = 'user:p<a>ss&word-0123456789';
    const body = JSON.stringify({ seen: secret })
      .replaceAll('<', '\\u003c')
      .replaceAll('>', '\\u003e')
      .replaceAll('&', '\\u0026');
    expect(maskSecret(body, { kind: 'basic' }, secret)).not.toContain('word-0123456789');
  });

  it('gives up on a response body that never ends', async () => {
    const network = fakeNetwork(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ok":'));
            },
          }),
          { status: 200 },
        ),
    );
    const started = Date.now();
    const outcome = await runVerifyCheck(
      { fetch: network.fetch, now: () => Date.now() },
      { ...target, timeout_ms: 1000 },
      'T0001/B0002/abcdefghijklmnop',
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(outcome).toMatchObject({ status: 200, passed: true });
  });
});
