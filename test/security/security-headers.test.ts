import { env } from 'cloudflare:workers';
import { describe, expect, it, onTestFinished } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../../src/http/security';
import { createTestApp, setAdminHosts } from '../helpers/app';

async function withAdminHosts(hosts: string[]): Promise<void> {
  onTestFinished(() => setAdminHosts(null));
  await setAdminHosts(hosts);
}

function expectBrowserHeaders(res: Response, https = true) {
  expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('strict-transport-security')).toBe(https ? 'max-age=31536000' : null);
}

describe('I-DEPLOY-1: security headers and host pinning', () => {
  it('CSP forbids scripts, framing and foreign form targets', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("form-action 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('script-src');
  });

  it.each(['/admin', '/admin/services', '/admin/nope'])(
    'sets headers and no-store on %s',
    async (path) => {
      const app = createTestApp();
      const res = await app.request(path, { redirect: 'manual' });
      expectBrowserHeaders(res);
      expect(res.headers.get('cache-control')).toBe('no-store');
    },
  );

  it('sets headers on other worker responses without forcing no-store', async () => {
    const app = createTestApp();
    for (const path of ['/', '/not-a-route']) {
      const res = await app.request(path, { redirect: 'manual' });
      expectBrowserHeaders(res);
      expect(res.headers.get('cache-control')).toBeNull();
    }
  });

  it('omits HSTS on plain http (local development)', async () => {
    const app2 = createTestApp();
    const res = await app2.request('/admin', { origin: 'http://localhost:8787' });
    expectBrowserHeaders(res, false);
  });

  it('does not touch proxy responses', async () => {
    const app = createTestApp();
    const res = await app.request('/proxy/some-service/v1/items');
    expect(res.headers.get('x-tokengate-source')).toBe('gateway');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('referrer-policy')).toBeNull();
  });

  it('with admin hosts set, /admin answers 404 on any other host', async () => {
    await withAdminHosts(['admin.example.com']);
    const app = createTestApp();
    for (const origin of ['https://tokengate.acme.workers.dev', 'https://gw.test']) {
      for (const path of ['/admin', '/admin/services', '/admin/users/x']) {
        const res = await app.request(path, { origin, redirect: 'manual' });
        expect(res.status, `${origin}${path}`).toBe(404);
        expectBrowserHeaders(res);
      }
    }
    // On the listed host the request reaches the Access check (no JWT here: 401). The port is
    // ignored; plain http is refused on a non-loopback host.
    const pinned = await app.request('/admin', { origin: 'https://admin.example.com' });
    expect(pinned.status).toBe(401);
    const otherPort = await app.request('/admin', { origin: 'https://admin.example.com:8443' });
    expect(otherPort.status).toBe(401);
    const http = await app.request('/admin', { origin: 'http://admin.example.com' });
    expect(http.status).toBe(404);
  });

  it('a wildcard admin host covers subdomains, not the domain itself', async () => {
    await withAdminHosts(['*.example.com']);
    const app = createTestApp();
    expect((await app.request('/admin', { origin: 'https://a.example.com' })).status).toBe(401);
    expect((await app.request('/admin', { origin: 'https://example.com' })).status).toBe(404);
  });

  it('before the first sign-in, /admin answers on any host except workers.dev', async () => {
    const app = createTestApp();
    expect((await app.request('/admin', { origin: 'https://gw.test' })).status).toBe(401);
    expect(
      (await app.request('/admin', { origin: 'https://tokengate.acme.workers.dev' })).status,
    ).toBe(404);
  });

  it('percent-encoded /admin paths are pinned like the plain ones', async () => {
    await withAdminHosts(['admin.example.com']);
    // Hono routes on the decoded path, so `/%61dmin` reaches the admin pages.
    const app = createTestApp();
    for (const path of ['/%61dmin', '/%61dmin/services', '/%41dmin/../%61dmin/users']) {
      const res = await app.request(path, {
        origin: 'https://tokengate.acme.workers.dev',
        redirect: 'manual',
      });
      expect(res.status, path).toBe(404);
      expect(res.headers.get('cache-control'), path).toBe('no-store');
    }
    const pinned = await app.request('/%61dmin', { origin: 'https://admin.example.com' });
    expect(pinned.status).toBe(401);
    expect(pinned.headers.get('cache-control')).toBe('no-store');
    expectBrowserHeaders(pinned);
  });

  it('the proxy stays reachable on every host', async () => {
    await withAdminHosts(['admin.example.com']);
    const app = createTestApp();
    const res = await app.request('/proxy/x/y', { origin: 'https://tokengate.acme.workers.dev' });
    expect(res.status).not.toBe(404);
    expect(res.headers.get('x-tokengate-source')).toBe('gateway');
  });

  it('a stored admin host list that is not valid closes /admin everywhere', async () => {
    onTestFinished(() => setAdminHosts(null));
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by)
       VALUES ('admin_hosts', '["https://admin.example.com"]', 0, NULL)`,
    ).run();
    const app = createTestApp();
    for (const origin of ['https://admin.example.com', 'https://gw.test', 'http://localhost']) {
      expect((await app.request('/admin', { origin, redirect: 'manual' })).status).toBe(404);
    }
  });
});
