import { beforeEach, describe, expect, it } from 'vitest';
import {
  addPendingLogin,
  decodePendingLogins,
  encodePendingLogins,
  OAUTH_COOKIE_VALUE_MAX,
  type PendingLogin,
} from '../../src/admin/auth/oauth-state';
import { OAUTH_COOKIE } from '../../src/admin/auth/routes';
import { RETURN_TO_MAX, SESSION_COOKIE, sanitizeReturnTo } from '../../src/admin/auth/session';
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

async function setup() {
  const github = fakeGithub();
  const app = createAdminTestApp({ env: ENV, fetch: combineFetch(github.handler) });
  await createUser({
    email: 'octocat@example.com',
    role: 'owner',
    identity: { loginProvider: 'github', subject: '583231' },
  });
  return { app, github };
}

/** The `Cookie` header a browser sends after `res`, starting from `jar` (OAuth cookie only). */
function nextJar(jar: string | null, res: Response): string | null {
  const stored = setCookies(res).get(OAUTH_COOKIE);
  if (!stored) return jar;
  return stored.attributes.includes('Max-Age=0') ? null : `${OAUTH_COOKIE}=${stored.value}`;
}

describe('I-OAUTH-1: pending logins are keyed by state, so logins and stray callbacks do not cancel each other', () => {
  it.each([
    ['first started finishes first', [0, 1]],
    ['last started finishes first', [1, 0]],
  ])('two logins in one browser both complete (%s)', async (_label, order) => {
    const { app, github } = await setup();
    const tabA = await startLogin(app.request, 'github', '/admin/services');
    const tabB = await startLogin(app.request, 'github', '/admin/grants', tabA.oauthCookie);
    const tabs = [tabA, tabB];
    let jar: string | null = tabB.oauthCookie;
    for (const index of order) {
      const tab = tabs[index];
      if (!tab) throw new Error('missing tab');
      const res = await callback(
        app.request,
        'github',
        { code: `c${index}`, state: tab.state },
        jar,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(index === 0 ? '/admin/services' : '/admin/grants');
      expect(setCookies(res).has(SESSION_COOKIE)).toBe(true);
      jar = nextJar(jar, res);
    }
    expect(github.tokenRequests).toHaveLength(2);
    expect(jar).toBeNull();
  });

  it.each([
    ['an unknown state', { code: 'c', state: 'forged' }],
    ['no state', { code: 'c' }],
  ])(
    'a callback with %s answers 400 and leaves the pending login intact',
    async (_label, params) => {
      const { app, github } = await setup();
      const started = await startLogin(app.request, 'github');
      // E.g. a cross-site top-level navigation: SameSite=Lax sends the cookie.
      const forged = await callback(app.request, 'github', params, started.oauthCookie);
      expect(forged.status).toBe(400);
      expect(setCookies(forged).has(OAUTH_COOKIE)).toBe(false);
      expect(github.tokenRequests).toEqual([]);

      const real = await callback(
        app.request,
        'github',
        { code: 'c', state: started.state },
        started.oauthCookie,
      );
      expect(real.status).toBe(302);
    },
  );

  it('a consumed state cannot be replayed with the cookie that remains', async () => {
    const { app, github } = await setup();
    const tabA = await startLogin(app.request, 'github');
    const tabB = await startLogin(app.request, 'github', undefined, tabA.oauthCookie);
    const first = await callback(
      app.request,
      'github',
      { code: 'c', state: tabA.state },
      tabB.oauthCookie,
    );
    expect(first.status).toBe(302);
    const jar = nextJar(tabB.oauthCookie, first);
    expect(jar).not.toBeNull();
    const replay = await callback(app.request, 'github', { code: 'c', state: tabA.state }, jar);
    expect(replay.status).toBe(400);
    expect(github.tokenRequests).toHaveLength(1);
  });

  it('keeps at most the three newest pending logins', async () => {
    const { app } = await setup();
    let jar: string | null = null;
    const started = [];
    for (let i = 0; i < 4; i++) {
      const login = await startLogin(app.request, 'github', undefined, jar);
      started.push(login);
      jar = login.oauthCookie;
    }
    const oldest = started[0];
    const newest = started[3];
    if (!oldest || !newest) throw new Error('missing login');
    const dropped = await callback(app.request, 'github', { code: 'c', state: oldest.state }, jar);
    expect(dropped.status).toBe(400);
    const kept = await callback(app.request, 'github', { code: 'c', state: newest.state }, jar);
    expect(kept.status).toBe(302);
  });
});

describe('I-OAUTH-1: the state cookie stays within browser limits whatever return_to is', () => {
  const COOKIE_LIMIT = 4096;

  it.each([
    ['non-ASCII', `/admin/${'é'.repeat(1000)}`],
    ['characters URL serialization escapes', `/admin/${'<'.repeat(1000)}`],
    ['astral characters', `/admin/${'😀'.repeat(250)}`],
    ['backslashes in the query', `/admin/?q=${'\\'.repeat(1000)}`],
  ])('return_to of %s', async (_label, returnTo) => {
    const { app } = await setup();
    let jar: string | null = null;
    for (let i = 0; i < 3; i++) {
      const login = await startLogin(app.request, 'github', returnTo, jar);
      expect(login.oauthCookie.length).toBeLessThanOrEqual(COOKIE_LIMIT);
      jar = login.oauthCookie;
    }
  });

  it('lands on a non-ASCII return_to that fits the cap after encoding', async () => {
    const { app } = await setup();
    const returnTo = `/admin/${'é'.repeat(80)}`;
    const started = await startLogin(app.request, 'github', returnTo);
    const res = await callback(
      app.request,
      'github',
      { code: 'c', state: started.state },
      started.oauthCookie,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(new URL(returnTo, 'https://x.invalid').pathname);
  });
});

describe('I-OAUTH-1: only the 3-entry cap pushes out a pending login, whatever return_to is', () => {
  it.each([
    ['backslashes in the query', `/admin?${'\\'.repeat(505)}`],
    ['a 1024-character return_to of backslashes', `/admin?${'\\'.repeat(1017)}`],
    ['quotes in the query', `/admin?${'"'.repeat(160)}`],
    ['non-ASCII', `/admin/${'é'.repeat(84)}`],
    ['the longest ASCII path', `/admin/${'a'.repeat(RETURN_TO_MAX - 7)}`],
  ])('two crafted starts with %s leave the earlier login working', async (_label, crafted) => {
    const { app } = await setup();
    const victim = await startLogin(app.request, 'github', '/admin/services');
    let jar: string | null = victim.oauthCookie;
    for (let i = 0; i < 2; i++) {
      const login = await startLogin(app.request, 'github', crafted, jar);
      expect(login.oauthCookie.length).toBeLessThanOrEqual(OAUTH_COOKIE_VALUE_MAX + 30);
      jar = login.oauthCookie;
    }
    expect(decodePendingLogins(jar.slice(OAUTH_COOKIE.length + 1))).toHaveLength(3);
    const res = await callback(app.request, 'github', { code: 'c', state: victim.state }, jar);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/services');
  });

  it('three entries with the largest return_to fit the cookie value cap', () => {
    const token = 'A'.repeat(43);
    const entry: PendingLogin = {
      state: token,
      code_verifier: token,
      nonce: token,
      return_to: sanitizeReturnTo(`/admin/${'a'.repeat(RETURN_TO_MAX - 7)}`),
      login_provider: 'github',
      expires_at: 9_999_999_999_999,
    };
    expect(entry.return_to).toHaveLength(RETURN_TO_MAX);
    const three = [entry, entry, entry];
    expect(encodePendingLogins(three).length).toBeLessThanOrEqual(OAUTH_COOKIE_VALUE_MAX);
    expect(addPendingLogin([entry, entry], entry, 0)).toHaveLength(3);
  });
});
