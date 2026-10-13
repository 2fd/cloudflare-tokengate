import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  decodePendingLogins,
  encodePendingLogins,
  type PendingLogin,
} from '../../src/admin/auth/oauth-state';
import { OAUTH_COOKIE, OAUTH_STATE_TTL_MS } from '../../src/admin/auth/routes';
import { SESSION_COOKIE } from '../../src/admin/auth/session';
import { toBase64Url, utf8 } from '../../src/lib/encoding';
import {
  createAdminTestApp,
  createUser,
  resetControlPlane,
  setCookies,
} from '../helpers/admin-auth';
import { callback, combineFetch, fakeGithub, startLogin } from '../helpers/login-providers';

const ENV = {
  AUTH_GITHUB_CLIENT_ID: 'Iv1.testclient',
  AUTH_GITHUB_CLIENT_SECRET: 'gh-secret',
};

beforeEach(resetControlPlane);

async function setup(now: () => number = () => Date.now()) {
  const github = fakeGithub();
  const app = createAdminTestApp({ env: ENV, fetch: combineFetch(github.handler), now });
  await createUser({
    email: 'octocat@example.com',
    role: 'owner',
    identity: { loginProvider: 'github', subject: '583231' },
  });
  return { app, github };
}

/** The pending login a browser holds after /start. */
function pendingOf(started: { oauthCookie: string }): PendingLogin {
  const pending = decodePendingLogins(started.oauthCookie.slice(`${OAUTH_COOKIE}=`.length)).at(-1);
  if (!pending) throw new Error('no pending login in cookie');
  return pending;
}

/** `Cookie` header carrying a pending login the browser could hold (e.g. set by its own user). */
function cookieFor(pending: PendingLogin): string {
  return `${OAUTH_COOKIE}=${encodePendingLogins([pending])}`;
}

/** Row count of every control-plane table. */
async function controlPlaneRowCounts(): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  const counts: Record<string, number> = {};
  for (const { name } of results) {
    const row = await env.DB.prepare(`SELECT count(*) AS n FROM "${name}"`).first<{ n: number }>();
    counts[name] = Number(row?.n ?? 0);
  }
  return counts;
}

