// The admin shell around every page (ADR 0019, ADR 0022): skip link, sidebar with the four
// sections in order, their pages, the counts and the decision pill, the health line, the account
// menu (docs, version, sign out) and the health strip; the forbidden page with who to ask; the 404
// page for unlisted URLs (with static hints for the URLs that moved); notices that never show
// query text or another person's change; and `_return`, which sends a row action back to a fixed
// page.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { version } from '../../package.json';
import { loadDone, resolveNotice } from '../../src/admin/notice';
import { ADMIN_BRANDING_KEY, getAdminBranding, putSettingStatement } from '../../src/db/settings';
import type { User } from '../../src/db/types';
import { newId } from '../../src/lib/ids';
import {
  type AdminWorld,
  createAdminWorldApp,
  resetAdminWorld,
  seedAdminWorld,
} from '../fixtures/admin-forms';
import { type AdminSession, adminGet, adminPost, createUser, loginAs } from '../helpers/admin-auth';
import { createTestApp } from '../helpers/app';
import { KEK_1 } from '../unit/admin/ops/helpers';

const PNG_DATA =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
let world: AdminWorld;
let ownerUser: User;
let owner: AdminSession;

beforeEach(async () => {
  await resetAdminWorld();
  world = await seedAdminWorld(createAdminWorldApp());
  ownerUser = await createUser({ email: 'owner@example.com', role: 'owner' });
  owner = await loginAs(world.app, ownerUser);
});

async function page(session: AdminSession, path: string): Promise<string> {
  return (await adminGet(world.app, session, path)).text();
}

/** The sidebar navigation landmark. */
function sideNav(html: string): string {
  const start = html.indexOf('<nav class="nav" aria-label="Sections">');
  expect(start, 'sidebar nav').toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</nav>', start));
}

/** The opening tag of the sidebar link to `href` (a section row or a page item). */
function navLink(html: string, href: string): string {
  const match = new RegExp(`<a (?:class="[^"]*" )?href="${href}"[^>]*>`).exec(sideNav(html));
  if (!match) throw new Error(`no sidebar link to ${href}`);
  return match[0];
}

