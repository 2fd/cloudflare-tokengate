// I-RBAC-1 against the real app: the routes createApp() registers under /admin are exactly the
// RBAC table's keys, and for every route × role (anonymous and the five roles) the response is
// sign-in, 403 with no side effect, or success. Successful mutations reuse the I-AUDIT-1 fixtures.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { can, ROUTE_PERMISSIONS } from '../../src/admin/auth/rbac';
import { createApp } from '../../src/app';
import type { Role } from '../../src/db/types';
import {
  type AdminWorld,
  createAdminWorldApp,
  expectedActions,
  MUTATION_FIXTURES,
  readPath,
  resetAdminWorld,
  seedAdminWorld,
} from '../fixtures/admin-forms';
import { type AdminSession, adminGet, adminPost, createUser, loginAs } from '../helpers/admin-auth';

type Actor = 'anonymous' | Role;
const ROLES: Role[] = ['viewer', 'token_manager', 'access_manager', 'admin', 'owner'];
const ACTORS: Actor[] = ['anonymous', ...ROLES];

/** `METHOD path` of every concrete (non-middleware) route the real app registers under /admin. */
function registeredAdminRoutes(): string[] {
  const keys = createApp()
    .routes.filter((route) => route.method !== 'ALL')
    .filter((route) => route.path === '/admin' || route.path.startsWith('/admin/'))
    .map((route) => `${route.method} ${route.path}`);
  return [...new Set(keys)].sort();
}

async function auditCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT count(*) AS n FROM audit_log').first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Every control-plane row except identities (sign-ins touch them), for "no side effect" checks. */
async function controlPlaneDump(): Promise<string> {
  const tables = [
    'users',
    'caller_providers',
    'services',
    'grants',
    'claim_labels',
    'settings',
    'audit_log',
  ];
  const dumps = await Promise.all(tables.map((t) => env.DB.prepare(`SELECT * FROM ${t}`).all()));
  return JSON.stringify(dumps.map((d) => d.results));
}

let world: AdminWorld;
let sessions: Record<Role, AdminSession>;

beforeEach(async () => {
  await resetAdminWorld();
  world = await seedAdminWorld(createAdminWorldApp());
  const entries = await Promise.all(
    ROLES.map(async (role) => {
      const user = await createUser({ email: `${role}@example.com`, role });
      return [role, await loginAs(world.app, user)] as const;
    }),
  );
  sessions = Object.fromEntries(entries) as Record<Role, AdminSession>;
});

describe('I-RBAC-1: the RBAC table and the registered admin routes are a bijection', () => {
  const registered = registeredAdminRoutes();
  const table = Object.keys(ROUTE_PERMISSIONS).sort();

  it('enumerates a non-trivial route set', () => {
    expect(registered.length).toBeGreaterThanOrEqual(30);
  });

  it('every registered /admin route is in the table', () => {
    expect(registered.filter((key) => !table.includes(key))).toEqual([]);
  });

  it('every table entry is a registered route', () => {
    expect(table.filter((key) => !registered.includes(key))).toEqual([]);
  });

  it('only unsafe methods are marked as mutating, and every unsafe route is', () => {
    for (const [key, rule] of Object.entries(ROUTE_PERMISSIONS)) {
      expect(rule.mutates, key).toBe(!key.startsWith('GET '));
    }
  });
});

