// Credentials › Allowed hosts (`/admin/credentials/hosts`): the upstream host allowlist (I-SSRF-1).
// Owners edit it (settings:write) by picking candidate hosts plus typed others.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerTokenHostsRoutes } from '../../src/admin/routes/token-hosts';
import { getAllowedUpstreamHosts } from '../../src/db/settings';
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
import { setUpstreamHosts } from '../helpers/app';
import { opsDeps, seedService } from '../unit/admin/ops/helpers';

const T0 = Date.UTC(2026, 9, 13, 12);

let app: AdminTestApp;

beforeEach(async () => {
  await resetControlPlane();
  app = createAdminTestApp({ routes: registerTokenHostsRoutes, now: () => T0 });
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

/** The checkbox of `host` in the page's host CheckboxGroup. */
function hostBox(html: string, host: string): string {
  return (
    new RegExp(`<input type="checkbox"[^>]*value="${host.replaceAll('.', '\\.')}"[^>]*>`).exec(
      html,
    )?.[0] ?? ''
  );
}

describe('I-SSRF-1: upstream host allowlist at /admin/credentials/hosts', () => {
  it('defaults to any host; owners get the mode choice and the candidate hosts', async () => {
    const res = await adminGet(app, await sessionFor('owner'), '/admin/credentials/hosts');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Allowed hosts – Settings – tokengate</title>');
    expect(html).toContain('action="/admin/credentials/hosts"');
    expect(html).toMatch(/name="mode" value="any" checked=""/);
    // Template hosts are candidates; none is checked while any host is allowed.
    expect(hostBox(html, 'slack.com')).not.toContain('checked');
    expect(html).toContain('Template: Slack Web API');
    expect(html).toContain('name="other_hosts"');
    // The edit is a dialog behind "Change…" (a settings card), with the host list revealed by
    // the "Only" choice; inside that branch nothing carries native validation (A7.6).
    expect(html).toContain('commandfor="dlg-hosts"');
    expect(html).toMatch(/<dialog class="dlg wide lform" id="dlg-hosts"/);
    const reveal = /<div class="rv1 subbox" data-o="2">[\s\S]*?<\/textarea>/.exec(html)?.[0] ?? '';
    expect(reveal).toContain('name="host"');
    expect(reveal).toContain('name="other_hosts"');
    expect(reveal).not.toMatch(/ required| pattern=/);
    expect(html).toContain('Any public HTTPS host');
  });

  it('shows the list read-only to admins, with who to ask', async () => {
    await setUpstreamHosts(['api.github.com']);
    await createUser({ email: 'boss@example.com', role: 'owner' }, T0);
    const html = await (
      await adminGet(app, await sessionFor('admin'), '/admin/credentials/hosts')
    ).text();
    expect(html).toContain('<code>api.github.com</code>');
    expect(html).toContain('mailto:boss@example.com');
    expect(html).not.toContain('action="/admin/credentials/hosts"');
  });

  it('checks only hosts that the stored list contains literally, and keeps the others typed', async () => {
    await setUpstreamHosts(['api.github.com', '*.slack.com', 'unused.example.org']);
    const owner = await sessionFor('owner');
    await seedService(opsDeps(), {
      slug: 'hook',
      base_url: 'https://hooks.slack.com/services',
      injection: { kind: 'path' },
      forward_headers: [],
    });
    await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    const html = await (await adminGet(app, owner, '/admin/credentials/hosts')).text();
    expect(html).toMatch(/name="mode" value="list" checked=""/);
    expect(hostBox(html, 'api.github.com')).toContain('checked');
    // Covered by a wildcard: not checked, so a save never adds it silently.
    expect(hostBox(html, 'hooks.slack.com')).not.toContain('checked');
    expect(html).toContain('Already allowed by *.slack.com.');
    expect(html).toContain('Unchecking stops this token.');
    expect(html).toMatch(
      /<textarea[^>]*name="other_hosts"[^>]*>\*\.slack\.com\nunused\.example\.org<\/textarea>/,
    );
  });

  it('owners save picked and typed hosts (a pasted URL becomes its host), then any host', async () => {
    const owner = await sessionFor('owner');
    const save = await adminPost(app, owner, '/admin/credentials/hosts', {
      mode: 'list',
      host: ['api.github.com'],
      other_hosts: 'https://API.Slack.com/api\n*.example.net',
    });
    expect(save.headers.get('location')).toBe('/admin/credentials/hosts?notice=hosts_saved');
    expect(await getAllowedUpstreamHosts(env.DB)).toEqual([
      'api.github.com',
      'api.slack.com',
      '*.example.net',
    ]);
    const any = await adminPost(app, owner, '/admin/credentials/hosts', {
      mode: 'any',
      host: ['api.github.com'],
    });
    expect(any.headers.get('location')).toBe('/admin/credentials/hosts?notice=hosts_saved');
    expect(await getAllowedUpstreamHosts(env.DB)).toBeNull();
    const again = await adminPost(app, owner, '/admin/credentials/hosts', { mode: 'any' });
    expect(again.headers.get('location')).toBe('/admin/credentials/hosts?notice=hosts_unchanged');
    expect(await auditActions()).toEqual(['settings.upstream_hosts', 'settings.upstream_hosts']);
  });

  it('refuses "Only" with nothing chosen: an empty list would mean any host', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/credentials/hosts', {
      mode: 'list',
      other_hosts: '  ',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Choose at least one host, or choose Any public HTTPS host.');
    // The group's error links to its first box (a fieldset cannot take focus).
    expect(html).toContain('href="#f-host-1"');
    expect(await getAllowedUpstreamHosts(env.DB)).toBeNull();
  });

  it('refuses IPs, localhost and workers.dev with the line number, and keeps the input', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/credentials/hosts', {
      mode: 'list',
      other_hosts: 'api.github.com\n10.0.0.1\nlocalhost\nx.workers.dev',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Line 2: 10.0.0.1 is an IP address');
    expect(html).toContain('Line 3: localhost is not a public host');
    expect(html).toContain('Line 4: x.workers.dev is a workers.dev Worker');
    expect(html).toContain('href="#f-other_hosts"');
    expect(html).toMatch(/<textarea[^>]*>api\.github\.com\n10\.0\.0\.1/);
    expect(await getAllowedUpstreamHosts(env.DB)).toBeNull();
  });

  it('flags a malformed stored value: every host is refused until it is saved', async () => {
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('allowed_upstream_hosts', '\"oops\"', 0, NULL)",
    ).run();
    const html = await (
      await adminGet(app, await sessionFor('owner'), '/admin/credentials/hosts')
    ).text();
    expect(html).toContain('The stored list is invalid, so every host is refused.');
  });

  it('lists tokens outside the list, with links to them', async () => {
    const owner = await sessionFor('owner');
    const id = await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    await setUpstreamHosts(['only.example.com']);
    const html = await (await adminGet(app, owner, '/admin/credentials/hosts')).text();
    expect(html).toContain('<caption class="vh">Tokens outside the allowed hosts</caption>');
    expect(html).toContain(`<a class="ent-n" href="/admin/credentials/${id}">GitHub</a>`);
    expect(html).toContain('Used by GitHub, which is refused now. Check to allow.');
  });

  it('is forbidden for admins', async () => {
    const res = await adminPost(app, await sessionFor('admin'), '/admin/credentials/hosts', {
      mode: 'list',
      host: ['api.github.com'],
    });
    expect(res.status).toBe(403);
    expect(await getAllowedUpstreamHosts(env.DB)).toBeNull();
  });
});
