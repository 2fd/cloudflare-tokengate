import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetOidcDiscoveryCacheForTests } from '../../src/admin/auth/oidc';
import { resolveLogin } from '../../src/admin/auth/resolve-login';
import { SESSION_COOKIE } from '../../src/admin/auth/session';
import { resetLoginStatements } from '../../src/db/users';
import {
  createAdminTestApp,
  createUser,
  resetControlPlane,
  setCookies,
} from '../helpers/admin-auth';
import {
  callback,
  combineFetch,
  fakeGithub,
  fakeOidc,
  startLogin,
} from '../helpers/login-providers';

beforeEach(async () => {
  await resetControlPlane();
  resetOidcDiscoveryCacheForTests();
});

const T0 = Date.UTC(2026, 9, 13, 12);
const GITHUB_ENV = { AUTH_GITHUB_CLIENT_ID: 'Iv1.x', AUTH_GITHUB_CLIENT_SECRET: 's' };

async function count(sql: string): Promise<number> {
  return Number(await env.DB.prepare(sql).first('n'));
}

async function githubLogin(emails: Array<{ email: string; verified: boolean }>, now = () => T0) {
  const github = fakeGithub({ userId: 777, emails });
  const app = createAdminTestApp({ env: GITHUB_ENV, fetch: combineFetch(github.handler), now });
  const started = await startLogin(app.request, 'github');
  return callback(app.request, 'github', { code: 'c', state: started.state }, started.oauthCookie);
}

