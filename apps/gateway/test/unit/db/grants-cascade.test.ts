import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteGrantsByIdsStatement, exactGrantSetGuard, listGrants } from '../../../src/db/grants';
import type { CallerProvider } from '../../../src/db/types';
import {
  opsDeps,
  resetControlPlane,
  seedGithubProvider,
  seedGrant,
  seedService,
} from '../admin/ops/helpers';

let provider: CallerProvider;
let serviceId: string;
let otherServiceId: string;
let ids: string[];

beforeEach(async () => {
  await resetControlPlane();
  const deps = opsDeps();
  provider = await seedGithubProvider(deps);
  serviceId = await seedService(deps, { slug: 'one' });
  otherServiceId = await seedService(deps, { slug: 'two' });
  ids = [
    (await seedGrant(deps, provider.id, serviceId, 'a')).id,
    (await seedGrant(deps, provider.id, serviceId, 'b')).id,
  ];
  await seedGrant(deps, provider.id, otherServiceId, 'other');
});

async function cascade(listed: string[]) {
  const guard = exactGrantSetGuard('service_id', serviceId, listed);
  const [result] = await env.DB.batch([deleteGrantsByIdsStatement(env.DB, listed, guard)]);
  return result?.meta.changes;
}

describe('cascade delete of grants under an exact-set guard', () => {
  it('deletes exactly the listed grants when they are all the grants of the owner', async () => {
    expect(await cascade([...ids].reverse())).toBe(2);
    expect((await listGrants(env.DB)).map((grant) => grant.service_id)).toEqual([otherServiceId]);
  });

  it('deletes nothing when a grant was added since the list was shown', async () => {
    await seedGrant(opsDeps(), provider.id, serviceId, 'late');
    expect(await cascade(ids)).toBe(0);
    expect(await listGrants(env.DB, { service_id: serviceId })).toHaveLength(3);
  });

  it('deletes nothing when the list misses a grant or names one of another owner', async () => {
    expect(await cascade([ids[0] ?? ''])).toBe(0);
    const other = (await listGrants(env.DB, { service_id: otherServiceId }))[0]?.id ?? '';
    expect(await cascade([ids[0] ?? '', other])).toBe(0);
    expect(await listGrants(env.DB)).toHaveLength(3);
  });

  it('ignores duplicate ids', async () => {
    expect(await cascade([...ids, ...ids])).toBe(2);
  });

  it('an empty list holds only for an owner without grants', async () => {
    const empty = exactGrantSetGuard('caller_provider_id', 'cpr_none', []);
    const holds = await env.DB.prepare(`SELECT ${empty.sql} AS ok`)
      .bind(...empty.binds)
      .first<number>('ok');
    expect(holds).toBe(1);
    expect(await cascade([])).toBe(0);
    expect(await listGrants(env.DB)).toHaveLength(3);
  });

  it('keeps a fixed bind count for any number of ids (D1 allows 100 per statement)', async () => {
    const many = [...ids, ...Array.from({ length: 148 }, (_, index) => `grt_missing_${index}`)];
    const guard = exactGrantSetGuard('service_id', serviceId, many);
    expect(guard.binds).toHaveLength(4);
    expect(guard.sql.match(/\?/g)).toHaveLength(4);
    // The extra ids are not grants of the owner, so the count differs and nothing is deleted.
    expect(await cascade(many)).toBe(0);
    expect(await listGrants(env.DB)).toHaveLength(3);
  });

  it('refuses a column outside the two owners', () => {
    expect(() => exactGrantSetGuard('name' as never, 'x', [])).toThrow();
  });
});
