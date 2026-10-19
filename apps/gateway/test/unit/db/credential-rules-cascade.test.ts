// The credential delete guards of src/db/access-rules.ts: deleting a credential cascades to its credential
// access rules (foreign key), so the delete carries a guard that its rules are exactly the confirmed
// set (exactCredentialRuleSetGuard), or that it has none (noCredentialRulesGuard). A rule added or
// removed concurrently makes the delete write nothing (I-AUDIT-1).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  exactCredentialRuleSetGuard,
  listCredentialAccessRules,
  noCredentialRulesGuard,
} from '../../../src/db/access-rules';
import { deleteServiceStatement } from '../../../src/db/credentials';
import { opsDeps, resetControlPlane, seedCredentialRule, seedService } from '../admin/ops/helpers';

let serviceId: string;
let otherServiceId: string;
let ids: string[];

beforeEach(async () => {
  await resetControlPlane();
  const deps = opsDeps();
  serviceId = await seedService(deps, { slug: 'one' });
  otherServiceId = await seedService(deps, { slug: 'two' });
  ids = [
    (await seedCredentialRule(deps, { credential_id: serviceId, name: 'a' })).id,
    (await seedCredentialRule(deps, { credential_id: serviceId, name: 'b' })).id,
  ];
  await seedCredentialRule(deps, { credential_id: otherServiceId, name: 'other' });
});

async function holds(guard: { sql: string; binds: unknown[] }): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT ${guard.sql} AS ok`)
    .bind(...guard.binds)
    .first<number>('ok');
  return row === 1;
}

/** Runs the guarded delete; true when the credential is gone. */
async function deleteWith(listed: string[]): Promise<boolean> {
  const guard = exactCredentialRuleSetGuard(serviceId, listed);
  await env.DB.batch([deleteServiceStatement(env.DB, serviceId, guard)]);
  const row = await env.DB.prepare('SELECT id FROM credentials WHERE id = ?')
    .bind(serviceId)
    .first();
  return row === null;
}

describe('credential delete under an exact rule-set guard', () => {
  it('deletes the credential and, by cascade, exactly its rules', async () => {
    expect(await deleteWith([...ids].reverse())).toBe(true);
    expect((await listCredentialAccessRules(env.DB)).map((rule) => rule.credential_id)).toEqual([
      otherServiceId,
    ]);
  });

  it('deletes nothing when a rule was added since the list was shown', async () => {
    await seedCredentialRule(opsDeps(), { credential_id: serviceId, name: 'late' });
    expect(await deleteWith(ids)).toBe(false);
    expect(await listCredentialAccessRules(env.DB, { credential_id: serviceId })).toHaveLength(3);
  });

  it('deletes nothing when the list misses a rule or names one of another credential', async () => {
    expect(await deleteWith([ids[0] ?? ''])).toBe(false);
    const other =
      (await listCredentialAccessRules(env.DB, { credential_id: otherServiceId }))[0]?.id ?? '';
    expect(await deleteWith([ids[0] ?? '', other])).toBe(false);
    expect(await listCredentialAccessRules(env.DB)).toHaveLength(3);
  });

  it('ignores duplicate ids', async () => {
    expect(await holds(exactCredentialRuleSetGuard(serviceId, [...ids, ...ids]))).toBe(true);
  });

  it('keeps a fixed bind count for any number of ids (D1 allows 100 per statement)', async () => {
    const many = [...ids, ...Array.from({ length: 148 }, (_, index) => `acr_missing_${index}`)];
    const guard = exactCredentialRuleSetGuard(serviceId, many);
    expect(guard.binds).toHaveLength(4);
    expect(guard.sql.match(/\?/g)).toHaveLength(4);
    expect(await holds(guard)).toBe(false);
  });
});

describe('noCredentialRulesGuard', () => {
  it('holds only for an existing credential without rules', async () => {
    const empty = await seedService(opsDeps(), { slug: 'three' });
    expect(await holds(noCredentialRulesGuard(empty))).toBe(true);
    expect(await holds(noCredentialRulesGuard(serviceId))).toBe(false);
    expect(await holds(noCredentialRulesGuard('svc_missing'))).toBe(false);
  });

  it('a concurrent rule insert makes the guarded delete write nothing', async () => {
    const empty = await seedService(opsDeps(), { slug: 'four' });
    const guard = noCredentialRulesGuard(empty);
    await seedCredentialRule(opsDeps(), { credential_id: empty, name: 'concurrent' });
    await env.DB.batch([deleteServiceStatement(env.DB, empty, guard)]);
    expect(
      await env.DB.prepare('SELECT id FROM credentials WHERE id = ?').bind(empty).first(),
    ).not.toBeNull();
  });
});