describe('the shell on every page', () => {
  it('loads title and uploaded image from D1 on signed-in and sign-in screens', async () => {
    await env.DB.batch([
      putSettingStatement(
        env.DB,
        ADMIN_BRANDING_KEY,
        {
          title: 'Acme <Gateway>',
          image: PNG_DATA,
        },
        Date.now(),
        ownerUser.id,
      ),
    ]);
    const app = createTestApp();
    const session = await loginAs(app, ownerUser);
    const html = await (await adminGet(app, session, '/admin')).text();
    expect(html).toContain('Acme &lt;Gateway&gt;');
    expect(html).toContain(`src="${PNG_DATA}"`);
    const anonymous = await (await app.request('/admin')).text();
    expect(anonymous).toContain('Acme &lt;Gateway&gt;');
    expect(anonymous).toContain(`src="${PNG_DATA}"`);
  });

  it('ends every document title with the configured title', async () => {
    const app = createTestApp();
    const session = await loginAs(app, ownerUser);
    expect(await (await adminGet(app, session, '/admin/credentials')).text()).toContain(
      '<title>Credentials – tokengate</title>',
    );
    await env.DB.batch([
      putSettingStatement(
        env.DB,
        ADMIN_BRANDING_KEY,
        { title: 'Acme <Gateway>', image: null },
        Date.now(),
        ownerUser.id,
      ),
    ]);
    expect(await (await adminGet(app, session, '/admin/credentials')).text()).toContain(
      '<title>Credentials – Acme &lt;Gateway&gt;</title>',
    );
    expect(await (await adminGet(app, session, '/admin/users/appearance')).text()).toContain(
      '<title>Appearance – Settings – Acme &lt;Gateway&gt;</title>',
    );
    expect(await (await app.request('/admin')).text()).toContain('– Acme &lt;Gateway&gt;</title>');
  });

  it('links a favicon made from the brand image, and the shield by default', async () => {
    const app = createTestApp();
    const session = await loginAs(app, ownerUser);
    const faviconHref = (html: string) => {
      const match =
        /<link rel="icon" type="image\/svg\+xml" href="(\/static\/favicon\.[0-9a-f]+\.svg)"\/?>/.exec(
          html,
        );
      if (!match) throw new Error('no favicon link');
      return match[1]!;
    };
    const shieldHref = faviconHref(await (await adminGet(app, session, '/admin')).text());
    const shield = await app.request(shieldHref);
    expect(shield.status).toBe(200);
    expect(shield.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
    expect(shield.headers.get('cache-control')).toContain('immutable');
    const shieldSvg = await shield.text();
    expect(shieldSvg).toContain('fill="#055f73"');
    expect(shieldSvg).not.toContain('<image');

    await env.DB.batch([
      putSettingStatement(
        env.DB,
        ADMIN_BRANDING_KEY,
        { title: 'tokengate', image: PNG_DATA },
        Date.now(),
        ownerUser.id,
      ),
    ]);
    const customHref = faviconHref(await (await adminGet(app, session, '/admin')).text());
    expect(customHref).not.toBe(shieldHref);
    // The sign-in screens link the same icon.
    expect(faviconHref(await (await app.request('/admin')).text())).toBe(customHref);
    expect(await (await app.request(customHref)).text()).toContain(`<image href="${PNG_DATA}"`);
    // The replaced icon is gone; the stable URL serves the current one.
    expect((await app.request(shieldHref)).status).toBe(404);
    const stable = await app.request('/static/favicon.svg');
    expect(stable.headers.get('cache-control')).toContain('must-revalidate');
    expect(await stable.text()).toContain(`<image href="${PNG_DATA}"`);
  });

  it('falls back safely for blank titles and invalid stored images', async () => {
    await env.DB.batch([
      putSettingStatement(
        env.DB,
        ADMIN_BRANDING_KEY,
        {
          title: '  ',
          image: 'data:image/svg+xml,<svg onload="alert(1)"/>',
        },
        Date.now(),
        ownerUser.id,
      ),
    ]);
    const html = await page(owner, '/admin');
    expect(html).toContain('class="inst-name" href="/admin">tokengate</a>');
    expect(html).toContain('M12 3l7 3');
    expect(html).not.toContain('onload');
  });

  it('starts with the skip link and has one h1 inside main#main', async () => {
    const html = await page(owner, '/admin/credentials');
    expect(html.indexOf('<a ')).toBe(html.indexOf('<a class="skip-link" href="#main">'));
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html).toContain('<main class="main" id="main" tabindex="-1">');
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html.indexOf('<h1>')).toBeGreaterThan(html.indexOf('<main'));
    expect(html).toContain('<meta name="color-scheme" content="light dark"/>');
    expect(html).toContain('<title>Credentials – tokengate</title>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain(' style=');
  });

  it('starts every page with a doctype (no quirks mode), including the 404 page', async () => {
    for (const path of ['/admin/credentials', '/admin/nope']) {
      const html = await page(owner, path);
      expect(html.startsWith('<!doctype html><html lang="en">'), path).toBe(true);
    }
  });

  it('lists all pages in labeled groups regardless of the open section', async () => {
    const nav = sideNav(await page(owner, '/admin/credentials/hosts'));
    const rows = [...nav.matchAll(/<a class="nav-item" href="([^"]+)"/g)].map((m) => m[1]);
    expect(rows).toEqual([
      '/admin',
      '/admin/requests',
      '/admin/audit',
      '/admin/retention',
      '/admin/credentials',
      '/admin/credential-access-rules',
      '/admin/users',
      '/admin/credentials/hosts',
      '/admin/credentials/keys',
      '/admin/users/appearance',
      '/admin/faq',
    ]);
    expect([...nav.matchAll(/class="nav-label">([^<]+)/g)].map((m) => m[1])).toEqual([
      'Monitoring',
      'Credentials',
      'Settings',
    ]);
  });

  it('shows the account menu: name, role, email, version, docs of the section and Sign out', async () => {
    const html = await page(owner, '/admin/credentials');
    const menu = html.slice(html.indexOf('<div class="acct">'), html.indexOf('</main>'));
    expect(menu).toContain('<b>owner@example.com</b><small>Owner</small>');
    expect(menu).toContain('<span class="vh">, account menu</span>');
    expect(menu).toContain(
      `<p class="menu-h"><span>owner@example.com</span><span>tokengate ${version}</span></p>`,
    );
    expect(menu).toContain(
      'href="https://github.com/2fd/cloudflare-tokengate/blob/main/docs/concepts.md#credential">Docs<span class="vh">: Credentials (GitHub docs)</span></a>',
    );
    expect(menu).toContain('<a class="menu-item" href="/cdn-cgi/access/logout">Sign out</a>');
    // The account block is in the sidebar, never inside main.
    expect(html.indexOf('<div class="acct">')).toBeLessThan(html.indexOf('<main'));
  });

  it('shows Access rules under Credentials, current on credential and global rule pages', async () => {
    const list = sideNav(await page(owner, '/admin/global-access-rules'));
    const section = list.slice(list.indexOf('aria-label="Credentials"'));
    expect([...section.matchAll(/class="nav-text">([^<]+)/g)].map((m) => m[1]).slice(0, 2)).toEqual(
      ['Credentials', 'Access rules'],
    );
    expect(list).not.toContain('href="/admin/global-access-rules"');
    expect(navLink(list, '/admin/credential-access-rules')).toContain('aria-current="true"');
    const detail = await page(owner, `/admin/global-access-rules/${world.global.id}`);
    expect(navLink(detail, '/admin/credential-access-rules')).toContain('aria-current="true"');
    const rules = await page(owner, '/admin/credential-access-rules');
    expect(navLink(rules, '/admin/credential-access-rules')).toContain('aria-current="page"');
    const rule = await page(owner, `/admin/credential-access-rules/${world.rule.id}`);
    expect(navLink(rule, '/admin/credential-access-rules')).toContain('aria-current="true"');
  });

  it('switches between credential and global access rules with tabs in the header', async () => {
    const tabs = (html: string) => {
      const start = html.indexOf('<nav class="tabs" aria-label="Access rule kinds">');
      expect(start, 'access rule tabs').toBeGreaterThan(-1);
      return html.slice(start, html.indexOf('</nav>', start));
    };
    const credential = tabs(await page(owner, '/admin/credential-access-rules'));
    expect(credential).toContain('<a href="/admin/credential-access-rules" aria-current="page">');
    expect(credential).toContain('<a href="/admin/global-access-rules">Global access rules');
    const global = tabs(await page(owner, '/admin/global-access-rules'));
    expect(global).toContain('<a href="/admin/global-access-rules" aria-current="page">');
    expect(global).toContain('<a href="/admin/credential-access-rules">Credential access rules');
  });

  it('marks the current page item as the page or as an ancestor (aria-current)', async () => {
    const list = await page(owner, '/admin/credentials');
    // The flat row marks the current page.
    expect(navLink(list, '/admin/credentials')).toBe(
      '<a class="nav-item" href="/admin/credentials" aria-current="page">',
    );
    expect(sideNav(list)).toContain(
      '<li><a class="nav-item" href="/admin/credentials" aria-current="page">',
    );
    expect(navLink(list, '/admin')).not.toContain('aria-current');

    const hosts = sideNav(await page(owner, '/admin/credentials/hosts'));
    expect(hosts).toContain(
      '<li><a class="nav-item" href="/admin/credentials/hosts" aria-current="page">',
    );
    expect(hosts).toContain('<li><a class="nav-item" href="/admin/credentials">');

    const detail = sideNav(await page(owner, `/admin/credentials/${world.serviceId}`));
    expect(detail).toContain(
      '<li><a class="nav-item" href="/admin/credentials" aria-current="true">',
    );

    const audit = sideNav(await page(owner, '/admin/audit'));
    expect(audit).toContain('<a class="nav-item" href="/admin">');
    expect(audit).toContain('<li><a class="nav-item" href="/admin/audit" aria-current="page">');

    // Forbidden and not-found pages open the section and mark no item.
    const missing = sideNav(await page(owner, '/admin/credentials/nope/deeper'));
    expect(missing).toContain('<a class="nav-item" href="/admin/credentials">');
    expect(missing).not.toContain('aria-current');
  });

  it('counts credentials and credential access rules, and shows none for an empty list', async () => {
    const nav = sideNav(await page(owner, '/admin/requests'));
    expect(nav).toContain('Credentials</span><span class="nav-count">1</span>');
    expect(nav).toContain('Access rules</span><span class="nav-count">1</span>');
    expect(nav).not.toMatch(/(Overview|Members)<\/span><span class="nav-count">/);
  });

  it('shows owners how many people need a decision, with a text alternative', async () => {
    await createUser({
      email: 'pending@example.com',
      role: 'viewer',
      status: 'pending',
      identity: { loginProvider: 'access', subject: 'pending-subject' },
    });
    const pill =
      // The only owner also gets the single-owner note.
      'Members</span><span class="dot nav-dot info" aria-hidden="true"></span><span class="vh">: 1 note</span><span class="nav-pill">1 pending<span class="vh">: a person needs your decision</span></span>';
    expect(await page(owner, '/admin/requests')).toContain(pill);
    const admin = await loginAs(
      world.app,
      await createUser({ email: 'admin@example.com', role: 'admin' }),
    );
    const html = await page(admin, '/admin/requests');
    expect(html).not.toContain('class="nav-pill"');
    expect(html).toContain('<small>Admin</small>');
  });

  it('shows no pill when nobody needs a decision', async () => {
    expect(await page(owner, '/admin/requests')).not.toContain('class="nav-pill"');
  });

  it('has a health line that links to the Overview and says what it found', async () => {
    const html = await page(owner, '/admin/requests');
    // One active owner and an hourly job that has not run yet are notes: they are not counted.
    expect(html).toContain(
      '<a class="health" href="/admin"><span class="dot" aria-hidden="true"></span>Healthy<span class="vh">. Open Overview</span></a>',
    );
  });
});

