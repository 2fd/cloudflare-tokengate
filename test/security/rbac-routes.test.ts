// I-RBAC-1 against the real app: the routes createApp() registers under /admin are exactly the
// RBAC table's keys, and for every route × role (anonymous, viewer, admin, owner) the response is
// sign-in, 403 with no side effect, or success. Successful mutations reuse the I-AUDIT-1 fixtures.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { can, ROUTE_PERMISSIONS } from '../../src/admin/auth/rbac';
import { createApp } from '../../src/app';
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

type Actor = 'anonymous' | Role;
const ACTORS: Actor[] = ['anonymous', 'viewer', 'admin', 'owner'];

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

/** Every control-plane row except sessions (login touches them), for "no side effect" checks. */
async function controlPlaneDump(): Promise<string> {
  const tables = ['users', 'caller_providers', 'services', 'grants', 'settings', 'audit_log'];
  const dumps = await Promise.all(tables.map((t) => env.DB.prepare(`SELECT * FROM ${t}`).all()));
  return JSON.stringify(dumps.map((d) => d.results));
}

let world: AdminWorld;
let sessions: Record<Role, AdminSession>;

beforeEach(async () => {
  await resetAdminWorld();
  world = await seedAdminWorld(createAdminWorldApp());
  const entries = await Promise.all(
    (['viewer', 'admin', 'owner'] as const).map(async (role) => {
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
      if (isGet) {
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toMatch(/^\/auth\/login\?return_to=/);
      } else {
        expect(res.status).toBe(401);
      }
    } else if (!allowed) {
      expect(res.status).toBe(403);
      expect(body).toContain('Your role does not allow this action.');
    } else if (isGet) {
      expect(res.status, body.slice(0, 500)).toBe(200);
    } else {
      expect(mutation?.successStatus ?? [303], body.slice(0, 500)).toContain(res.status);
      expect(await auditCount()).toBe(auditBefore + 1);
    }

    if (!allowed) {
      // Denied requests have no side effect at all, audit included.
      expect(await controlPlaneDump()).toBe(dumpBefore);
    }
  });
});

describe('I-RBAC-1: routes outside the table are denied (fail closed)', () => {
  it.each([
    ['GET', '/admin/not-a-page'],
    ['GET', '/admin/services/svc_x/credential'],
    ['POST', '/admin/requests'],
    ['POST', '/admin/audit'],
    ['PUT', '/admin/services'],
    ['DELETE', '/admin/users/usr_x'],
    ['PATCH', '/admin/settings'],
  ])('%s %s is 403 for an owner', async (method, path) => {
    const owner = sessions.owner;
    const res = await world.app.request(path, {
      method,
      headers: {
        cookie: owner.cookie,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      ...(method === 'GET' ? {} : { body: new URLSearchParams({ _csrf: owner.csrfToken }) }),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
  });

  it('HEAD resolves to the GET rule (admin-only pages stay admin-only)', async () => {
    const head = (actor: Role) =>
      world.app.request('/admin/services/new', {
        method: 'HEAD',
        headers: { cookie: sessions[actor].cookie },
        redirect: 'manual',
      });
    expect((await head('viewer')).status).toBe(403);
    expect((await head('admin')).status).toBe(200);
  });

  it('HEAD or GET on the POST-only export is refused and writes no audit row', async () => {
    const before = await auditCount();
    for (const method of ['GET', 'HEAD']) {
      const res = await world.app.request('/admin/export', {
        method,
        headers: { cookie: sessions.owner.cookie },
        redirect: 'manual',
      });
      expect(res.status, method).toBe(403);
    }
    expect(await auditCount()).toBe(before);
  });
});
