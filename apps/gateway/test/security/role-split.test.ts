// I-RBAC-1 for the role split (ADR 0018) on the real app: a credential manager manages credentials but
// cannot give anyone access to them, an access manager manages credential access rules and issuer_access_rules but
// cannot touch a service or its credential, field permissions refuse the fields a role lacks, and
// neither role can export. Every refusal leaves the control plane unchanged.
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
} from '../fixtures/admin-forms';
import { type AdminSession, adminGet, adminPost, createUser, loginAs } from '../helpers/admin-auth';

/** Every control-plane row except identities (sign-ins touch them). */
async function controlPlaneDump(): Promise<string> {
  const tables = [
    'users',
    'credential_access_rules',
    'credentials',
    'issuer_access_rules',
    'claim_labels',
    'settings',
    'audit_log',
  ];
  const dumps = await Promise.all(tables.map((t) => env.DB.prepare(`SELECT * FROM ${t}`).all()));
  return JSON.stringify(dumps.map((d) => d.results));
}

const routesWith = (permission: string) =>
  Object.entries(ROUTE_PERMISSIONS)
    .filter(([, rule]) => rule.permission === permission)
    .map(([key]) => key);

const TOKEN_ROUTES = routesWith('tokens:write');
const ACCESS_ROUTES = routesWith('access:write');

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

describe('I-RBAC-1: token and access duties are separate', () => {
  it('lists token and access routes', () => {
    expect(TOKEN_ROUTES).toContain('POST /admin/credentials/:id/test');
    expect(TOKEN_ROUTES).toContain('POST /admin/credentials/:id/secret');
    expect(TOKEN_ROUTES).toContain('POST /admin/credentials/:id/destination');
    expect(ACCESS_ROUTES).toContain('POST /admin/issuer-access-rules');
    expect(TOKEN_ROUTES).toContain('POST /admin/credential-access-rules');
  });

  it.each(ACCESS_ROUTES)('token_manager is refused %s', async (key) => {
    await expectRefused(key, 'token_manager');
  });

  it.each(TOKEN_ROUTES)('token_manager may use %s', async (key) => {
    const { res, mutation } = await send(key, 'token_manager');
    const body = await res.text();
    expect(mutation?.successStatus ?? (mutation ? [303] : [200]), body.slice(0, 500)).toContain(
      res.status,
    );
  });

  it.each(TOKEN_ROUTES)('access_manager is refused %s', async (key) => {
    await expectRefused(key, 'access_manager');
  });

  it.each(ACCESS_ROUTES)('access_manager may use %s', async (key) => {
    const { res, mutation } = await send(key, 'access_manager');
    const body = await res.text();
    expect(mutation?.successStatus ?? (mutation ? [303] : [200]), body.slice(0, 500)).toContain(
      res.status,
    );
  });

  it('a credential manager cannot delete a service together with its issuer_access_rules (with_accesses)', async () => {
    await expectRefused('POST /admin/credentials/:id/delete', 'token_manager', {
      with_accesses: '1',
    });
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