describe('health strip', () => {
  it('shows a missing keyring on other pages and links to rotate encryption', async () => {
    const app = createTestApp({ env: { TOKENGATE_KEK: '', TOKENGATE_KEYRING: '' } });
    const session = await loginAs(app, ownerUser);
    const html = await (await adminGet(app, session, '/admin/requests')).text();
    const strip = /<p class="hstrip">(.*?)<\/p>/s.exec(html)?.[1] ?? '';
    // Not announced on every page load, and "Error:" for screen readers.
    expect(html).not.toContain('role="alert"');
    expect(strip).toContain('<span aria-hidden="true">✕</span> <span class="vh">Error: </span>');
    // A short bold title, then the detail in plain text.
    expect(strip).toContain(
      '<span class="vh">Error: </span>Encryption keys are not loaded.</b> Requests through credentials fail with 503 and secrets cannot change (keyring_absent).',
    );
    expect(strip).toContain('<a href="/admin/credentials/keys">Open rotate encryption</a>');
    expect(strip).toContain('<a href="/admin#health">Show all problems</a>');
    // It is the first thing in main, and the health line counts the problem.
    expect(html.indexOf('<p class="hstrip">')).toBeGreaterThan(html.indexOf('<main'));
    expect(html).toContain(
      '1 problem to fix<span class="vh">. Open Overview, Needs attention</span>',
    );
    // The Overview lists every problem itself.
    expect(await (await adminGet(app, session, '/admin')).text()).not.toContain('class="hstrip"');
  });

  it('is absent when nothing is wrong', async () => {
    expect(await page(owner, '/admin/requests')).not.toContain('class="hstrip"');
  });

  it('still renders when the alert data does not load, with the checks that need no table', async () => {
    // A database behind on a migration: one statement of the alert batch names a missing table.
    const DB = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) =>
            target.prepare(
              sql.includes('FROM access_rules WHERE credential_id IS NOT NULL ORDER BY name, id')
                ? sql.replace('FROM access_rules', 'FROM rules_of_a_newer_migration')
                : sql,
            );
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (line: string) => warnings.push(line);
    try {
      const plain = createTestApp({ env: { DB, TOKENGATE_KEK: KEK_1 } });
      const res = await adminGet(plain, await loginAs(plain, ownerUser), '/admin/nope');
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain('<h1>Page not found</h1>');
      expect(html).toContain(
        'Health not checked<span class="vh">. The checks could not read the database. Open Overview, Health</span>',
      );
      expect(html).not.toContain('Healthy');
      expect(html).not.toContain('class="hstrip"');
      // The keyring check needs no table, so its strip still shows.
      const noKeys = createTestApp({ env: { DB, TOKENGATE_KEK: '', TOKENGATE_KEYRING: '' } });
      const strip = await (
        await adminGet(noKeys, await loginAs(noKeys, ownerUser), '/admin/nope')
      ).text();
      expect(strip).toContain('Encryption keys are not loaded.</b>');
      expect(strip).toContain('1 problem to fix<span class="vh">. Open Overview, Health</span>');
    } finally {
      console.warn = original;
    }
    expect(warnings.some((line) => line.includes('"type":"admin.shell_health_failed"'))).toBe(true);
  });
});

