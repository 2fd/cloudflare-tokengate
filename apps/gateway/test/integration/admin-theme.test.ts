// The theme preference of the account menu: a cookie in the browser (System, Light, Dark) that
// forces `color-scheme` through `data-theme` on <html>. POST /admin/theme is CSRF-checked, open to
// every role, writes no audit row and returns only to an admin path of this site.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { THEME_COOKIE } from '../../src/admin/theme';
import {
  type AdminWorld,
  createAdminWorldApp,
  resetAdminWorld,
  seedAdminWorld,
} from '../fixtures/admin-forms';
import {
  type AdminSession,
  adminGet,
  adminPost,
  createUser,
  loginAs,
  setCookies,
} from '../helpers/admin-auth';

let world: AdminWorld;
let viewer: AdminSession;

beforeEach(async () => {
  await resetAdminWorld();
  world = await seedAdminWorld(createAdminWorldApp());
  viewer = await loginAs(
    world.app,
    await createUser({ email: 'viewer@example.com', role: 'viewer' }),
  );
});

async function pageWithTheme(theme: string | null): Promise<string> {
  const cookie = theme === null ? viewer.cookie : `${viewer.cookie}; ${THEME_COOKIE}=${theme}`;
  const res = await adminGet(world.app, viewer, '/admin/credentials', { cookie });
  expect(res.status).toBe(200);
  return res.text();
}

async function auditCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT count(*) AS n FROM audit_log').first<{ n: number }>();
  return Number(row?.n ?? 0);
}

describe('theme on the page', () => {
  it('follows the OS without a cookie', async () => {
    const html = await pageWithTheme(null);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="color-scheme" content="light dark"/>');
    expect(html).toContain('value="system" aria-pressed="true"');
  });

  it.each(['light', 'dark'])('forces %s from the cookie', async (theme) => {
    const html = await pageWithTheme(theme);
    expect(html).toContain(`<html lang="en" data-theme="${theme}">`);
    expect(html).toContain(`<meta name="color-scheme" content="${theme}"/>`);
    expect(html).toContain(`value="${theme}" aria-pressed="true"`);
    expect(html).toContain('value="system" aria-pressed="false"');
  });

  it('ignores a cookie value it does not write', async () => {
    const html = await pageWithTheme('purple');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('value="system" aria-pressed="true"');
  });

  it('the account menu posts the theme with the CSRF token and this page as return path', async () => {
    const html = await pageWithTheme(null);
    expect(html).toContain('<form class="menu-choice" method="post" action="/admin/theme">');
    expect(html).toContain(`<input type="hidden" name="_csrf" value="${viewer.csrfToken}"/>`);
    expect(html).toContain('<input type="hidden" name="return" value="/admin/credentials"/>');
  });

  it('the return path never echoes the query or an unknown path', async () => {
    const searched = await (
      await adminGet(world.app, viewer, '/admin/credentials?q=canary')
    ).text();
    expect(searched).toContain('<input type="hidden" name="return" value="/admin/credentials"/>');
    const missing = await adminGet(world.app, viewer, '/admin/nope-canary');
    expect(missing.status).toBe(404);
    const html = await missing.text();
    expect(html).toContain('<input type="hidden" name="return" value="/admin"/>');
    expect(html).not.toContain('nope-canary');
  });
});

describe('POST /admin/theme', () => {
  it('stores a forced theme and returns to the page, with no audit row', async () => {
    const before = await auditCount();
    const res = await adminPost(world.app, viewer, '/admin/theme', {
      theme: 'dark',
      return: '/admin/credentials',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/credentials');
    const cookie = setCookies(res).get(THEME_COOKIE);
    expect(cookie?.value).toBe('dark');
    expect(cookie?.attributes).toEqual(
      expect.arrayContaining(['Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax']),
    );
    expect(await auditCount()).toBe(before);
  });

  it('System clears the cookie', async () => {
    const res = await adminPost(world.app, viewer, '/admin/theme', { theme: 'system' });
    expect(setCookies(res).get(THEME_COOKIE)?.attributes).toContain('Max-Age=0');
  });

  it('an unknown theme sets nothing', async () => {
    const res = await adminPost(world.app, viewer, '/admin/theme', { theme: 'purple' });
    expect(res.status).toBe(303);
    expect(setCookies(res).has(THEME_COOKIE)).toBe(false);
  });

  it.each([
    'https://evil.example/admin',
    '//evil.example/admin',
    '/\\evil.example/admin',
    '/administrator',
    '/docs',
    'javascript:alert(1)',
  ])('returns to the Overview instead of %s', async (target) => {
    const res = await adminPost(world.app, viewer, '/admin/theme', {
      theme: 'light',
      return: target,
    });
    expect(res.headers.get('location')).toBe('/admin');
  });

  it('refuses a request without the CSRF token', async () => {
    const res = await adminPost(
      world.app,
      viewer,
      '/admin/theme',
      { theme: 'dark' },
      { csrf: null },
    );
    expect(res.status).toBe(403);
    expect(setCookies(res).has(THEME_COOKIE)).toBe(false);
  });
});
