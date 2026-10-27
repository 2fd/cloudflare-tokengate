import { env } from 'cloudflare:workers';
import { describe, expect, it, onTestFinished } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../../src/http/security';
import { adminGet, createUser, loginAs, resetControlPlane } from '../helpers/admin-auth';
import { createTestApp } from '../helpers/app';

function expectBrowserHeaders(res: Response, https = true) {
  expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('strict-transport-security')).toBe(https ? 'max-age=31536000' : null);
}

describe('I-DEPLOY-1: security headers and admin hostnames', () => {
  it('CSP forbids scripts, framing and foreign form targets', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("form-action 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('script-src');
  });

  it.each(['/admin', '/admin/credentials', '/admin/nope'])(
    'sets headers and no-store on %s',
    async (path) => {
      const app = createTestApp();
      const res = await app.request(path, { redirect: 'manual' });
      expectBrowserHeaders(res);
      expect(res.headers.get('cache-control')).toBe('no-store');
    },
  );

  it('sets the same headers and no-store on the signed-in 404 page', async () => {
    onTestFinished(() => resetControlPlane());
    const app = createTestApp();
    const owner = await createUser({ email: 'o@example.com', role: 'owner' });
    const res = await adminGet(app, await loginAs(app, owner), '/admin/nope');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Page not found');
    expectBrowserHeaders(res);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

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

  it('/admin answers 404 on workers.dev and on plain http off loopback', async () => {
    const app = createTestApp();
    for (const origin of ['https://tokengate.acme.workers.dev', 'http://gw.test']) {
      for (const path of ['/admin', '/admin/credentials', '/admin/users/x']) {
        const res = await app.request(path, { origin, redirect: 'manual' });
        expect(res.status, `${origin}${path}`).toBe(404);
        expectBrowserHeaders(res, origin.startsWith('https:'));
      }
    }
    // Any other https hostname reaches the Access check (no JWT here: 401), whatever its port.
    for (const origin of ['https://gw.test', 'https://admin.example.com:8443']) {
      expect((await app.request('/admin', { origin })).status, origin).toBe(401);
    }
  });

  it('ignores an admin_hosts row left by an older version', async () => {
    onTestFinished(async () => {
      await env.DB.prepare("DELETE FROM settings WHERE key = 'admin_hosts'").run();
    });
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by)
       VALUES ('admin_hosts', '["admin.example.com"]', 0, NULL)`,
    ).run();
    const app = createTestApp();
    expect((await app.request('/admin', { origin: 'https://gw.test' })).status).toBe(401);
  });

  it('percent-encoded /admin paths are checked like the plain ones', async () => {
    // Hono routes on the decoded path, so `/%61dmin` reaches the admin pages.
    const app = createTestApp();
    for (const path of ['/%61dmin', '/%61dmin/credentials', '/%41dmin/../%61dmin/users']) {
      const res = await app.request(path, {
        origin: 'https://tokengate.acme.workers.dev',
        redirect: 'manual',
      });
      expect(res.status, path).toBe(404);
      expect(res.headers.get('cache-control'), path).toBe('no-store');
    }
    const served = await app.request('/%61dmin', { origin: 'https://admin.example.com' });
    expect(served.status).toBe(401);
    expect(served.headers.get('cache-control')).toBe('no-store');
    expectBrowserHeaders(served);
  });

  it('the proxy stays reachable on every host', async () => {
    const app = createTestApp();
    const res = await app.request('/proxy/x/y', { origin: 'https://tokengate.acme.workers.dev' });
    expect(res.status).not.toBe(404);
    expect(res.headers.get('x-tokengate-source')).toBe('gateway');
  });
});