describe('forbidden page', () => {
  it('names the roles that can do it and asks only active holders of the permission', async () => {
    await createUser({ email: 'tm@example.com', role: 'token_manager' });
    await createUser({ email: 'gone-tm@example.com', role: 'token_manager', status: 'suspended' });
    await createUser({ email: 'am@example.com', role: 'access_manager' });
    const viewer = await loginAs(
      world.app,
      await createUser({ email: 'viewer@example.com', role: 'viewer' }),
    );
    const res = await adminGet(world.app, viewer, '/admin/credentials/new');
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain(
      '<h1>Forbidden</h1><p class="desc">Your role does not allow this action.</p>',
    );
    expect(html).toContain(
      '<p><b>Changing credentials needs the Credential manager, Admin or Owner role.</b></p>',
    );
    const ask = /<p class="ask">(.*?)<\/p>/s.exec(html)?.[1] ?? '';
    // The callout names the roles, so the ask sentence starts with the people.
    expect(ask).not.toContain('Only');
    // Owners come last: they can do everything, so they are the fallback.
    expect(ask.indexOf('tm@example.com')).toBeLessThan(ask.indexOf('owner@example.com'));
    expect(ask).toContain('<b>owner@example.com</b>');
    expect(ask).toContain('<a href="mailto:tm@example.com,owner@example.com">Email them</a>');
    expect(ask).not.toContain('gone-tm@example.com');
    expect(ask).not.toContain('am@example.com');
    expect(ask).not.toContain('viewer@example.com');
    expect(html).toContain(
      '<a class="btn secondary" href="/admin/credentials">Back to Credentials</a>',
    );
    expect(html).toContain('<title>Forbidden – Credentials – tokengate</title>');
  });

  it('names at most 3 people and counts the rest', async () => {
    for (const n of [1, 2, 3, 4]) {
      await createUser({ email: `am${n}@example.com`, role: 'access_manager' });
    }
    const viewer = await loginAs(
      world.app,
      await createUser({ email: 'viewer@example.com', role: 'viewer' }),
    );
    const html = await page(viewer, '/admin/credential-access-rules/new');
    const ask = /<p class="ask">(.*?)<\/p>/s.exec(html)?.[1] ?? '';
    expect(ask).toContain('Ask <b>');
    expect(ask.match(/<b>/g)).toHaveLength(3);
    expect(ask).toContain('and 2 more.');
  });
});

