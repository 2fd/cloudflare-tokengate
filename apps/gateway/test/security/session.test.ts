import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ACCESS_JWT_HEADER } from '../../src/admin/auth/access';
import { resetLogin } from '../../src/admin/ops/users';
import type { Actor } from '../../src/db/types';
import { updateUserStatements } from '../../src/db/users';
import {
  adminGet,
  createAdminTestApp,
  createUser,
  loginAs,
  resetControlPlane,
  setCookies,
  stubAdminPages,
} from '../helpers/admin-auth';
import { testAccess } from '../helpers/login-providers';

beforeEach(resetControlPlane);

const T0 = Date.UTC(2026, 9, 13, 12);

function clockedApp() {
  let now = T0;
  const app = createAdminTestApp({ routes: stubAdminPages, now: () => now });
  return {
    app,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('I-SESS-1: every admin request is authenticated by its own Access JWT', () => {
  it('the gateway stores no session: no sessions table, no identifying cookie', async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
    ).all();
    expect(tables.results).toEqual([]);
    const { app } = clockedApp();
    const user = await createUser({ email: 'o@example.com', role: 'owner' }, T0);
    const session = await loginAs(app, user);
    const res = await app.request('/admin', {
      headers: { [ACCESS_JWT_HEADER]: session.assertion },
    });
    expect(res.status).toBe(200);
    // The only cookie is the CSRF token, which is random and names nobody.
    expect([...setCookies(res).keys()]).toEqual(['__Host-tokengate_csrf']);
    expect(setCookies(res).get('__Host-tokengate_csrf')?.value).not.toContain(user.id);
  });

  it('stops accepting a JWT once Access lets it expire', async () => {
    const { app, advance } = clockedApp();
    const user = await createUser({ email: 'o@example.com', role: 'owner' }, T0);
    const access = await testAccess();
    await loginAs(app, user);
    const jwt = await access.sign(
      { sub: `sub-${user.id}`, email: user.email },
      { now: T0, ttlSeconds: 3600 },
    );
    const at = () => app.request('/admin', { headers: { [ACCESS_JWT_HEADER]: jwt } });
    expect((await at()).status).toBe(200);
    advance(3600_000 + 31_000);
    expect((await at()).status).toBe(401);
  });

  it('refuses the user from the next request once disabled', async () => {
    const { app } = clockedApp();
    const user = await createUser({ email: 'a@example.com', role: 'admin' }, T0);
    const session = await loginAs(app, user);
    expect((await adminGet(app, session, '/admin')).status).toBe(200);
    await env.DB.batch(updateUserStatements(env.DB, { id: user.id, now: T0, status: 'suspended' }));
    const res = await adminGet(app, session, '/admin');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('suspended');
  });

  it('applies a role change on the next request', async () => {
    const { app } = clockedApp();
    const user = await createUser({ email: 'a@example.com', role: 'admin' }, T0);
    const session = await loginAs(app, user);
    expect(await (await adminGet(app, session, '/admin')).text()).toBe('ok admin');
    await env.DB.batch(updateUserStatements(env.DB, { id: user.id, now: T0, role: 'viewer' }));
    expect(await (await adminGet(app, session, '/admin')).text()).toBe('ok viewer');
  });

  it('a reset login unlinks the identity; the next request re-links it through the invite', async () => {
    const { app } = clockedApp();
    const owner = await createUser({ email: 'owner@example.com', role: 'owner' }, T0);
    const user = await createUser({ email: 'a@example.com', role: 'admin' }, T0);
    const session = await loginAs(app, user);
    const actor: Actor = {
      type: 'user',
      id: owner.id,
      email: owner.email,
      ip: null,
      userAgent: null,
    };
    expect(await resetLogin(app.deps, actor, user.id)).toMatchObject({ ok: true });
    // The reset re-invites the email, so the next request links the identity again (I-LINK-1).
    expect((await adminGet(app, session, '/admin')).status).toBe(200);
    const links = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE action = 'user.link'",
    ).first('n');
    expect(links).toBe(1);
  });

  it('an unlinked identity of an active user is not accepted', async () => {
    const { app } = clockedApp();
    const user = await createUser({ email: 'a@example.com', role: 'admin' }, T0);
    const session = await loginAs(app, user);
    await env.DB.prepare('DELETE FROM user_identities WHERE user_id = ?').bind(user.id).run();
    const res = await adminGet(app, session, '/admin');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Another user already has this email address');
  });
});
