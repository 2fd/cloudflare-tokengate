// Users › Sign-in (`/admin/users/sign-in`): the admin hosts the console answers on (I-DEPLOY-1),
// one host added or removed per submit (settings:write), and the login provider status.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerSignInRoutes } from '../../src/admin/routes/sign-in';
import { getAdminHosts, putSettingStatement } from '../../src/db/settings';
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

describe('GET /admin/users/sign-in', () => {
  it('shows the admin hosts and the login provider to a viewer, read-only', async () => {
    await storeHosts(['gw.test']);
    const res = await adminGet(app, await sessionFor('viewer'), '/admin/users/sign-in');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Sign-in · tokengate</title>');
    expect(html).toContain('<code>gw.test</code> (the host you are using now)');
    expect(html).toContain('<dt>Login providers</dt><dd>Cloudflare Access</dd>');
    expect(html).toContain('Only owners can change this.');
    expect(html).not.toContain('action="/admin/users/sign-in/hosts"');
  });

  it('shows owners the add form, and a remove button only when more than one host is listed', async () => {
    const owner = await sessionFor('owner');
    await storeHosts(['gw.test']);
    const one = await (await adminGet(app, owner, '/admin/users/sign-in')).text();
    expect(one).toContain('name="add"');
    expect(one).not.toContain('name="remove"');
    await storeHosts(['gw.test', 'old.example.com']);
    const two = await (await adminGet(app, owner, '/admin/users/sign-in')).text();
    expect(two).toContain('name="remove" value="old.example.com"');
  });
});

describe('I-DEPLOY-1: POST /admin/users/sign-in/hosts', () => {
  it('adds a host to the current host when none is stored, with one audit row', async () => {
    const owner = await sessionFor('owner');
    await storeHosts(null);
    const save = await adminPost(app, owner, '/admin/users/sign-in/hosts', {
      add: '*.Admin.example.com',
    });
    expect(save.headers.get('location')).toBe('/admin/users/sign-in?notice=hosts_saved');
    expect(await getAdminHosts(env.DB)).toEqual(['gw.test', '*.admin.example.com']);
    expect(await auditActions()).toEqual(['settings.admin_hosts']);
  });

  it('pins the console to the current host in one submit', async () => {
    await storeHosts(null);
    const save = await adminPost(app, await sessionFor('owner'), '/admin/users/sign-in/hosts', {
      add: 'gw.test',
    });
    expect(save.headers.get('location')).toBe('/admin/users/sign-in?notice=hosts_saved');
    expect(await getAdminHosts(env.DB)).toEqual(['gw.test']);
  });

  it('removes a host and reports an unchanged list without an audit row', async () => {
    const owner = await sessionFor('owner');
    await storeHosts(['gw.test', 'old.example.com']);
    const remove = await adminPost(app, owner, '/admin/users/sign-in/hosts', {
      remove: 'old.example.com',
    });
    expect(remove.headers.get('location')).toBe('/admin/users/sign-in?notice=hosts_saved');
    expect(await getAdminHosts(env.DB)).toEqual(['gw.test']);
    const again = await adminPost(app, owner, '/admin/users/sign-in/hosts', { add: 'gw.test' });
    expect(again.headers.get('location')).toBe('/admin/users/sign-in?notice=hosts_unchanged');
    expect(await auditActions()).toEqual(['settings.admin_hosts']);
  });

  const stored = ['gw.test', 'other.example.com'];
  it.each([
    ['removing the current host', stored, { remove: 'gw.test' }],
    ['a workers.dev entry', stored, { add: 'tokengate.acme.workers.dev' }],
    ['a URL instead of a hostname', stored, { add: 'https://other.example.com' }],
    ['no host', stored, { add: ' ' }],
    ['both add and remove', stored, { add: 'a.example.com', remove: 'other.example.com' }],
  ])('refuses %s and keeps the previous list', async (_, hosts, fields) => {
    await storeHosts(hosts);
    const res = await adminPost(
      app,
      await sessionFor('owner'),
      '/admin/users/sign-in/hosts',
      fields,
    );
    expect(res.status).toBe(400);
    expect(await getAdminHosts(env.DB)).toEqual(hosts);
    expect(await auditActions()).toEqual([]);
  });

  it('is forbidden for admins', async () => {
    const res = await adminPost(app, await sessionFor('admin'), '/admin/users/sign-in/hosts', {
      add: 'gw.test',
    });
    expect(res.status).toBe(403);
    expect(await getAdminHosts(env.DB)).toBeNull();
  });
});