describe('I-LINK-1: email linking only for invited, unexpired users with an authoritative email', () => {
  it('links an invited user with a verified email', async () => {
    const invited = await createUser(
      { email: 'dev@acme.com', role: 'admin', status: 'invited', inviteExpiresAt: T0 + 1000 },
      T0,
    );
    const res = await githubLogin([{ email: 'dev@acme.com', verified: true }]);
    expect(res.status).toBe(302);
    const user = await env.DB.prepare('SELECT status, role FROM users WHERE id = ?')
      .bind(invited.id)
      .first();
    expect(user).toEqual({ status: 'active', role: 'admin' });
    const audit = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'user.link'").first<{
      target_id: string;
      diff: string;
    }>();
    expect(audit?.target_id).toBe(invited.id);
    expect(JSON.parse(audit?.diff ?? '{}')).toMatchObject({
      login_provider: 'github',
      subject: '777',
    });
  });

  it('never links an active user by email', async () => {
    await createUser(
      { email: 'dev@acme.com', role: 'owner', identity: { loginProvider: 'github', subject: '1' } },
      T0,
    );
    const res = await githubLogin([{ email: 'dev@acme.com', verified: true }]);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('not been invited');
    expect(await count("SELECT count(*) AS n FROM user_identities WHERE subject = '777'")).toBe(0);
    expect(setCookies(res).has(SESSION_COOKIE)).toBe(false);
  });

  it('never links a disabled user by email', async () => {
    await createUser({ email: 'owner@acme.com', role: 'owner' }, T0);
    await createUser({ email: 'dev@acme.com', status: 'disabled' }, T0);
    const res = await githubLogin([{ email: 'dev@acme.com', verified: true }]);
    expect(res.status).toBe(403);
    expect(await count('SELECT count(*) AS n FROM user_identities')).toBe(0);
  });

  it('rejects an expired invitation', async () => {
    await createUser({ email: 'dev@acme.com', status: 'invited', inviteExpiresAt: T0 }, T0 - 1000);
    const res = await githubLogin([{ email: 'dev@acme.com', verified: true }]);
    expect(res.status).toBe(403);
    expect(await count("SELECT count(*) AS n FROM users WHERE status = 'invited'")).toBe(1);
  });

  it('rejects an unverified GitHub email', async () => {
    await createUser({ email: 'dev@acme.com', status: 'invited', inviteExpiresAt: T0 + 1000 }, T0);
    const res = await githubLogin([
      { email: 'dev@acme.com', verified: false },
      { email: 'personal@example.com', verified: true },
    ]);
    expect(res.status).toBe(403);
    expect(await count("SELECT count(*) AS n FROM users WHERE status = 'invited'")).toBe(1);
  });

  it('a known identity of a disabled user is refused', async () => {
    await createUser({ email: 'owner@acme.com', role: 'owner' }, T0);
    await createUser(
      {
        email: 'dev@acme.com',
        status: 'disabled',
        identity: { loginProvider: 'github', subject: '777' },
      },
      T0,
    );
    const res = await githubLogin([{ email: 'dev@acme.com', verified: true }]);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('disabled');
  });

  it('after "reset login" the user links a new identity through the invite path', async () => {
    await createUser({ email: 'owner@acme.com', role: 'owner' }, T0);
    const user = await createUser(
      {
        email: 'dev@acme.com',
        role: 'admin',
        identity: { loginProvider: 'github', subject: 'old' },
      },
      T0,
    );
    await env.DB.batch(
      resetLoginStatements(env.DB, { id: user.id, now: T0, inviteExpiresAt: T0 + 1000 }),
    );
    const res = await githubLogin([{ email: 'dev@acme.com', verified: true }]);
    expect(res.status).toBe(302);
    const { results } = await env.DB.prepare(
      'SELECT subject FROM user_identities WHERE user_id = ?',
    )
      .bind(user.id)
      .all<{ subject: string }>();
    expect(results.map((row) => row.subject)).toEqual(['777']);
  });

  it('concurrent links of one invitation by two identities link exactly one', async () => {
    const invited = await createUser(
      { email: 'dev@acme.com', status: 'invited', inviteExpiresAt: T0 + 1000 },
      T0,
    );
    const app = createAdminTestApp({ now: () => T0 });
    const results = await Promise.all(
      ['a', 'b', 'c'].map((subject) =>
        resolveLogin(app.deps, {
          loginProvider: 'github',
          subject,
          emails: ['dev@acme.com'],
          name: null,
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      await count(`SELECT count(*) AS n FROM user_identities WHERE user_id = '${invited.id}'`),
    ).toBe(1);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE action = 'user.link'")).toBe(1);
  });

  describe('AUTH_OIDC_ALLOWED_DOMAINS gates every OIDC sign-in, not only linking', () => {
    const issuer = 'https://idp.example.test';

    async function oidcLogin(claims: Record<string, unknown>) {
      const idp = await fakeOidc({ issuer, clientId: 'client' });
      const app = createAdminTestApp({
        env: {
          AUTH_OIDC_ISSUER: issuer,
          AUTH_OIDC_CLIENT_ID: 'client',
          AUTH_OIDC_CLIENT_SECRET: 'secret',
          AUTH_OIDC_ALLOWED_DOMAINS: 'acme.com',
        },
        fetch: combineFetch(idp.handler),
      });
      const started = await startLogin(app.request, 'oidc');
      const code = idp.issueCode({ sub: 'u-1', nonce: started.nonce, ...claims });
      return callback(app.request, 'oidc', { code, state: started.state }, started.oauthCookie);
    }

    beforeEach(async () => {
      // Linked while the deployment still accepted any domain.
      await createUser({
        email: 'contractor@other.com',
        identity: { loginProvider: 'oidc', subject: `${issuer}|u-1` },
      });
    });

    it('refuses a linked identity whose email is outside the allowed domains', async () => {
      const res = await oidcLogin({ email: 'contractor@other.com', email_verified: true });
      expect(res.status).toBe(403);
      expect(setCookies(res).has(SESSION_COOKIE)).toBe(false);
      expect(await count('SELECT count(*) AS n FROM sessions')).toBe(0);
    });

    it('refuses a linked identity whose email is not verified', async () => {
      const res = await oidcLogin({ email: 'contractor@acme.com', email_verified: false });
      expect(res.status).toBe(403);
    });

    it('accepts the linked identity once its email is in an allowed domain', async () => {
      const res = await oidcLogin({ email: 'contractor@acme.com', email_verified: true });
      expect(res.status).toBe(302);
      expect(setCookies(res).has(SESSION_COOKIE)).toBe(true);
    });
  });

  describe('Google hd rules', () => {
    async function googleLogin(claims: Record<string, unknown>, allowedDomains?: string) {
      const issuer = 'https://accounts.google.com';
      const idp = await fakeOidc({ issuer, clientId: 'google-client' });
      const app = createAdminTestApp({
        env: {
          AUTH_GOOGLE_CLIENT_ID: 'google-client',
          AUTH_GOOGLE_CLIENT_SECRET: 'google-secret',
          ...(allowedDomains ? { AUTH_OIDC_ALLOWED_DOMAINS: allowedDomains } : {}),
        },
        fetch: combineFetch(idp.handler),
      });
      const started = await startLogin(app.request, 'oidc');
      const code = idp.issueCode({
        sub: 'g-1',
        nonce: started.nonce,
        email_verified: true,
        ...claims,
      });
      return callback(app.request, 'oidc', { code, state: started.state }, started.oauthCookie);
    }

    beforeEach(async () => {
      await createUser({
        email: 'dev@acme.com',
        status: 'invited',
        inviteExpiresAt: Date.now() + 60_000,
      });
    });

    it('links a Workspace account whose hd matches', async () => {
      expect(
        (await googleLogin({ email: 'dev@acme.com', hd: 'acme.com' }, 'acme.com')).status,
      ).toBe(302);
    });

    it('refuses a consumer Google account registered with the company address', async () => {
      expect((await googleLogin({ email: 'dev@acme.com' })).status).toBe(403);
      expect((await googleLogin({ email: 'dev@acme.com' }, 'acme.com')).status).toBe(403);
    });

    it('refuses a Workspace account of another domain', async () => {
      expect((await googleLogin({ email: 'dev@acme.com', hd: 'evil.com' })).status).toBe(403);
    });

    it('sends the hd hint for a single allowed domain', async () => {
      const issuer = 'https://accounts.google.com';
      const idp = await fakeOidc({ issuer, clientId: 'google-client' });
      const app = createAdminTestApp({
        env: {
          AUTH_GOOGLE_CLIENT_ID: 'google-client',
          AUTH_GOOGLE_CLIENT_SECRET: 'google-secret',
          AUTH_OIDC_ALLOWED_DOMAINS: 'acme.com',
        },
        fetch: combineFetch(idp.handler),
      });
      const started = await startLogin(app.request, 'oidc');
      expect(started.authorizeUrl.searchParams.get('hd')).toBe('acme.com');
    });
  });
});
