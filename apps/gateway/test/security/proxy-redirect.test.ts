import { describe, expect, it } from 'vitest';
import { setupProxy, TEST_SECRET } from '../helpers/proxy-fixtures';

const redirect =
  (location: string, extra: Record<string, string> = {}) =>
  () =>
    new Response(null, { status: 302, headers: { location, ...extra } });

describe('I-REDIR-1: redirects are returned, never followed, and rewritten or dropped', () => {
  it('fetches with redirect: manual and does not follow a 302', async () => {
    const fx = await setupProxy({ upstream: redirect('https://evil.example/steal') });
    const response = await fx.call('/a');
    expect(response.status).toBe(302);
    expect(fx.upstreamCalls).toHaveLength(1);
    expect(fx.upstreamCalls[0]?.redirect).toBe('manual');
    // Cross-origin Location passes through unchanged; the caller follows it without credentials.
    expect(response.headers.get('location')).toBe('https://evil.example/steal');
  });

  it('rewrites a same-origin Location under the base path to the gateway', async () => {
    const fx = await setupProxy({ upstream: redirect('/v1/items/2?page=3') });
    const response = await fx.call('/items/1');
    expect(response.headers.get('location')).toBe('https://gw.test/proxy/echo/items/2?page=3');
  });

  it('drops a same-origin Location outside the base path', async () => {
    const fx = await setupProxy({ upstream: redirect('https://api.upstream.test/admin') });
    const response = await fx.call('/a');
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-tokengate-redirect-blocked')).toBe('1');
  });

  it('removes the path-injected secret from a rewritten Location', async () => {
    const fx = await setupProxy({
      service: {
        baseUrl: 'https://hooks.upstream.test/services',
        injection: { kind: 'path' },
        secret: 'T000/B000/XYZ123',
      },
      upstream: redirect('https://hooks.upstream.test/services/T000/B000/XYZ123/next'),
    });
    const response = await fx.call('');
    expect(response.headers.get('location')).toBe('https://gw.test/proxy/echo/next');
  });

  it('removes the query-injected secret from a rewritten Location', async () => {
    const fx = await setupProxy({
      service: { injection: { kind: 'query', param: 'key' } },
      upstream: redirect(`/v1/next?key=${encodeURIComponent(TEST_SECRET)}&a=1`),
    });
    const response = await fx.call('/a');
    expect(response.headers.get('location')).toBe('https://gw.test/proxy/echo/next?a=1');
  });

  it('rewrites Link values under base and drops the others', async () => {
    const fx = await setupProxy({
      upstream: () =>
        new Response('[]', {
          headers: {
            link: '<https://api.upstream.test/v1/items?page=2>; rel="next", <https://other.example/x>; rel="help"',
          },
        }),
    });
    const response = await fx.call('/items');
    expect(response.headers.get('link')).toBe(
      '<https://gw.test/proxy/echo/items?page=2>; rel="next"',
    );
  });
});

describe('I-RESP-1: upstream response headers are filtered and echoed credentials redacted', () => {
  it('drops cookies, auth challenges, hop-by-hop headers and spoofed x-tokengate-* headers', async () => {
    const fx = await setupProxy({
      upstream: () =>
        new Response('{}', {
          headers: {
            'set-cookie': 'session=upstream',
            'www-authenticate': 'Bearer realm="upstream"',
            'proxy-authenticate': 'Basic',
            'alt-svc': 'h3=":443"',
            'x-tokengate-source': 'gateway',
            'x-tokengate-request-id': 'req_spoofed',
            'x-tokengate-error': 'not_configured',
            'x-tokengate-redacted': 'nothing',
            'x-kept': '1',
          },
        }),
    });
    const response = await fx.call('/a');
    expect(response.status).toBe(200);
    for (const name of [
      'set-cookie',
      'www-authenticate',
      'proxy-authenticate',
      'alt-svc',
      'x-tokengate-error',
      'x-tokengate-redacted',
    ]) {
      expect(response.headers.get(name), name).toBeNull();
    }
    expect(response.headers.get('x-tokengate-source')).toBe('upstream');
    expect(response.headers.get('x-tokengate-request-id')).toMatch(/^req_[0-9A-Z]{26}$/);
    expect(response.headers.get('x-kept')).toBe('1');
  });

  it('redacts a cross-origin Location that carries the query-injected credential', async () => {
    const fx = await setupProxy({
      service: { injection: { kind: 'query', param: 'key' } },
      upstream: redirect(`https://evil.example/cb?key=${encodeURIComponent(TEST_SECRET)}`),
    });
    const response = await fx.call('/a');
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-tokengate-redacted')).toBe('location');
  });

  it('redacts headers echoing the basic credential in base64', async () => {
    const fx = await setupProxy({
      service: { injection: { kind: 'basic', username: 'api' } },
      upstream: (call) =>
        new Response('{}', {
          headers: { 'x-debug-auth': call.headers.get('authorization') ?? '' },
        }),
    });
    const response = await fx.call('/a');
    expect(response.headers.get('x-debug-auth')).toBeNull();
    expect(response.headers.get('x-tokengate-redacted')).toBe('x-debug-auth');
  });

  it('gateway error bodies never contain the credential', async () => {
    const fx = await setupProxy({ service: { timeoutMs: 1000 } });
    fx.setUpstream(() => {
      throw new TypeError(`connect https://api.upstream.test/?key=${TEST_SECRET}`);
    });
    const response = await fx.call('/a');
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(TEST_SECRET);
  });
});
