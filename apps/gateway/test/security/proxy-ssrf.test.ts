import { env } from 'cloudflare:workers';
import { describe, expect, it, onTestFinished } from 'vitest';
import { canonicalJson } from '../../src/lib/json';
import { setAdminHosts, setUpstreamHosts } from '../helpers/app';
import { sealFor, setupProxy, TEST_BASE_URL, TEST_SECRET } from '../helpers/proxy-fixtures';

/**
 * Simulates a D1-level edit of base_url that is also re-sealed for the new URL, so the credential
 * binding (I-CRED-2) would pass and only the request-time base URL check can stop the fetch.
 */
async function repointWithValidSeal(
  fx: Awaited<ReturnType<typeof setupProxy>>,
  baseUrl: string,
): Promise<void> {
  const sealed = await sealFor(
    fx.app.deps.env,
    fx.serviceId,
    baseUrl,
    canonicalJson({ kind: 'bearer' }),
    TEST_SECRET,
  );
  await env.DB.prepare('UPDATE services SET base_url = ?, credential_sealed = ? WHERE id = ?')
    .bind(baseUrl, sealed, fx.serviceId)
    .run();
}

describe('I-SSRF-1: base_url is re-validated at proxy time and fails closed without a fetch', () => {
  it.each([
    ['IPv4 literal', 'https://127.0.0.1/api'],
    ['IPv6 literal', 'https://[::1]/api'],
    ['metadata IP', 'https://169.254.169.254/latest'],
    ['localhost', 'https://localhost/api'],
    ['*.localhost', 'https://admin.localhost/api'],
    ['the gateway itself (request host)', 'https://gw.test/admin'],
    ['a workers.dev Worker', 'https://other.example.workers.dev'],
    ['plain http', 'http://api.upstream.test/v1'],
    ['userinfo', 'https://user:pass@api.upstream.test/v1'],
    ['single-label host', 'https://intranet/v1'],
  ])('%s', async (_label, baseUrl) => {
    const fx = await setupProxy();
    await repointWithValidSeal(fx, baseUrl);
    const response = await fx.call('/a');
    expect(response.status).toBe(503);
    expect(response.headers.get('x-tokengate-error')).toBe('not_configured');
    expect(fx.upstreamCalls).toHaveLength(0);
    const [record] = await fx.records();
    expect(record?.reason).toBe('base_url_invalid');
  });

  it('an admin host is refused even when the request arrives on another host', async () => {
    const fx = await setupProxy();
    onTestFinished(() => setAdminHosts(null));
    await setAdminHosts(['gw.test', '*.tokengate.example.com']);
    await repointWithValidSeal(fx, 'https://eu.tokengate.example.com/admin');
    const response = await fx.call('/a');
    expect(response.status).toBe(503);
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('the upstream host allowlist setting is enforced at proxy time, on the next request', async () => {
    onTestFinished(() => setUpstreamHosts(null));
    const fx = await setupProxy();
    await setUpstreamHosts(['api.example.com']);
    const response = await fx.call('/a');
    expect(response.status).toBe(503);
    expect(fx.upstreamCalls).toHaveLength(0);

    await setUpstreamHosts(['*.upstream.test']);
    expect((await fx.call('/a')).status).toBe(200);
  });

  it('a malformed stored allowlist denies every host', async () => {
    onTestFinished(() => setUpstreamHosts(null));
    const fx = await setupProxy();
    await setUpstreamHosts(['*.upstream.test']);
    await env.DB.prepare(
      "UPDATE settings SET value = '[\"https://x\"]' WHERE key = 'allowed_upstream_hosts'",
    ).run();
    expect((await fx.call('/a')).status).toBe(503);
    expect(fx.upstreamCalls).toHaveLength(0);
  });
});

describe('I-PATH-1: the upstream URL stays on the base origin and under the base path', () => {
  it.each(['/a/..%2fb', '/a%2f..%2fb', '/a/%2e%2e%2fb', '/%c0%ae%c0%ae/b', '/a//b'])(
    '%s → 400 path_invalid without a fetch',
    async (path) => {
      const fx = await setupProxy();
      const response = await fx.call(path);
      expect(response.status).toBe(400);
      expect(response.headers.get('x-tokengate-error')).toBe('path_invalid');
      expect(fx.upstreamCalls).toHaveLength(0);
    },
  );

  // The WHATWG URL parser resolves ".", "..", ".%2e", "%2e%2e" and reads "\" as "/" before the
  // Worker sees the request: such paths are either routed away from /proxy or stay under base.
  it.each(['/../../admin', '/a/../../other/x', '/a/.%2e/b', '/a/%2e%2e/%2e%2e/x', '/a\\..\\..\\x'])(
    '%s never reaches a URL outside the base path',
    async (path) => {
      const fx = await setupProxy();
      await fx.call(path);
      for (const call of fx.upstreamCalls) {
        expect(call.url.startsWith(`${TEST_BASE_URL}/`)).toBe(true);
      }
    },
  );

  it.each(['/@evil.example/x', '/:@evil.example', '/a?@evil.example'])(
    '%s keeps the upstream origin',
    async (path) => {
      const fx = await setupProxy();
      expect((await fx.call(path)).status).toBe(200);
      expect(new URL(fx.upstreamCalls[0]?.url ?? '').origin).toBe('https://api.upstream.test');
    },
  );

  it('path injection: the caller path cannot reach outside the credential segment', async () => {
    const fx = await setupProxy({
      service: {
        baseUrl: 'https://hooks.upstream.test/services',
        injection: { kind: 'path' },
        secret: 'T000/B000/XYZ123',
      },
    });
    expect((await fx.call('/..%2fother')).status).toBe(400);
    expect((await fx.call('/x')).status).toBe(200);
    expect(fx.upstreamCalls.map((c) => c.url)).toEqual([
      'https://hooks.upstream.test/services/T000/B000/XYZ123/x',
    ]);
  });
});
