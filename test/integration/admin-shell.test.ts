// The admin shell around every page (ADR 0019): skip link, section nav with the decision badge,
// subnav, Help, account, health strip and footer; the forbidden page with who to ask; the 404 page
// for unlisted URLs (with static hints for the URLs that moved); notices that never show query
// text or another person's change; and `_return`, which sends a row action back to a fixed page.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { version } from '../../package.json';
import { loadDone, resolveNotice } from '../../src/admin/notice';
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

/** The opening tag of the link to `href` inside the element that starts with `container`. */
function linkIn(html: string, container: string, href: string): string {
  const start = html.indexOf(container);
  expect(start, container).toBeGreaterThan(-1);
  const end = html.indexOf('</nav>', start);
  const match = new RegExp(`<a href="${href}"[^>]*>`).exec(html.slice(start, end));
  if (!match) throw new Error(`no link to ${href} in ${container}`);
  return match[0];
}

describe('the shell on every page', () => {
  it('starts with the skip link and has one h1 inside main#main', async () => {
    const html = await page(owner, '/admin/tokens');
    expect(html.indexOf('<a ')).toBe(html.indexOf('<a class="skip-link" href="#main">'));
    expect(html).toContain('<main id="main" tabindex="-1">');
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain('<meta name="color-scheme" content="light dark"/>');
    expect(html).toContain('<title>Services – Service tokens – tokengate</title>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain(' style=');
  });

  it('starts every page with a doctype (no quirks mode), including the 404 page', async () => {
    for (const path of ['/admin/tokens', '/admin/nope']) {
      const html = await page(owner, path);
      expect(html.startsWith('<!doctype html><html lang="en">'), path).toBe(true);
    }
  });

  it('shows the section nav, the subnav, Help, the role badge and the version', async () => {
    const html = await page(owner, '/admin/tokens/hosts');
    expect(html).toContain('<nav class="sections" aria-label="Sections">');
    expect(html).toContain('<nav aria-label="Service tokens pages" class="subnav">');
    expect(html).toContain('Help<span class="vh">: Service tokens (GitHub docs)</span>');
    expect(html).toContain(
      'href="https://github.com/2fd/cloudflare-tokengate/blob/main/docs/concepts.md#service-token"',
    );
    expect(html).toContain('<span>owner@example.com</span> <span class="badge">Owner</span>');
    expect(html).toContain(`<p>tokengate ${version}</p>`);
  });

  it('marks the current section and tab as the page or as an ancestor (aria-current)', async () => {
    const list = await page(owner, '/admin/tokens');
    expect(linkIn(list, '<nav class="sections"', '/admin/tokens')).toContain('aria-current="page"');
    expect(linkIn(list, '<nav aria-label="Service tokens pages"', '/admin/tokens')).toContain(
      'aria-current="page"',
    );
    expect(linkIn(list, '<nav class="sections"', '/admin')).not.toContain('aria-current');

    const hosts = await page(owner, '/admin/tokens/hosts');
    expect(linkIn(hosts, '<nav class="sections"', '/admin/tokens')).toContain(
      'aria-current="true"',
    );
    expect(
      linkIn(hosts, '<nav aria-label="Service tokens pages"', '/admin/tokens/hosts'),
    ).toContain('aria-current="page"');

    const detail = await page(owner, `/admin/tokens/${world.serviceId}`);
    expect(linkIn(detail, '<nav class="sections"', '/admin/tokens')).toContain(
      'aria-current="true"',
    );
    expect(linkIn(detail, '<nav aria-label="Service tokens pages"', '/admin/tokens')).toContain(
      'aria-current="true"',
    );

    const audit = await page(owner, '/admin/audit');
    expect(linkIn(audit, '<nav class="sections"', '/admin')).toContain('aria-current="true"');
    expect(linkIn(audit, '<nav aria-label="Monitoring pages"', '/admin/audit')).toContain(
      'aria-current="page"',
    );
  });

  it('shows owners how many people need a decision, with a text alternative', async () => {
    await createUser({
      email: 'pending@example.com',
      role: 'viewer',
      status: 'pending',
      identity: { loginProvider: 'access', subject: 'pending-subject' },
    });
    const badge = '<span class="count">1<span class="vh"> need a decision</span></span>';
    expect(await page(owner, '/admin/requests')).toContain(badge);
    const admin = await loginAs(
      world.app,
      await createUser({ email: 'admin@example.com', role: 'admin' }),
    );
    const html = await page(admin, '/admin/requests');
    expect(html).not.toContain('class="count"');
    expect(html).toContain('<span class="badge">Admin</span>');
  });

  it('shows no badge when nobody needs a decision', async () => {
    expect(await page(owner, '/admin/requests')).not.toContain('class="count"');
  });
});

describe('health strip', () => {
  it('shows a missing keyring on other pages and links to the encryption keys', async () => {
    const app = createTestApp({ env: { TOKENGATE_KEK: '', TOKENGATE_KEYRING: '' } });
    const session = await loginAs(app, ownerUser);
    const html = await (await adminGet(app, session, '/admin/requests')).text();
    const strip = /<section class="health-strip" aria-labelledby="hs-h">(.*?)<\/section>/s.exec(
      html,
    )?.[1];
    expect(strip).toContain('<h2 id="hs-h" class="vh">System problems</h2>');
    expect(strip).toContain('Encryption keys are not loaded (keyring_absent)');
    expect(strip).toContain('<a href="/admin/tokens/keys">Open encryption keys</a>');
    expect(strip).toContain('<a href="/admin#health">Show all problems</a>');
    // The Overview lists every problem itself.
    expect(await (await adminGet(app, session, '/admin')).text()).not.toContain('health-strip');
  });

  it('is absent when nothing is wrong', async () => {
    expect(await page(owner, '/admin/requests')).not.toContain('health-strip');
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
    const res = await adminGet(world.app, viewer, '/admin/tokens/new');
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('<p>Your role does not allow this action.</p>');
    expect(html).toContain(
      '<p>Changing service tokens needs the Token manager, Admin or Owner role.</p>',
    );
    const ask = /<p class="ask">(.*?)<\/p>/s.exec(html)?.[1] ?? '';
    expect(ask).toContain('Ask a token manager:');
    // Owners come last: they can do everything, so they are the fallback.
    expect(ask.indexOf('tm@example.com')).toBeLessThan(ask.indexOf('owner@example.com'));
    expect(ask).toContain('<a href="mailto:owner@example.com">owner@example.com</a>');
    expect(ask).not.toContain('gone-tm@example.com');
    expect(ask).not.toContain('am@example.com');
    expect(ask).not.toContain('viewer@example.com');
    expect(html).toContain('<p><a href="/admin/tokens">Back</a></p>');
    expect(html).toContain('<title>Forbidden – Service tokens – tokengate</title>');
  });

  it('names at most 3 people and counts the rest', async () => {
    for (const n of [1, 2, 3, 4]) {
      await createUser({ email: `am${n}@example.com`, role: 'access_manager' });
    }
    const viewer = await loginAs(
      world.app,
      await createUser({ email: 'viewer@example.com', role: 'viewer' }),
    );
    const html = await page(viewer, '/admin/access/new');
    const ask = /<p class="ask">(.*?)<\/p>/s.exec(html)?.[1] ?? '';
    expect(ask).toContain('Ask an access manager:');
    expect(ask.match(/mailto:/g)).toHaveLength(3);
    expect(ask).toContain('and 2 more.');
  });
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

describe('notices', () => {
  it('render only known keys, never query text', async () => {
    for (const notice of ['<script>alert(1)</script>', '__proto__', 'constructor']) {
      const html = await page(
        owner,
        `/admin/tokens/${world.serviceId}?notice=${encodeURIComponent(notice)}`,
      );
      expect(html).not.toContain('class="notice"');
      expect(html).not.toContain('alert(1)');
    }
    expect(resolveNotice({ saved: () => ({ text: 'Saved.' }) }, '__proto__', null)).toBeNull();
    expect(resolveNotice({ saved: () => ({ text: 'Saved.' }) }, 'toString', null)).toBeNull();
  });

  it('render a known key after the h1, focused', async () => {
    const html = await page(owner, `/admin/tokens/${world.serviceId}?notice=disabled`);
    expect(
      html.indexOf('<div class="notice" role="status" tabindex="-1" autofocus="">'),
    ).toBeGreaterThan(html.indexOf('<h1>'));
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