describe('404 page for unlisted admin URLs', () => {
  it.each([
    ['/admin/tokens', 'Services are now <a href="/admin/credentials">Credentials</a>.'],
    ['/admin/tokens/svc_x', 'Services are now <a href="/admin/credentials">Credentials</a>.'],
    [
      '/admin/consumers/new',
      'Service consumers are now <a href="/admin/credential-access-rules">Credential access rules</a>.',
    ],
    [
      '/admin/access?service=x',
      'Consumer access is now part of <a href="/admin/credential-access-rules">Credential access rules</a>. <a href="/admin/global-access-rules">Global access rules</a> are the ceilings on every credential access rule of an issuer.',
    ],
    [
      '/admin/issuer-access-rules/new?view=list',
      'Issuer access rules are now part of <a href="/admin/credential-access-rules">Credential access rules</a>. Each credential access rule now holds its issuer, its identity conditions and its operations.',
    ],
  ])('GET %s says where the page moved: %s', async (path, hint) => {
    const res = await adminGet(world.app, owner, path);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<title>This page moved – tokengate</title>');
    expect(html).toContain(`<h1>This page moved</h1><p class="desc">${hint}</p>`);
    expect(html).not.toContain('Page not found');
    expect(html).not.toContain('There is no page at this address.');
  });

  it.each([
    '/admin/retention',
    '/admin/credentials/hosts',
    '/admin/credentials/keys',
    '/admin/users#login',
    '/admin#health',
  ])('GET /admin/settings links %s from "Where each setting is now"', async (href) => {
    const res = await adminGet(world.app, owner, '/admin/settings');
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<h1>The Settings page was split up</h1>');
    expect(html).toContain('account menu');
    const moved = html.slice(html.indexOf('<h2 id="nf-moved-h">Where each setting is now</h2>'));
    expect(moved.slice(0, moved.indexOf('</section>'))).toContain(
      `<a class="tcard" href="${href}">`,
    );
  });

  it('opens no sidebar section and keeps the section out of the title', async () => {
    for (const path of ['/admin/nope', '/admin/settings']) {
      const html = await (await adminGet(world.app, owner, path)).text();
      expect(html, path).not.toContain('nav-item is-open');
      expect(html, path).not.toContain('aria-current');
      expect(html, path).not.toMatch(/<title>[^<]*– Monitoring –/);
    }
  });

  it('links to the three sections and shows no hint for other paths', async () => {
    const html = await (await adminGet(world.app, owner, '/admin/nope')).text();
    expect(html).toContain('<title>Page not found – tokengate</title>');
    expect(html).toContain(
      '<h1>Page not found</h1><p class="desc">There is no page at this address.</p>',
    );
    expect(html).toContain('<h2 id="nf-sections-h">Go to a section</h2>');
    for (const href of ['/admin', '/admin/credentials', '/admin/users']) {
      expect(html).toContain(`<a class="tcard" href="${href}">`);
    }
    expect(html).not.toContain('are now');
    expect(html).not.toContain('nf-moved');
  });

  it('never echoes the requested path', async () => {
    for (const path of ['/admin/credentials<script>alert(1)</script>', '/admin/nope-canary-1234']) {
      const html = await (await adminGet(world.app, owner, path)).text();
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('%3Cscript');
      expect(html).not.toContain('alert(1)');
      expect(html).not.toContain('nope-canary');
      expect(html).not.toContain('/admin/credentials&lt;script');
    }
  });
});

