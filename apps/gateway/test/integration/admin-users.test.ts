// Users › People (`/admin/users`): the decision cards, the invite form, the people table with its
// row controls, `done` notices with Undo, and the user mutations behind them (I-RBAC-1, I-LINK-1,
// I-OWNER-1, I-AUDIT-1). No client script: dialogs open with invoker commands.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ACCESS_JWT_HEADER } from '../../src/admin/auth/access';
import { routePermission } from '../../src/admin/auth/rbac';
import { registerUsersRoutes } from '../../src/admin/routes/users';
import { EMAIL_PATTERN } from '../../src/admin/views/users';
import type { Role, User } from '../../src/db/types';
import { countNeedsDecision, getUser, INVITE_TTL_MS } from '../../src/db/users';
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
import { testAccess } from '../helpers/login-providers';

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

async function page(session: AdminSession, path = '/admin/users'): Promise<string> {
  const res = await adminGet(app, session, path);
  expect(res.status, path).toBe(200);
  return res.text();
}

/** The page a POST-redirect-GET lands on. */
async function follow(session: AdminSession, res: Response): Promise<string> {
  expect(res.status).toBe(303);
  return page(session, res.headers.get('location') ?? '');
}

function linked(email: string, extra: Partial<Parameters<typeof createUser>[0]> = {}) {
  return createUser(
    {
      email,
      role: 'admin',
      identity: { loginProvider: 'access', subject: `team|${email}` },
      ...extra,
    },
    // An hour ago, so a refused attempt recorded since is newer than the last change.
    T0 - 3_600_000,
  );
}

async function refusedAt(
  id: string,
  at: number,
  subject = 'https://x.cloudflareaccess.com|abcd1234',
) {
  await env.DB.prepare(
    'UPDATE users SET last_refused_at = ?, last_refused_subject = ? WHERE id = ?',
  )
    .bind(at, subject, id)
    .run();
}

/** The section of `html` from `start` up to the next `end` (or the end). */
function slice(html: string, start: string, end?: string): string {
  const from = html.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const rest = html.slice(from);
  const to = end === undefined ? -1 : rest.indexOf(end, start.length);
  return to === -1 ? rest : rest.slice(0, to);
}