describe('I-OAUTH-1: OAuth state is bound to the browser, single use, return_to sanitized', () => {
  it('rejects a callback without the state cookie (login CSRF / stolen callback URL)', async () => {
    const { app, github } = await setup();
    const started = await startLogin(app.request, 'github');
    const res = await callback(app.request, 'github', { code: 'c', state: started.state }, null);
    expect(res.status).toBe(400);
    expect(setCookies(res).has(SESSION_COOKIE)).toBe(false);
    expect(github.tokenRequests).toEqual([]);
  });

  it('rejects a callback whose cookie belongs to another login attempt', async () => {
    const { app, github } = await setup();
    const victim = await startLogin(app.request, 'github');
    const attacker = await startLogin(app.request, 'github');
    const res = await callback(
      app.request,
      'github',
      { code: 'c', state: attacker.state },
      victim.oauthCookie,
    );
    expect(res.status).toBe(400);
    expect(github.tokenRequests).toEqual([]);
  });

  it('rejects a callback without state', async () => {
    const { app } = await setup();
    const started = await startLogin(app.request, 'github');
    const res = await callback(app.request, 'github', { code: 'c' }, started.oauthCookie);
    expect(res.status).toBe(400);
  });

  it.each([
    ['garbage', 'not base64url!'],
    ['not JSON', 'bm90IGpzb24'],
    ['an object, not a list', toBase64Url(utf8('{"state":"s","login_provider":"github"}'))],
    ['missing fields', toBase64Url(utf8('[{"state":"s","login_provider":"github"}]'))],
  ])('rejects a malformed state cookie (%s)', async (_label, value) => {
    const { app, github } = await setup();
    const res = await callback(
      app.request,
      'github',
      { code: 'c', state: 's' },
      `${OAUTH_COOKIE}=${value}`,
    );
    expect(res.status).toBe(400);
    expect(github.tokenRequests).toEqual([]);
  });

  it('/start writes nothing to D1 (no anonymous control-plane writes)', async () => {
    const { app } = await setup();
    const before = await controlPlaneRowCounts();
    for (let i = 0; i < 5; i++) await startLogin(app.request, 'github', '/admin/services');
    expect(await controlPlaneRowCounts()).toEqual(before);
  });

  it('keeps the pending login in a __Host- HttpOnly SameSite=Lax cookie for 10 minutes', async () => {
    const { app } = await setup();
    const started = await startLogin(app.request, 'github');
    expect(setCookies(started.start).get(OAUTH_COOKIE)?.attributes).toEqual(
      expect.arrayContaining(['Max-Age=600', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']),
    );
    expect(setCookies(started.start).get(OAUTH_COOKIE)?.attributes.join(';')).not.toMatch(
      /domain=/i,
    );
    expect(pendingOf(started)).toMatchObject({ state: started.state, login_provider: 'github' });
  });

  it('clears the state cookie on the first callback, so a replay has no state', async () => {
    const { app, github } = await setup();
    const started = await startLogin(app.request, 'github');
    const first = await callback(
      app.request,
      'github',
      { code: 'c', state: started.state },
      started.oauthCookie,
    );
    expect(first.status).toBe(302);
    expect(setCookies(first).get(OAUTH_COOKIE)?.attributes).toContain('Max-Age=0');
    // The browser no longer sends the cookie.
    const replay = await callback(app.request, 'github', { code: 'c', state: started.state }, null);
    expect(replay.status).toBe(400);
    expect(github.tokenRequests).toHaveLength(1);
  });

  it('rejects an expired pending login, even if the cookie is still sent', async () => {
    let now = Date.now();
    const { app, github } = await setup(() => now);
    const started = await startLogin(app.request, 'github');
    now += OAUTH_STATE_TTL_MS + 1;
    const res = await callback(
      app.request,
      'github',
      { code: 'c', state: started.state },
      started.oauthCookie,
    );
    expect(res.status).toBe(400);
    expect(github.tokenRequests).toEqual([]);
  });

  it('rejects a pending login started for another login provider', async () => {
    const { app, github } = await setup();
    const started = await startLogin(app.request, 'github');
    const res = await callback(
      app.request,
      'github',
      { code: 'c', state: started.state },
      cookieFor({ ...pendingOf(started), login_provider: 'oidc' }),
    );
    expect(res.status).toBe(400);
    expect(github.tokenRequests).toEqual([]);
  });

  it('consumes the matching entry even when the login provider then fails', async () => {
    const { app } = await setup();
    const started = await startLogin(app.request, 'github');
    const res = await callback(
      app.request,
      'github',
      { error: 'access_denied', state: started.state },
      started.oauthCookie,
    );
    expect(res.status).toBe(400);
    expect(setCookies(res).get(OAUTH_COOKIE)?.attributes).toContain('Max-Age=0');
  });

  it.each([
    'https://evil.test/admin',
    '//evil.test/admin',
    '/\\evil.test',
    '/admin/../auth/logout',
    'javascript:alert(1)',
    '/proxy/slack/chat.postMessage',
  ])('neutralizes return_to %j', async (returnTo) => {
    const { app } = await setup();
    const started = await startLogin(app.request, 'github', returnTo);
    expect(pendingOf(started).return_to).toBe('/admin');
    const res = await callback(
      app.request,
      'github',
      { code: 'c', state: started.state },
      started.oauthCookie,
    );
    expect(res.headers.get('location')).toBe('/admin');
  });

  it('sanitizes return_to again at the callback (the cookie is client-held)', async () => {
    const { app } = await setup();
    const started = await startLogin(app.request, 'github');
    const res = await callback(
      app.request,
      'github',
      { code: 'c', state: started.state },
      cookieFor({ ...pendingOf(started), return_to: 'https://evil.test/admin' }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
  });

  it('keeps a legitimate return_to', async () => {
    const { app } = await setup();
    const started = await startLogin(app.request, 'github', '/admin/grants/grt_1?tab=rules');
    const res = await callback(
      app.request,
      'github',
      { code: 'c', state: started.state },
      started.oauthCookie,
    );
    expect(res.headers.get('location')).toBe('/admin/grants/grt_1?tab=rules');
  });
});
