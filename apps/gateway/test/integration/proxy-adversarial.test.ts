// Hostile callers, hostile upstreams, tampered rows and failing bindings against the full pipeline.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ProxyFixture,
  sealFor,
  setupProxy,
  TEST_BASE_URL,
  TEST_SECRET,
} from '../helpers/proxy-fixtures';

afterEach(() => {
  vi.restoreAllMocks();
});

const errorOf = (response: Response) => response.headers.get('x-tokengate-error');

/** Captures console output so tests can assert nothing sensitive is logged. */
function captureConsole(): () => string {
  const lines: unknown[][] = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });
  }
  return () => JSON.stringify(lines);
}

/** Rewrites the stored binding (base_url, injection) and re-seals the credential for it, as only
 * someone holding both D1 write access and the KEK could. */
async function rebind(fx: ProxyFixture, baseUrl: string, injectionJson: string): Promise<void> {
  const sealed = await sealFor(fx.app.deps.env, fx.serviceId, baseUrl, injectionJson, TEST_SECRET);
  await env.DB.prepare(
    'UPDATE credentials SET base_url = ?, injection = ?, credential_sealed = ? WHERE id = ?',
  )
    .bind(baseUrl, injectionJson, sealed, fx.serviceId)
    .run();
}

describe('proxy: authorization scope', () => {
  it('a credential access rule for another issuer on the same credential does not apply to callers of this issuer', async () => {
    const fx = await setupProxy({ rule: false });
    await fx.addRule({
      profile: 'generic',
      issuer: 'https://ci.example.org',
      jwksUri: 'https://ci.example.org/jwks',
      allowedAlgs: ['RS256'],
      tenantPin: [],
      anchorClaims: ['sub'],
      conditions: [{ claim: 'sub', match: 'exact', values: ['ci'] }],
    });
    const response = await fx.call('/a');
    expect(response.status).toBe(401);
    expect(errorOf(response)).toBe('issuer_unknown');
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('method-override headers are never forwarded, so rules see the real method', async () => {
    const fx = await setupProxy({
      rule: { rules: [{ methods: ['GET'], path: '/**' }] },
      service: { forwardHeaders: ['x-request-id'] },
    });
    const response = await fx.call('/a', {
      headers: {
        'x-http-method-override': 'DELETE',
        'x-http-method': 'DELETE',
        'x-method-override': 'DELETE',
        'x-request-id': 'r1',
      },
    });
    expect(response.status).toBe(200);
    const headers = [...(fx.upstreamCalls[0]?.headers ?? [])].map(([name]) => name);
    expect(headers).toContain('x-request-id');
    expect(headers.filter((name) => name.includes('method'))).toEqual([]);
  });

  it('URL and method override headers in stored forward_headers are dropped at request time', async () => {
    const overrides = ['x-original-url', 'x-rewrite-url', 'x-original-method', 'x-override-url'];
    const fx = await setupProxy({
      rule: { rules: [{ methods: ['GET'], path: '/a' }] },
      service: { forwardHeaders: [...overrides, 'x-request-id'] },
    });
    const response = await fx.call('/a', {
      headers: {
        'x-original-url': '/admin/delete',
        'x-rewrite-url': '/admin/delete',
        'x-original-method': 'DELETE',
        'x-override-url': '/admin/delete',
        'x-request-id': 'r1',
      },
    });
    expect(response.status).toBe(200);
    const headers = [...(fx.upstreamCalls[0]?.headers ?? [])].map(([name]) => name);
    expect(headers).toContain('x-request-id');
    for (const name of overrides) expect(headers).not.toContain(name);
  });

  it('a lowercase method is matched and forwarded in upper case', async () => {
    const fx = await setupProxy({ rule: { rules: [{ methods: ['PATCH'], path: '/**' }] } });
    const response = await fx.call('/a', { method: 'patch', body: '{}' });
    expect(response.status).toBe(200);
    expect(fx.upstreamCalls[0]?.method).toBe('PATCH');
  });
});

describe('proxy: tampered service rows', () => {
  it('a non-canonical stored injection is refused even when the seal matches it', async () => {
    const fx = await setupProxy();
    await rebind(fx, TEST_BASE_URL, '{"name":"x-api-key","kind":"header"}');
    const response = await fx.call('/a');
    expect(response.status).toBe(503);
    expect(errorOf(response)).toBe('credential_unavailable');
    expect(fx.upstreamCalls).toHaveLength(0);
    expect((await fx.records())[0]?.reason).toBe('injection_invalid');
  });

  it.each([
    ['trailing slash', `${TEST_BASE_URL}/`],
    ['upper-case host', 'https://API.upstream.test/v1'],
    ['explicit default port', 'https://api.upstream.test:443/v1'],
  ])(
    'a base_url not in normalized form (%s) is refused even when the seal matches it',
    async (_label, baseUrl) => {
      const fx = await setupProxy();
      await rebind(fx, baseUrl, '{"kind":"bearer"}');
      const response = await fx.call('/a');
      expect(response.status).toBe(503);
      expect(errorOf(response)).toBe('not_configured');
      expect(fx.upstreamCalls).toHaveLength(0);
      expect((await fx.records())[0]?.reason).toBe('base_url_invalid');
    },
  );
});

describe('proxy: failing dependencies', () => {
  it('a D1 outage answers 500 internal_error and logs the error name only', async () => {
    const fx = await setupProxy();
    const logs = captureConsole();
    fx.app.deps.env.DB = {
      prepare: () => ({ bind: () => ({}) }),
      batch: async () => {
        throw new Error(`D1_ERROR: ${TEST_SECRET}`);
      },
    } as unknown as D1Database;
    const response = await fx.call('/a');
    expect(response.status).toBe(500);
    expect(response.headers.get('x-tokengate-error')).toBe('internal_error');
    expect(response.headers.get('x-tokengate-request-id')).toMatch(/^req_/);
    expect(fx.upstreamCalls).toHaveLength(0);
    const [record] = await fx.records();
    expect(record).toMatchObject({
      outcome: 'error',
      reason: 'internal_error',
      claims_verified: 0,
    });
    expect(logs()).not.toContain(TEST_SECRET);
    expect(logs()).toContain('proxy.internal_error');
  });

  it('a throwing rate limiter binding does not block traffic and is logged by code', async () => {
    const fx = await setupProxy({
      env: {
        PROXY_RATE_LIMITER: {
          limit: async () => {
            throw new Error('limiter down');
          },
        } as RateLimit,
      },
    });
    const logs = captureConsole();
    expect((await fx.call('/a')).status).toBe(200);
    expect(logs()).toContain('proxy.rate_limiter_failed');
    expect(logs()).not.toContain('limiter down');
  });

  it('a limiter result without success: true is a denial', async () => {
    const fx = await setupProxy({
      env: { PROXY_RATE_LIMITER: { limit: async () => ({}) } as unknown as RateLimit },
    });
    expect((await fx.call('/a')).status).toBe(429);
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('upstream failure logs carry no URL, so a path-injected secret is not logged', async () => {
    const fx = await setupProxy({
      service: {
        baseUrl: 'https://hooks.upstream.test/credentials',
        injection: { kind: 'path' },
        secret: 'T000/B000/XYZ123secret',
      },
    });
    fx.setUpstream((call) => {
      throw new TypeError(`connect ${call.url}`);
    });
    const logs = captureConsole();
    expect((await fx.call('')).status).toBe(502);
    const records = await fx.records();
    const everything = JSON.stringify({ logs: logs(), records });
    expect(everything).not.toContain('XYZ123secret');
    expect(everything).toContain('upstream_unreachable');
  });
});

describe('proxy: pre-trust failures', () => {
  it('a hostile issuer is truncated in the hint and the record', async () => {
    const fx = await setupProxy();
    const iss = `https://${'a'.repeat(2000)}.example`;
    const response = await fx.call('/a', { token: await fx.issuer.sign({ iss, sub: 'x' }) });
    expect(response.status).toBe(401);
    expect(errorOf(response)).toBe('issuer_unknown');
    const body = (await response.json()) as { message: string };
    expect(body.message.length).toBeLessThan(400);
    const [record] = await fx.records();
    expect(record?.untrusted_iss).toHaveLength(128);
    expect(record?.claims_verified).toBe(0);
  });

  it('405 is recorded as a pre-trust denial without caller fields', async () => {
    const fx = await setupProxy();
    const response = await fx.call('/a', { method: 'TRACE' });
    expect(response.status).toBe(405);
    expect(response.headers.get('x-tokengate-request-id')).toMatch(/^req_/);
    const [record] = await fx.records();
    expect(record).toMatchObject({
      outcome: 'denied',
      reason: 'method_not_allowed',
      claims_verified: 0,
      caller_claims: null,
      untrusted_iss: null,
    });
  });

  it('a JWS-shaped value in the injection header of an unknown slug is token_missing, not parsed', async () => {
    const fx = await setupProxy({ service: { injection: { kind: 'header', name: 'x-api-key' } } });
    const token = await fx.token();
    const unknown = await fx.call('/a', {
      slug: 'nope',
      token: null,
      headers: { 'x-api-key': token },
    });
    expect(unknown.status).toBe(401);
    expect(errorOf(unknown)).toBe('token_missing');
  });
});

describe('proxy: routing', () => {
  it('/proxy/<slug>/ forwards to the base URL with a trailing slash', async () => {
    const fx = await setupProxy();
    expect((await fx.call('/')).status).toBe(200);
    expect(fx.upstreamCalls[0]?.url).toBe(`${TEST_BASE_URL}/`);
  });

  it('a percent-encoded slug does not select the decoded service', async () => {
    const fx = await setupProxy();
    const response = await fx.call('/a', { slug: 'ech%6F' });
    expect(response.status).toBe(404);
    expect(errorOf(response)).toBe('service_not_found');
    expect(fx.upstreamCalls).toHaveLength(0);
  });
});