describe('GET /admin/users', () => {
  it('lists people for a viewer without any form, and says who decides', async () => {
    await createUser(
      {
        email: 'wait@example.com',
        status: 'pending',
        identity: { loginProvider: 'access', subject: 't|w' },
      },
      T0,
    );
    const html = await page(await sessionFor('viewer'));
    expect(html).toContain('<title>People – Users – tokengate</title>');
    expect(html).toContain('owner@example.com');
    expect(html).not.toMatch(/<form\b[^>]*\bmethod="post"/);
    expect(html).toContain('Only owners can decide.');
    expect(html).toContain('wait@example.com');
    expect(html).not.toContain('id="invite"');
    expect(html).not.toContain('<script');
  });

  it('shows owners the invite form, row controls and the single-owner callout', async () => {
    const admin = await linked('admin@example.com');
    const html = await page(await sessionFor('owner'));
    expect(html).toContain('id="invite-form"');
    expect(html).toContain('You are the only owner.');
    expect(html).toContain('href="/admin/users#invite"');
    expect(html).toContain('The email of their Cloudflare Access account');
    expect(html).toContain('placeholder="alex@example.com"');
    // Reset sign-in is a dialog whose own form posts the reset.
    const reset = slice(html, `<dialog class="dlg" id="dlg-reset-${admin.id}"`, '</dialog>');
    expect(reset).toContain(`<form method="post" action="/admin/users/${admin.id}/reset-login"`);
    expect(reset).toContain('name="confirm" value="1"');
    expect(html).toContain(
      `<button class="menu-item two bad" type="button" command="show-modal" commandfor="dlg-reset-${admin.id}"`,
    );
    expect(html).not.toContain(`action="/admin/users/${owner.id}/reset-login"`);
    expect(html).not.toContain('<script');
  });

  it('shows the role map next to the decisions, with role filter links and a text equivalent', async () => {
    await linked('admin@example.com', { name: 'Diego Ruiz' });
    const html = await page(await sessionFor('owner'));
    const map = slice(html, 'id="roles-map"', '</section>');
    expect(map).toContain('<a class="node cnode" href="/admin/users?role=admin">');
    expect(map).toContain('<span class="nl">Diego Ruiz</span>');
    expect(map).toContain('<svg class="wires"');
    expect(map).toContain('<b>Admin:</b> credentials, issuer access rules, export.');
    // Without decisions or the single-owner note there is no column to sit beside.
    await createUser({ email: 'o2@example.com', role: 'owner' }, T0);
    expect(await page(await sessionFor('owner'))).not.toContain('id="roles-map"');
  });

  it('tells non-owners whom to ask about a pending person, without any control', async () => {
    await createUser(
      {
        email: 'wait@example.com',
        status: 'pending',
        identity: { loginProvider: 'access', subject: 't|w' },
      },
      T0,
    );
    const html = await page(await sessionFor('admin'));
    const decide = slice(html, '<section class="tray tone-warn" id="decide"', '</section>');
    expect(decide).toContain('<p>Only owners can decide.</p>');
    expect(decide).toMatch(
      /<p class="ask">\s*Ask <b>owner@example\.com<\/b>\. <a href="mailto:owner@example\.com">Email them<\/a><\/p>/,
    );
    expect(decide).not.toContain('/approve"');
    expect(html).not.toContain('Invite someone</a>');
  });

  it('the self row has no controls', async () => {
    const html = await page(await sessionFor('owner'));
    const self = slice(html, `id="user-${owner.id}"`, '</tr>');
    expect(self).toContain(
      '<span class="meta">This is you<span class="vh">. Another owner can change your account.</span></span>',
    );
    expect(self).not.toContain('person-actions');
  });

  it('lists active people by role (owners first), then invitations with who sent them', async () => {
    const session = await sessionFor('owner');
    await linked('a-viewer@example.com', { role: 'viewer' });
    await linked('b-token@example.com', { role: 'token_manager' });
    await linked('c-admin@example.com', { role: 'admin' });
    await adminPost(app, session, '/admin/users', { email: 'a-new@example.com', role: 'admin' });
    const html = await page(session);
    const rows = [
      ...html.matchAll(/<tr id="user-[^"]+"[^>]*>.*?class="ent-n"[^>]*>([^<]+)</gs),
    ].map((match) => match[1]);
    expect(rows).toEqual([
      'owner@example.com',
      'c-admin@example.com',
      'b-token@example.com',
      'a-viewer@example.com',
      'a-new@example.com',
    ]);
    const invited = slice(html, 'a-new@example.com</a>', '</tr>');
    expect(invited).toContain('Invited by owner@example.com');
  });

  it('has a captioned table with row headers and a Changes link', async () => {
    const admin = await linked('admin@example.com');
    const session = await sessionFor('owner');
    await adminPost(app, session, `/admin/users/${admin.id}`, { role: 'viewer' });
    const html = await page(session);
    expect(html).toContain('<caption class="vh">People (2 shown of 2)</caption>');
    expect(html).toContain(`<tr id="user-${owner.id}"><th scope="row">`);
    expect(html).toContain(
      `href="/admin/audit?actor=${owner.id}">1 change<span class="vh"> by owner@example.com</span></a> in 30 days`,
    );
  });

  it('escapes user-controlled text', async () => {
    await createUser({ email: 'x@example.com', name: '<script>alert(1)</script>' }, T0);
    const html = await page(await sessionFor('viewer'));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('never echoes unknown notice keys or a forged done id', async () => {
    const session = await sessionFor('viewer');
    const html = await page(session, '/admin/users?notice=%3Cb%3Ehi&done=%3Cb%3E');
    expect(html).not.toContain('<b>hi');
    expect(html).not.toContain('class="callout ok notice"');
  });

  it('filters with link chips; unknown values are ignored', async () => {
    await createUser({ email: 'gone@example.com', role: 'viewer', status: 'suspended' }, T0);
    await createUser({ email: 'late@example.com', status: 'invited', inviteExpiresAt: T0 - 1 }, T0);
    const session = await sessionFor('viewer');
    const html = await page(session, '/admin/users?status=suspended');
    const nav = slice(html, '<nav class="qlinks" aria-label="Filter people">', '</nav>');
    expect(nav).toContain('href="/admin/users?status=suspended" aria-current="true"');
    expect(nav).toContain('Invitation expired <span class="n">1</span>');
    expect(slice(html, 'id="people-h"', '</section>')).toContain(
      '<a href="/admin/users">Clear filters</a>',
    );
    expect(html).toContain('People (1 shown of 4)');
    const late = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind('late@example.com')
      .first<{ id: string }>();
    expect(late?.id).toBeTruthy();
    expect(html).not.toContain(`id="user-${late?.id}"`);
    const ignored = await page(session, '/admin/users?status=bogus&role=root');
    expect(ignored).toContain('People (4 shown of 4)');
    const none = await page(session, '/admin/users?role=token_manager');
    expect(none).toContain('No people match these filters.');
  });

  it('adds a search with a datalist only above 20 people, matching email and name', async () => {
    const session = await sessionFor('viewer');
    expect(await page(session)).not.toContain('role="search"');
    for (let i = 0; i < 20; i++) {
      await createUser({ email: `p${i}@example.com`, name: i === 7 ? 'Zoë Q' : null }, T0);
    }
    const html = await page(session);
    expect(html).toContain('role="search"');
    expect(html).toContain('<option value="p3@example.com">');
    expect(await page(session, '/admin/users?q=ZOË')).toContain('People (1 shown of 22)');
    expect(await page(session, '/admin/users?q=P1')).toContain('People (11 shown of 22)');
    // `%` is a plain character, not a wildcard.
    expect(await page(session, '/admin/users?q=%25')).toContain('No people match these filters.');
    const long = await page(session, `/admin/users?q=${'a'.repeat(300)}`);
    expect(long).toContain('Search text too long; showing everyone');
  });

  it('renders patterns that compile with the v flag', async () => {
    const html = await page(await sessionFor('owner'));
    expect(() => new RegExp(`^(?:${EMAIL_PATTERN})$`, 'v')).not.toThrow();
    expect(html).toContain('pattern="[^\\s@,;&lt;&gt;&quot;]+@');
    const pattern = new RegExp(`^(?:${EMAIL_PATTERN})$`, 'v');
    expect(pattern.test('alex@acme.com')).toBe(true);
    expect(pattern.test('alex@localhost')).toBe(false);
  });
});

describe('dialogs and implicit submission (no client script)', () => {
  it('Enter in the invite form invites as Viewer; the Owner dialog follows the form', async () => {
    const html = await page(await sessionFor('owner'));
    const form = slice(html, 'id="invite-form"', '</form>');
    const firstSubmit = /<button\b[^>]*\btype="submit"[^>]*>/.exec(form)?.[0] ?? '';
    expect(firstSubmit).toContain('value="viewer"');
    expect(form).not.toContain('value="owner"');
    expect(html.indexOf('id="dlg-invite-owner"')).toBeGreaterThan(
      html.indexOf('</form>', html.indexOf('id="invite-form"')),
    );
    const dialog = slice(html, 'id="dlg-invite-owner"', '</dialog>');
    expect(dialog).toMatch(
      /<button class="btn [^"]+" type="submit" name="role" value="owner" form="invite-form" formnovalidate/,
    );
  });

  it('every invoker is type=button, and no popover opens a dialog', async () => {
    await linked('admin@example.com');
    await createUser({ email: 'o2@example.com', role: 'owner' }, T0);
    await createUser(
      {
        email: 'p@example.com',
        status: 'pending',
        identity: { loginProvider: 'access', subject: 't|p' },
      },
      T0,
    );
    const html = await page(await sessionFor('owner'));
    const invokers = html.match(/<button[^>]*commandfor=[^>]*>/g) ?? [];
    expect(invokers.length).toBeGreaterThan(5);
    for (const button of invokers) expect(button).toContain('type="button"');
    // A dialog is a popover (the fallback); only its own Cancel may target anything from inside.
    for (const dialog of html.match(/<dialog[\s\S]*?<\/dialog>/g) ?? []) {
      expect(dialog).not.toContain('command="show-modal"');
    }
  });

  it('making someone Owner exists only inside a dialog', async () => {
    const admin = await linked('admin@example.com');
    const html = await page(await sessionFor('owner'));
    const outside = html.replace(/<dialog[\s\S]*?<\/dialog>/g, '');
    expect(outside).not.toContain('value="owner"');
    // The dialog posts the change itself (no shared role form on People).
    const dialog = slice(html, `id="dlg-owner-${admin.id}"`, '</dialog>');
    expect(dialog).toContain(`<form method="post" action="/admin/users/${admin.id}">`);
    expect(dialog).toContain('<input type="hidden" name="role" value="owner"/>');
    expect(dialog).toContain(`name="expected_updated_at" value="${admin.updated_at}"`);
  });
});

describe('RBAC on user mutations', () => {
  it('forbids every role but owner from inviting or changing people', async () => {
    for (const role of ['viewer', 'token_manager', 'access_manager', 'admin'] as const) {
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

  it('pins the new routes and never mutates on GET', async () => {
    for (const action of ['delete', 'dismiss-attempt']) {
      expect(routePermission('POST', `/admin/users/:id/${action}`)?.permission).toBe('users:write');
    }
    expect(routePermission('POST', '/admin/users/sign-in/policy')?.permission).toBe('users:write');
    expect(routePermission('POST', '/admin/users/defaults')).toBeNull();
    const target = await linked('r2@example.com');
    const session = await sessionFor('owner');
    for (const action of ['reset-login', 'resend-invite', 'delete', 'dismiss-attempt']) {
      const res = await adminGet(app, session, `/admin/users/${target.id}/${action}`);
      expect(res.status, action).toBeGreaterThanOrEqual(400);
    }
    expect((await getUser(env.DB, target.id))?.status).toBe('active');
    expect(await auditActions()).toEqual([]);
  });

  it('rejects user changes without the CSRF token or from another site', async () => {
    const admin = await linked('r1@example.com');
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
    expect(await auditActions()).toEqual([]);
  });
});

describe('POST /admin/users (invite)', () => {
  it('invites, and the notice names the role, the expiry and an email link', async () => {
    const session = await sessionFor('owner');
    const res = await adminPost(app, session, '/admin/users', {
      email: 'New.Person@Example.com',
      role: 'token_manager',
    });
    const row = await env.DB.prepare(
      'SELECT id, status, role, invite_expires_at FROM users WHERE email = ?',
    )
      .bind('new.person@example.com')
      .first<{ id: string; status: string; role: string; invite_expires_at: number }>();
    expect(row).toMatchObject({
      status: 'invited',
      role: 'token_manager',
      invite_expires_at: T0 + INVITE_TTL_MS,
    });
    expect(res.headers.get('location')).toMatch(
      new RegExp(`^/admin/users\\?notice=invited&done=aud_[0-9A-Z]{26}#user-${row?.id}$`),
    );
    expect(await auditActions()).toEqual(['user.invite']);
    const html = await follow(session, res);
    expect(html).toContain(
      'Invited new.person@example.com as Credential manager until 20 Oct 2026, 12:00 UTC. Nothing was sent.',
    );
    expect(html).toContain('href="mailto:new.person@example.com?subject=');
    expect(html).toContain('Email new.person@example.com the sign-in link');
    expect(html).toContain('https%3A%2F%2Fgw.test%2Fadmin');
    expect(html).toContain(
      '<p class="more">Send them https://gw.test/admin. They sign in with Cloudflare Access as new.person@example.com.</p>',
    );
    // The invited row is highlighted; the invite tray is closed again (no fragment opens it).
    expect(html).toContain(`<tr class="hl" id="user-${row?.id}">`);
    expect(html).toContain('<section class="tray span-12" id="invite"');
  });

  it('opens the invite tray only when targeted or after a failed invite', async () => {
    const session = await sessionFor('owner');
    const html = await page(session);
    expect(html).toContain('<section class="tray span-12" id="invite"');
    // The header primary and the single-owner callout target it.
    expect(html).toContain(
      '<a class="btn primary" href="/admin/users#invite"><span class="plus" aria-hidden="true">+</span>Invite someone</a>',
    );
    const failed = await adminPost(app, session, '/admin/users', { email: 'nope', role: 'admin' });
    expect(await failed.text()).toContain('<section class="tray span-12 is-open" id="invite"');
  });

  it('shows the detail only for the viewer’s own recent audit row', async () => {
    const session = await sessionFor('owner');
    const res = await adminPost(app, session, '/admin/users', {
      email: 'a@example.com',
      role: 'viewer',
    });
    const location = res.headers.get('location') ?? '';
    const done = /done=(aud_[0-9A-Z]{26})/.exec(location)?.[1] ?? '';
    // Another owner following the same link sees the generic text, never the person.
    const other = await loginAs(
      app,
      await createUser({ email: 'o2@example.com', role: 'owner' }, T0),
    );
    const theirs = await page(other, location);
    expect(theirs).toContain('Invitation saved. Nothing was sent.');
    expect(theirs).not.toContain('Invited a@example.com');
    // Older than 10 minutes: generic too.
    const later = createAdminTestApp({ routes: registerUsersRoutes, now: () => T0 + 11 * 60_000 });
    const old = await (
      await adminGet(later, session, `/admin/users?notice=invited&done=${done}`)
    ).text();
    expect(old).toContain('Invitation saved. Nothing was sent.');
  });

  it('re-renders the email with the error at the field', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/users', {
      email: 'not an email',
      role: 'admin',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('<title>Error: People – Users – tokengate</title>');
    expect(html).toContain('<a href="#f-email">Enter an email address like alex@acme.com.</a>');
    expect(html).toContain('value="not an email"');
    expect(html).toMatch(/id="f-email"[^>]*aria-invalid="true"/);
    expect(await auditActions()).toEqual([]);
  });

  it('refuses an email whose user signed in, offering that person', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/users', {
      email: 'OWNER@example.com',
      role: 'viewer',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('owner@example.com already signed in with an account (Active).');
    expect(html).toContain(`href="/admin/users#user-${owner.id}"`);
  });

  it('offers a suspended person’s Reactivate after the invite form, never nested in it', async () => {
    const gone = await linked('gone@example.com', { status: 'suspended' });
    const res = await adminPost(app, await sessionFor('owner'), '/admin/users', {
      email: 'gone@example.com',
      role: 'viewer',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    const form = slice(html, 'id="invite-form"', '</form>');
    expect(form).not.toContain('<form');
    expect(/<button\b[^>]*\btype="submit"[^>]*>/.exec(form)?.[0] ?? '').toContain('value="viewer"');
    expect(form).toContain('value="admin"');
    const existing = slice(html, 'id="invite-existing"', '</div>');
    expect(html.indexOf('id="invite-existing"')).toBeGreaterThan(
      html.indexOf('</form>', html.indexOf('id="invite-form"')),
    );
    expect(existing).toContain(`href="/admin/users#user-${gone.id}"`);
    expect(existing).toContain(
      `<form class="action-form" method="post" action="/admin/users/${gone.id}"`,
    );
    expect(existing).toContain('name="status" value="active"');
    expect(existing).toContain('Reactivate');
    expect(html).toMatch(/id="f-email"[^>]*aria-describedby="[^"]*invite-existing"/);
  });

  it('points a pending person’s refused invite at their decision card', async () => {
    const pending = await createUser(
      {
        email: 'wait@example.com',
        role: 'viewer',
        status: 'pending',
        identity: { loginProvider: 'access', subject: 'team|wait@example.com' },
      },
      T0,
    );
    const res = await adminPost(app, await sessionFor('owner'), '/admin/users', {
      email: 'wait@example.com',
      role: 'viewer',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('wait@example.com already signed in with an account');
    expect(slice(html, 'id="invite-existing"', '</div>')).toContain(
      `href="#decide-${pending.id}-h"`,
    );
    expect(html).toContain(`id="decide-${pending.id}-h"`);
  });

  it.each([
    ['an expired invitation', { status: 'invited' as const, inviteExpiresAt: T0 - 1 }],
    ['a cancelled invitation', { status: 'suspended' as const }],
  ])('invites %s again instead of refusing it', async (_label, seed) => {
    await createUser({ email: 'again@example.com', role: 'viewer', ...seed }, T0 - 10);
    const session = await sessionFor('owner');
    const res = await adminPost(app, session, '/admin/users', {
      email: 'again@example.com',
      role: 'admin',
    });
    expect(await follow(session, res)).toContain('Invited again@example.com again as Admin');
    expect(await auditActions()).toEqual(['user.invite']);
  });

  it('refuses an unknown role', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/users', {
      email: 'r4@example.com',
      role: 'superuser',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(
      'Choose one of: Viewer, Credential manager, Access manager, Admin, Owner.',
    );
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
});

describe('POST /admin/users/:id (role and status, one click each)', () => {
  it('changes a role, effective on the next request, with an Undo', async () => {
    const admin = await linked('a1@example.com');
    const adminSession = await loginAs(app, admin);
    const session = await sessionFor('owner');
    const res = await adminPost(app, session, `/admin/users/${admin.id}`, {
      role: 'viewer',
      expected_updated_at: String(admin.updated_at),
    });
    expect(res.headers.get('location')).toMatch(
      new RegExp(`^/admin/users\\?notice=updated&done=aud_[0-9A-Z]{26}#user-${admin.id}$`),
    );
    expect((await getUser(env.DB, admin.id))?.role).toBe('viewer');
    const after = await adminPost(app, adminSession, '/admin/users', { email: 'x@example.com' });
    expect(after.status).toBe(403);
    const html = await follow(session, res);
    expect(html).toContain('Made a1@example.com Viewer (was Admin).');
    const notice = slice(html, '<div class="callout ok notice"', '</div></div>');
    expect(notice).toContain(`action="/admin/users/${admin.id}"`);
    expect(notice).toContain('name="role" value="admin"');
    expect(await auditActions()).toEqual(['user.update']);
  });

  it('marks the changed row, says what the role does, and names the Undo', async () => {
    const admin = await linked('a1@example.com');
    const session = await sessionFor('owner');
    const res = await adminPost(app, session, `/admin/users/${admin.id}`, {
      role: 'viewer',
      expected_updated_at: String(admin.updated_at),
    });
    const html = await follow(session, res);
    expect(html).toContain(`<tr class="hl" id="user-${admin.id}">`);
    expect(html.match(/<tr class="hl"/g)).toHaveLength(1);
    const notice = slice(html, '<div class="callout ok notice"', '</div></div>');
    expect(notice).toContain('<p class="more">Viewer: Sees every page. Changes nothing.');
    expect(notice).toContain('Undo<span class="vh">: make a1@example.com Admin again</span>');
    // Hidden fields: the token first, then where to return, then the change.
    expect(notice).toMatch(
      /name="_csrf" value="[^"]+"\/><input type="hidden" name="_return" value="list"\/><input type="hidden" name="role" value="admin"\/>/,
    );
  });

  it('suspends a non-owner in one click; Undo reactivates; a stale Undo disappears', async () => {
    const user = await linked('u@example.com', { role: 'viewer' });
    const session = await sessionFor('owner');
    const suspend = await adminPost(app, session, `/admin/users/${user.id}`, {
      status: 'suspended',
      expected_updated_at: String(user.updated_at),
    });
    const html = await follow(session, suspend);
    expect(html).toContain(
      'Suspended u@example.com. Their Access session stays valid, but tokengate refuses every request they make.',
    );
    const undo = slice(html, '<div class="callout ok notice"', '</div></div>');
    expect(undo).toContain('name="status" value="active"');
    const version = /name="expected_updated_at" value="(\d+)"/.exec(undo)?.[1] ?? '';
    const back = await adminPost(app, session, `/admin/users/${user.id}`, {
      status: 'active',
      expected_updated_at: version,
    });
    expect(back.status).toBe(303);
    expect((await getUser(env.DB, user.id))?.status).toBe('active');
    // The first notice's row changed again: no Undo any more.
    const stale = await page(session, suspend.headers.get('location') ?? '');
    expect(slice(stale, '<div class="callout ok notice"', '</div></div>')).not.toContain('Undo');
  });

  it('offers no Undo for owner transitions', async () => {
    const other = await linked('o2@example.com', { role: 'owner' });
    const session = await sessionFor('owner');
    const res = await adminPost(app, session, `/admin/users/${other.id}`, { role: 'admin' });
    const html = await follow(session, res);
    expect(html).toContain('Made o2@example.com Admin (was Owner).');
    expect(slice(html, '<div class="callout ok notice"', '</div></div>')).not.toContain('Undo');
  });

  it('refuses a stale page with 409 and the current state', async () => {
    const admin = await linked('s@example.com');
    const session = await sessionFor('owner');
    const res = await adminPost(app, session, `/admin/users/${admin.id}`, {
      role: 'viewer',
      expected_updated_at: String(admin.updated_at - 1),
    });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('s@example.com was changed by someone else at');
    expect(html).toContain(`<a href="#f-user-${admin.id}">`);
    expect(html).toContain(`id="f-user-${admin.id}"`);
    expect(html).toMatch(
      new RegExp(
        `<details class="rowmenu" name="person-actions" open(="")?><summary class="btn sm secondary">Change<span class="vh"> s@example.com`,
      ),
    );
    expect((await getUser(env.DB, admin.id))?.role).toBe('admin');
  });

  it('suspending another owner needs the dialog confirmation', async () => {
    const other = await linked('o2@example.com', { role: 'owner' });
    const session = await sessionFor('owner');
    const res = await adminPost(app, session, `/admin/users/${other.id}`, { status: 'suspended' });
    expect(res.status).toBe(422);
    expect((await getUser(env.DB, other.id))?.status).toBe('active');
    const confirmed = await adminPost(app, session, `/admin/users/${other.id}`, {
      status: 'suspended',
      confirm: '1',
    });
    expect(confirmed.status).toBe(303);
    expect((await getUser(env.DB, other.id))?.status).toBe('suspended');
  });

  it('refuses changing your own account', async () => {
    const res = await adminPost(app, await sessionFor('owner'), `/admin/users/${owner.id}`, {
      status: 'suspended',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('You cannot change your own account');
  });

  it('says nothing changed for the current role, and 404s an unknown user', async () => {
    const admin = await linked('u1@example.com');
    const session = await sessionFor('owner');
    const same = await adminPost(app, session, `/admin/users/${admin.id}`, { role: 'admin' });
    expect(same.headers.get('location')).toBe('/admin/users?notice=unchanged');
    const missing = await adminPost(app, session, '/admin/users/usr_nope', { role: 'viewer' });
    expect(missing.status).toBe(404);
    expect(await auditActions()).toEqual([]);
  });

  it('refuses activating an invited user and the pending or invited status', async () => {
    const invited = await createUser({ email: 'r5@example.com', status: 'invited' }, T0);
    const session = await sessionFor('owner');
    for (const status of ['active', 'pending', 'invited']) {
      const res = await adminPost(app, session, `/admin/users/${invited.id}`, { status });
      expect(res.status, status).toBe(400);
    }
    expect((await getUser(env.DB, invited.id))?.status).toBe('invited');
  });

  it('_return=detail goes back to the Person page', async () => {
    const admin = await linked('d@example.com');
    const res = await adminPost(app, await sessionFor('owner'), `/admin/users/${admin.id}`, {
      role: 'viewer',
      _return: 'detail',
    });
    expect(res.headers.get('location')).toMatch(
      new RegExp(`^/admin/users/${admin.id}\\?notice=updated&done=aud_[0-9A-Z]{26}$`),
    );
  });
});

describe('reset sign-in, renew and cancel an invitation', () => {
  it('reset sign-in of a linked user needs the dialog confirmation', async () => {
    const admin = await linked('a2@example.com');
    const session = await sessionFor('owner');
    const unconfirmed = await adminPost(app, session, `/admin/users/${admin.id}/reset-login`);
    expect(unconfirmed.status).toBe(422);
    expect((await getUser(env.DB, admin.id))?.status).toBe('active');
    const reset = await adminPost(app, session, `/admin/users/${admin.id}/reset-login`, {
      confirm: '1',
      expected_updated_at: String(admin.updated_at),
    });
    expect(await follow(session, reset)).toContain('Reset the sign-in of a2@example.com.');
    expect((await getUser(env.DB, admin.id))?.status).toBe('invited');
    const resend = await adminPost(app, session, `/admin/users/${admin.id}/resend-invite`);
    expect(await follow(session, resend)).toContain('Renewed the invitation of a2@example.com.');
    expect(await auditActions()).toEqual(['user.reset_login', 'user.resend_invite']);
  });

  it('"Invite again" names the role and needs no dialog for a user who never signed in', async () => {
    const cancelled = await createUser({ email: 'c@example.com', status: 'suspended' }, T0);
    const session = await sessionFor('owner');
    const html = await page(session);
    expect(slice(html, `id="user-${cancelled.id}"`, '</tr>')).toContain(
      'Invite again as Admin<span class="vh"> c@example.com</span>',
    );
    const res = await adminPost(app, session, `/admin/users/${cancelled.id}/reset-login`);
    expect(res.status).toBe(303);
    expect((await getUser(env.DB, cancelled.id))?.status).toBe('invited');
  });

  it('inviting a cancelled Owner again goes through a dialog the server requires', async () => {
    const cancelled = await createUser(
      { email: 'boss@example.com', role: 'owner', status: 'suspended' },
      T0 - 3_600_000,
    );
    await refusedAt(cancelled.id, T0 - 60_000);
    const session = await sessionFor('owner');
    const html = await page(session);
    const card = slice(html, `id="decide-${cancelled.id}-h"`, '</li>');
    expect(card).toContain('but their invitation as Owner was cancelled.');
    expect(card).toContain(`commandfor="dlg-card-again-${cancelled.id}"`);
    expect(card).toContain('Invite again as Owner…');
    // The only reset-login form is the dialog's, which carries confirm=1.
    const dialog = slice(card, `id="dlg-card-again-${cancelled.id}"`, '</dialog>');
    expect(dialog).toContain(`action="/admin/users/${cancelled.id}/reset-login"`);
    expect(dialog).toContain('name="confirm" value="1"');
    expect(card.split(`/reset-login"`)).toHaveLength(2);
    expect(slice(html, `id="user-${cancelled.id}"`, '</tr>')).toContain(
      `commandfor="dlg-row-again-${cancelled.id}"`,
    );
    const unconfirmed = await adminPost(app, session, `/admin/users/${cancelled.id}/reset-login`);
    expect(unconfirmed.status).toBe(422);
    expect(await unconfirmed.text()).toContain(
      'Confirm inviting boss@example.com again as Owner in the dialog.',
    );
    expect((await getUser(env.DB, cancelled.id))?.status).toBe('suspended');
    const res = await adminPost(app, session, `/admin/users/${cancelled.id}/reset-login`, {
      confirm: '1',
    });
    expect(res.status).toBe(303);
    expect(await getUser(env.DB, cancelled.id)).toMatchObject({ status: 'invited', role: 'owner' });
  });

  it('cancelling an invitation deletes the row, after the dialog', async () => {
    const invited = await createUser({ email: 'i@example.com', status: 'invited' }, T0);
    const session = await sessionFor('owner');
    const html = await page(session);
    const row = slice(html, `id="user-${invited.id}"`, '</tr>');
    expect(row).toContain('Email sign-in link');
    expect(row).toContain('Cancel invitation…');
    expect(row).toContain(
      'If they sign in later, they are treated like anyone new: Let them in as Viewer.',
    );
    expect((await adminPost(app, session, `/admin/users/${invited.id}/delete`)).status).toBe(422);
    const res = await adminPost(app, session, `/admin/users/${invited.id}/delete`, {
      confirm: '1',
    });
    expect(await follow(session, res)).toContain('Deleted i@example.com.');
    expect(await getUser(env.DB, invited.id)).toBeNull();
    expect(await auditActions()).toEqual(['user.delete']);
  });

  it('refuses deleting someone who signed in', async () => {
    const user = await linked('l@example.com', { status: 'suspended' });
    const res = await adminPost(app, await sessionFor('owner'), `/admin/users/${user.id}/delete`, {
      confirm: '1',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Suspend them instead');
    expect(await getUser(env.DB, user.id)).not.toBeNull();
  });

  it('an expired invitation shows Renew invitation as its state button', async () => {
    const late = await createUser(
      { email: 'late@example.com', status: 'invited', inviteExpiresAt: T0 - 1 },
      T0,
    );
    const html = await page(await sessionFor('owner'));
    const row = slice(html, `id="user-${late.id}"`, '</tr>');
    expect(row).toContain('Invitation expired');
    expect(row).toContain('Renew invitation<span class="vh"> for late@example.com</span>');
    // The email link of an expired invitation does not claim it is still valid.
    expect(row).toContain('href="mailto:late@example.com?');
    expect(row).not.toContain('valid%20until');
  });
});

describe('Needs your decision', () => {
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

  it('lists pending people as cards with one submit per role, not in the table', async () => {
    const pending = await pendingUser();
    const html = await page(await sessionFor('owner'));
    const decide = slice(html, '<section class="tray tone-warn" id="decide"', '</section>');
    expect(decide).toContain('Needs your decision<span class="count">1</span>');
    expect(decide).toContain('wait@example.com');
    expect(decide).toContain(`action="/admin/users/${pending.id}/approve"`);
    expect(decide).toContain(`action="/admin/users/${pending.id}/reject"`);
    for (const role of ['viewer', 'token_manager', 'access_manager', 'admin']) {
      expect(decide).toContain(`name="role" value="${role}"`);
    }
    const rows = slice(
      slice(html, '<section class="tray span-12" id="people"', '</table>'),
      '<tbody',
    );
    expect(rows).not.toContain('wait@example.com');
    expect(html).not.toContain(`id="user-${pending.id}"`);
    // The Accounts tray says where the pending person is instead.
    expect(html).toContain('wait@example.com waits above, under “Needs your decision”.');
    expect(html).toContain('<a class="ql warn" href="#decide">');
  });

  it('approve with a role is user.approve, reject is user.reject', async () => {
    const session = await sessionFor('owner');
    const a = await pendingUser('a@example.com');
    const b = await pendingUser('b@example.com');
    const approve = await adminPost(app, session, `/admin/users/${a.id}/approve`, {
      role: 'access_manager',
    });
    expect(await follow(session, approve)).toContain('Approved a@example.com as Access manager.');
    const reject = await adminPost(app, session, `/admin/users/${b.id}/reject`);
    expect(await follow(session, reject)).toContain('Rejected b@example.com.');
    expect(await getUser(env.DB, a.id)).toMatchObject({ status: 'active', role: 'access_manager' });
    expect((await getUser(env.DB, b.id))?.status).toBe('suspended');
    expect(await auditActions()).toEqual(['user.approve', 'user.reject']);
  });

  it('approve without a role, or of someone decided meanwhile, is refused', async () => {
    const session = await sessionFor('owner');
    const pending = await pendingUser();
    expect((await adminPost(app, session, `/admin/users/${pending.id}/approve`)).status).toBe(400);
    await adminPost(app, session, `/admin/users/${pending.id}/reject`);
    const late = await adminPost(app, session, `/admin/users/${pending.id}/approve`, {
      role: 'viewer',
    });
    expect(late.status).toBe(409);
    expect(await late.text()).toContain(
      'wait@example.com was already approved or rejected (now Suspended).',
    );
  });

  it('end to end: an expired invitee tries, the owner renews, the invitee gets in', async () => {
    const invitee = await createUser(
      {
        email: 'late@example.com',
        role: 'token_manager',
        status: 'invited',
        inviteExpiresAt: T0 - 1,
      },
      T0 - 10,
    );
    const access = await testAccess();
    const jwt = await access.sign({ sub: 'late-sub', email: 'late@example.com' }, { now: T0 });
    const signIn = () => app.request('/admin/users', { headers: { [ACCESS_JWT_HEADER]: jwt } });
    const refused = await signIn();
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain(
      'Your invitation expired. Owners can see that you tried.',
    );
    expect(await countNeedsDecision(env.DB, T0)).toBe(1);

    const session = await sessionFor('owner');
    const decide = slice(
      await page(session),
      '<section class="tray tone-warn" id="decide"',
      '</section>',
    );
    expect(decide).toContain(
      'late@example.com tried to sign in just now, but the invitation expired',
    );
    expect(decide).toContain(`action="/admin/users/${invitee.id}/resend-invite"`);
    const renew = await adminPost(app, session, `/admin/users/${invitee.id}/resend-invite`);
    expect(renew.status).toBe(303);
    expect(await countNeedsDecision(env.DB, T0)).toBe(0);

    expect((await signIn()).status).toBe(200);
    expect(await getUser(env.DB, invitee.id)).toMatchObject({
      status: 'active',
      role: 'token_manager',
    });
  });

  it('a deliberately suspended user who tried is not queued; their row says they tried', async () => {
    const user = await linked('s@example.com', { status: 'suspended' });
    await refusedAt(user.id, T0 - 60_000);
    expect(await countNeedsDecision(env.DB, T0)).toBe(0);
    const html = await page(await sessionFor('owner'));
    expect(html).not.toContain('id="decide"');
    expect(slice(html, `id="user-${user.id}"`, '</tr>')).toContain(
      '<span class="meta">tried 1 min ago</span>',
    );
  });

  it('a different sign-in account card offers Reset sign-in… and Dismiss removes it', async () => {
    const user = await linked('d@example.com');
    await refusedAt(user.id, T0 - 60_000);
    const session = await sessionFor('owner');
    const decide = slice(
      await page(session),
      '<section class="tray tone-warn" id="decide"',
      '</section>',
    );
    expect(decide).toContain(
      'with a different sign-in account (Access user ID <code>…1234</code>)',
    );
    expect(decide).toContain(`commandfor="dlg-card-reset-${user.id}"`);
    expect(decide).not.toContain('cloudflareaccess.com');
    const dismiss = await adminPost(app, session, `/admin/users/${user.id}/dismiss-attempt`, {
      expected_refused_at: String(T0 - 60_000),
    });
    const html = await follow(session, dismiss);
    expect(html).toContain('Dismissed the refused sign-in of d@example.com.');
    expect(html).not.toContain('id="decide"');
    expect(await auditActions()).toEqual(['user.dismiss_attempt']);
  });

  it('a stale Dismiss keeps a newer attempt (409)', async () => {
    const user = await linked('d@example.com');
    await refusedAt(user.id, T0 - 30_000);
    const res = await adminPost(
      app,
      await sessionFor('owner'),
      `/admin/users/${user.id}/dismiss-attempt`,
      {
        expected_refused_at: String(T0 - 60_000),
      },
    );
    expect(res.status).toBe(409);
    expect((await getUser(env.DB, user.id))?.last_refused_at).toBe(T0 - 30_000);
    // The error is at the card's Dismiss, and the summary links to it.
    const html = await res.text();
    expect(html).toContain(`<a href="#f-dismiss-${user.id}">`);
    expect(slice(html, `id="decide-${user.id}-h"`, '</li>')).toContain(`id="f-dismiss-${user.id}"`);
    expect(html).not.toContain(`id="f-user-${user.id}"`);
  });
});
