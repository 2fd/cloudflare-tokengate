import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../../src/http/security';
import { createTestApp } from '../helpers/app';

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
    const app2 = createTestApp({ env: { PUBLIC_URL: 'http://localhost:8787' } });
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

  it('with PUBLIC_URL, /admin answers 404 on any other origin', async () => {
    const app = createTestApp({ env: { PUBLIC_URL: 'https://admin.example.com' } });
    for (const path of ['/admin', '/admin/services', '/admin/users/x']) {
      const res = await app.request(path, {
        origin: 'https://tokengate.acme.workers.dev',
        redirect: 'manual',
      });
      expect(res.status, path).toBe(404);
      expectBrowserHeaders(res);
    }
    // On the pinned origin the request reaches the Access check (no JWT here: 401).
    const pinned = await app.request('/admin', { origin: 'https://admin.example.com' });
    expect(pinned.status).toBe(401);
    const otherPort = await app.request('/admin', { origin: 'https://admin.example.com:8443' });
    expect(otherPort.status).toBe(404);
  });

  it('percent-encoded /admin paths are pinned like the plain ones', async () => {
    // Hono routes on the decoded path, so `/%61dmin` reaches the admin pages.
    const app = createTestApp({ env: { PUBLIC_URL: 'https://admin.example.com' } });
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
    const app = createTestApp({ env: { PUBLIC_URL: 'https://admin.example.com' } });
    const res = await app.request('/proxy/x/y', { origin: 'https://tokengate.acme.workers.dev' });
    expect(res.status).not.toBe(404);
    expect(res.headers.get('x-tokengate-source')).toBe('gateway');
  });

  it('a malformed PUBLIC_URL closes /admin everywhere', async () => {
    const app = createTestApp({ env: { PUBLIC_URL: 'http://admin.example.com' } });
    for (const origin of ['http://admin.example.com', 'https://gw.test']) {
      expect((await app.request('/admin', { origin, redirect: 'manual' })).status).toBe(404);
    }
  });
});
