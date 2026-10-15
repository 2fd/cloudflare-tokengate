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
      expect(html).toContain('<code>https://gw.test/admin</code>');
      expect(html).toContain('Now: <strong>Let them in as Viewer</strong>');
      expect(html).toContain('<code>gw.test</code><span> · you are here</span>');
      // The footer export form (admins) is not part of this page.
      expect(html.slice(html.indexOf('<main'), html.indexOf('</main>'))).not.toContain(
        '<form method="post"',
      );
      expect(html).toContain('class="ask"');
    },
  );

  it('shows owners six policy options; the three elevated ones are dialogs', async () => {
    const html = await page(await sessionFor('owner'));
    const form = html.slice(
      html.indexOf('id="policy-form"'),
      html.indexOf('</form>', html.indexOf('id="policy-form"')),
    );
    for (const value of ['pending', 'active:viewer', 'closed']) {
      expect(form).toContain(`type="submit" name="join_policy" value="${value}"`);
    }
    for (const value of ['active:token_manager', 'active:access_manager', 'active:admin']) {
      const id = `dlg-policy-${value.replace(':', '-')}`;
      expect(form).toContain(`type="button" class="confirm-trigger secondary" commandfor="${id}"`);
      expect(form).not.toContain(`value="${value}"`);
      const dialog = html.slice(
        html.indexOf(`id="${id}"`),
        html.indexOf('</dialog>', html.indexOf(`id="${id}"`)),
      );
      expect(dialog).toContain(`form="policy-form" name="confirmed_join_policy" value="${value}"`);
    }
    expect(html).toContain('Anyone Access admits can let a consumer use any service token.');
    expect(form).toContain('Let them in as Viewer <span class="badge">Current</span>');
  });

  it('names the login provider and its variables, never their values (I-CFG-1)', async () => {
    const html = await page(await sessionFor('owner'));
    expect(html).toContain('<dt>Cloudflare Access</dt><dd>in use (you signed in with it)</dd>');
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
    expect(one).toContain('Only this hostname is listed.');
    expect(one).toContain('(covers this host, cannot be removed)');

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
    expect(wild).toContain('<code>*.acme.com</code><span> · you are here</span>');
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
      /<fieldset class="submits" id="f-join_policy" data-invalid="true"><legend>New people who sign in<\/legend><p class="field-error"><span class="vh">Error:<\/span> Choose one of the listed options.<\/p>/,
    );
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
