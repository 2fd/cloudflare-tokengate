// I-RBAC-1 against the real app: the routes createApp() registers under /admin are exactly the
// RBAC table's keys, and for every route × role (anonymous and the five roles) the response is
// sign-in, 403 with no side effect, or success. The oracle is a constant table in this file (WHO),
// never the production check. Successful mutations reuse the I-AUDIT-1 fixtures.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROUTE_PERMISSIONS } from '../../src/admin/auth/rbac';
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
  const tables = ['users', 'access_rules', 'credentials', 'claim_labels', 'settings', 'audit_log'];
  const dumps = await Promise.all(tables.map((t) => env.DB.prepare(`SELECT * FROM ${t}`).all()));
  return JSON.stringify(dumps.map((d) => d.results));
}

const ALL = ROLES;
const TOKENS: readonly Role[] = ['token_manager', 'admin', 'owner'];
const ACCESS: readonly Role[] = ['access_manager', 'admin', 'owner'];
const GLOBAL: readonly Role[] = ['admin', 'owner'];
const EXPORT: readonly Role[] = ['admin', 'owner'];
const OWNER: readonly Role[] = ['owner'];

/**
 * Who may use each route (ADR 0018, AR-15): credential managers decide which credentials exist,
 * access managers decide who may use them, and only admins and owners set global access rules.
 */
const WHO: Readonly<Record<string, readonly Role[]>> = {
  // == monitoring ==
  'GET /admin': ALL,
  'GET /admin/requests': ALL,
  'GET /admin/requests/:id': ALL,
  'GET /admin/audit': ALL,
  'GET /admin/retention': ALL,
  'POST /admin/retention': OWNER,

  // == users ==
  'GET /admin/users/appearance': ALL,
  'POST /admin/users/appearance': OWNER,
  'GET /admin/users/sign-in': ALL,
  'POST /admin/users/sign-in/policy': OWNER,
  'POST /admin/users/sign-in/hosts': OWNER,
  'GET /admin/users': ALL,
  'POST /admin/users': OWNER,
  'GET /admin/users/:id': ALL,
  'POST /admin/users/:id': OWNER,
  'POST /admin/users/:id/approve': OWNER,
  'POST /admin/users/:id/reject': OWNER,
  'POST /admin/users/:id/reset-login': OWNER,
  'POST /admin/users/:id/resend-invite': OWNER,
  'POST /admin/users/:id/delete': OWNER,
  'POST /admin/users/:id/dismiss-attempt': OWNER,

  // == tokens ==
  'GET /admin/credentials/hosts': ALL,
  'POST /admin/credentials/hosts': OWNER,
  'GET /admin/credentials/keys': ALL,
  'POST /admin/credentials/keys/rewrap': OWNER,
  'GET /admin/credentials': ALL,
  'GET /admin/credentials/new': TOKENS,
  'POST /admin/credentials': TOKENS,
  'GET /admin/credentials/:id': ALL,
  'POST /admin/credentials/:id': TOKENS,
  'POST /admin/credentials/:id/secret': TOKENS,
  'POST /admin/credentials/:id/destination': TOKENS,
  'POST /admin/credentials/:id/test': TOKENS,
  'POST /admin/credentials/:id/toggle': TOKENS,
  'POST /admin/credentials/:id/delete': TOKENS,

  // == access rules ==
  'GET /admin/credential-access-rules': ALL,
  'GET /admin/credential-access-rules/new': ACCESS,
  'POST /admin/credential-access-rules': ACCESS,
  'GET /admin/credential-access-rules/:id': ALL,
  'POST /admin/credential-access-rules/:id': ACCESS,
  'POST /admin/credential-access-rules/:id/tenants': ACCESS,
  'POST /admin/credential-access-rules/:id/copy': ACCESS,
  'POST /admin/credential-access-rules/:id/toggle': ACCESS,
  'POST /admin/credential-access-rules/:id/delete': ACCESS,
  // Every role reads global access rules (AR-16); only admins and owners change them (AR-15).
  'GET /admin/global-access-rules': ALL,
  'GET /admin/global-access-rules/new': GLOBAL,
  'POST /admin/global-access-rules': GLOBAL,
  'GET /admin/global-access-rules/:id': ALL,
  'POST /admin/global-access-rules/:id': GLOBAL,
  'POST /admin/global-access-rules/:id/toggle': GLOBAL,
  'POST /admin/global-access-rules/:id/delete': GLOBAL,

  // == global ==
  'POST /admin/export': EXPORT,
};

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
  it('the oracle covers exactly the route table', () => {
    expect(Object.keys(WHO).sort()).toEqual(Object.keys(ROUTE_PERMISSIONS).sort());
  });

  const cases = Object.keys(ROUTE_PERMISSIONS).flatMap((key) =>
    ACTORS.map((actor) => [key, actor] as const),
  );

  it.each(cases)('%s as %s', async (key, actor) => {
    const isGet = key.startsWith('GET ');
    const session = actor === 'anonymous' ? null : sessions[actor];
    const allowed = actor !== 'anonymous' && (WHO[key] ?? []).includes(actor);
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
    ['GET', '/admin/credentials/svc_x/credential'],
    ['HEAD', '/admin/not-a-page'],
    // Old URLs (ADR 0019): no redirects.
    ['GET', '/admin/tokens'],
    ['GET', '/admin/tokens/new'],
    ['GET', '/admin/consumers'],
    ['GET', '/admin/access'],
    ['GET', '/admin/issuer-access-rules'],
    ['GET', '/admin/settings'],
  ])('%s %s is a 404 page for an owner, with no side effect', async (method, path) => {
    const before = await controlPlaneDump();
    const res = await ownerRequest(method, path);
    expect(res.status).toBe(404);
    // An unknown path says there is no page; an old one says where its page went.
    if (method === 'GET') {
      expect(await res.text()).toMatch(
        /<h1>(?:Page not found|This page moved|The Settings page was split up)<\/h1>/,
      );
    }
    expect(await controlPlaneDump()).toBe(before);
  });

  it.each([
    ['POST', '/admin/requests'],
    ['POST', '/admin/audit'],
    ['POST', '/admin/tokens'],
    ['POST', '/admin/settings'],
    ['PUT', '/admin/credentials'],
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
      world.app.request('/admin/credentials/new', {
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
