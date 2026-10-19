// I-RBAC-1 for the role split (ADR 0018, AR-15) on the real app: a credential manager manages
// credentials but cannot give anyone access to them (no credential access rule, no global access
// rule, no delete of a credential together with its rules); an access manager manages credential
// access rules but cannot touch a credential or a global access rule; an admin does both, global
// access rules included. Field permissions refuse the fields a role lacks, and neither split role
// can export. Every refusal leaves the control plane unchanged.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROUTE_PERMISSIONS } from '../../src/admin/auth/rbac';
import type { Role } from '../../src/db/types';
import {
  type AdminWorld,
  createAdminWorldApp,
  MUTATION_FIXTURES,
  readPath,
  resetAdminWorld,
  seedAdminWorld,
  TOKEN_FIXTURE_VARIANTS,
} from '../fixtures/admin-forms';
import { type AdminSession, adminGet, adminPost, createUser, loginAs } from '../helpers/admin-auth';
import { seedService } from '../unit/admin/ops/helpers';

/** Every control-plane row except identities (sign-ins touch them). */
async function controlPlaneDump(): Promise<string> {
  const tables = ['users', 'access_rules', 'credentials', 'claim_labels', 'settings', 'audit_log'];
  const dumps = await Promise.all(tables.map((t) => env.DB.prepare(`SELECT * FROM ${t}`).all()));
  return JSON.stringify(dumps.map((d) => d.results));
}

const routesWith = (permission: string) =>
  Object.entries(ROUTE_PERMISSIONS)
    .filter(([, rule]) => rule.permission === permission)
    .map(([key]) => key);

const TOKEN_ROUTES = routesWith('tokens:write');
const ACCESS_ROUTES = routesWith('access:write');
const GLOBAL_ROUTES = routesWith('access_rules:global');

let world: AdminWorld;
let sessions: Record<Role, AdminSession>;

beforeEach(async () => {
  await resetAdminWorld();
  world = await seedAdminWorld(createAdminWorldApp());
  const roles: Role[] = ['token_manager', 'access_manager', 'admin', 'owner', 'viewer'];
  const entries = await Promise.all(
    roles.map(async (role) => {
      const user = await createUser({ email: `${role}@example.com`, role });
      return [role, await loginAs(world.app, user)] as const;
    }),
  );
  sessions = Object.fromEntries(entries) as Record<Role, AdminSession>;
});

/**
 * Prepares route `key` (its fixture may seed rows), then returns a function that sends it as
 * `role` with the fixture's fields plus `extra`.
 */
async function prepare(key: string, role: Role, extra: Record<string, string> = {}) {
  if (key.startsWith('GET ')) {
    const path = readPath(key, world);
    return async () => ({ res: await adminGet(world.app, sessions[role], path), mutation: null });
  }
  const mutation = await MUTATION_FIXTURES[key]?.(world);
  if (!mutation) throw new Error(`no fixture for ${key}`);
  return async () => ({
    res: await adminPost(mutation.app ?? world.app, sessions[role], mutation.path, {
      ...mutation.fields,
      ...extra,
    }),
    mutation,
  });
}

async function send(key: string, role: Role, extra: Record<string, string> = {}) {
  return (await prepare(key, role, extra))();
}

async function expectRefused(key: string, role: Role, extra: Record<string, string> = {}) {
  const request = await prepare(key, role, extra);
  const before = await controlPlaneDump();
  const { res } = await request();
  expect(res.status, `${key} as ${role}`).toBe(403);
  expect(await res.text()).toContain('Your role does not allow this action.');
  expect(await controlPlaneDump(), `${key} as ${role}`).toBe(before);
}

async function expectAllowed(key: string, role: Role) {
  const { res, mutation } = await send(key, role);
  const body = await res.text();
  expect(mutation?.successStatus ?? (mutation ? [303] : [200]), body.slice(0, 500)).toContain(
    res.status,
  );
}

