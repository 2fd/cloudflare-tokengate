// Admin sign-in end to end through the middleware: Cloudflare Access (faked via injected fetch),
// the loopback-only dev login, the setup page and the RBAC/CSRF gate.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ACCESS_JWT_HEADER, resetAccessCertsCacheForTests } from '../../src/admin/auth/access';
import { CSRF_COOKIE } from '../../src/admin/auth/csrf';
import { SEEN_INTERVAL_MS } from '../../src/admin/auth/middleware';
import { formData, renderPage } from '../../src/admin/render';
import {
  adminGet,
  adminPost,
  createAdminTestApp,
  createUser,
  loginAs,
  resetControlPlane,
  setCookies,
  stubAdminPages,
} from '../helpers/admin-auth';
import { combineFetch, fakeAccess, testAccess } from '../helpers/login-providers';

beforeEach(async () => {
  await resetControlPlane();
  resetAccessCertsCacheForTests();
});

/** Audit actions, sorted by name (ids written in the same millisecond have random order). */
async function auditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT action FROM audit_log ORDER BY action').all<{
    action: string;
  }>();
  return results.map((row) => row.action);
}

const NO_ACCESS = { AUTH_ACCESS_TEAM_DOMAIN: '', AUTH_ACCESS_AUD: '' };

describe('setup page', () => {
  it('explains Access setup when no login is configured', async () => {
    const app = createAdminTestApp({ env: NO_ACCESS, routes: stubAdminPages });
    const res = await app.request('/admin/services');
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('Set up sign-in');
    expect(html).toContain('AUTH_ACCESS_TEAM_DOMAIN');
    expect(html).toContain('AUTH_DEV_EMAIL');
    expect(html).toContain('https://gw.test');
  });

  it('names misconfigured variables but never echoes values', async () => {
    const app = createAdminTestApp({
      env: { AUTH_ACCESS_TEAM_DOMAIN: 'leaky-team-value!', AUTH_ACCESS_AUD: 'a'.repeat(64) },
    });
    const html = await (await app.request('/admin')).text();
    expect(html).toContain('AUTH_ACCESS_TEAM_DOMAIN');
    expect(html).not.toContain('leaky-team-value');
  });

  it('serves no /auth routes', async () => {
    const app = createAdminTestApp({ routes: stubAdminPages });
    for (const path of ['/auth/login', '/auth/github/start', '/auth/access/start']) {
      expect((await app.request(path)).status, path).toBe(404);
    }
    expect((await app.request('/auth/logout', { method: 'POST' })).status).toBe(404);
  });
});

