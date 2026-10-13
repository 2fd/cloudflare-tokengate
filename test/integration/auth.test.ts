// Login flows end to end through the app, with GitHub, OIDC and Access faked via injected fetch.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetAccessCertsCacheForTests } from '../../src/admin/auth/access';
import { decodePendingLogins } from '../../src/admin/auth/oauth-state';
import {
  DISCOVERY_FAILURE_TTL_MS,
  resetOidcDiscoveryCacheForTests,
} from '../../src/admin/auth/oidc';
import { OAUTH_COOKIE } from '../../src/admin/auth/routes';
import { SESSION_COOKIE, SESSION_TOUCH_INTERVAL_MS } from '../../src/admin/auth/session';
import { formData } from '../../src/admin/render';
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
import {
  callback,
  combineFetch,
  fakeAccess,
  fakeGithub,
  fakeOidc,
  GITHUB_TEST_TOKEN,
  startLogin,
} from '../helpers/login-providers';

const GITHUB_ENV = {
  AUTH_GITHUB_CLIENT_ID: 'Iv1.testclient',
  AUTH_GITHUB_CLIENT_SECRET: 'gh-secret-value',
};

beforeEach(async () => {
  await resetControlPlane();
  resetOidcDiscoveryCacheForTests();
  resetAccessCertsCacheForTests();
});

/** Audit actions, sorted by name (ids written in the same millisecond have random order). */
async function auditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT action FROM audit_log ORDER BY action').all<{
    action: string;
  }>();
  return results.map((row) => row.action);
}

describe('GET /auth/login', () => {
  it('shows the setup page with exact callback URLs when no login provider is configured', async () => {
    const app = createAdminTestApp();
    const res = await app.request('/auth/login');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Set up sign-in');
    expect(html).toContain('https://gw.test/auth/github/callback');
    expect(html).toContain('https://gw.test/auth/oidc/callback');
    expect(html).toContain('AUTH_GITHUB_CLIENT_ID');
    expect(html).toContain('BOOTSTRAP_OWNER_EMAILS');
  });

  it('uses PUBLIC_URL for callback URLs', async () => {
    const app = createAdminTestApp({ env: { PUBLIC_URL: 'https://admin.example.com' } });
    const res = await app.request('/auth/login', { origin: 'https://admin.example.com' });
    expect(await res.text()).toContain('https://admin.example.com/auth/github/callback');
  });

  it('names misconfigured variables but never echoes values', async () => {
    const app = createAdminTestApp({ env: { AUTH_GITHUB_CLIENT_ID: 'leaky-client-id-value' } });
    const html = await (await app.request('/auth/login')).text();
    expect(html).toContain('AUTH_GITHUB_CLIENT_SECRET');
    expect(html).not.toContain('leaky-client-id-value');
  });

  it('lists configured providers with a sanitized return_to', async () => {
    const app = createAdminTestApp({ env: GITHUB_ENV });
    const html = await (
      await app.request('/auth/login?return_to=https%3A%2F%2Fevil.test%2Fadmin')
    ).text();
    expect(html).toContain('href="/auth/github/start?return_to=%2Fadmin"');
    expect(html).not.toContain('evil.test');
    expect(html).not.toContain('gh-secret-value');
  });

  it('redirects a signed-in user to return_to', async () => {
    const app = createAdminTestApp({ env: GITHUB_ENV });
    const user = await createUser({ email: 'a@example.com', role: 'owner' });
    const session = await loginAs(app, user);
    const res = await adminGet(app, session, '/auth/login?return_to=%2Fadmin%2Fgrants');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/grants');
  });
});

