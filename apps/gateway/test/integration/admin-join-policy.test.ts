// Settings › Members (`/admin/users`): the join policy (users:write, I-LINK-1), the login provider
// status, names and states only (I-CFG-1), and Settings › FAQ (`/admin/faq`).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerFaqRoutes } from '../../src/admin/routes/faq';
import { registerUsersRoutes } from '../../src/admin/routes/users';
import type { App } from '../../src/app';
import { getJoinDefaults } from '../../src/db/settings';
import type { Role } from '../../src/db/types';
import {
  type AdminSession,
  type AdminTestApp,
  adminGet,
  adminPost,
  createAdminTestApp,
  createUser,
  loginAs,
  resetControlPlane,
  TEST_ACCESS_ENV,
} from '../helpers/admin-auth';

const T0 = Date.UTC(2026, 9, 13, 12);
const POLICY = '/admin/users/join-policy';

let app: AdminTestApp;

beforeEach(async () => {
  await resetControlPlane();
  app = createAdminTestApp({
    routes: (a: App) => {
      registerFaqRoutes(a);
      registerUsersRoutes(a);
    },
    now: () => T0,
  });
});

async function sessionFor(role: Role): Promise<AdminSession> {
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
  expect(res.status).toBe(200);
  return res.text();
}

describe('GET /admin/users: default access', () => {
  it.each(['viewer', 'token_manager', 'access_manager', 'admin'] as const)(
    'shows a %s the policy, with no way to change it',
    async (role) => {
      const html = await page(await sessionFor(role));
      expect(html).toContain('<title>Members – Settings – tokengate</title>');
      expect(html).toContain('New people who sign in: <b>Let them in as Viewer</b>.');
      expect(html).not.toContain('dlg-policy');
      expect(html).not.toContain(POLICY);
    },
  );

  it('gives owners a Default access button next to Invite, opening six options', async () => {
    const html = await page(await sessionFor('owner'));
    const actions = html.slice(html.indexOf('<div class="ph-actions">'));
    expect(actions.slice(0, actions.indexOf('</div>'))).toMatch(
      /command="show-modal" commandfor="dlg-policy"[^>]*>Default access….*Invite someone/s,
    );
    const start = html.indexOf('<dialog class="dlg wide" id="dlg-policy"');
    expect(start).toBeGreaterThan(-1);
    const form = html.slice(start, html.indexOf('</dialog>', start));
    expect(form).toContain(`<form method="post" action="${POLICY}">`);
    expect(form).toContain('name="_csrf"');
    for (const value of ['pending', 'closed']) {
      expect(form).toContain(`type="submit" name="join_policy" value="${value}"`);
    }
    // The current policy is a plain card: choosing it again would change nothing.
    expect(form).not.toContain('value="active:viewer"');
    expect(form).toMatch(
      /<div class="rc is-current" aria-current="true"><span class="rc-b"><span class="rc-t">Let them in as Viewer <span class="badge accent"><span aria-hidden="true">✓<\/span>Current<\/span>/,
    );
    for (const value of ['active:token_manager', 'active:access_manager', 'active:admin']) {
      const id = `dlg-policy-${value.replace(':', '-')}`;
      expect(form).toContain(
        `<button class="rc risk" type="button" command="show-modal" commandfor="${id}"`,
      );
      expect(form).not.toContain(`value="${value}"`);
      // The confirm is a sibling dialog with its own form, never nested in the policy form.
      const at = html.indexOf(`<dialog class="dlg" id="${id}"`);
      expect(at).toBeGreaterThan(html.indexOf('</dialog>', start));
      const dialog = html.slice(at, html.indexOf('</dialog>', at));
      expect(dialog).toContain(
        `<input type="hidden" name="confirmed_join_policy" value="${value}"/>`,
      );
      expect(dialog).not.toContain('name="join_policy"');
    }
  });

  it('names the login provider and its variables, never their values (I-CFG-1)', async () => {
    const html = await page(await sessionFor('viewer'));
    expect(html).toContain('id="login"');
    expect(html).toContain(
      '<dt>Cloudflare Access</dt><dd><div class="line"><span class="badge ok"><span aria-hidden="true">✓</span>In use</span></div></dd>',
    );
    expect(html).toContain(
      '<dt>Local development login</dt><dd><div class="line"><span class="badge off"><span aria-hidden="true">⏸</span>Off</span></div></dd>',
    );
    for (const anchor of ['faq-authentication', 'faq-revoke-session']) {
      expect(html).toContain(`href="/admin/faq#${anchor}"`);
    }
    expect(html).not.toContain(TEST_ACCESS_ENV.AUTH_ACCESS_AUD);
    expect(html).not.toContain(`${TEST_ACCESS_ENV.AUTH_ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`);
  });
});

