import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { updateCredentialAccessRule } from '../../../../src/admin/ops/credential-access-rules';
import { updateServiceFields } from '../../../../src/admin/ops/credentials';
import { updateIssuerAccessRule } from '../../../../src/admin/ops/issuer_access_rules';
import { getCredentialAccessRule } from '../../../../src/db/credential-access-rules';
import { getService } from '../../../../src/db/credentials';
import { getIssuerAccessRule } from '../../../../src/db/issuer_access_rules';
import {
  ACTOR,
  auditCount,
  opsDeps,
  resetControlPlane,
  seedGithubProvider,
  seedIssuerAccessRule,
  seedService,
} from './helpers';

beforeEach(resetControlPlane);

// I-AUDIT-1: an audit row records a mutation; a save that changes nothing is not one.
describe('updates that change nothing write nothing', () => {
  it('updateIssuerAccessRule', async () => {
    const deps = opsDeps();
    const provider = await seedGithubProvider(deps);
    const grant = await seedIssuerAccessRule(deps, provider.id, await seedService(deps));
    const audits = await auditCount();

    const result = await updateIssuerAccessRule(deps, ACTOR, grant.id, {
      name: grant.name,
      conditions: grant.conditions,
      rules: grant.rules,
    });

    expect(result).toMatchObject({ ok: true, changed: false });
    expect(await auditCount()).toBe(audits);
    expect((await getIssuerAccessRule(env.DB, grant.id))?.updated_at).toBe(grant.updated_at);
    expect(await updateIssuerAccessRule(deps, ACTOR, grant.id, { name: 'renamed' })).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(await auditCount()).toBe(audits + 1);
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

  it('updateCredentialAccessRule', async () => {
    const deps = opsDeps();
    const provider = await seedGithubProvider(deps);
    const audits = await auditCount();

    const result = await updateCredentialAccessRule(deps, ACTOR, provider.id, {
      name: provider.name,
      tenant_pin: provider.tenant_pin,
    });

    expect(result).toMatchObject({ ok: true, changed: false });
    expect(await auditCount()).toBe(audits);
    expect((await getCredentialAccessRule(env.DB, provider.id))?.updated_at).toBe(
      provider.updated_at,
    );
  });

  it('an explicit enable is still recorded when the flag already had that value', async () => {
    const deps = opsDeps();
    const provider = await seedGithubProvider(deps);
    const audits = await auditCount();
    expect(
      await updateCredentialAccessRule(deps, ACTOR, provider.id, { enabled: true }),
    ).toMatchObject({
      ok: true,
    });
    expect(await auditCount()).toBe(audits + 1);
  });
});
