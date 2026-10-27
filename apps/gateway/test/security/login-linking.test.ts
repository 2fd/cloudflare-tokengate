import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ACCESS_JWT_HEADER, accessSubject } from '../../src/admin/auth/access';
import { SEEN_INTERVAL_MS } from '../../src/admin/auth/middleware';
import { resolveLogin } from '../../src/admin/auth/resolve-login';
import { resetLoginStatements } from '../../src/db/users';
import {
  createAdminTestApp,
  createUser,
  resetControlPlane,
  stubAdminPages,
} from '../helpers/admin-auth';
import { testAccess } from '../helpers/login-providers';

beforeEach(resetControlPlane);

const T0 = Date.UTC(2026, 9, 13, 12);

async function count(sql: string): Promise<number> {
  return Number(await env.DB.prepare(sql).first('n'));
}

async function subjectOf(sub: string): Promise<string> {
  return accessSubject((await testAccess()).teamDomain, sub);
}

/** GET /admin as a browser behind Access whose JWT carries these claims. */
async function accessLogin(claims: Record<string, unknown>, now = T0) {
  const access = await testAccess();
  const app = createAdminTestApp({ now: () => now, routes: stubAdminPages });
  const assertion = await access.sign({ sub: '777', ...claims }, { now });
  return app.request('/admin', { headers: { [ACCESS_JWT_HEADER]: assertion } });
}

