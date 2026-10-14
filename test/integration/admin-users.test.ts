import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerUsersRoutes } from '../../src/admin/routes/users';
import { getJoinDefaults } from '../../src/db/settings';
import type { Role, User } from '../../src/db/types';
import { getUser, INVITE_TTL_MS } from '../../src/db/users';
import {
  type AdminSession,
  type AdminTestApp,
  adminGet,
  adminPost,
  createAdminTestApp,
  createUser,
  loginAs,
  resetControlPlane,
} from '../helpers/admin-auth';

const T0 = Date.UTC(2026, 9, 13, 12);

let app: AdminTestApp;
let owner: User;

beforeEach(async () => {
  await resetControlPlane();
  app = createAdminTestApp({ routes: registerUsersRoutes, now: () => T0 });
  owner = await createUser({ email: 'owner@example.com', role: 'owner' }, T0);
});

async function sessionFor(role: Role): Promise<AdminSession> {
  if (role === 'owner') return loginAs(app, owner);
  return loginAs(app, await createUser({ email: `${role}@example.com`, role }, T0));
}

async function auditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT action FROM audit_log ORDER BY rowid').all<{
    action: string;
  }>();
  return results.map((row) => row.action);
}

describe('GET /admin/users', () => {
  it('lists users for a viewer without any management controls', async () => {
    const res = await adminGet(app, await sessionFor('viewer'), '/admin/users');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('owner@example.com');
    expect(html).toContain('Only owners can invite users');
    expect(html).not.toContain('action="/admin/users"');
    expect(html).not.toContain('reset-login');
  });

  it('shows owners the invite form, row actions, and the single-owner warning', async () => {
    const admin = await createUser({ email: 'admin@example.com', role: 'admin' }, T0);
    const res = await adminGet(app, await sessionFor('owner'), '/admin/users');
    const html = await res.text();
    expect(html).toContain('action="/admin/users"');
    expect(html).toContain(`action="/admin/users/${admin.id}/reset-login"`);
    expect(html).not.toContain(`action="/admin/users/${owner.id}/reset-login"`);
    expect(html).toContain('Only one active owner');
    expect(html).toContain('verified email address of their Cloudflare Access account');
    expect(html).toContain('<code>https://gw.test/admin</code>');
    expect(html).not.toContain('revoke-sessions');
  });

  it('escapes user-controlled text', async () => {
    await createUser({ email: 'x@example.com', name: '<script>alert(1)</script>' }, T0);
    const html = await (await adminGet(app, await sessionFor('viewer'), '/admin/users')).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('never echoes unknown notice keys', async () => {
    const res = await adminGet(app, await sessionFor('viewer'), '/admin/users?notice=%3Cb%3Ehi');
    expect(await res.text()).not.toContain('<b>hi');
  });
});

describe('RBAC on user mutations', () => {
  it('forbids viewers and admins from inviting or changing users', async () => {
    for (const role of ['viewer', 'admin'] as const) {
      const session = await sessionFor(role);
      const invite = await adminPost(app, session, '/admin/users', {
        email: `new-${role}@example.com`,
        role: 'owner',
      });
      expect(invite.status).toBe(403);
      const change = await adminPost(app, session, `/admin/users/${owner.id}`, { role: 'viewer' });
      expect(change.status).toBe(403);
    }
    expect((await getUser(env.DB, owner.id))?.role).toBe('owner');
    expect(await auditActions()).toEqual([]);
  });
});

describe('POST /admin/users (invite)', () => {
  it('invites a user and redirects with a notice naming the login providers', async () => {
    const session = await sessionFor('owner');
    const res = await adminPost(app, session, '/admin/users', {
      email: 'New.Person@Example.com',
      role: 'admin',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/users?notice=invited');
    const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?')
      .bind('new.person@example.com')
      .first<{ status: string; role: string; invite_expires_at: number }>();
    expect(row).toMatchObject({
      status: 'invited',
      role: 'admin',
      invite_expires_at: T0 + INVITE_TTL_MS,
    });
    expect(await auditActions()).toEqual(['user.invite']);

    const page = await (await adminGet(app, session, '/admin/users?notice=invited')).text();
    expect(page).toContain('sign in with Cloudflare Access using the invited email address');
  });

  it('re-renders the form with the submitted values on validation errors', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/users', {
      email: 'not an email',
      role: 'admin',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Enter a valid email address');
    expect(html).toContain('value="not an email"');
    expect(await auditActions()).toEqual([]);
  });

  it('reports an existing email address', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/users', {
      email: 'OWNER@example.com',
      role: 'viewer',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('A user with this email address already exists;');
  });
});

describe('POST /admin/users/:id and actions', () => {
  it('changes a role, effective on the user’s next request', async () => {
    const admin = await createUser({ email: 'a1@example.com', role: 'admin' }, T0);
    const adminSession = await loginAs(app, admin);
    const res = await adminPost(app, await sessionFor('owner'), `/admin/users/${admin.id}`, {
      role: 'viewer',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/users?notice=updated');
    expect((await getUser(env.DB, admin.id))?.role).toBe('viewer');
    const after = await adminPost(app, adminSession, '/admin/users', { email: 'x@example.com' });
    expect(after.status).toBe(403);
    expect(await after.text()).toContain('Your role does not allow this action.');
    expect(await auditActions()).toEqual(['user.update']);
  });

  it('refuses changing your own account', async () => {
    const res = await adminPost(app, await sessionFor('owner'), `/admin/users/${owner.id}`, {
      status: 'suspended',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('You cannot change your own account');
    expect((await getUser(env.DB, owner.id))?.status).toBe('active');
  });

  it('returns 404 for an unknown user', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/users/usr_nope', {
      role: 'viewer',
    });
    expect(res.status).toBe(404);
  });

  it('resets a login and resends an invitation', async () => {
    const session = await sessionFor('owner');
    const admin = await createUser(
      {
        email: 'a2@example.com',
        role: 'admin',
        identity: { loginProvider: 'access', subject: 'team|99' },
      },
      T0,
    );
    const reset = await adminPost(app, session, `/admin/users/${admin.id}/reset-login`);
    expect(reset.headers.get('location')).toBe('/admin/users?notice=reset');
    expect((await getUser(env.DB, admin.id))?.status).toBe('invited');

    const resend = await adminPost(app, session, `/admin/users/${admin.id}/resend-invite`);
    expect(resend.headers.get('location')).toBe('/admin/users?notice=resent');

    expect(await auditActions()).toEqual(['user.reset_login', 'user.resend_invite']);
  });

  it('refuses resending an invitation to an active user', async () => {
    const admin = await createUser({ email: 'a3@example.com', role: 'admin' }, T0);
    const res = await adminPost(
      app,
      await sessionFor('owner'),
      `/admin/users/${admin.id}/resend-invite`,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('is not waiting for an invitation');
  });
});

describe('review: CSRF, method safety and input handling', () => {
  it('rejects user changes without the CSRF token or from another site', async () => {
    const admin = await createUser({ email: 'r1@example.com', role: 'admin' }, T0);
    const session = await sessionFor('owner');
    const noToken = await adminPost(
      app,
      session,
      `/admin/users/${admin.id}`,
      { status: 'suspended' },
      { csrf: null },
    );
    expect(noToken.status).toBe(403);
    const crossSite = await adminPost(
      app,
      session,
      '/admin/users',
      { email: 'x@example.com', role: 'owner' },
      { headers: { 'sec-fetch-site': 'cross-site' } },
    );
    expect(crossSite.status).toBe(403);
    expect((await getUser(env.DB, admin.id))?.status).toBe('active');
    expect(await auditActions()).toEqual([]);
  });

  it('never mutates on GET', async () => {
    const admin = await createUser(
      {
        email: 'r2@example.com',
        role: 'admin',
        identity: { loginProvider: 'access', subject: 'team|7' },
      },
      T0,
    );
    const session = await sessionFor('owner');
    for (const action of ['reset-login', 'resend-invite']) {
      const res = await adminGet(app, session, `/admin/users/${admin.id}/${action}`);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect((await getUser(env.DB, admin.id))?.status).toBe('active');
    expect(await auditActions()).toEqual([]);
  });

  it('rejects an unknown role or the invited status from the form', async () => {
    const admin = await createUser({ email: 'r3@example.com', role: 'admin' }, T0);
    const session = await sessionFor('owner');
    const badRole = await adminPost(app, session, '/admin/users', {
      email: 'r4@example.com',
      role: 'superuser',
    });
    expect(badRole.status).toBe(400);
    const invitedStatus = await adminPost(app, session, `/admin/users/${admin.id}`, {
      status: 'invited',
    });
    expect(invitedStatus.status).toBe(400);
    expect(await getUser(env.DB, admin.id)).toMatchObject({ role: 'admin', status: 'active' });
    expect(await auditActions()).toEqual([]);
  });

  it('escapes a hostile email echoed back into the invite form', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/users', {
      email: '"><script>alert(1)</script>',
      role: 'viewer',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('refuses activating an invited user directly (only a sign-in activates)', async () => {
    const invited = await createUser(
      { email: 'r5@example.com', role: 'admin', status: 'invited' },
      T0,
    );
    const res = await adminPost(app, await sessionFor('owner'), `/admin/users/${invited.id}`, {
      status: 'active',
    });
    expect(res.status).toBe(400);
    expect((await getUser(env.DB, invited.id))?.status).toBe('invited');
  });
});

describe('review: operator feedback', () => {
  it('says nothing changed when the submitted role is the current one', async () => {
    const admin = await createUser({ email: 'u1@example.com', role: 'admin' }, T0);
    const res = await adminPost(app, await sessionFor('owner'), `/admin/users/${admin.id}`, {
      role: 'admin',
    });
    expect(res.headers.get('location')).toBe('/admin/users?notice=unchanged');
    expect(await auditActions()).toEqual([]);
  });

  it('points to the existing row when inviting an address that is already a user', async () => {
    await createUser({ email: 'gone@example.com', role: 'viewer', status: 'suspended' }, T0);
    const res = await adminPost(app, await sessionFor('owner'), '/admin/users', {
      email: 'gone@example.com',
      role: 'viewer',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('see their row in the list above');
  });

  it('explains what each row action does', async () => {
    await createUser({ email: 'u2@example.com', role: 'admin' }, T0);
    const html = await (await adminGet(app, await sessionFor('owner'), '/admin/users')).text();
    expect(html).toContain('What the actions do');
    expect(html).toContain('Reset login');
  });

  it('tells the owner to resend an expired invitation', async () => {
    await createUser({ email: 'late@example.com', status: 'invited', inviteExpiresAt: T0 - 1 }, T0);
    const html = await (await adminGet(app, await sessionFor('owner'), '/admin/users')).text();
    expect(html).toContain('invitation expired');
    expect(html).toContain('aria-label="Resend invitation: late@example.com"');
  });
});

describe('pending users', () => {
  async function pendingUser(email = 'wait@example.com'): Promise<User> {
    return createUser(
      {
        email,
        role: 'viewer',
        status: 'pending',
        identity: { loginProvider: 'access', subject: `team|${email}` },
      },
      T0,
    );
  }

  it('lists pending users in their own section with one-click Approve and Reject', async () => {
    const pending = await pendingUser();
    const html = await (await adminGet(app, await sessionFor('owner'), '/admin/users')).text();
    const section = html.split('<h2>Waiting for approval</h2>')[1]?.split('<h2>All users</h2>')[0];
    expect(section).toContain('wait@example.com');
    expect(section).toContain(`action="/admin/users/${pending.id}/approve"`);
    expect(section).toContain(`action="/admin/users/${pending.id}/reject"`);
    const all = html.split('<h2>All users</h2>')[1]?.split('<h2>')[0];
    expect(all).not.toContain('wait@example.com');
  });

  it('shows viewers the pending list without decision buttons', async () => {
    await pendingUser();
    const html = await (await adminGet(app, await sessionFor('viewer'), '/admin/users')).text();
    expect(html).toContain('wait@example.com');
    expect(html).not.toContain('/approve"');
  });

  it('approve activates and reject suspends, each with one audit row', async () => {
    const owner = await sessionFor('owner');
    const a = await pendingUser('a@example.com');
    const b = await pendingUser('b@example.com');
    const approve = await adminPost(app, owner, `/admin/users/${a.id}/approve`);
    expect(approve.headers.get('location')).toBe('/admin/users?notice=approved');
    const reject = await adminPost(app, owner, `/admin/users/${b.id}/reject`);
    expect(reject.headers.get('location')).toBe('/admin/users?notice=rejected');
    expect((await getUser(env.DB, a.id))?.status).toBe('active');
    expect((await getUser(env.DB, b.id))?.status).toBe('suspended');
    expect(await auditActions()).toEqual(['user.update', 'user.update']);
  });

  it('refuses to approve a user who is no longer pending', async () => {
    const owner = await sessionFor('owner');
    const suspended = await createUser(
      {
        email: 's@example.com',
        status: 'suspended',
        identity: { loginProvider: 'access', subject: 'team|s' },
      },
      T0,
    );
    const res = await adminPost(app, owner, `/admin/users/${suspended.id}/approve`);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('no longer waiting for approval');
    expect((await getUser(env.DB, suspended.id))?.status).toBe('suspended');
  });
});

describe('role and status in the user list', () => {
  it('changes role and status in one save', async () => {
    const owner = await sessionFor('owner');
    const user = await createUser(
      {
        email: 'u@example.com',
        role: 'viewer',
        identity: { loginProvider: 'access', subject: 't|u' },
      },
      T0,
    );
    const html = await (await adminGet(app, owner, '/admin/users')).text();
    expect(html).toContain('aria-label="Status for u@example.com"');
    const res = await adminPost(app, owner, `/admin/users/${user.id}`, {
      role: 'admin',
      status: 'suspended',
    });
    expect(res.headers.get('location')).toBe('/admin/users?notice=updated');
    expect(await getUser(env.DB, user.id)).toMatchObject({ role: 'admin', status: 'suspended' });
    const back = await adminPost(app, owner, `/admin/users/${user.id}`, {
      role: 'admin',
      status: 'active',
    });
    expect(back.headers.get('location')).toBe('/admin/users?notice=updated');
    expect((await getUser(env.DB, user.id))?.status).toBe('active');
  });

  it('refuses pending as a status set from the list', async () => {
    const owner = await sessionFor('owner');
    const user = await createUser(
      { email: 'u@example.com', identity: { loginProvider: 'access', subject: 't|u' } },
      T0,
    );
    const res = await adminPost(app, owner, `/admin/users/${user.id}`, { status: 'pending' });
    expect(res.status).toBe(400);
    expect((await getUser(env.DB, user.id))?.status).toBe('active');
  });
});

describe('join defaults', () => {
  it('starts as active viewer and is shown on the page', async () => {
    const html = await (await adminGet(app, await sessionFor('owner'), '/admin/users')).text();
    expect(html).toContain('<strong>active viewer</strong>');
    expect(html).toContain('action="/admin/users/defaults"');
  });

  it('owners can change role and status for later sign-ins', async () => {
    const owner = await sessionFor('owner');
    const res = await adminPost(app, owner, '/admin/users/defaults', {
      role: 'admin',
      status: 'pending',
    });
    expect(res.headers.get('location')).toBe('/admin/users?notice=defaults_saved');
    expect(await getJoinDefaults(env.DB)).toEqual({ role: 'admin', status: 'pending' });
    expect(await auditActions()).toEqual(['user.join_defaults']);
    const again = await adminPost(app, owner, '/admin/users/defaults', {
      role: 'admin',
      status: 'pending',
    });
    expect(again.headers.get('location')).toBe('/admin/users?notice=defaults_unchanged');
  });

  it.each([
    [{ role: 'owner', status: 'active' }],
    [{ role: 'viewer', status: 'invited' }],
    [{ role: 'viewer' }],
  ])('rejects %j', async (fields) => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/users/defaults', fields);
    expect(res.status).toBe(400);
    expect(await getJoinDefaults(env.DB)).toEqual({ role: 'viewer', status: 'active' });
  });
});
