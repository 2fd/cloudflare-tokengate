// Users › People › Person (`/admin/users/:id`): status, the same controls as the People row (open),
// the refused sign-in, sign-in accounts without the Access team domain (I-CFG-1), what the person
// changed and the history of the account.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerUsersRoutes } from '../../src/admin/routes/users';
import type { User } from '../../src/db/types';
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
const TEAM = 'https://acme-team.cloudflareaccess.com';

let app: AdminTestApp;
let owner: User;
let session: AdminSession;

beforeEach(async () => {
  await resetControlPlane();
  app = createAdminTestApp({ routes: registerUsersRoutes, now: () => T0 });
  owner = await createUser({ email: 'owner@example.com', role: 'owner' }, T0);
  session = await loginAs(app, owner);
});

async function page(path: string, as = session): Promise<string> {
  const res = await adminGet(app, as, path);
  expect(res.status, path).toBe(200);
  return res.text();
}

describe('GET /admin/users/:id', () => {
  it('shows the sign-in accounts with the Access user ID only, never the team domain', async () => {
    const person = await createUser(
      {
        email: 'alex@acme.com',
        name: 'Alex',
        role: 'access_manager',
        identity: { loginProvider: 'access', subject: `${TEAM}|7f3e-a1b2` },
      },
      T0 - 86_400_000,
    );
    const html = await page(`/admin/users/${person.id}`);
    expect(html).toContain('<title>alex@acme.com – Settings – tokengate</title>');
    // The identity H1 holds the status badge; it is the only H1.
    expect(html).toContain('<h1>alex@acme.com <span class="badge ok">');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('<nav class="crumbs" aria-label="Breadcrumb">');
    expect(html.match(/aria-label="Breadcrumb"/g)).toHaveLength(1);
    expect(html).toContain('<span class="idchip" title="Access user ID">7f3e-a1b2</span>');
    expect(html).not.toContain('acme-team');
    expect(html).toContain('Access manager');
    // The row controls, shown open (not inside a disclosure).
    expect(html).toContain(`id="role-${person.id}"`);
    expect(html).not.toContain('name="person-actions"');
    expect(html).toContain('name="_return" value="detail"');
  });

  it('changes a role with one card; Owner and the danger actions confirm in dialogs', async () => {
    const person = await createUser(
      {
        email: 'tom@acme.com',
        name: 'Tom Becker',
        role: 'access_manager',
        identity: { loginProvider: 'access', subject: `${TEAM}|a1b2c3` },
      },
      T0 - 86_400_000,
    );
    const html = await page(`/admin/users/${person.id}`);
    expect(html).toContain(
      '<p class="relline">Tom can add and change the credential access rules of every credential',
    );
    const form = html.slice(
      html.indexOf(`id="role-${person.id}"`),
      html.indexOf('</form>', html.indexOf(`id="role-${person.id}"`)),
    );
    expect(form).toContain(`name="expected_updated_at" value="${person.updated_at}"`);
    expect(form).toContain('<legend>Make Tom</legend>');
    expect(form).toContain('type="submit" name="role" value="token_manager"');
    expect(form).toContain(
      '<span class="gain">+ credentials</span> · <span class="lose">− access rules</span>',
    );
    // Owner is a card that opens a dialog; the dialog posts the change on its own form.
    expect(form).toContain(`commandfor="dlg-owner-${person.id}"`);
    expect(form).not.toContain('value="owner"');
    const owner = html.slice(html.indexOf(`id="dlg-owner-${person.id}"`));
    expect(owner.slice(0, owner.indexOf('</dialog>'))).toContain(
      '<input type="hidden" name="role" value="owner"/>',
    );
    // Account access: Suspend posts directly (Undo follows), Reset sign-in confirms.
    const danger = html.slice(html.indexOf('id="access-h"'));
    expect(danger).toContain('Stop Tom from using the console.');
    expect(danger).toContain('name="status" value="suspended"');
    expect(danger).toContain(`commandfor="dlg-reset-${person.id}"`);
    const reset = danger.slice(danger.indexOf(`id="dlg-reset-${person.id}"`));
    expect(reset.slice(0, reset.indexOf('</dialog>'))).toContain('name="confirm" value="1"');
    expect(reset).toContain('Access user <code>a1b2c3</code> is unlinked.');
    expect(html).not.toContain('acme-team');
    // The rail lists what the role can and cannot do.
    expect(html).toContain('<span class="vh">No: </span>Download the configuration export');
  });

  it('lists the last changes the person made, newest first', async () => {
    const other = await createUser(
      { email: 'b@example.com', identity: { loginProvider: 'access', subject: 'team|b' } },
      T0 - 1000,
    );
    await adminPost(app, session, `/admin/users/${other.id}`, { role: 'viewer' });
    const html = await page(`/admin/users/${owner.id}`);
    const changes = html.slice(html.indexOf('id="changes-h"'), html.indexOf('id="accounts-h"'));
    expect(changes).toContain('Changed role Admin → Viewer of b@example.com');
    expect(changes).toContain('<p class="meta">Changed a person</p>');
    // The person's own sign-in (bootstrap/link) is not a change.
    expect(changes).not.toContain('user.link');
  });

  it('lists what the person changed per category, and the history of the account', async () => {
    const other = await createUser(
      { email: 'b@example.com', identity: { loginProvider: 'access', subject: 'team|b' } },
      T0 - 1000,
    );
    await adminPost(app, session, `/admin/users/${other.id}`, { role: 'viewer' });
    await adminPost(app, session, '/admin/users', { email: 'c@example.com', role: 'viewer' });
    const self = await page(`/admin/users/${owner.id}`);
    expect(self).toContain(`href="/admin/audit?actor=${owner.id}&amp;category=users">2 people</a>`);
    expect(self).toContain(`All changes by owner@example.com`);
    expect(self).toContain('This is you. Another owner can change your account.');
    expect(self).not.toContain(`id="role-${owner.id}"`);

    const html = await page(`/admin/users/${other.id}`);
    const history = html.slice(html.indexOf('id="history-h"'));
    // The actor starts the sentence: "owner@example.com changed role …".
    expect(history).toContain(
      'owner@example.com</a></b> changed role Admin → Viewer of b@example.com',
    );
    expect(history).toContain(`href="/admin/audit?target=${other.id}"`);
    expect(html).toContain('No changes in the last 30 days.');
  });

  it('shows a refused sign-in with Dismiss, and "Never signed in." without accounts', async () => {
    const invited = await createUser(
      { email: 'late@example.com', status: 'invited', inviteExpiresAt: T0 - 1 },
      T0 - 10_000,
    );
    await env.DB.prepare(
      'UPDATE users SET last_refused_at = ?, last_refused_subject = ? WHERE id = ?',
    )
      .bind(T0 - 120_000, `${TEAM}|9c9c`, invited.id)
      .run();
    const html = await page(`/admin/users/${invited.id}`);
    expect(html).toContain('Last refused sign-in 2 min ago');
    expect(html).toContain('with Access user ID <code>9c9c</code>');
    expect(html).toContain(`action="/admin/users/${invited.id}/dismiss-attempt"`);
    expect(html).toContain('Never signed in.');
    expect(html).toContain('Renew invitation');
    expect(html).not.toContain('acme-team');
  });

  it('shows a viewer the page without controls', async () => {
    const viewer = await loginAs(
      app,
      await createUser({ email: 'v@example.com', role: 'viewer' }, T0),
    );
    const html = await page(`/admin/users/${owner.id}`, viewer);
    expect(html.slice(html.indexOf('<main'), html.indexOf('</main>'))).not.toMatch(
      /<form\b[^>]*\bmethod="post"/,
    );
  });

  it('a failed action re-renders the Person page with the error', async () => {
    const person = await createUser(
      { email: 'p@example.com', identity: { loginProvider: 'access', subject: 'team|p' } },
      T0 - 1000,
    );
    const res = await adminPost(app, session, `/admin/users/${person.id}`, {
      role: 'viewer',
      expected_updated_at: '1',
      _return: 'detail',
    });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('<title>Error: p@example.com – Settings – tokengate</title>');
    expect(html).toContain(`<a href="#f-user-${person.id}">`);
  });

  it('a pending person gets the approve decision, not the role controls', async () => {
    const pending = await createUser(
      {
        email: 'wait@example.com',
        status: 'pending',
        identity: { loginProvider: 'access', subject: `${TEAM}|w1` },
      },
      T0 - 1000,
    );
    const html = await page(`/admin/users/${pending.id}`);
    expect(html).toContain(`action="/admin/users/${pending.id}/approve"`);
    expect(html).toContain(`action="/admin/users/${pending.id}/reject"`);
    expect(html).not.toContain(`id="role-${pending.id}"`);

    const res = await adminPost(app, session, `/admin/users/${pending.id}`, {
      status: 'active',
      _return: 'detail',
    });
    expect(res.status).toBe(400);
    const failed = await res.text();
    expect(failed).toContain('is waiting for approval.');
    // No "Change" controls here, so the summary item links nowhere rather than to a missing id.
    expect(failed).not.toContain(`href="#f-user-${pending.id}"`);
  });

  it('a confirmed Reset sign-in never decides a pending person', async () => {
    const pending = await createUser(
      {
        email: 'wait@example.com',
        status: 'pending',
        identity: { loginProvider: 'access', subject: `${TEAM}|w1` },
      },
      T0 - 1000,
    );
    const res = await adminPost(app, session, `/admin/users/${pending.id}/reset-login`, {
      confirm: '1',
      expected_updated_at: String(pending.updated_at),
      _return: 'detail',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('is waiting for approval.');
    const after = await env.DB.prepare(
      'SELECT u.status, (SELECT COUNT(*) FROM user_identities i WHERE i.user_id = u.id) AS ids FROM users u WHERE u.id = ?',
    )
      .bind(pending.id)
      .first<{ status: string; ids: number }>();
    expect(after).toEqual({ status: 'pending', ids: 1 });
  });

  it('a stale Dismiss of a pending person shows the error at the Dismiss button', async () => {
    const pending = await createUser(
      {
        email: 'wait@example.com',
        status: 'pending',
        identity: { loginProvider: 'access', subject: `${TEAM}|w1` },
      },
      T0 - 3_600_000,
    );
    await env.DB.prepare(
      'UPDATE users SET last_refused_at = ?, last_refused_subject = ? WHERE id = ?',
    )
      .bind(T0 - 30_000, `${TEAM}|w1`, pending.id)
      .run();
    const res = await adminPost(app, session, `/admin/users/${pending.id}/dismiss-attempt`, {
      expected_refused_at: String(T0 - 60_000),
      _return: 'detail',
    });
    expect(res.status).toBe(409);
    const html = await res.text();
    const href = /<div class="callout bad errsum"[\s\S]*?<a href="#([^"]+)">/.exec(html)?.[1];
    expect(href).toBe(`f-dismiss-${pending.id}`);
    const refused = html.slice(html.indexOf('id="refused-h"'));
    expect(refused).toContain(`id="f-dismiss-${pending.id}"`);
  });

  it('is 404 for an unknown id', async () => {
    const res = await adminGet(app, session, '/admin/users/usr_nope');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('There is no user with this ID.');
  });
});
