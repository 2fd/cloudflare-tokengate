// Users › Sign-in (`/admin/users/sign-in`): the console address, the join policy (users:write,
// I-LINK-1), the admin hosts the console answers on (settings:write, one host per submit,
// I-DEPLOY-1) and the login provider status, names and states only (I-CFG-1).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerSignInRoutes } from '../../src/admin/routes/sign-in';
import { ADMIN_HOST_PATTERN } from '../../src/admin/routes/sign-in';
import { getAdminHosts, getJoinDefaults, putSettingStatement } from '../../src/db/settings';
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

let app: AdminTestApp;

beforeEach(async () => {
  await resetControlPlane();
  app = createAdminTestApp({ routes: registerSignInRoutes, now: () => T0 });
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

/** Pins the stored list (the first sign-in normally does this). */
async function storeHosts(hosts: string[] | null): Promise<void> {
  if (hosts === null) {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'admin_hosts'").run();
    return;
  }
  await env.DB.batch([putSettingStatement(env.DB, 'admin_hosts', hosts, T0, null)]);
}

async function page(session: AdminSession): Promise<string> {
  const res = await adminGet(app, session, '/admin/users/sign-in');
  expect(res.status).toBe(200);
  return res.text();
}

describe('GET /admin/users/sign-in', () => {
  it.each(['viewer', 'token_manager', 'access_manager', 'admin'] as const)(
    'is read-only for a %s',
    async (role) => {
      await storeHosts(['gw.test']);
      const html = await page(await sessionFor(role));
      expect(html).toContain('<title>Sign-in – Users – tokengate</title>');
      expect(html).toContain('aria-label="Console address">https://gw.test/admin</pre>');
      expect(html).toContain(
        '<p class="u-now"><span class="muted">Now</span><span class="big">Let them in as Viewer</span>',
      );
      expect(html).toContain(
        '<span class="mono">gw.test</span> <span class="badge accent">you are here</span>',
      );
      // Nothing to open: the policy dialogs are for owners only.
      expect(html).not.toContain('dlg-policy');
      // The account menu export form (admins) is in the sidebar, not part of this page.
      expect(html.slice(html.indexOf('<main'), html.indexOf('</main>'))).not.toMatch(
        /<form\b[^>]*\bmethod="post"/,
      );
      expect(html).toContain('class="ask"');
    },
  );

  it('shows owners six policy options; the three elevated ones are dialogs', async () => {
    const html = await page(await sessionFor('owner'));
    expect(html).toContain(
      '<button class="btn sm secondary" type="button" command="show-modal" commandfor="dlg-policy"',
    );
    const start = html.indexOf('<dialog class="dlg wide" id="dlg-policy"');
    expect(start).toBeGreaterThan(-1);
    const form = html.slice(start, html.indexOf('</dialog>', start));
    expect(form).toContain('<form method="post" action="/admin/users/sign-in/policy">');
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
    expect(html).toContain('Anyone Access admits can let a consumer use any service token.');
  });

  it('explains the pending policy and links the people waiting', async () => {
    await createUser(
      {
        email: 'wait@example.com',
        status: 'pending',
        identity: { loginProvider: 'access', subject: 't|w' },
      },
      T0,
    );
    const owner = await sessionFor('owner');
    await adminPost(app, owner, '/admin/users/sign-in/policy', { join_policy: 'pending' });
    const html = await page(owner);
    expect(html).toContain('<span class="big">Ask an owner first</span>');
    expect(html).toContain('<ol class="trace u-c3" aria-label="What happens now">');
    expect(html).toContain(
      '<li class="tstep is-on"><span class="s">2 · Waits</span><span class="v">In “Needs your decision”</span><span class="d"><a href="/admin/users#decide">1 person waiting: wait@example.com</a></span></li>',
    );
  });

  it('names the login provider and its variables, never their values (I-CFG-1)', async () => {
    const html = await page(await sessionFor('owner'));
    expect(html).toContain(
      '<dt>Cloudflare Access</dt><dd><div class="line"><span class="badge ok"><span aria-hidden="true">✓</span>In use</span><span class="muted">You signed in with it.</span></div></dd>',
    );
    expect(html).toContain(
      '<dt>Local development login</dt><dd><div class="line"><span class="badge off"><span aria-hidden="true">⏸</span>Off</span></div></dd>',
    );
    expect(html).toContain('every person needs Reset sign-in before they can sign in again');
    expect(html).toContain('href="https://one.dash.cloudflare.com/"');
    expect(html).not.toContain(TEST_ACCESS_ENV.AUTH_ACCESS_AUD);
    expect(html).not.toContain(`${TEST_ACCESS_ENV.AUTH_ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`);
  });

  it('offers the one-click pin while no admin host is set', async () => {
    await storeHosts(null);
    const html = await page(await sessionFor('owner'));
    expect(html).toContain('Not pinned: the console answers on every hostname');
    expect(html).toContain('name="add" value="gw.test"');
    expect(html).toContain('Answer only on gw.test');
  });

  it('offers Remove… only where the rest still covers the host in use', async () => {
    const owner = await sessionFor('owner');
    await storeHosts(['gw.test']);
    const one = await page(owner);
    expect(one).not.toContain('name="remove"');
    // The note sits on the row of the host it is about.
    expect(one).toContain(
      '<span class="badge accent">you are here</span></span><span class="hint">Covers this host, so it cannot be removed.</span>',
    );
    expect(one).toContain('<p class="hint">Only this hostname is listed.</p>');
    expect(one).not.toContain('dlg-host-');

    await storeHosts(['gw.test', 'old.example.com']);
    const two = await page(owner);
    expect(two).toContain('name="remove" value="old.example.com"');
    expect(two).not.toContain('name="remove" value="gw.test"');
    expect(two).toContain('People who use old.example.com lose the console at once.');

    // Either entry can go while the other still covers the host in use; the last one cannot.
    const at = async () => {
      const res = await app.request('/admin/users/sign-in', {
        origin: 'https://admin.acme.com',
        headers: owner.headers,
      });
      expect(res.status).toBe(200);
      return res.text();
    };
    await storeHosts(['admin.acme.com', '*.acme.com']);
    const wild = await at();
    expect(wild).toContain('name="remove" value="admin.acme.com"');
    expect(wild).toContain('name="remove" value="*.acme.com"');
    expect(wild).toContain(
      '<span class="mono">*.acme.com</span> <span class="badge accent">you are here</span>',
    );
    await storeHosts(['*.acme.com']);
    expect(await at()).not.toContain('name="remove"');
  });

  it('the add field pattern compiles with the v flag and accepts a pasted URL', async () => {
    const html = await page(await sessionFor('owner'));
    expect(html).toContain('placeholder="admin.example.com"');
    const pattern = new RegExp(`^(?:${ADMIN_HOST_PATTERN})$`, 'v');
    for (const ok of [
      'admin.acme.com',
      '*.acme.com',
      'https://Admin.acme.com:8443/x',
      'localhost',
    ]) {
      expect(pattern.test(ok), ok).toBe(true);
    }
    expect(pattern.test('not a host')).toBe(false);
  });
});

describe('I-DEPLOY-1: POST /admin/users/sign-in/hosts', () => {
  it('adds a host to the current host when none is stored, with one audit row', async () => {
    const owner = await sessionFor('owner');
    await storeHosts(null);
    const save = await adminPost(app, owner, '/admin/users/sign-in/hosts', {
      add: '*.Admin.example.com',
    });
    expect(save.headers.get('location')).toMatch(
      /^\/admin\/users\/sign-in\?notice=hosts_saved&done=aud_[0-9A-Z]{26}#hosts$/,
    );
    expect(await getAdminHosts(env.DB)).toEqual(['gw.test', '*.admin.example.com']);
    expect(await auditActions()).toEqual(['settings.admin_hosts']);
    const html = await (await adminGet(app, owner, save.headers.get('location') ?? '')).text();
    expect(html).toContain('Saved: Admin host *.admin.example.com added (2 entries).');
  });

  it('pins the console to the current host in one submit', async () => {
    await storeHosts(null);
    const save = await adminPost(app, await sessionFor('owner'), '/admin/users/sign-in/hosts', {
      add: 'gw.test',
    });
    expect(save.status).toBe(303);
    expect(await getAdminHosts(env.DB)).toEqual(['gw.test']);
  });

  it('reduces a pasted URL to its hostname', async () => {
    await storeHosts(['gw.test']);
    const save = await adminPost(app, await sessionFor('owner'), '/admin/users/sign-in/hosts', {
      add: 'https://Other.Example.com:8443/admin/?x=1',
    });
    expect(save.status).toBe(303);
    expect(await getAdminHosts(env.DB)).toEqual(['gw.test', 'other.example.com']);
  });

  it('removes a host, and reports listed or absent hosts without an audit row', async () => {
    const owner = await sessionFor('owner');
    await storeHosts(['gw.test', 'old.example.com']);
    const remove = await adminPost(app, owner, '/admin/users/sign-in/hosts', {
      remove: 'old.example.com',
      confirm: '1',
    });
    expect(remove.status).toBe(303);
    expect(await getAdminHosts(env.DB)).toEqual(['gw.test']);
    const again = await adminPost(app, owner, '/admin/users/sign-in/hosts', { add: 'gw.test' });
    expect(again.headers.get('location')).toBe('/admin/users/sign-in?notice=host_present#hosts');
    const gone = await adminPost(app, owner, '/admin/users/sign-in/hosts', {
      remove: 'old.example.com',
      confirm: '1',
    });
    expect(gone.headers.get('location')).toBe('/admin/users/sign-in?notice=host_absent#hosts');
    expect(await auditActions()).toEqual(['settings.admin_hosts']);
  });

  it('removing a host needs the dialog confirmation (lockout risk)', async () => {
    await storeHosts(['gw.test', 'old.example.com']);
    const res = await adminPost(app, await sessionFor('owner'), '/admin/users/sign-in/hosts', {
      remove: 'old.example.com',
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Confirm removing old.example.com in the dialog.');
    expect(await getAdminHosts(env.DB)).toEqual(['gw.test', 'old.example.com']);
    expect(await auditActions()).toEqual([]);
  });

  const stored = ['gw.test', 'other.example.com'];
  it.each([
    ['removing the current host', { remove: 'gw.test', confirm: '1' }],
    ['a workers.dev entry', { add: 'tokengate.acme.workers.dev' }],
    ['no host', { add: ' ' }],
    ['both add and remove', { add: 'a.example.com', remove: 'other.example.com', confirm: '1' }],
  ])('refuses %s and keeps the previous list', async (_, fields) => {
    await storeHosts(stored);
    const res = await adminPost(
      app,
      await sessionFor('owner'),
      '/admin/users/sign-in/hosts',
      fields,
    );
    expect(res.status).toBe(400);
    expect(await getAdminHosts(env.DB)).toEqual(stored);
    expect(await auditActions()).toEqual([]);
  });

  it('re-renders an invalid host with the error at the field', async () => {
    await storeHosts(stored);
    const res = await adminPost(app, await sessionFor('owner'), '/admin/users/sign-in/hosts', {
      add: 'tokengate.acme.workers.dev',
    });
    const html = await res.text();
    expect(html).toContain('<a href="#f-add">Enter a hostname like admin.acme.com or *.acme.com.');
    expect(html).toContain('value="tokengate.acme.workers.dev"');
    expect(html).toMatch(/id="f-add"[^>]*aria-invalid="true"/);
  });

  it('is forbidden for admins', async () => {
    const res = await adminPost(app, await sessionFor('admin'), '/admin/users/sign-in/hosts', {
      add: 'gw.test',
    });
    expect(res.status).toBe(403);
    expect(await getAdminHosts(env.DB)).toBeNull();
  });
});

describe('I-LINK-1: POST /admin/users/sign-in/policy', () => {
  it('saves one value with one audit row; the same value again is unchanged', async () => {
    const owner = await sessionFor('owner');
    const res = await adminPost(app, owner, '/admin/users/sign-in/policy', {
      confirmed_join_policy: 'active:access_manager',
    });
    expect(res.headers.get('location')).toMatch(
      /^\/admin\/users\/sign-in\?notice=policy_saved&done=aud_[0-9A-Z]{26}#policy$/,
    );
    expect(await getJoinDefaults(env.DB)).toEqual({ role: 'access_manager', status: 'active' });
    const html = await (await adminGet(app, owner, res.headers.get('location') ?? '')).text();
    expect(html).toContain('Saved. New people who sign in: Let them in as Access manager.');
    const again = await adminPost(app, owner, '/admin/users/sign-in/policy', {
      confirmed_join_policy: 'active:access_manager',
    });
    expect(again.headers.get('location')).toBe(
      '/admin/users/sign-in?notice=policy_unchanged#policy',
    );
    expect(await auditActions()).toEqual(['user.join_defaults']);
  });

  it.each(['pending', 'closed'] as const)('%s stores the role viewer', async (policy) => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/users/sign-in/policy', {
      join_policy: policy,
    });
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
    const res = await adminPost(
      app,
      await sessionFor('owner'),
      '/admin/users/sign-in/policy',
      fields,
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('<a href="#f-join_policy">Choose one of the listed options.</a>');
    expect(html).toMatch(
      /<fieldset class="field" id="f-join_policy" aria-describedby="f-join_policy-error"><legend><span class="vh">New people who sign in<\/span><\/legend><p class="field-error" id="f-join_policy-error"><span aria-hidden="true">✕<\/span><span class="vh">Error:<\/span> Choose one of the listed options.<\/p>/,
    );
    // The options sit open in the policy tray, next to the error, not in a closed modal.
    const policy = html.slice(html.indexOf('id="policy"'), html.indexOf('id="address"'));
    expect(policy).toContain('<dialog class="dlg wide" id="dlg-policy"');
    expect(policy).toMatch(/<dialog class="dlg wide" id="dlg-policy"[^>]* open="">/);
    expect(html.match(/id="dlg-policy"/g)).toHaveLength(1);
    expect(await getJoinDefaults(env.DB)).toEqual({ role: 'viewer', status: 'active' });
  });

  it.each(['active:token_manager', 'active:access_manager', 'active:admin'])(
    'accepts the elevated %s only from its dialog',
    async (policy) => {
      const owner = await sessionFor('owner');
      const res = await adminPost(app, owner, '/admin/users/sign-in/policy', {
        join_policy: policy,
      });
      expect(res.status).toBe(422);
      expect(await res.text()).toMatch(
        /<a href="#f-join_policy">Confirm in the dialog: Let them in as [^<]+\.<\/a>/,
      );
      expect(await getJoinDefaults(env.DB)).toEqual({ role: 'viewer', status: 'active' });
      const confirmed = await adminPost(app, owner, '/admin/users/sign-in/policy', {
        confirmed_join_policy: policy,
      });
      expect(confirmed.status).toBe(303);
      expect((await getJoinDefaults(env.DB)).role).toBe(policy.slice('active:'.length));
    },
  );

  it('is forbidden for admins', async () => {
    const res = await adminPost(app, await sessionFor('admin'), '/admin/users/sign-in/policy', {
      join_policy: 'active:admin',
    });
    expect(res.status).toBe(403);
    expect(await getJoinDefaults(env.DB)).toEqual({ role: 'viewer', status: 'active' });
  });
});
