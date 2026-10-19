// Attempts to break the admin ops: races between read and write (guards must be SQL-enforced),
// revocation that depends on validation, stalled upstreams and credential echoes in odd encodings.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  setCredentialAccessRuleEnabled,
  updateCredentialAccessRule,
} from '../../../../src/admin/ops/credential-access-rules';
import {
  createService,
  deleteService,
  updateServiceFields,
} from '../../../../src/admin/ops/credentials';
import { updateGlobalAccessRule } from '../../../../src/admin/ops/global-access-rules';
import { maskSecret, runVerifyCheck } from '../../../../src/admin/ops/verify';
import {
  accessRuleUnchangedGuard,
  getAccessRuleRow,
  getCredentialAccessRule,
  updateAccessRuleStatement,
} from '../../../../src/db/access-rules';
import { getService } from '../../../../src/db/credentials';
import {
  ACTOR,
  auditCount,
  auditRows,
  CONTEXT,
  fakeNetwork,
  opsDeps,
  racingDeps,
  resetControlPlane,
  seedCredentialRule,
  seedGlobalRule,
  seedService,
  serviceInput,
} from './helpers';

beforeEach(resetControlPlane);

describe('revocation never depends on validation', () => {
  it('disables a credential access rule whose stored row no longer validates', async () => {
    const deps = opsDeps();
    const rule = await seedCredentialRule(deps);
    // Out of range for github-actions (max 900 s): e.g. written by an older version or by hand.
    await env.DB.prepare('UPDATE access_rules SET max_token_age_seconds = 3600 WHERE id = ?')
      .bind(rule.id)
      .run();
    const result = await setCredentialAccessRuleEnabled(deps, ACTOR, rule.id, false);
    expect(result.ok).toBe(true);
    expect((await getCredentialAccessRule(env.DB, rule.id))?.enabled).toBe(false);
    expect((await auditRows(rule.id)).at(-1)?.action).toBe('credential_access_rule.disable');
    // Enabling it again validates and is refused.
    const enabled = await setCredentialAccessRuleEnabled(deps, ACTOR, rule.id, true);
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
    const rule = await seedCredentialRule(deps);
    const snapshot = await getCredentialAccessRule(env.DB, rule.id);
    if (!snapshot) throw new Error('rule missing');

    expect((await setCredentialAccessRuleEnabled(deps, ACTOR, rule.id, false)).ok).toBe(true);
    // An edit based on the snapshot (still enabled) must not re-enable the rule.
    const stale = updateAccessRuleStatement(
      env.DB,
      rule.id,
      { ...snapshot, name: 'stale edit' },
      now,
      accessRuleUnchangedGuard(rule.id, snapshot.updated_at),
    );
    expect((await stale.run()).meta.changes).toBe(0);
    expect((await getCredentialAccessRule(env.DB, rule.id))?.enabled).toBe(false);
  });

  it('returns the stored version so the next op can use it as a guard', async () => {
    const now = 1_800_000_000_000;
    const deps = opsDeps({ now: () => now });
    const rule = await seedCredentialRule(deps);
    const first = await updateCredentialAccessRule(deps, ACTOR, rule.id, { name: 'one' });
    const second = await updateCredentialAccessRule(deps, ACTOR, rule.id, { name: 'two' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.rule.updated_at).toBeGreaterThan(first.rule.updated_at);
    expect(await getCredentialAccessRule(env.DB, rule.id)).toEqual(second.rule);
  });
});

describe('read-then-write races are decided in SQL', () => {
  it('a global access rule relaxed after the classification makes the unconfirmed tightening write nothing', async () => {
    const deps = opsDeps();
    const rule = await seedGlobalRule(deps, {
      rules: [{ methods: ['GET', 'POST'], path: '/repos/**' }],
    });
    const audits = await auditCount();
    // A concurrent confirmed update removes the operations limit after this op read the row.
    const racing = racingDeps(deps, () =>
      updateGlobalAccessRule(deps, ACTOR, rule.id, { rules: null, confirm_widening: true }),
    );
    const result = await updateGlobalAccessRule(racing, ACTOR, rule.id, {
      rules: [{ methods: ['GET'], path: '/repos/**' }],
    });
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect((await getAccessRuleRow(env.DB, rule.id))?.rules).toBeNull();
    // Only the racing update's own audit row was added.
    expect(await auditCount()).toBe(audits + 1);
  });

  it('a credential access rule created after the reference check blocks the credential delete', async () => {
    const deps = opsDeps();
    const serviceId = await seedService(deps);
    const audits = await auditCount();
    const racing = racingDeps(deps, () =>
      seedCredentialRule(deps, { credential_id: serviceId, name: 'late' }),
    );
    const result = await deleteService(racing, ACTOR, serviceId);
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await getService(env.DB, serviceId)).not.toBeNull();
    // Only the racing rule's own audit row was added.
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
    const rule = await seedCredentialRule(deps, { credential_id: id });
    await expect(
      updateCredentialAccessRule(deps, ACTOR, rule.id, { audience: null as never }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid' });
    await expect(
      updateCredentialAccessRule(deps, ACTOR, rule.id, { name: ['x'] as never }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid' });
    const global = await seedGlobalRule(deps);
    await expect(
      updateGlobalAccessRule(deps, ACTOR, global.id, { name: 7 as never }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid' });
    await expect(
      updateGlobalAccessRule(deps, ACTOR, global.id, { rules: 'x' as never }),
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
