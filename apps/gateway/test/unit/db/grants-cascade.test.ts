import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteIssuerAccessRulesByIdsStatement,
  exactIssuerAccessRuleSetGuard,
  listIssuerAccessRules,
} from '../../../src/db/issuer_access_rules';
import type { CredentialAccessRule } from '../../../src/db/types';
import {
  opsDeps,
  resetControlPlane,
  seedGithubProvider,
  seedIssuerAccessRule,
  seedService,
} from '../admin/ops/helpers';

let provider: CredentialAccessRule;
let serviceId: string;
let otherServiceId: string;
let ids: string[];

beforeEach(async () => {
  await resetControlPlane();
  const deps = opsDeps();
  serviceId = await seedService(deps, { slug: 'one' });
  provider = await seedGithubProvider(deps);
  otherServiceId = await seedService(deps, { slug: 'two' });
  ids = [
    (await seedIssuerAccessRule(deps, provider.id, serviceId, 'a')).id,
    (await seedIssuerAccessRule(deps, provider.id, serviceId, 'b')).id,
  ];
  await seedIssuerAccessRule(deps, provider.id, otherServiceId, 'other');
});

async function cascade(listed: string[]) {
  const guard = exactIssuerAccessRuleSetGuard('service_id', serviceId, listed);
  const [result] = await env.DB.batch([
    deleteIssuerAccessRulesByIdsStatement(env.DB, listed, guard),
  ]);
  return result?.meta.changes;
}

describe('cascade delete of issuer_access_rules under an exact-set guard', () => {
  it('deletes exactly the listed issuer_access_rules when they are all the issuer_access_rules of the owner', async () => {
    expect(await cascade([...ids].reverse())).toBe(2);
    expect((await listIssuerAccessRules(env.DB)).map((grant) => grant.service_id)).toEqual([
      otherServiceId,
    ]);
  });

  it('deletes nothing when a grant was added since the list was shown', async () => {
    await seedIssuerAccessRule(opsDeps(), provider.id, serviceId, 'late');
    expect(await cascade(ids)).toBe(0);
    expect(await listIssuerAccessRules(env.DB, { service_id: serviceId })).toHaveLength(3);
  });

  it('deletes nothing when the list misses a grant or names one of another owner', async () => {
    expect(await cascade([ids[0] ?? ''])).toBe(0);
    const other =
      (await listIssuerAccessRules(env.DB, { service_id: otherServiceId }))[0]?.id ?? '';
    expect(await cascade([ids[0] ?? '', other])).toBe(0);
    expect(await listIssuerAccessRules(env.DB)).toHaveLength(3);
  });

  it('ignores duplicate ids', async () => {
    expect(await cascade([...ids, ...ids])).toBe(2);
  });

  it('an empty list holds only for an owner without issuer_access_rules', async () => {
    const empty = exactIssuerAccessRuleSetGuard('credential_access_rule_id', 'cpr_none', []);
    const holds = await env.DB.prepare(`SELECT ${empty.sql} AS ok`)
      .bind(...empty.binds)
      .first<number>('ok');
    expect(holds).toBe(1);
    expect(await cascade([])).toBe(0);
    expect(await listIssuerAccessRules(env.DB)).toHaveLength(3);
  });

  it('keeps a fixed bind count for any number of ids (D1 allows 100 per statement)', async () => {
    const many = [...ids, ...Array.from({ length: 148 }, (_, index) => `grt_missing_${index}`)];
    const guard = exactIssuerAccessRuleSetGuard('service_id', serviceId, many);
    expect(guard.binds).toHaveLength(4);
    expect(guard.sql.match(/\?/g)).toHaveLength(4);
    // The extra ids are not issuer_access_rules of the owner, so the count differs and nothing is deleted.
    expect(await cascade(many)).toBe(0);
    expect(await listIssuerAccessRules(env.DB)).toHaveLength(3);
  });

  it('refuses a column outside the two owners', () => {
    expect(() => exactIssuerAccessRuleSetGuard('name' as never, 'x', [])).toThrow();
  });
});