describe('I-RBAC-1: token and access duties are separate', () => {
  it('lists credential, credential access rule and global access rule routes', () => {
    expect(TOKEN_ROUTES).toContain('POST /admin/credentials/:id/test');
    expect(TOKEN_ROUTES).toContain('POST /admin/credentials/:id/secret');
    expect(TOKEN_ROUTES).toContain('POST /admin/credentials/:id/destination');
    for (const action of ['', '/:id', '/:id/tenants', '/:id/copy', '/:id/toggle', '/:id/delete']) {
      const key = `POST /admin/credential-access-rules${action}`;
      expect(ACCESS_ROUTES).toContain(key);
      expect(TOKEN_ROUTES).not.toContain(key);
    }
    expect(ACCESS_ROUTES).toContain('GET /admin/credential-access-rules/new');
    for (const action of ['', '/:id', '/:id/toggle', '/:id/delete']) {
      expect(GLOBAL_ROUTES).toContain(`POST /admin/global-access-rules${action}`);
    }
    expect(GLOBAL_ROUTES).toContain('GET /admin/global-access-rules/new');
  });

  it.each(ACCESS_ROUTES)('token_manager is refused %s', async (key) => {
    await expectRefused(key, 'token_manager');
  });

  it.each(GLOBAL_ROUTES)('token_manager is refused %s', async (key) => {
    await expectRefused(key, 'token_manager');
  });

  it.each(TOKEN_ROUTES)('token_manager may use %s', async (key) => {
    await expectAllowed(key, 'token_manager');
  });

  it.each(TOKEN_ROUTES)('access_manager is refused %s', async (key) => {
    await expectRefused(key, 'access_manager');
  });

  it.each(GLOBAL_ROUTES)('access_manager is refused %s', async (key) => {
    await expectRefused(key, 'access_manager');
  });

  it.each(ACCESS_ROUTES)('access_manager may use %s', async (key) => {
    await expectAllowed(key, 'access_manager');
  });

  it.each([...ACCESS_ROUTES, ...GLOBAL_ROUTES])('admin may use %s', async (key) => {
    await expectAllowed(key, 'admin');
  });

  it('a credential manager cannot delete a credential together with its rules (with_rules)', async () => {
    const before = await controlPlaneDump();
    const request = await TOKEN_FIXTURE_VARIANTS.deleteWithRules(world);
    const res = await adminPost(world.app, sessions.token_manager, request.path, request.fields);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Your role does not allow this action.');
    expect(await controlPlaneDump()).toBe(before);
  });

  it('a credential manager cannot delete a credential that has rules without with_rules', async () => {
    // The route admits the role, so the request records the sign-in (`last_login_at`); a first
    // request records it before the dump, so the dump compares only what the delete could change.
    await adminGet(world.app, sessions.token_manager, '/admin');
    const before = await controlPlaneDump();
    const res = await adminPost(
      world.app,
      sessions.token_manager,
      `/admin/credentials/${world.serviceId}/delete`,
      { confirm: '1' },
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('1 credential access rule');
    expect(await controlPlaneDump()).toBe(before);
  });

  it('a credential manager can delete a credential that has no rules', async () => {
    const id = await seedService(world.app.deps, { slug: 'no-rules' });
    const res = await adminPost(
      world.app,
      sessions.token_manager,
      `/admin/credentials/${id}/delete`,
      {
        confirm: '1',
      },
    );
    expect(res.status).toBe(303);
    const row = await env.DB.prepare('SELECT id FROM credentials WHERE id = ?').bind(id).first();
    expect(row).toBeNull();
  });

  it('an access manager cannot delete a credential, with its rules or not', async () => {
    // Deleting the credential itself is a credential duty: the route needs tokens:write.
    await expectRefused('POST /admin/credentials/:id/delete', 'access_manager', {
      with_rules: '1',
    });
  });

  it('an admin can delete a credential together with its rules', async () => {
    const request = await TOKEN_FIXTURE_VARIANTS.deleteWithRules(world);
    const res = await adminPost(world.app, sessions.admin, request.path, request.fields);
    expect(res.status).toBe(303);
    const { results } = await env.DB.prepare('SELECT id FROM access_rules WHERE credential_id = ?')
      .bind(world.serviceId)
      .all();
    expect(results).toEqual([]);
    // The global access rule of another issuer stays.
    const global = await env.DB.prepare('SELECT id FROM access_rules WHERE id = ?')
      .bind(world.global.id)
      .first();
    expect(global).not.toBeNull();
  });

  it.each(['token_manager', 'admin'] as const)(
    '%s cannot allow a host on the way (allow_host needs settings:write)',
    async (role) => {
      await expectRefused('POST /admin/credentials', role, { allow_host: '1' });
    },
  );

  it('an empty field-permission field is not a use of it', async () => {
    const { res } = await send('POST /admin/credentials', 'token_manager', { allow_host: '' });
    expect(res.status).toBe(303);
  });

  it('an owner may send both fields', async () => {
    const { res } = await send('POST /admin/credentials', 'owner', { allow_host: '1' });
    expect(res.status).toBe(303);
  });

  it.each(['token_manager', 'access_manager'] as const)('%s cannot export', async (role) => {
    await expectRefused('POST /admin/export', role);
  });

  it('admins can export', async () => {
    const { res } = await send('POST /admin/export', 'admin');
    expect(res.status).toBe(200);
  });
});