describe('I-RBAC-1: route × role matrix on the real app', () => {
  const cases = Object.entries(ROUTE_PERMISSIONS).flatMap(([key, rule]) =>
    ACTORS.map((actor) => [key, actor, rule.permission] as const),
  );

  it.each(cases)('%s as %s', async (key, actor, permission) => {
    const isGet = key.startsWith('GET ');
    const session = actor === 'anonymous' ? null : sessions[actor];
    const allowed = actor !== 'anonymous' && can(actor, permission);
    const mutation = isGet ? null : await MUTATION_FIXTURES[key]?.(world);
    if (!isGet) expect(mutation, `no fixture for ${key}`).toBeDefined();
    const path = isGet ? readPath(key, world) : (mutation?.path ?? '');

    const auditBefore = await auditCount();
    const dumpBefore = allowed ? '' : await controlPlaneDump();
    const res = isGet
      ? await adminGet(world.app, session, path)
      : await adminPost(mutation?.app ?? world.app, session, path, mutation?.fields ?? {});
    const body = await res.text();

    if (actor === 'anonymous') {
      // No Access JWT: refused before routing, for every method.
      expect(res.status).toBe(401);
    } else if (!allowed) {
      expect(res.status).toBe(403);
      expect(body).toContain('Your role does not allow this action.');
    } else if (isGet) {
      expect(res.status, body.slice(0, 500)).toBe(200);
    } else {
      expect(mutation?.successStatus ?? [303], body.slice(0, 500)).toContain(res.status);
      const actions = mutation ? expectedActions(mutation).length : 1;
      expect(await auditCount()).toBe(auditBefore + actions);
    }

    if (!allowed) {
      // Denied requests have no side effect at all, audit included.
      expect(await controlPlaneDump()).toBe(dumpBefore);
    }
  });
});

describe('I-RBAC-1: routes outside the table are denied (fail closed)', () => {
  function ownerRequest(method: string, path: string) {
    const owner = sessions.owner;
    return world.app.request(path, {
      method,
      headers: {
        ...owner.headers,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: new URLSearchParams({ _csrf: owner.csrfToken }) }),
      redirect: 'manual',
    });
  }

  it.each([
    ['GET', '/admin/not-a-page'],
    ['GET', '/admin/tokens/svc_x/credential'],
    ['HEAD', '/admin/not-a-page'],
    // Old URLs (ADR 0019): no redirects.
    ['GET', '/admin/services'],
    ['GET', '/admin/services/new'],
    ['GET', '/admin/caller-providers'],
    ['GET', '/admin/grants'],
    ['GET', '/admin/settings'],
  ])('%s %s is a 404 page for an owner, with no side effect', async (method, path) => {
    const before = await controlPlaneDump();
    const res = await ownerRequest(method, path);
    expect(res.status).toBe(404);
    if (method === 'GET') expect(await res.text()).toContain('Page not found');
    expect(await controlPlaneDump()).toBe(before);
  });

  it.each([
    ['POST', '/admin/requests'],
    ['POST', '/admin/audit'],
    ['POST', '/admin/services'],
    ['POST', '/admin/settings'],
    ['PUT', '/admin/tokens'],
    ['DELETE', '/admin/users/usr_x'],
    ['PATCH', '/admin/retention'],
  ])('%s %s is 403 for an owner, with no side effect', async (method, path) => {
    const before = await controlPlaneDump();
    const res = await ownerRequest(method, path);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('This page does not exist or is not available.');
    expect(await controlPlaneDump()).toBe(before);
  });

  it('HEAD resolves to the GET rule (admin-only pages stay admin-only)', async () => {
    const head = (actor: Role) =>
      world.app.request('/admin/tokens/new', {
        method: 'HEAD',
        headers: { ...sessions[actor].headers },
        redirect: 'manual',
      });
    expect((await head('viewer')).status).toBe(403);
    expect((await head('access_manager')).status).toBe(403);
    expect((await head('token_manager')).status).toBe(200);
    expect((await head('admin')).status).toBe(200);
  });

  it('HEAD or GET on the POST-only export is a 404 and writes no audit row', async () => {
    const before = await auditCount();
    for (const method of ['GET', 'HEAD']) {
      const res = await world.app.request('/admin/export', {
        method,
        headers: { ...sessions.owner.headers },
        redirect: 'manual',
      });
      expect(res.status, method).toBe(404);
    }
    expect(await auditCount()).toBe(before);
  });
});