describe('Cloudflare Access login', () => {
  function accessApp(extraEnv: Record<string, string> = {}) {
    return createAdminTestApp({
      env: { BOOTSTRAP_OWNER_EMAILS: 'ops@acme.com', ...extraEnv },
      routes: stubAdminPages,
    });
  }

  it('bootstraps the first owner on the first request and links the Access identity', async () => {
    const access = await testAccess();
    const app = accessApp();
    const jwt = await access.sign({ sub: 'access-user-1', email: 'ops@acme.com', name: 'Ops' });
    const res = await app.request('/admin/services', { headers: { [ACCESS_JWT_HEADER]: jwt } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok owner');
    const identity = await env.DB.prepare(
      'SELECT login_provider, subject FROM user_identities',
    ).first();
    expect(identity).toEqual({
      login_provider: 'access',
      subject: `${access.teamDomain}|access-user-1`,
    });
    expect(await auditActions()).toEqual(['user.bootstrap']);
  });

  it('everyone after the first owner joins as a viewer the owner can promote', async () => {
    const access = await testAccess();
    const app = accessApp({ BOOTSTRAP_OWNER_EMAILS: '' });
    const as = async (sub: string, email: string) =>
      (
        await app.request('/admin', {
          headers: { [ACCESS_JWT_HEADER]: await access.sign({ sub, email }) },
        })
      ).text();
    expect(await as('first', 'first@acme.com')).toBe('ok owner');
    expect(await as('second', 'second@acme.com')).toBe('ok viewer');
    expect(await as('second', 'second@acme.com')).toBe('ok viewer');
    expect(await auditActions()).toEqual(['user.bootstrap', 'user.join']);
  });

  it('keeps no session: each request is authorized by its own JWT', async () => {
    const app = accessApp();
    const owner = await createUser({ email: 'o@acme.com', role: 'owner' });
    const viewer = await createUser({ email: 'v@acme.com', role: 'viewer' });
    const o = await loginAs(app, owner);
    const v = await loginAs(app, viewer);
    const first = await adminGet(app, o, '/admin');
    expect(await first.text()).toBe('ok owner');
    // Only the CSRF cookie is ever set; nothing identifies the user.
    expect([...setCookies(first).keys()]).toEqual([]);
    // Same browser (cookie), another person's JWT: the JWT decides.
    const swapped = await adminGet(app, o, '/admin', { [ACCESS_JWT_HEADER]: v.assertion });
    expect(await swapped.text()).toBe('ok viewer');
    // Without a JWT the cookie alone grants nothing.
    const bare = await app.request('/admin', { headers: { cookie: o.cookie } });
    expect(bare.status).toBe(401);
  });

  it.each([
    ['service token (no email)', { sub: '', common_name: 'client-id.access' }, {}],
    ['wrong audience', { sub: 'u', email: 'ops@acme.com' }, { aud: 'b'.repeat(64) }],
    [
      'wrong issuer',
      { sub: 'u', email: 'ops@acme.com' },
      { iss: 'https://evil.cloudflareaccess.com' },
    ],
    [
      'expired',
      { sub: 'u', email: 'ops@acme.com' },
      { now: Date.now() - 3600_000, ttlSeconds: 60 },
    ],
  ])('rejects %s with 401 and creates nothing', async (_name, claims, options) => {
    const access = await testAccess();
    const app = accessApp();
    const jwt = await access.sign(claims, options);
    const res = await app.request('/admin', { headers: { [ACCESS_JWT_HEADER]: jwt } });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('did not present a valid user identity');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(0);
  });

  it('rejects a JWT signed by another team key', async () => {
    const other = await fakeAccess('tokengate-test');
    const app = accessApp();
    const jwt = await other.sign({ sub: 'u', email: 'ops@acme.com' });
    const res = await app.request('/admin', { headers: { [ACCESS_JWT_HEADER]: jwt } });
    expect(res.status).toBe(401);
  });

  it('rejects a request without the Access header', async () => {
    const app = accessApp();
    expect((await app.request('/admin')).status).toBe(401);
    expect((await adminPost(app, null, '/admin/services', {})).status).toBe(401);
  });

  it('answers 503 when the Access certs cannot be fetched', async () => {
    const access = await fakeAccess('certs-down');
    const app = createAdminTestApp({
      env: { AUTH_ACCESS_TEAM_DOMAIN: 'certs-down' },
      fetch: async () => {
        throw new Error('network down');
      },
      routes: stubAdminPages,
    });
    const jwt = await access.sign({ sub: 'u', email: 'ops@acme.com' });
    const res = await app.request('/admin', { headers: { [ACCESS_JWT_HEADER]: jwt } });
    expect(res.status).toBe(503);
  });

  it('a different team configured later does not accept the old team tokens', async () => {
    const acme = await fakeAccess('acme-two');
    const app = createAdminTestApp({
      env: { AUTH_ACCESS_TEAM_DOMAIN: 'acme-two' },
      fetch: combineFetch(acme.handler),
      routes: stubAdminPages,
    });
    const owner = await createUser({ email: 'o@acme.com', role: 'owner' });
    const session = await loginAs(app, owner);
    expect((await adminGet(app, session, '/admin')).status).toBe(401);
  });

  it('links "Sign out" to the Access logout endpoint', async () => {
    const app = createAdminTestApp({
      routes: (a) => a.get('/admin/users', (c) => renderPage(c, { title: 'Users' }, 'body')),
    });
    const owner = await createUser({ email: 'o@acme.com', role: 'owner' });
    const html = await (await adminGet(app, await loginAs(app, owner), '/admin/users')).text();
    expect(html).toContain('<a href="/cdn-cgi/access/logout">Sign out</a>');
  });
});

describe('dev login', () => {
  const DEV_ORIGIN = 'http://localhost:8787';
  const DEV_ENV = {
    ...NO_ACCESS,
    PUBLIC_URL: DEV_ORIGIN,
    AUTH_DEV_EMAIL: 'dev@example.com',
    BOOTSTRAP_OWNER_EMAILS: 'dev@example.com',
  };

  it('signs every request in as AUTH_DEV_EMAIL on a loopback PUBLIC_URL', async () => {
    const app = createAdminTestApp({ env: DEV_ENV, routes: stubAdminPages });
    const res = await app.request('/admin', { origin: DEV_ORIGIN });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok owner');
    const identity = await env.DB.prepare(
      'SELECT login_provider, subject FROM user_identities',
    ).first();
    expect(identity).toEqual({ login_provider: 'dev', subject: 'dev@example.com' });
  });

  it('is unreachable on any other origin (host pinning)', async () => {
    const app = createAdminTestApp({ env: DEV_ENV, routes: stubAdminPages });
    expect((await app.request('/admin', { origin: 'https://gw.test' })).status).toBe(404);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(0);
  });

  it('is refused when PUBLIC_URL is not loopback, even for a localhost request', async () => {
    const app = createAdminTestApp({
      env: { ...DEV_ENV, PUBLIC_URL: '' },
      routes: stubAdminPages,
    });
    const res = await app.request('/admin', { origin: DEV_ORIGIN });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('AUTH_DEV_EMAIL requires PUBLIC_URL');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(0);
  });

  it('is ignored when Access is configured', async () => {
    const app = createAdminTestApp({
      env: {
        PUBLIC_URL: 'https://localhost',
        AUTH_DEV_EMAIL: 'dev@example.com',
        BOOTSTRAP_OWNER_EMAILS: 'dev@example.com',
      },
      routes: stubAdminPages,
    });
    const res = await app.request('/admin', { origin: 'https://localhost' });
    expect(res.status).toBe(401);
  });
});

describe('admin middleware', () => {
  it('denies routes missing from the RBAC table and method-agnostic routes', async () => {
    const app = createAdminTestApp({ routes: stubAdminPages });
    const owner = await createUser({ email: 'o@example.com', role: 'owner' });
    const session = await loginAs(app, owner);
    expect((await adminGet(app, session, '/admin/unlisted')).status).toBe(403);
    expect((await adminGet(app, session, '/admin/any-method')).status).toBe(403);
    expect((await adminGet(app, session, '/admin/does-not-exist')).status).toBe(403);
    expect((await adminGet(app, session, '/admin')).status).toBe(200);
  });

  it('enforces the role permission per route', async () => {
    const app = createAdminTestApp({ routes: stubAdminPages });
    const viewer = await createUser({ email: 'v@example.com', role: 'viewer' });
    const admin = await createUser({ email: 'a@example.com', role: 'admin' });
    const owner = await createUser({ email: 'o@example.com', role: 'owner' });
    const [v, a, o] = await Promise.all([
      loginAs(app, viewer),
      loginAs(app, admin),
      loginAs(app, owner),
    ]);

    expect((await adminGet(app, v, '/admin/services/svc_1')).status).toBe(200);
    expect((await adminGet(app, v, '/admin/services/new')).status).toBe(403);
    expect((await adminPost(app, v, '/admin/services')).status).toBe(403);
    expect((await adminPost(app, a, '/admin/services')).status).toBe(200);
    expect((await adminPost(app, a, '/admin/users')).status).toBe(403);
    expect((await adminPost(app, a, '/admin/settings/rewrap')).status).toBe(403);
    expect((await adminPost(app, o, '/admin/users')).status).toBe(200);
    expect((await adminPost(app, o, '/admin/settings/rewrap')).status).toBe(200);
  });

  it('serves HEAD through the GET route permission', async () => {
    const app = createAdminTestApp({ routes: stubAdminPages });
    const viewer = await createUser({ email: 'v@example.com', role: 'viewer' });
    const session = await loginAs(app, viewer);
    const res = await app.request('/admin/services', { method: 'HEAD', headers: session.headers });
    expect(res.status).toBe(200);
  });

  it('records last-seen times at most once per interval', async () => {
    let now = Date.UTC(2026, 9, 13, 12);
    const app = createAdminTestApp({ routes: stubAdminPages, now: () => now });
    const user = await createUser({ email: 'o@example.com', role: 'owner' }, now);
    const session = await loginAs(app, user);
    const lastSeen = async () => ({
      user: await env.DB.prepare('SELECT last_login_at FROM users').first('last_login_at'),
      identity: await env.DB.prepare('SELECT last_used_at FROM user_identities').first(
        'last_used_at',
      ),
    });
    const start = now;
    await adminGet(app, session, '/admin');
    expect(await lastSeen()).toEqual({ user: start, identity: start });

    now += SEEN_INTERVAL_MS - 1;
    await adminGet(app, session, '/admin');
    expect(await lastSeen()).toEqual({ user: start, identity: start });

    now += 1;
    await adminGet(app, session, '/admin');
    expect(await lastSeen()).toEqual({ user: now, identity: now });
  });

  it('issues the CSRF cookie once, as a __Host- Strict HttpOnly cookie', async () => {
    const app = createAdminTestApp({ routes: stubAdminPages });
    const session = await loginAs(app, await createUser({ email: 'o@example.com', role: 'owner' }));
    const fresh = await app.request('/admin', {
      headers: { [ACCESS_JWT_HEADER]: session.assertion },
    });
    const cookie = setCookies(fresh).get(CSRF_COOKIE);
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie?.attributes).toEqual(
      expect.arrayContaining(['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']),
    );
    expect(cookie?.attributes.join(';')).not.toMatch(/Domain=|Max-Age|Expires/i);
    // A browser that already has one keeps it.
    expect(setCookies(await adminGet(app, session, '/admin')).has(CSRF_COOKIE)).toBe(false);
  });

  it('denies methods with no registered route even with a valid CSRF token', async () => {
    const app = createAdminTestApp({ routes: stubAdminPages });
    const session = await loginAs(app, await createUser({ email: 'o@example.com', role: 'owner' }));
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await app.request('/admin/services/svc_1', {
        method,
        headers: {
          ...session.headers,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ _csrf: session.csrfToken }),
      });
      expect(res.status, method).toBe(403);
    }
  });

  it('formData keeps repeated fields as arrays and has no prototype', async () => {
    const app = createAdminTestApp({
      routes: (a) =>
        a.post('/admin/services', async (c) => {
          const form = await formData(c);
          return c.json({
            nullPrototype: Object.getPrototypeOf(form) === null,
            proto: Object.getOwnPropertyDescriptor(form, '__proto__')?.value ?? null,
            tags: form.tags,
            constructor: typeof form.constructor,
          });
        }),
    });
    const session = await loginAs(app, await createUser({ email: 'o@example.com', role: 'owner' }));
    const res = await adminPost(app, session, '/admin/services', {
      tags: ['a', 'b'],
      ['__proto__']: ['x', 'y'],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      nullPrototype: true,
      proto: ['x', 'y'],
      tags: ['a', 'b'],
      constructor: 'undefined',
    });
  });
});