describe('GET /admin/faq', () => {
  it('answers the hostname, authentication and session questions for every role', async () => {
    const html = await page(await sessionFor('viewer'), '/admin/faq');
    expect(html).toContain('<title>FAQ – Settings – tokengate</title>');
    for (const anchor of ['faq-hostnames', 'faq-authentication', 'faq-revoke-session']) {
      expect(html).toContain(`id="${anchor}"`);
    }
    expect(html).toContain('Every hostname you route to this Worker, over HTTPS.');
    expect(html).toContain('every person needs Reset sign-in before they can sign in again');
    expect(html).toContain('href="https://one.dash.cloudflare.com/"');
    expect(html).not.toContain(TEST_ACCESS_ENV.AUTH_ACCESS_AUD);
  });
});

describe('I-LINK-1: POST /admin/users/join-policy', () => {
  it('saves one value with one audit row; the same value again is unchanged', async () => {
    const owner = await sessionFor('owner');
    const res = await adminPost(app, owner, POLICY, {
      confirmed_join_policy: 'active:access_manager',
    });
    expect(res.headers.get('location')).toMatch(
      /^\/admin\/users\?notice=policy_saved&done=aud_[0-9A-Z]{26}$/,
    );
    expect(await getJoinDefaults(env.DB)).toEqual({ role: 'access_manager', status: 'active' });
    const html = await (await adminGet(app, owner, res.headers.get('location') ?? '')).text();
    expect(html).toContain('Saved. New people who sign in: Let them in as Access manager.');
    const again = await adminPost(app, owner, POLICY, {
      confirmed_join_policy: 'active:access_manager',
    });
    expect(again.headers.get('location')).toBe('/admin/users?notice=policy_unchanged');
    expect(await auditActions()).toEqual(['user.join_defaults']);
  });

  it.each(['pending', 'closed'] as const)('%s stores the role viewer', async (policy) => {
    const res = await adminPost(app, await sessionFor('owner'), POLICY, { join_policy: policy });
    expect(res.status).toBe(303);
    expect(await getJoinDefaults(env.DB)).toEqual({
      role: 'viewer',
      status: policy === 'pending' ? 'pending' : 'suspended',
    });
  });

  it.each<Record<string, string | string[]>>([
    { join_policy: 'active:owner' },
    { join_policy: 'admin' },
    { join_policy: ['pending', 'closed'] },
    {},
  ])('rejects %j', async (fields) => {
    const res = await adminPost(app, await sessionFor('owner'), POLICY, fields);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('<a href="#f-join_policy">Choose one of the listed options.</a>');
    expect(html).toMatch(
      /<fieldset class="field" id="f-join_policy" aria-describedby="f-join_policy-error"><legend><span class="vh">New people who sign in<\/span><\/legend><p class="field-error" id="f-join_policy-error"><span aria-hidden="true">✕<\/span><span class="vh">Error:<\/span> Choose one of the listed options.<\/p>/,
    );
    // The options sit open in the page, next to the error, not in a closed modal.
    expect(html).toMatch(/<dialog class="dlg wide" id="dlg-policy"[^>]* open="">/);
    expect(html.match(/id="dlg-policy"/g)).toHaveLength(1);
    expect(await getJoinDefaults(env.DB)).toEqual({ role: 'viewer', status: 'active' });
  });

  it.each(['active:token_manager', 'active:access_manager', 'active:admin'])(
    'accepts the elevated %s only from its dialog',
    async (policy) => {
      const owner = await sessionFor('owner');
      const res = await adminPost(app, owner, POLICY, { join_policy: policy });
      expect(res.status).toBe(422);
      expect(await res.text()).toMatch(
        /<a href="#f-join_policy">Confirm in the dialog: Let them in as [^<]+\.<\/a>/,
      );
      expect(await getJoinDefaults(env.DB)).toEqual({ role: 'viewer', status: 'active' });
      const confirmed = await adminPost(app, owner, POLICY, { confirmed_join_policy: policy });
      expect(confirmed.status).toBe(303);
      expect((await getJoinDefaults(env.DB)).role).toBe(policy.slice('active:'.length));
    },
  );

  it('is forbidden for admins', async () => {
    const res = await adminPost(app, await sessionFor('admin'), POLICY, {
      join_policy: 'active:admin',
    });
    expect(res.status).toBe(403);
    expect(await getJoinDefaults(env.DB)).toEqual({ role: 'viewer', status: 'active' });
  });
});

describe('the Sign-in page is gone', () => {
  it('no longer accepts the old policy route', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/users/sign-in/policy', {
      join_policy: 'pending',
    });
    // RBAC denies a route it does not list (fail closed).
    expect(res.status).toBe(403);
    expect(await getJoinDefaults(env.DB)).toEqual({ role: 'viewer', status: 'active' });
  });
});
