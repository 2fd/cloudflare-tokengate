// The admin shell around every page: the 404 page for unlisted URLs (with static hints for the
// URLs that moved, ADR 0019) and `_return`, which sends a row action back to a fixed page.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AdminWorld,
  createAdminWorldApp,
  resetAdminWorld,
  seedAdminWorld,
} from '../fixtures/admin-forms';
import { type AdminSession, adminGet, adminPost, createUser, loginAs } from '../helpers/admin-auth';

let world: AdminWorld;
let owner: AdminSession;

beforeEach(async () => {
  await resetAdminWorld();
  world = await seedAdminWorld(createAdminWorldApp());
  owner = await loginAs(world.app, await createUser({ email: 'owner@example.com', role: 'owner' }));
});

describe('404 page for unlisted admin URLs', () => {
  it.each([
    ['/admin/services', 'Services are now <a href="/admin/tokens">Service tokens</a>.'],
    ['/admin/services/svc_x', 'Services are now <a href="/admin/tokens">Service tokens</a>.'],
    [
      '/admin/caller-providers/new',
      'Caller providers are now <a href="/admin/consumers">Service consumers</a>.',
    ],
    ['/admin/grants?service=x', 'Grants are now <a href="/admin/access">Consumer access</a>.'],
    ['/admin/settings', '<a href="/admin/retention">Data retention</a>'],
    ['/admin/settings', '<a href="/admin/tokens/hosts">Allowed hosts</a>'],
    ['/admin/settings', '<a href="/admin/tokens/keys">Encryption keys</a>'],
    ['/admin/settings', '<a href="/admin/users/sign-in">Sign-in</a>'],
    ['/admin/settings', '<a href="/admin#health">the overview</a>'],
  ])('GET %s shows the moved hint %s', async (path, hint) => {
    const res = await adminGet(world.app, owner, path);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<h1>Page not found</h1>');
    expect(html).toContain(hint);
  });

  it('links to the four sections and shows no hint for other paths', async () => {
    const html = await (await adminGet(world.app, owner, '/admin/nope')).text();
    for (const href of ['/admin', '/admin/users', '/admin/tokens', '/admin/consumers']) {
      expect(html).toContain(`<li><a href="${href}">`);
    }
    expect(html).not.toContain('are now');
  });

  it('never echoes the requested path', async () => {
    for (const path of ['/admin/services<script>alert(1)</script>', '/admin/nope-canary-1234']) {
      const html = await (await adminGet(world.app, owner, path)).text();
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('%3Cscript');
      expect(html).not.toContain('alert(1)');
      expect(html).not.toContain('nope-canary');
      expect(html).not.toContain('/admin/services');
    }
  });
});

describe('_return: row actions go back to a fixed page', () => {
  const toggle = (path: string, _return?: string) =>
    adminPost(world.app, owner, path, {
      enabled: '0',
      ...(_return === undefined ? {} : { _return }),
    });

  it.each([
    [undefined, 'detail'],
    ['list', 'list'],
    ['detail', 'detail'],
    ['matrix', 'detail'],
    ['https://evil.example/', 'detail'],
    ['//evil.example', 'detail'],
    ['/admin/users', 'detail'],
  ])('token toggle with _return=%s goes to the %s page', async (value, target) => {
    const res = await toggle(`/admin/tokens/${world.serviceId}/toggle`, value);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(
      target === 'list'
        ? '/admin/tokens?notice=disabled'
        : `/admin/tokens/${world.serviceId}?notice=disabled`,
    );
  });

  it.each([
    [undefined, `/admin/consumers/:id`],
    ['list', '/admin/consumers'],
    ['__proto__', `/admin/consumers/:id`],
  ])('consumer toggle with _return=%s goes to %s', async (value, target) => {
    const res = await toggle(`/admin/consumers/${world.provider.id}/toggle`, value);
    expect(res.headers.get('location')).toBe(
      `${target.replace(':id', world.provider.id)}?notice=disabled`,
    );
  });

  it.each([
    [undefined, '/admin/access/:id'],
    ['list', '/admin/access?view=list'],
    ['matrix', '/admin/access'],
    ['javascript:alert(1)', '/admin/access/:id'],
  ])('access toggle with _return=%s goes to %s', async (value, target) => {
    const res = await toggle(`/admin/access/${world.grantId}/toggle`, value);
    const expected = target.replace(':id', world.grantId);
    const separator = expected.includes('?') ? '&' : '?';
    expect(res.headers.get('location')).toBe(`${expected}${separator}notice=disabled`);
  });

  it.each([
    ['approve', 'overview', '/admin?notice=approved'],
    ['approve', 'evil', '/admin/users?notice=approved'],
    ['reject', 'overview', '/admin?notice=rejected'],
    ['reject', 'list', '/admin/users?notice=rejected'],
  ] as const)('%s with _return=%s goes to %s', async (decision, value, location) => {
    const pending = await createUser({
      email: `${decision}-${value}@example.com`,
      role: 'viewer',
      status: 'pending',
      identity: { loginProvider: 'access', subject: `subject-${decision}-${value}` },
    });
    const res = await adminPost(world.app, owner, `/admin/users/${pending.id}/${decision}`, {
      _return: value,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(location);
  });
});
