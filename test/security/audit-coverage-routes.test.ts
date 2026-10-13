// I-AUDIT-1 at the HTTP layer: every mutating route of the RBAC table, submitted the way the admin
// UI submits it, writes exactly one audit_log row. A mutating route without a fixture in
// test/fixtures/admin-forms.ts fails here, so new routes cannot ship unaudited by omission.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROUTE_PERMISSIONS } from '../../src/admin/auth/rbac';
import {
  type AdminWorld,
  createAdminWorldApp,
  MUTATION_FIXTURES,
  resetAdminWorld,
  seedAdminWorld,
} from '../fixtures/admin-forms';
import { type AdminSession, adminGet, adminPost, createUser, loginAs } from '../helpers/admin-auth';

interface AuditRow {
  id: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
}

async function auditRows(): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, action, actor_type, actor_id FROM audit_log ORDER BY rowid',
  ).all<AuditRow>();
  return results;
}

const MUTATING_ROUTES = Object.entries(ROUTE_PERMISSIONS)
  .filter(([, rule]) => rule.mutates)
  .map(([key]) => key);

let world: AdminWorld;
let owner: AdminSession;
let ownerId: string;

beforeEach(async () => {
  await resetAdminWorld();
  world = await seedAdminWorld(createAdminWorldApp());
  const user = await createUser({ email: 'owner@example.com', role: 'owner' });
  ownerId = user.id;
  owner = await loginAs(world.app, user);
});

describe('I-AUDIT-1: every mutating admin route writes exactly one audit row', () => {
  it('the table lists mutating routes (guards against an empty matrix)', () => {
    expect(MUTATING_ROUTES.length).toBeGreaterThanOrEqual(20);
  });

  it('there is no fixture for a route that is not a mutating route of the table', () => {
    expect(Object.keys(MUTATION_FIXTURES).filter((key) => !MUTATING_ROUTES.includes(key))).toEqual(
      [],
    );
  });

  it.each(MUTATING_ROUTES)('%s', async (routeKey) => {
    const fixture = MUTATION_FIXTURES[routeKey];
    expect(fixture, `no fixture in test/fixtures/admin-forms.ts for ${routeKey}`).toBeDefined();
    if (!fixture) return;
    const request = await fixture(world);

    const before = new Set((await auditRows()).map((row) => row.id));
    const res = await adminPost(request.app ?? world.app, owner, request.path, request.fields);
    const body = await res.text();
    expect(request.successStatus ?? [303], `${res.status}: ${body.slice(0, 2000)}`).toContain(
      res.status,
    );
    await world.app.settle();

    const added = (await auditRows()).filter((row) => !before.has(row.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      action: request.action,
      actor_type: 'user',
      actor_id: ownerId,
    });
  });
});

describe('I-AUDIT-1: read routes', () => {
  it('no GET route is audited (an audited action must be a CSRF-checked POST)', async () => {
    const before = (await auditRows()).length;
    for (const key of Object.keys(ROUTE_PERMISSIONS)) {
      if (!key.startsWith('GET ') || key.includes(':')) continue;
      const res = await adminGet(world.app, owner, key.slice(4));
      expect(res.status, key).toBe(200);
    }
    expect(await auditRows()).toHaveLength(before);
  });
});
