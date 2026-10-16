// Deleting a consumer with accesses (D9): one confirmed submit deletes the consumer, exactly the
// accesses the dialog listed, and its labels, with one audit row (I-AUDIT-1). An access manager
// can do it; a changed access set deletes nothing.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getCallerProvider } from '../../src/db/caller-providers';
import { listGrants } from '../../src/db/grants';
import type { CallerProvider } from '../../src/db/types';
import { adminGet, adminPost } from '../helpers/admin-auth';
import {
  auditActions,
  type ConsumersWorld,
  consumersWorld,
  labels,
  lastAudit,
  locationOf,
  seedLabel,
} from '../helpers/consumers';
import { seedGithubProvider, seedGrant, seedService } from '../unit/admin/ops/helpers';

let world: ConsumersWorld;
let provider: CallerProvider;
let ids: string[];

beforeEach(async () => {
  world = await consumersWorld();
  provider = await seedGithubProvider(world.app.deps);
  const serviceId = await seedService(world.app.deps);
  ids = [
    (await seedGrant(world.app.deps, provider.id, serviceId, 'a')).id,
    (await seedGrant(world.app.deps, provider.id, serviceId, 'b')).id,
  ].sort();
  await seedLabel(provider.id, 'repository_id', '987654321', 'acme/api');
});

const session = () => world.sessions.access_manager;

describe('I-AUDIT-1: deleting a consumer and its accesses is one audited change', () => {
  it('lists the accesses in the dialog and carries their ids', async () => {
    const html = await (
      await adminGet(world.app, session(), `/admin/consumers/${provider.id}`)
    ).text();
    expect(html).toContain('and its 2 consumer accesses?');
    expect(html).toContain('name="with_accesses" value="1"');
    expect(html).toContain(`name="access_ids" value="${ids.join(',')}"`);
  });

  it('deletes the consumer, its accesses and its labels with one audit row', async () => {
    const before = await auditActions();
    const res = await adminPost(world.app, session(), `/admin/consumers/${provider.id}/delete`, {
      confirm: '1',
      with_accesses: '1',
      access_ids: ids.join(','),
    });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe('/admin/consumers?notice=deleted_with_accesses');
    expect(await getCallerProvider(env.DB, provider.id)).toBeNull();
    expect(await listGrants(env.DB)).toEqual([]);
    expect(await labels(provider.id)).toEqual([]);
    expect(await auditActions()).toEqual([...before, 'caller_provider.delete']);
    const diff = await lastAudit('caller_provider.delete');
    expect(
      ((diff?.before ?? { grants: [] }) as { grants: Array<{ id: string }> }).grants
        .map((g) => g.id)
        .sort(),
    ).toEqual(ids);
  });

  it('deletes nothing when an access was added after the dialog was shown', async () => {
    await seedGrant(
      world.app.deps,
      provider.id,
      (await listGrants(env.DB))[0]?.service_id ?? '',
      'late',
    );
    const before = await auditActions();
    const res = await adminPost(world.app, session(), `/admin/consumers/${provider.id}/delete`, {
      confirm: '1',
      with_accesses: '1',
      access_ids: ids.join(','),
    });
    expect(res.status).toBe(409);
    expect(await getCallerProvider(env.DB, provider.id)).not.toBeNull();
    expect(await listGrants(env.DB)).toHaveLength(3);
    expect(await labels(provider.id)).toHaveLength(1);
    expect(await auditActions()).toEqual(before);
  });

  it('a token manager cannot delete a consumer', async () => {
    const res = await adminPost(
      world.app,
      world.sessions.token_manager,
      `/admin/consumers/${provider.id}/delete`,
      {
        confirm: '1',
        with_accesses: '1',
        access_ids: ids.join(','),
      },
    );
    expect(res.status).toBe(403);
    expect(await listGrants(env.DB)).toHaveLength(2);
  });
});