describe('notices', () => {
  it('render only known keys, never query text', async () => {
    for (const notice of ['<script>alert(1)</script>', '__proto__', 'constructor']) {
      const html = await page(
        owner,
        `/admin/credentials/${world.serviceId}?notice=${encodeURIComponent(notice)}`,
      );
      expect(html).not.toContain('notice"');
      expect(html).not.toContain('alert(1)');
    }
    expect(resolveNotice({ saved: () => ({ text: 'Saved.' }) }, '__proto__', null)).toBeNull();
    expect(resolveNotice({ saved: () => ({ text: 'Saved.' }) }, 'toString', null)).toBeNull();
  });

  it('render a known key after the header, focused', async () => {
    const html = await page(owner, `/admin/credentials/${world.serviceId}?notice=disabled`);
    const notice = html.indexOf(
      '<div class="callout ok notice" role="status" tabindex="-1" autofocus="">',
    );
    expect(notice).toBeGreaterThan(html.indexOf('</header>'));
    expect(html.indexOf('</header>')).toBeGreaterThan(html.indexOf('<h1>'));
  });

  async function auditRow(actorId: string, ts: number): Promise<string> {
    const id = newId('aud', ts, (n) => crypto.getRandomValues(new Uint8Array(n)));
    await env.DB.prepare(
      `INSERT INTO audit_log (id, ts, actor_type, actor_id, actor_email, action, target_type, target_id, summary)
       VALUES (?, ?, 'user', ?, 'x@example.com', 'service.update', 'service', 'svc_x', 'Changed')`,
    )
      .bind(id, ts, actorId)
      .run();
    return id;
  }

  it("use a done id only for the viewer's own change from the last 10 minutes", async () => {
    const now = Date.now();
    const deps = { env: world.app.deps.env, now: () => now };
    const viewer = { userId: ownerUser.id };
    const own = await auditRow(ownerUser.id, now - 60_000);
    expect((await loadDone(deps, viewer, own))?.id).toBe(own);

    const other = await createUser({ email: 'other@example.com', role: 'owner' });
    expect(await loadDone(deps, viewer, await auditRow(other.id, now - 60_000))).toBeNull();
    expect(
      await loadDone(deps, viewer, await auditRow(ownerUser.id, now - 11 * 60_000)),
    ).toBeNull();
    for (const raw of ['aud_x', `${own}' OR 1=1`, own.toLowerCase(), undefined, ['x']]) {
      expect(await loadDone(deps, viewer, raw)).toBeNull();
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
    const res = await toggle(`/admin/credentials/${world.serviceId}/toggle`, value);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(
      target === 'list'
        ? '/admin/credentials?notice=disabled'
        : `/admin/credentials/${world.serviceId}?notice=disabled`,
    );
  });

  it.each([
    [undefined, `/admin/credential-access-rules/:id`],
    ['list', '/admin/credential-access-rules'],
    ['matrix', `/admin/credential-access-rules/:id`],
    ['__proto__', `/admin/credential-access-rules/:id`],
  ])('credential access rule toggle with _return=%s goes to %s', async (value, target) => {
    const res = await toggle(`/admin/credential-access-rules/${world.rule.id}/toggle`, value);
    expect(res.headers.get('location')).toBe(
      `${target.replace(':id', world.rule.id)}?notice=disabled`,
    );
  });

  it.each([
    [undefined, '/admin/global-access-rules/:id'],
    ['list', '/admin/global-access-rules'],
    ['javascript:alert(1)', '/admin/global-access-rules/:id'],
  ])('global access rule toggle with _return=%s goes to %s', async (value, target) => {
    // The world's only GitLab.com global access rule: disabling it is the last disable.
    const res = await adminPost(
      world.app,
      owner,
      `/admin/global-access-rules/${world.global.id}/toggle`,
      {
        enabled: '0',
        confirm_last_disable: '1',
        ...(value === undefined ? {} : { _return: value }),
      },
    );
    expect(res.headers.get('location')).toBe(
      `${target.replace(':id', world.global.id)}?notice=disabled`,
    );
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
      role: 'viewer',
    });
    expect(res.status).toBe(303);
    // The `done` id and the row fragment are the Users notice details (A7.2).
    const bare = res.headers
      .get('location')
      ?.replace(/&done=aud_[0-9A-Z]{26}/, '')
      .replace(/#.*$/, '');
    expect(bare).toBe(location);
  });
});