describe('GitHub login', () => {
  it('runs the OAuth App flow with PKCE and bootstraps the first owner', async () => {
    const github = fakeGithub({ emails: [{ email: 'Owner@Example.com', verified: true }] });
    const app = createAdminTestApp({
      env: { ...GITHUB_ENV, BOOTSTRAP_OWNER_EMAILS: 'owner@example.com' },
      fetch: combineFetch(github.handler),
      routes: stubAdminPages,
    });

    const started = await startLogin(app.request, 'github', '/admin/services');
    const authorize = started.authorizeUrl;
    expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('Iv1.testclient');
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://gw.test/auth/github/callback');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get('scope')).toBe('read:user user:email');
    expect(started.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const oauthCookie = setCookies(started.start).get(OAUTH_COOKIE);
    expect(oauthCookie?.attributes).toEqual(
      expect.arrayContaining(['Max-Age=600', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']),
    );
    const pending = decodePendingLogins(oauthCookie?.value).at(-1);
    expect(pending).toMatchObject({
      state: started.state,
      login_provider: 'github',
      return_to: '/admin/services',
    });

    const res = await callback(
      app.request,
      'github',
      { code: 'gh-code', state: started.state },
      started.oauthCookie,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/services');
    const cookies = setCookies(res);
    expect(cookies.get(OAUTH_COOKIE)?.attributes).toContain('Max-Age=0');
    const sessionCookie = cookies.get(SESSION_COOKIE);
    expect(sessionCookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionCookie?.attributes).toEqual(
      expect.arrayContaining(['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']),
    );

    const tokenRequest = github.tokenRequests[0];
    expect(tokenRequest?.get('code')).toBe('gh-code');
    expect(tokenRequest?.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenRequest?.get('client_secret')).toBe('gh-secret-value');
    expect(github.apiAuthorizations.every((h) => h === `Bearer ${GITHUB_TEST_TOKEN}`)).toBe(true);

    const user = await env.DB.prepare('SELECT * FROM users').first<Record<string, unknown>>();
    expect(user).toMatchObject({ email: 'owner@example.com', role: 'owner', status: 'active' });
    const identity = await env.DB.prepare('SELECT * FROM user_identities').first();
    expect(identity).toMatchObject({ login_provider: 'github', subject: '583231' });
    expect(await auditActions()).toEqual(['user.bootstrap', 'user.login']);

    // The GitHub access token is not persisted anywhere.
    for (const table of ['users', 'user_identities', 'sessions', 'audit_log', 'settings']) {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      expect(JSON.stringify(results)).not.toContain(GITHUB_TEST_TOKEN);
    }

    const page = await adminGet(
      app,
      { sessionId: '', csrfToken: '', cookie: `${SESSION_COOKIE}=${sessionCookie?.value}` },
      '/admin/services',
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('ok owner');
  });

  it('requests read:org and enforces active membership in an allowed org', async () => {
    for (const [orgs, status] of [
      [{ acme: 'active' as const }, 302],
      [{ acme: 'pending' as const }, 403],
      [{ other: 'active' as const }, 403],
    ] as const) {
      await resetControlPlane();
      const github = fakeGithub({ orgs });
      const app = createAdminTestApp({
        env: {
          ...GITHUB_ENV,
          AUTH_GITHUB_ALLOWED_ORGS: 'acme',
          BOOTSTRAP_OWNER_EMAILS: 'octocat@example.com',
        },
        fetch: combineFetch(github.handler),
      });
      const started = await startLogin(app.request, 'github');
      expect(started.authorizeUrl.searchParams.get('scope')).toBe('read:user user:email read:org');
      const res = await callback(
        app.request,
        'github',
        { code: 'c', state: started.state },
        started.oauthCookie,
      );
      expect(res.status, JSON.stringify(orgs)).toBe(status);
      if (status === 403) expect(await res.text()).toContain('not an active member');
    }
  });

  it('fails closed on a 200 token response carrying an error', async () => {
    const github = fakeGithub({
      tokenResponse: () =>
        Response.json({ error: 'bad_verification_code', error_description: 'expired' }),
    });
    const app = createAdminTestApp({
      env: { ...GITHUB_ENV, BOOTSTRAP_OWNER_EMAILS: 'octocat@example.com' },
      fetch: combineFetch(github.handler),
    });
    const started = await startLogin(app.request, 'github');
    const res = await callback(
      app.request,
      'github',
      { code: 'c', state: started.state },
      started.oauthCookie,
    );
    expect(res.status).toBe(400);
    expect(setCookies(res).has(SESSION_COOKIE)).toBe(false);
    expect(github.apiAuthorizations).toEqual([]);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(0);
  });

  it('reports a provider error when the user denies access', async () => {
    const app = createAdminTestApp({ env: GITHUB_ENV, fetch: combineFetch(fakeGithub().handler) });
    const started = await startLogin(app.request, 'github');
    const res = await callback(
      app.request,
      'github',
      { error: 'access_denied', state: started.state },
      started.oauthCookie,
    );
    expect(res.status).toBe(400);
  });

  it('answers 404 for unconfigured or unknown providers', async () => {
    const app = createAdminTestApp();
    expect((await app.request('/auth/github/start')).status).toBe(404);
    expect((await app.request('/auth/oidc/callback?code=x&state=y')).status).toBe(404);
    expect((await app.request('/auth/saml/start')).status).toBe(404);
    expect((await app.request('/auth/access/start')).status).toBe(404);
  });
});

describe('OIDC login', () => {
  const ISSUER = 'https://idp.example.test';
  const OIDC_ENV = {
    AUTH_OIDC_ISSUER: ISSUER,
    AUTH_OIDC_CLIENT_ID: 'tokengate-client',
    AUTH_OIDC_CLIENT_SECRET: 'oidc-secret',
    AUTH_OIDC_NAME: 'Acme SSO',
  };

  it('discovers, uses PKCE + state + nonce and links an invited user', async () => {
    const idp = await fakeOidc({ issuer: ISSUER, clientId: 'tokengate-client' });
    const app = createAdminTestApp({ env: OIDC_ENV, fetch: combineFetch(idp.handler) });
    const invited = await createUser({ email: 'dev@acme.com', role: 'viewer', status: 'invited' });

    const loginHtml = await (await app.request('/auth/login')).text();
    expect(loginHtml).toContain('Sign in with Acme SSO');

    const started = await startLogin(app.request, 'oidc');
    const authorize = started.authorizeUrl;
    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/authorize`);
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('scope')).toBe('openid email profile');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(started.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const code = idp.issueCode({
      sub: 'idp-user-1',
      nonce: started.nonce,
      email: 'dev@acme.com',
      email_verified: true,
      name: 'Dev',
    });
    const res = await callback(
      app.request,
      'oidc',
      { code, state: started.state },
      started.oauthCookie,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
    expect(idp.tokenRequests[0]?.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(invited.id).first();
    expect(user).toMatchObject({ status: 'active', invite_expires_at: null, name: 'Dev' });
    const identity = await env.DB.prepare('SELECT * FROM user_identities').first();
    expect(identity).toMatchObject({ login_provider: 'oidc', subject: `${ISSUER}|idp-user-1` });
    expect(await auditActions()).toEqual(['user.link', 'user.login']);
  });

  it('rejects an ID token with the wrong nonce', async () => {
    const idp = await fakeOidc({ issuer: ISSUER, clientId: 'tokengate-client' });
    const app = createAdminTestApp({ env: OIDC_ENV, fetch: combineFetch(idp.handler) });
    await createUser({ email: 'dev@acme.com', status: 'invited' });
    const started = await startLogin(app.request, 'oidc');
    const code = idp.issueCode({
      sub: 's',
      nonce: 'other',
      email: 'dev@acme.com',
      email_verified: true,
    });
    const res = await callback(
      app.request,
      'oidc',
      { code, state: started.state },
      started.oauthCookie,
    );
    expect(res.status).toBe(400);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM user_identities').first('n')).toBe(0);
  });

  it('rejects an ID token for another audience', async () => {
    const idp = await fakeOidc({ issuer: ISSUER, clientId: 'someone-else' });
    const app = createAdminTestApp({ env: OIDC_ENV, fetch: combineFetch(idp.handler) });
    await createUser({ email: 'dev@acme.com', status: 'invited' });
    const started = await startLogin(app.request, 'oidc');
    const code = idp.issueCode({
      sub: 's',
      nonce: started.nonce,
      email: 'dev@acme.com',
      email_verified: true,
    });
    const res = await callback(
      app.request,
      'oidc',
      { code, state: started.state },
      started.oauthCookie,
    );
    expect(res.status).toBe(400);
  });

  it('shows provider_unavailable when discovery fails', async () => {
    const app = createAdminTestApp({
      env: OIDC_ENV,
      fetch: async () => {
        throw new TypeError('network down');
      },
    });
    const res = await app.request('/auth/oidc/start', { redirect: 'manual' });
    expect(res.status).toBe(502);
    expect(setCookies(res).has(OAUTH_COOKIE)).toBe(false);
  });

  it('caches a discovery failure briefly: an IdP outage is not one outbound fetch per /start', async () => {
    const idp = await fakeOidc({ issuer: ISSUER, clientId: 'tokengate-client' });
    let clock = 1_800_000_000_000;
    let idpUp = false;
    let fetches = 0;
    const app = createAdminTestApp({
      env: OIDC_ENV,
      now: () => clock,
      fetch: async (input, init) => {
        fetches++;
        if (!idpUp) throw new TypeError('network down');
        return combineFetch(idp.handler)(input, init);
      },
    });
    const start = () => app.request('/auth/oidc/start', { redirect: 'manual' });
    for (let i = 0; i < 5; i++) expect((await start()).status).toBe(502);
    expect(fetches).toBe(1);

    idpUp = true;
    clock += DISCOVERY_FAILURE_TTL_MS - 1;
    expect((await start()).status).toBe(502);
    expect(fetches).toBe(1);
    clock += 1;
    expect((await start()).status).toBe(302);
    expect(fetches).toBe(2);
  });
});

describe('Cloudflare Access login', () => {
  async function accessApp() {
    const access = await fakeAccess();
    const app = createAdminTestApp({
      env: {
        PUBLIC_URL: 'https://gw.test',
        AUTH_ACCESS_TEAM_DOMAIN: 'acme',
        AUTH_ACCESS_AUD: access.aud,
        BOOTSTRAP_OWNER_EMAILS: 'ops@acme.com',
      },
      fetch: combineFetch(access.handler),
      routes: stubAdminPages,
    });
    return { access, app };
  }

  it('signs in from the Access JWT and re-validates it on every admin request', async () => {
    const { access, app } = await accessApp();
    const jwt = await access.sign({ sub: 'access-user-1', email: 'ops@acme.com' });
    const res = await app.request('/auth/access/start?return_to=%2Fadmin%2Fservices', {
      headers: { 'cf-access-jwt-assertion': jwt },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/services');
    const sessionId = setCookies(res).get(SESSION_COOKIE)?.value ?? '';
    const session = { sessionId, csrfToken: '', cookie: `${SESSION_COOKIE}=${sessionId}` };
    const identity = await env.DB.prepare('SELECT subject FROM user_identities').first('subject');
    expect(identity).toBe(`${access.teamDomain}|access-user-1`);

    const ok = await adminGet(app, session, '/admin', { 'cf-access-jwt-assertion': jwt });
    expect(ok.status).toBe(200);

    const otherJwt = await access.sign({ sub: 'access-user-2', email: 'ops@acme.com' });
    const mismatch = await adminGet(app, session, '/admin', {
      'cf-access-jwt-assertion': otherJwt,
    });
    expect(mismatch.status).toBe(302);
    expect(mismatch.headers.get('location')).toMatch(/^\/auth\/login\?/);
    // The session was revoked: even the original JWT no longer works with it.
    const after = await adminGet(app, session, '/admin', { 'cf-access-jwt-assertion': jwt });
    expect(after.status).toBe(302);
  });

  it('revokes the session when the Access JWT is missing', async () => {
    const { access, app } = await accessApp();
    const jwt = await access.sign({ sub: 'access-user-1', email: 'ops@acme.com' });
    const res = await app.request('/auth/access/start', {
      headers: { 'cf-access-jwt-assertion': jwt },
      redirect: 'manual',
    });
    const sessionId = setCookies(res).get(SESSION_COOKIE)?.value ?? '';
    const session = { sessionId, csrfToken: '', cookie: `${SESSION_COOKIE}=${sessionId}` };
    expect((await adminGet(app, session, '/admin')).status).toBe(302);
    const revoked = await env.DB.prepare('SELECT revoked_at FROM sessions').first('revoked_at');
    expect(revoked).not.toBeNull();
  });

  it.each([
    ['service token (no email)', { sub: '', common_name: 'client-id.access' }, {}],
    ['wrong audience', { sub: 'u', email: 'ops@acme.com' }, { aud: 'b'.repeat(64) }],
    [
      'wrong issuer',
      { sub: 'u', email: 'ops@acme.com' },
      { iss: 'https://evil.cloudflareaccess.com' },
    ],
  ])('rejects %s', async (_name, claims, options) => {
    const { access, app } = await accessApp();
    const jwt = await access.sign(claims, options);
    const res = await app.request('/auth/access/start', {
      headers: { 'cf-access-jwt-assertion': jwt },
      redirect: 'manual',
    });
    expect(res.status).toBe(401);
    expect(setCookies(res).has(SESSION_COOKIE)).toBe(false);
  });

  it('revokes an Access session once Access login is no longer configured', async () => {
    const { access, app } = await accessApp();
    const jwt = await access.sign({ sub: 'access-user-1', email: 'ops@acme.com' });
    const res = await app.request('/auth/access/start', {
      headers: { 'cf-access-jwt-assertion': jwt },
      redirect: 'manual',
    });
    const sessionId = setCookies(res).get(SESSION_COOKIE)?.value ?? '';
    const session = { sessionId, csrfToken: '', cookie: `${SESSION_COOKIE}=${sessionId}` };
    const withoutAccess = createAdminTestApp({
      env: { PUBLIC_URL: 'https://gw.test' },
      fetch: combineFetch(access.handler),
      routes: stubAdminPages,
    });
    const after = await adminGet(withoutAccess, session, '/admin', {
      'cf-access-jwt-assertion': jwt,
    });
    expect(after.status).toBe(302);
    const revoked = await env.DB.prepare('SELECT revoked_at FROM sessions').first('revoked_at');
    expect(revoked).not.toBeNull();
  });

  it('rejects a request without the Access header', async () => {
    const { app } = await accessApp();
    expect((await app.request('/auth/access/start')).status).toBe(401);
  });
});

describe('admin middleware', () => {
  it('redirects unauthenticated GETs to login and rejects other methods', async () => {
    const app = createAdminTestApp({ routes: stubAdminPages });
    const get = await adminGet(app, null, '/admin/services?x=1');
    expect(get.status).toBe(302);
    expect(get.headers.get('location')).toBe('/auth/login?return_to=%2Fadmin%2Fservices%3Fx%3D1');
    const post = await adminPost(app, null, '/admin/services', {});
    expect(post.status).toBe(401);
  });

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
    const res = await app.request('/admin/services', {
      method: 'HEAD',
      headers: { cookie: session.cookie },
    });
    expect(res.status).toBe(200);
  });

  it('slides the idle expiry at most once per touch interval', async () => {
    let now = Date.UTC(2026, 9, 13, 12);
    const app = createAdminTestApp({ routes: stubAdminPages, now: () => now });
    const user = await createUser({ email: 'o@example.com', role: 'owner' }, now);
    const session = await loginAs(app, user);
    const lastSeen = () =>
      env.DB.prepare('SELECT last_seen_at FROM sessions').first('last_seen_at');
    const start = now;

    now += SESSION_TOUCH_INTERVAL_MS - 1;
    await adminGet(app, session, '/admin');
    expect(await lastSeen()).toBe(start);

    now += 1;
    await adminGet(app, session, '/admin');
    expect(await lastSeen()).toBe(now);
  });

  it('denies methods with no registered route even with a valid CSRF token', async () => {
    const app = createAdminTestApp({ routes: stubAdminPages });
    const session = await loginAs(app, await createUser({ email: 'o@example.com', role: 'owner' }));
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await app.request('/admin/services/svc_1', {
        method,
        headers: {
          cookie: session.cookie,
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

describe('POST /auth/logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const app = createAdminTestApp({ routes: stubAdminPages });
    const user = await createUser({ email: 'o@example.com', role: 'owner' });
    const session = await loginAs(app, user);
    const res = await adminPost(app, session, '/auth/logout');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/auth/login?notice=signed_out');
    expect(setCookies(res).get(SESSION_COOKIE)?.attributes).toContain('Max-Age=0');
    expect((await adminGet(app, session, '/admin')).status).toBe(302);
    const notice = await (await app.request('/auth/login?notice=signed_out')).text();
    expect(notice).toContain('You have signed out.');
  });

  it('without a session just clears the cookie', async () => {
    const app = createAdminTestApp();
    const res = await adminPost(app, null, '/auth/logout');
    expect(res.status).toBe(303);
  });
});
