import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveLogin } from '../../src/admin/auth/resolve-login';
import {
  issueSession,
  loadSession,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from '../../src/admin/auth/session';
import { resetLogin } from '../../src/admin/ops/users';
import { sha256Hex } from '../../src/crypto/hash';
import { revokeSessionStatement, touchSessionStatement } from '../../src/db/sessions';
import type { Actor } from '../../src/db/types';
import { resetLoginStatements, updateUserStatements } from '../../src/db/users';
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
import { callback, combineFetch, fakeGithub, startLogin } from '../helpers/login-providers';

beforeEach(resetControlPlane);

const T0 = Date.UTC(2026, 9, 13, 12);

function clockedApp(
  envOverrides: Record<string, string> = {},
  extra: { fetch?: typeof fetch } = {},
) {
  let now = T0;
  const app = createAdminTestApp({
    routes: stubAdminPages,
    now: () => now,
    env: envOverrides,
    ...extra,
  });
  return {
    app,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('I-SESS-1: sessions hashed at rest, re-validated every request, rotated on login', () => {
  it('stores only SHA-256 of the session id', async () => {
    const { app } = clockedApp();
    const user = await createUser({ email: 'o@example.com', role: 'owner' }, T0);
    const session = await loginAs(app, user);
    const { results } = await env.DB.prepare('SELECT * FROM sessions').all<{ id_hash: string }>();
    expect(results).toHaveLength(1);
    expect(results[0]?.id_hash).toBe(await sha256Hex(session.sessionId));
    expect(JSON.stringify(results)).not.toContain(session.sessionId);
  });

  it('expires after the idle timeout without activity', async () => {
    const { app, advance } = clockedApp();
    const session = await loginAs(
      app,
      await createUser({ email: 'o@example.com', role: 'owner' }, T0),
    );
    advance(SESSION_IDLE_MS - 1);
    expect((await adminGet(app, session, '/admin')).status).toBe(200);
    advance(SESSION_IDLE_MS - 1);
    expect((await adminGet(app, session, '/admin')).status).toBe(200);
    advance(SESSION_IDLE_MS);
    expect((await adminGet(app, session, '/admin')).status).toBe(302);
  });

  it('expires at the absolute lifetime even when active', async () => {
    const { app, advance } = clockedApp();
    const session = await loginAs(
      app,
      await createUser({ email: 'o@example.com', role: 'owner' }, T0),
    );
    const step = SESSION_IDLE_MS / 2;
    let elapsed = 0;
    while (elapsed + step < SESSION_ABSOLUTE_MS) {
      advance(step);
      elapsed += step;
      expect((await adminGet(app, session, '/admin')).status).toBe(200);
    }
    // Still well inside the idle window, but past the absolute lifetime.
    advance(SESSION_ABSOLUTE_MS - elapsed);
    expect((await adminGet(app, session, '/admin')).status).toBe(302);
  });

  it('rejects the session once the user is disabled', async () => {
    const { app } = clockedApp();
    await createUser({ email: 'owner@example.com', role: 'owner' }, T0);
    const admin = await createUser({ email: 'a@example.com', role: 'admin' }, T0);
    const session = await loginAs(app, admin);
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(admin.id).run();
    expect((await adminGet(app, session, '/admin')).status).toBe(302);
    expect((await adminPost(app, session, '/admin/services')).status).toBe(401);
  });

  it('applies a role change on the next request', async () => {
    const { app } = clockedApp();
    await createUser({ email: 'owner@example.com', role: 'owner' }, T0);
    const admin = await createUser({ email: 'a@example.com', role: 'admin' }, T0);
    const session = await loginAs(app, admin);
    expect((await adminPost(app, session, '/admin/services')).status).toBe(200);
    // Direct role edit (no session revocation) still takes effect: role is re-read per request.
    await env.DB.prepare("UPDATE users SET role = 'viewer' WHERE id = ?").bind(admin.id).run();
    expect((await adminPost(app, session, '/admin/services')).status).toBe(403);
    expect(await (await adminGet(app, session, '/admin')).text()).toBe('ok viewer');
  });

  it('role/status changes and login resets through the repository revoke sessions', async () => {
    const { app } = clockedApp();
    await createUser({ email: 'owner@example.com', role: 'owner' }, T0);
    const admin = await createUser({ email: 'a@example.com', role: 'admin' }, T0);
    const first = await loginAs(app, admin);
    await env.DB.batch(updateUserStatements(env.DB, { id: admin.id, now: T0, role: 'viewer' }));
    expect((await adminGet(app, first, '/admin')).status).toBe(302);

    const second = await loginAs(app, { ...admin, role: 'viewer' });
    await env.DB.batch(
      resetLoginStatements(env.DB, { id: admin.id, now: T0, inviteExpiresAt: T0 + 1 }),
    );
    expect((await adminGet(app, second, '/admin')).status).toBe(302);
  });

  it('rotates on login: a new id is issued and the previous session is revoked', async () => {
    const github = fakeGithub();
    const { app } = clockedApp(
      { AUTH_GITHUB_CLIENT_ID: 'Iv1.x', AUTH_GITHUB_CLIENT_SECRET: 's' },
      { fetch: combineFetch(github.handler) },
    );
    const user = await createUser(
      {
        email: 'octocat@example.com',
        role: 'owner',
        identity: { loginProvider: 'github', subject: '583231' },
      },
      T0,
    );
    const old = await loginAs(app, user);
    const started = await startLogin(app.request, 'github');
    const res = await callback(
      app.request,
      'github',
      { code: 'c', state: started.state },
      `${started.oauthCookie}; ${old.cookie}`,
    );
    expect(res.status).toBe(302);
    const fresh = setCookies(res).get(SESSION_COOKIE)?.value;
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(old.sessionId);
    expect((await adminGet(app, old, '/admin')).status).toBe(302);
    const freshSession = {
      sessionId: fresh ?? '',
      csrfToken: '',
      cookie: `${SESSION_COOKIE}=${fresh}`,
    };
    expect((await adminGet(app, freshSession, '/admin')).status).toBe(200);
  });

  it('rejects revoked sessions and malformed or unknown cookies', async () => {
    const { app } = clockedApp();
    const session = await loginAs(
      app,
      await createUser({ email: 'o@example.com', role: 'owner' }, T0),
    );
    await env.DB.prepare('UPDATE sessions SET revoked_at = ?').bind(T0).run();
    expect((await adminGet(app, session, '/admin')).status).toBe(302);
    for (const value of ['', 'short', 'x'.repeat(43), `${session.sessionId}x`, "' OR 1=1 --"]) {
      const res = await adminGet(
        app,
        { sessionId: value, csrfToken: '', cookie: `${SESSION_COOKIE}=${value}` },
        '/admin',
      );
      expect(res.status, value).toBe(302);
    }
  });

  it('writes last_seen_at at most once per touch interval', async () => {
    const { app, advance } = clockedApp();
    const session = await loginAs(
      app,
      await createUser({ email: 'o@example.com', role: 'owner' }, T0),
    );
    advance(SESSION_TOUCH_INTERVAL_MS / 2);
    await adminGet(app, session, '/admin');
    expect(await env.DB.prepare('SELECT last_seen_at FROM sessions').first('last_seen_at')).toBe(
      T0,
    );
  });
});

describe('I-SESS-1: session repository statements cannot extend a dead session', () => {
  it('touch never revives an idle-expired, absolutely expired or revoked session', async () => {
    const { app } = clockedApp();
    const user = await createUser({ email: 'o@example.com', role: 'owner' }, T0);
    const idHash = await sha256Hex((await loginAs(app, user)).sessionId);
    const row = () =>
      env.DB.prepare('SELECT idle_expires_at, expires_at FROM sessions WHERE id_hash = ?')
        .bind(idHash)
        .first<{ idle_expires_at: number; expires_at: number }>();
    const touch = (at: number) =>
      touchSessionStatement(env.DB, idHash, at, at + SESSION_IDLE_MS).run();

    expect((await touch(T0 + SESSION_IDLE_MS)).meta.changes).toBe(0);

    await env.DB.prepare('UPDATE sessions SET idle_expires_at = ? WHERE id_hash = ?')
      .bind(T0 + SESSION_ABSOLUTE_MS * 2, idHash)
      .run();
    expect((await touch(T0 + SESSION_ABSOLUTE_MS)).meta.changes).toBe(0);
    expect((await row())?.expires_at).toBe(T0 + SESSION_ABSOLUTE_MS);

    await revokeSessionStatement(env.DB, idHash, T0 + 1).run();
    expect((await touch(T0 + 2)).meta.changes).toBe(0);
  });
});

describe('I-SESS-1: a session dies with its login identity (reset-login race)', () => {
  async function raceSetup() {
    const { app } = clockedApp();
    const owner = await createUser({ email: 'owner@example.com', role: 'owner' }, T0);
    const user = await createUser(
      {
        email: 'u@example.com',
        role: 'admin',
        identity: { loginProvider: 'github', subject: 'old' },
      },
      T0,
    );
    const ownerActor: Actor = {
      type: 'user',
      id: owner.id,
      email: owner.email,
      ip: null,
      userAgent: null,
    };
    // The login resolves, then an owner's "Reset login" commits before the session is issued.
    const resolved = await resolveLogin(app.deps, {
      loginProvider: 'github',
      subject: 'old',
      emails: [],
      name: null,
    });
    if (!resolved.ok) throw new Error('login did not resolve');
    expect((await resetLogin(app.deps, ownerActor, user.id)).ok).toBe(true);
    return { app, user: resolved.user };
  }

  const loginAudits = async (userId: string) =>
    env.DB.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE action = 'user.login' AND actor_id = ?",
    )
      .bind(userId)
      .first('n');

  /** users.last_login_at and the user's identities' last_used_at. */
  const lastLogin = async (userId: string) => ({
    user: await env.DB.prepare('SELECT last_login_at FROM users WHERE id = ?')
      .bind(userId)
      .first('last_login_at'),
    identities: (
      await env.DB.prepare('SELECT last_used_at FROM user_identities WHERE user_id = ?')
        .bind(userId)
        .all<{ last_used_at: number | null }>()
    ).results.map((row) => row.last_used_at),
  });

  it('issues no session and no user.login audit row once the identity is gone', async () => {
    const { app, user } = await raceSetup();
    const issued = await issueSession(app.deps, {
      user,
      loginProvider: 'github',
      identitySubject: 'old',
      previousSessionId: null,
      meta: { ip: null, userAgent: null },
    });
    expect(issued).toBeNull();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM sessions').first('n')).toBe(0);
    expect(await loginAudits(user.id)).toBe(0);
    expect(await lastLogin(user.id)).toEqual({ user: null, identities: [] });
  });

  it('records no login timestamps when the user is disabled before the session is issued', async () => {
    const { app } = clockedApp();
    await createUser({ email: 'owner@example.com', role: 'owner' }, T0);
    const created = await createUser(
      {
        email: 'd@example.com',
        role: 'admin',
        identity: { loginProvider: 'github', subject: 's' },
      },
      T0,
    );
    const resolved = await resolveLogin(app.deps, {
      loginProvider: 'github',
      subject: 's',
      emails: [],
      name: null,
    });
    if (!resolved.ok) throw new Error('login did not resolve');
    await env.DB.batch(
      updateUserStatements(env.DB, { id: created.id, now: T0, status: 'disabled' }),
    );
    const issued = await issueSession(app.deps, {
      user: resolved.user,
      loginProvider: 'github',
      identitySubject: 's',
      previousSessionId: null,
      meta: { ip: null, userAgent: null },
    });
    expect(issued).toBeNull();
    expect(await loginAudits(created.id)).toBe(0);
    expect(await lastLogin(created.id)).toEqual({ user: null, identities: [null] });
  });

  it('a session row for an unlinked identity stays dead after the user re-links another one', async () => {
    const { app, user } = await raceSetup();
    // A session row written for the removed identity (as an unguarded insert would have).
    const sessionId = 'A'.repeat(43);
    await env.DB.prepare(
      `INSERT INTO sessions (id_hash, user_id, login_provider, identity_subject, csrf_token, created_at,
         last_seen_at, expires_at, idle_expires_at)
       VALUES (?, ?, 'github', 'old', 'csrf', ?, ?, ?, ?)`,
    )
      .bind(
        await sha256Hex(sessionId),
        user.id,
        T0,
        T0,
        T0 + SESSION_ABSOLUTE_MS,
        T0 + SESSION_IDLE_MS,
      )
      .run();
    // The legitimate person signs in again with a new identity: the user is active again.
    const relinked = await resolveLogin(app.deps, {
      loginProvider: 'github',
      subject: 'new',
      emails: ['u@example.com'],
      name: null,
    });
    expect(relinked).toMatchObject({ ok: true, via: 'invite' });
    expect(await loadSession(app.deps, sessionId)).toBeNull();
    const stale = { sessionId, csrfToken: 'csrf', cookie: `${SESSION_COOKIE}=${sessionId}` };
    expect((await adminGet(app, stale, '/admin')).status).toBe(302);
  });
});