describe('I-LINK-1: email linking only for invited, unexpired users with an authoritative email', () => {
  it('links an invited user with the Access email on their first request', async () => {
    const invited = await createUser(
      { email: 'dev@acme.com', role: 'admin', status: 'invited', inviteExpiresAt: T0 + 1000 },
      T0,
    );
    const res = await accessLogin({ email: 'Dev@Acme.com' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok admin');
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
      login_provider: 'access',
      subject: await subjectOf('777'),
    });
  });

  it('later requests resolve by identity and write no further link', async () => {
    await createUser(
      { email: 'dev@acme.com', role: 'admin', status: 'invited', inviteExpiresAt: T0 + 1000 },
      T0,
    );
    expect((await accessLogin({ email: 'dev@acme.com' })).status).toBe(200);
    expect((await accessLogin({ email: 'dev@acme.com' }, T0 + 5000)).status).toBe(200);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE action = 'user.link'")).toBe(1);
  });

  it('never links an active user by email', async () => {
    await createUser(
      {
        email: 'dev@acme.com',
        role: 'owner',
        identity: { loginProvider: 'access', subject: await subjectOf('1') },
      },
      T0,
    );
    const res = await accessLogin({ email: 'dev@acme.com' });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Another user already has this email address');
    expect(
      await count(
        `SELECT count(*) AS n FROM user_identities WHERE subject = '${await subjectOf('777')}'`,
      ),
    ).toBe(0);
  });

  it('never links a disabled user by email', async () => {
    await createUser({ email: 'owner@acme.com', role: 'owner' }, T0);
    await createUser({ email: 'dev@acme.com', status: 'suspended' }, T0);
    const res = await accessLogin({ email: 'dev@acme.com' });
    expect(res.status).toBe(403);
    expect(await count('SELECT count(*) AS n FROM user_identities')).toBe(0);
  });

  it('rejects an expired invitation', async () => {
    await createUser({ email: 'dev@acme.com', status: 'invited', inviteExpiresAt: T0 }, T0 - 1000);
    const res = await accessLogin({ email: 'dev@acme.com' });
    expect(res.status).toBe(403);
    expect(await count("SELECT count(*) AS n FROM users WHERE status = 'invited'")).toBe(1);
  });

  it('does not link an invitation for another email: that person joins as viewer', async () => {
    await createUser({ email: 'owner@acme.com', role: 'owner' }, T0);
    await createUser({ email: 'dev@acme.com', status: 'invited', inviteExpiresAt: T0 + 1000 }, T0);
    const res = await accessLogin({ email: 'personal@example.com' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok viewer');
    expect(await count("SELECT count(*) AS n FROM users WHERE status = 'invited'")).toBe(1);
  });

  it('refuses an Access token without an email (credential)', async () => {
    await createUser({ email: 'dev@acme.com', status: 'invited', inviteExpiresAt: T0 + 1000 }, T0);
    const res = await accessLogin({ sub: '', common_name: 'ci.access' });
    expect(res.status).toBe(401);
    expect(await count('SELECT count(*) AS n FROM user_identities')).toBe(0);
  });

  it('a known identity of a disabled user is refused', async () => {
    await createUser({ email: 'owner@acme.com', role: 'owner' }, T0);
    await createUser(
      {
        email: 'dev@acme.com',
        status: 'suspended',
        identity: { loginProvider: 'access', subject: await subjectOf('777') },
      },
      T0,
    );
    const res = await accessLogin({ email: 'dev@acme.com' });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('suspended');
  });

  it('after "reset login" the user links a new identity through the invite path', async () => {
    await createUser({ email: 'owner@acme.com', role: 'owner' }, T0);
    const user = await createUser(
      {
        email: 'dev@acme.com',
        role: 'admin',
        identity: { loginProvider: 'access', subject: await subjectOf('old') },
      },
      T0,
    );
    await env.DB.batch(
      resetLoginStatements(env.DB, { id: user.id, now: T0, inviteExpiresAt: T0 + 1000 }),
    );
    const res = await accessLogin({ email: 'dev@acme.com' });
    expect(res.status).toBe(200);
    const { results } = await env.DB.prepare(
      'SELECT subject FROM user_identities WHERE user_id = ?',
    )
      .bind(user.id)
      .all<{ subject: string }>();
    expect(results.map((row) => row.subject)).toEqual([await subjectOf('777')]);
  });

  it('an identity from another Access team is a different identity', async () => {
    await createUser(
      {
        email: 'dev@acme.com',
        role: 'admin',
        identity: { loginProvider: 'access', subject: 'https://other.cloudflareaccess.com|777' },
      },
      T0,
    );
    const res = await accessLogin({ email: 'dev@acme.com' });
    expect(res.status).toBe(403);
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
          loginProvider: 'access',
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
});

describe('I-LINK-1: a refused sign-in of a known user is recorded on it, and links nothing', () => {
  async function row(id: string) {
    return env.DB.prepare(
      'SELECT status, updated_at, last_refused_at, last_refused_subject FROM users WHERE id = ?',
    )
      .bind(id)
      .first<{
        status: string;
        updated_at: number;
        last_refused_at: number | null;
        last_refused_subject: string | null;
      }>();
  }

  it.each([
    ['an expired invitation', { status: 'invited' as const, inviteExpiresAt: T0 - 1 }, false],
    ['a suspended user', { status: 'suspended' as const }, true],
    ['a pending user', { status: 'pending' as const }, true],
  ])('records %s: time and subject, no audit row, no identity', async (_label, seed, known) => {
    await createUser({ email: 'owner@acme.com', role: 'owner' }, T0);
    const user = await createUser(
      {
        email: 'dev@acme.com',
        ...seed,
        ...(known
          ? { identity: { loginProvider: 'access', subject: await subjectOf('777') } }
          : {}),
      },
      T0 - 10_000,
    );
    const res = await accessLogin({ email: 'dev@acme.com' });
    expect(res.status).toBe(403);
    expect(await row(user.id)).toEqual({
      status: seed.status,
      updated_at: T0 - 10_000,
      last_refused_at: T0,
      last_refused_subject: await subjectOf('777'),
    });
    expect(await count('SELECT count(*) AS n FROM audit_log')).toBe(0);
    expect(
      await count(`SELECT count(*) AS n FROM user_identities WHERE user_id = '${user.id}'`),
    ).toBe(known ? 1 : 0);
  });

  it('shows the expired-invitation copy', async () => {
    await createUser(
      { email: 'dev@acme.com', status: 'invited', inviteExpiresAt: T0 - 1 },
      T0 - 1000,
    );
    const res = await accessLogin({ email: 'dev@acme.com' });
    expect(await res.text()).toContain(
      'Your invitation expired. Owners can see that you tried. Ask one to renew it, then reload.',
    );
  });

  it('writes at most once per interval', async () => {
    const user = await createUser({ email: 'dev@acme.com', status: 'suspended' }, T0 - 1000);
    await accessLogin({ email: 'dev@acme.com' });
    await accessLogin({ email: 'dev@acme.com' }, T0 + 60_000);
    expect((await row(user.id))?.last_refused_at).toBe(T0);
    await accessLogin({ email: 'dev@acme.com' }, T0 + SEEN_INTERVAL_MS + 1);
    expect((await row(user.id))?.last_refused_at).toBe(T0 + SEEN_INTERVAL_MS + 1);
  });

  it('an unrelated email changes nothing, and neither does a request without a valid JWT', async () => {
    await createUser({ email: 'owner@acme.com', role: 'owner' }, T0);
    const user = await createUser({ email: 'dev@acme.com', status: 'suspended' }, T0 - 1000);
    expect((await accessLogin({ email: 'other@acme.com' })).status).toBe(200);
    const app = createAdminTestApp({ now: () => T0, routes: stubAdminPages });
    const forged = await app.request('/admin', { headers: { [ACCESS_JWT_HEADER]: 'not-a-jwt' } });
    expect(forged.status).toBe(401);
    const access = await testAccess();
    const wrongAud = await access.sign(
      { sub: '777', email: 'dev@acme.com' },
      { aud: 'b'.repeat(64), now: T0 },
    );
    expect(
      (await app.request('/admin', { headers: { [ACCESS_JWT_HEADER]: wrongAud } })).status,
    ).toBe(401);
    expect((await row(user.id))?.last_refused_at).toBeNull();
  });
});
