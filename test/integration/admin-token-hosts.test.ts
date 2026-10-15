// Service tokens › Allowed hosts (`/admin/tokens/hosts`): the upstream host allowlist (I-SSRF-1).
// Owners edit it (settings:write).
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
import { opsDeps, seedService } from '../unit/admin/ops/helpers';

const T0 = Date.UTC(2026, 9, 13, 12);

let app: AdminTestApp;

beforeEach(async () => {
  await resetControlPlane();
  await env.DB.prepare('DELETE FROM services').run();
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

describe('I-SSRF-1: upstream host allowlist at /admin/tokens/hosts', () => {
  it('defaults to any host and shows owners an empty allowlist form', async () => {
    const res = await adminGet(app, await sessionFor('owner'), '/admin/tokens/hosts');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Allowed hosts · tokengate</title>');
    expect(html).toContain('action="/admin/tokens/hosts"');
    expect(html).toContain('name="allowed_upstream_hosts"');
  });

  it('shows the list read-only to admins', async () => {
    const html = await (
      await adminGet(app, await sessionFor('admin'), '/admin/tokens/hosts')
    ).text();
    expect(html).toContain('Any public https host is allowed.');
    expect(html).toContain('Only owners can change this.');
    expect(html).not.toContain('action="/admin/tokens/hosts"');
  });

  it('owners save, normalize and clear the list, each with one audit row', async () => {
    const owner = await sessionFor('owner');
    const save = await adminPost(app, owner, '/admin/tokens/hosts', {
      allowed_upstream_hosts: 'API.GitHub.com\n*.slack.com, api.github.com',
    });
    expect(save.headers.get('location')).toBe('/admin/tokens/hosts?notice=hosts_saved');
    expect(await getAllowedUpstreamHosts(env.DB)).toEqual(['api.github.com', '*.slack.com']);
    const clear = await adminPost(app, owner, '/admin/tokens/hosts', {
      allowed_upstream_hosts: '  ',
    });
    expect(clear.headers.get('location')).toBe('/admin/tokens/hosts?notice=hosts_saved');
    expect(await getAllowedUpstreamHosts(env.DB)).toBeNull();
    expect(await auditActions()).toEqual(['settings.upstream_hosts', 'settings.upstream_hosts']);
  });

  it('rejects malformed entries and keeps the previous list', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/tokens/hosts', {
      allowed_upstream_hosts: 'api.github.com\nhttps://evil.example',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('https://evil.example');
    expect(await getAllowedUpstreamHosts(env.DB)).toBeNull();
  });

  it('warns about services that point outside the list, with links to them', async () => {
    const owner = await sessionFor('owner');
    const id = await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    await adminPost(app, owner, '/admin/tokens/hosts', {
      allowed_upstream_hosts: 'only.example.com',
    });
    const html = await (await adminGet(app, owner, '/admin/tokens/hosts')).text();
    expect(html).toContain('These services point outside the allowlist');
    expect(html).toContain(`<a href="/admin/tokens/${id}">gh</a>`);
  });

  it('is forbidden for admins', async () => {
    const res = await adminPost(app, await sessionFor('admin'), '/admin/tokens/hosts', {
      allowed_upstream_hosts: 'api.github.com',
    });
    expect(res.status).toBe(403);
    expect(await getAllowedUpstreamHosts(env.DB)).toBeNull();
  });
});
