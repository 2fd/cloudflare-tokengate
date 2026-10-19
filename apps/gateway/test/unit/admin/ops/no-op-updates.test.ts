import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { updateCredentialAccessRule } from '../../../../src/admin/ops/credential-access-rules';
import { updateServiceFields } from '../../../../src/admin/ops/credentials';
import { updateGlobalAccessRule } from '../../../../src/admin/ops/global-access-rules';
import { getAccessRuleRow } from '../../../../src/db/access-rules';
import { getService } from '../../../../src/db/credentials';
import {
  ACTOR,
  auditCount,
  opsDeps,
  resetControlPlane,
  seedCredentialRule,
  seedGlobalRule,
  seedService,
} from './helpers';

beforeEach(resetControlPlane);

// I-AUDIT-1: an audit row records a mutation; a save that changes nothing is not one.
describe('updates that change nothing write nothing', () => {
  it('updateCredentialAccessRule', async () => {
    const deps = opsDeps();
    const rule = await seedCredentialRule(deps);
    const audits = await auditCount();

    const result = await updateCredentialAccessRule(deps, ACTOR, rule.id, {
      name: rule.name,
      tenant_pin: rule.tenant_pin,
      conditions: rule.conditions,
      rules: rule.rules,
    });

    expect(result).toMatchObject({ ok: true, changed: false });
    expect(await auditCount()).toBe(audits);
    expect((await getAccessRuleRow(env.DB, rule.id))?.updated_at).toBe(rule.updated_at);
    expect(
      await updateCredentialAccessRule(deps, ACTOR, rule.id, { name: 'renamed' }),
    ).toMatchObject({ ok: true, changed: true });
    expect(await auditCount()).toBe(audits + 1);
  });

  it('updateGlobalAccessRule', async () => {
    const deps = opsDeps();
    const rule = await seedGlobalRule(deps, {
      rules: [{ methods: ['GET'], path: '/repos/**' }],
    });
    const audits = await auditCount();

    const result = await updateGlobalAccessRule(deps, ACTOR, rule.id, {
      name: rule.name,
      rules: rule.rules,
      tenant_pin: null,
    });

    expect(result).toMatchObject({ ok: true, changed: false });
    expect(await auditCount()).toBe(audits);
    expect((await getAccessRuleRow(env.DB, rule.id))?.updated_at).toBe(rule.updated_at);
  });

  it('updateServiceFields', async () => {
    const deps = opsDeps();
    const id = await seedService(deps);
    const before = await getService(env.DB, id);
    const audits = await auditCount();

    const result = await updateServiceFields(deps, ACTOR, id, {
      name: before?.name,
      timeout_ms: before?.timeout_ms,
    });

    expect(result).toMatchObject({ ok: true, changed: false });
    expect(await auditCount()).toBe(audits);
    expect((await getService(env.DB, id))?.updated_at).toBe(before?.updated_at);
  });

  it('an explicit enable is still recorded when the flag already had that value', async () => {
    const deps = opsDeps();
    const rule = await seedCredentialRule(deps);
    const audits = await auditCount();
    expect(await updateCredentialAccessRule(deps, ACTOR, rule.id, { enabled: true })).toMatchObject(
      { ok: true },
    );
    expect(await auditCount()).toBe(audits + 1);
  });
});