describe('appearance settings', () => {
  async function upload(session: AdminSession, image: File, csrf = session.csrfToken) {
    const body = new FormData();
    body.set('_csrf', csrf);
    body.set('title', 'My workspace');
    body.set('image', image);
    return world.app.request('/admin/users/appearance', {
      method: 'POST',
      body,
      headers: { ...session.headers, 'sec-fetch-site': 'same-origin' },
    });
  }
  function png() {
    return new File(
      [Uint8Array.from(atob(PNG_DATA.split(',')[1]!), (c) => c.charCodeAt(0))],
      'logo.png',
      { type: 'image/png' },
    );
  }

  it('uploads, persists, preserves and resets the image and title with an audit entry', async () => {
    expect(await page(owner, '/admin/users/appearance')).toContain('enctype="multipart/form-data"');
    expect((await upload(owner, png())).status).toBe(303);
    expect(await getAdminBranding(env.DB)).toEqual({ title: 'My workspace', image: PNG_DATA });
    expect(await page(owner, '/admin')).toContain(`src="${PNG_DATA}"`);
    expect(
      (await adminPost(world.app, owner, '/admin/users/appearance', { title: 'Renamed' })).status,
    ).toBe(303);
    expect(await getAdminBranding(env.DB)).toEqual({ title: 'Renamed', image: PNG_DATA });
    expect(
      (
        await adminPost(world.app, owner, '/admin/users/appearance', {
          title: '',
          remove_image: 'yes',
        })
      ).status,
    ).toBe(303);
    expect(await getAdminBranding(env.DB)).toEqual({ title: 'tokengate', image: null });
    const audit = await env.DB.prepare(
      "SELECT * FROM audit_log WHERE target_id = 'admin_branding'",
    ).all();
    expect(audit.results).toHaveLength(3);
    expect(JSON.stringify(audit.results)).not.toContain('base64');
  });

  it('rejects unsupported and oversized files without changing settings', async () => {
    expect(
      (await upload(owner, new File(['<svg/>'], 'logo.png', { type: 'image/png' }))).status,
    ).toBe(400);
    expect(
      (await upload(owner, new File([new Uint8Array(256 * 1024 + 1)], 'big.png'))).status,
    ).toBe(400);
    expect(
      (await adminPost(world.app, owner, '/admin/users/appearance', { title: 'x'.repeat(81) }))
        .status,
    ).toBe(400);
    expect(await getAdminBranding(env.DB)).toEqual({ title: 'tokengate', image: null });
  });

  it('requires owner permission and CSRF for image uploads', async () => {
    const viewer = await loginAs(
      world.app,
      await createUser({ email: 'viewer@example.com', role: 'viewer' }),
    );
    expect((await upload(viewer, png())).status).toBe(403);
    expect((await upload(owner, png(), 'invalid')).status).toBe(403);
    expect(await getAdminBranding(env.DB)).toEqual({ title: 'tokengate', image: null });
  });
});
