import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { splitProxyPath } from '../../src/proxy/routes';
import { PRETRUST_LOG_BUDGET_PER_MINUTE } from '../../src/telemetry/sinks';
import { TEST_AUDIENCE } from '../helpers/jwt';
import { setupProxy, TEST_BASE_URL, TEST_SECRET } from '../helpers/proxy-fixtures';

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  expect(response.headers.get('x-tokengate-error')).toBe(body.error.code);
  return body.error.code;
}

describe('splitProxyPath', () => {
  it.each([
    ['/proxy/slack', { slug: 'slack', rawPath: '' }],
    ['/proxy/slack/', { slug: 'slack', rawPath: '/' }],
    ['/proxy/slack/api/chat.postMessage', { slug: 'slack', rawPath: '/api/chat.postMessage' }],
    ['/proxy/gh/repos/a%2Fb/contents', { slug: 'gh', rawPath: '/repos/a%2Fb/contents' }],
    ['/proxy/sl%61ck/x', { slug: 'sl%61ck', rawPath: '/x' }],
    ['/admin', null],
  ])('%s', (pathname, expected) => {
    expect(splitProxyPath(pathname)).toEqual(expected);
  });
});

describe('proxy: allowed requests', () => {
  it('forwards GET with the credential, filters the response and records it', async () => {
    const fx = await setupProxy({
      upstream: () =>
        new Response('{"hello":"world"}', {
          status: 201,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'a=b',
            'x-upstream': 'kept',
            'cache-control': 'max-age=60',
          },
        }),
    });
    const response = await fx.call('/items/1?expand=true', {
      headers: {
        accept: 'application/json',
        'user-agent': 'ci/1',
        'cf-connecting-ip': '192.0.2.7',
      },
    });

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"hello":"world"}');
    expect(response.headers.get('x-tokengate-source')).toBe('upstream');
    expect(response.headers.get('x-tokengate-request-id')).toMatch(/^req_[0-9A-Z]{26}$/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-upstream')).toBe('kept');
    expect(response.headers.get('set-cookie')).toBeNull();

    expect(fx.upstreamCalls).toHaveLength(1);
    const [call] = fx.upstreamCalls;
    expect(call?.url).toBe(`${TEST_BASE_URL}/items/1?expand=true`);
    expect(call?.method).toBe('GET');
    expect(call?.redirect).toBe('manual');
    expect(call?.headers.get('authorization')).toBe(`Bearer ${TEST_SECRET}`);
    expect(call?.headers.get('accept')).toBe('application/json');
    expect(call?.headers.has('x-tokengate-token')).toBe(false);
    expect(call?.headers.has('cf-connecting-ip')).toBe(false);

    const [record] = await fx.records();
    expect(record).toMatchObject({
      id: response.headers.get('x-tokengate-request-id'),
      outcome: 'allowed',
      reason: null,
      status: 201,
      upstream_status: 201,
      method: 'GET',
      path: '/items/1',
      service_slug: 'echo',
      service_id: fx.serviceId,
      credential_access_rule_id: fx.ruleId,
      global_access_rule_id: null,
      claims_verified: 1,
      caller_repository: 'acme/app',
      untrusted_iss: null,
      eval_trace: null,
      weight: 1,
      ip: '192.0.2.7',
      user_agent: 'ci/1',
    });
    expect(JSON.parse(record?.caller_claims ?? '{}')).toMatchObject({
      repository_id: '987654321',
      event_name: 'push',
    });
  });

  it('forwards POST bodies and the bare service root', async () => {
    const fx = await setupProxy();
    const post = await fx.call('/chat.postMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"text":"hi"}',
    });
    expect(post.status).toBe(200);
    expect(fx.upstreamCalls[0]).toMatchObject({
      url: `${TEST_BASE_URL}/chat.postMessage`,
      method: 'POST',
      body: '{"text":"hi"}',
    });
    expect(fx.upstreamCalls[0]?.headers.get('content-type')).toBe('application/json');

    const root = await fx.call('');
    expect(root.status).toBe(200);
    expect(fx.upstreamCalls[1]?.url).toBe(`${TEST_BASE_URL}/`);
  });

  it('answers HEAD without a body', async () => {
    const fx = await setupProxy();
    const response = await fx.call('/x', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(fx.upstreamCalls[0]?.method).toBe('HEAD');
    expect(await response.text()).toBe('');
  });

  it('accepts the token as Authorization: Bearer and as the service injection header', async () => {
    const bearer = await setupProxy();
    const token = await bearer.token();
    const viaAuthorization = await bearer.call('/a', {
      token: null,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaAuthorization.status).toBe(200);

    const header = await setupProxy({
      service: { injection: { kind: 'header', name: 'x-api-key' } },
    });
    const viaInjectionHeader = await header.call('/a', {
      token: null,
      headers: { 'x-api-key': await header.token() },
    });
    expect(viaInjectionHeader.status).toBe(200);
    expect(header.upstreamCalls[0]?.headers.get('x-api-key')).toBe(TEST_SECRET);
  });

  it('injects query and path credentials', async () => {
    const query = await setupProxy({ service: { injection: { kind: 'query', param: 'key' } } });
    expect((await query.call('/v?a=1')).status).toBe(200);
    expect(query.upstreamCalls[0]?.url).toBe(
      `${TEST_BASE_URL}/v?a=1&key=${encodeURIComponent(TEST_SECRET)}`,
    );

    const path = await setupProxy({
      service: {
        baseUrl: 'https://hooks.upstream.test/credentials',
        injection: { kind: 'path' },
        secret: 'T000/B000/XYZ123',
      },
    });
    expect((await path.call('')).status).toBe(200);
    expect(path.upstreamCalls[0]?.url).toBe(
      'https://hooks.upstream.test/credentials/T000/B000/XYZ123',
    );
  });

  it('samples allowed records by allowed_sample_rate and weights them', async () => {
    const fx = await setupProxy();
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('allowed_sample_rate', '0', 0)",
    ).run();
    expect((await fx.call('/a')).status).toBe(200);
    expect((await fx.call('/a', { token: 'a.b.c' })).status).toBe(401);
    const records = await fx.records();
    expect(records.map((r) => r.outcome)).toEqual(['denied']);

    await env.DB.prepare(
      "UPDATE settings SET value = '0.5' WHERE key = 'allowed_sample_rate'",
    ).run();
    const random = vi.spyOn(fx.app.deps, 'random');
    // 0x00000000 / 2^32 = 0 < 0.5: kept. The request id consumes the other random calls.
    random.mockImplementation((n) => new Uint8Array(n));
    expect((await fx.call('/b')).status).toBe(200);
    random.mockImplementation((n) => new Uint8Array(n).fill(0xff));
    expect((await fx.call('/c')).status).toBe(200);
    random.mockRestore();
    const allowed = (await fx.records()).filter((r) => r.outcome === 'allowed');
    expect(allowed.map((r) => [r.path, r.weight])).toEqual([['/b', 2]]);
  });
});

describe('proxy: gateway errors', () => {
  it('rejects unsupported methods with 405', async () => {
    const fx = await setupProxy();
    const response = await fx.call('/a', { method: 'PROPFIND' });
    expect(response.status).toBe(405);
    expect(await errorCode(response)).toBe('method_not_allowed');
    expect(response.headers.get('x-tokengate-source')).toBe('gateway');
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('maps token, issuer and audience failures with safe hints', async () => {
    const fx = await setupProxy();
    const missing = await fx.call('/a', { token: null });
    expect(missing.status).toBe(401);
    expect(await errorCode(missing)).toBe('token_missing');

    const otherIssuer = await fx.issuer.sign({ iss: 'https://ci.example.org', sub: 'x' });
    const unknown = await fx.call('/a', { token: otherIssuer });
    const unknownBody = (await unknown.json()) as { message: string };
    expect(unknown.status).toBe(401);
    expect(unknownBody.message).toContain('"https://ci.example.org"');

    const wrongAud = await fx.call('/a', {
      token: await fx.token({ aud: 'tokengate:someone-else-entirely' }),
    });
    const wrongAudBody = (await wrongAud.json()) as { error: { code: string; message: string } };
    expect(wrongAud.status).toBe(401);
    expect(wrongAudBody.error.code).toBe('audience_mismatch');
    expect(wrongAudBody.error.message).toContain(TEST_AUDIENCE);
  });

  it('returns 503 jwks_unavailable when the issuer keys cannot be fetched', async () => {
    const fx = await setupProxy();
    fx.issuer.failJwks(500);
    const response = await fx.call('/a');
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('jwks_unavailable');
    const [record] = await fx.records();
    expect(record).toMatchObject({
      outcome: 'error',
      reason: 'jwks_unavailable',
      claims_verified: 0,
    });
  });

  it('rejects non-canonical paths and query strings with 400 path_invalid', async () => {
    const fx = await setupProxy({ service: { injection: { kind: 'query', param: 'key' } } });
    for (const path of ['/a%2e/b', '/a;b', '/a%25/b', '/a%5cb']) {
      const response = await fx.call(path);
      expect(response.status, path).toBe(400);
      expect(await errorCode(response)).toBe('path_invalid');
    }
    const smuggled = await fx.call('/a?x=1;key=evil');
    expect(smuggled.status).toBe(400);
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('returns 403 event_not_trusted with the event as the only hint', async () => {
    const fx = await setupProxy();
    const response = await fx.call('/a', { token: await fx.token({ event_name: 'pull_request' }) });
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(response.status).toBe(403);
    expect(body.error.code).toBe('event_not_trusted');
    expect(body.error.message).toContain('"pull_request"');
    expect(body.error.message).not.toContain('rule 1');
    const [record] = await fx.records();
    expect(record?.eval_trace).toContain('event_not_trusted');
  });

  it('applies the optional rate limiter per credential access rule', async () => {
    const keys: string[] = [];
    const fx = await setupProxy({
      env: {
        PROXY_RATE_LIMITER: {
          limit: async ({ key }: { key: string }) => {
            keys.push(key);
            return { success: false };
          },
        } as RateLimit,
      },
    });
    const response = await fx.call('/a');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await errorCode(response)).toBe('rate_limited');
    expect(keys).toEqual([`rule:${fx.ruleId}`]);
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('fails closed without a keyring or credential', async () => {
    const noKeyring = await setupProxy();
    noKeyring.app.deps.env.TOKENGATE_KEK = '';
    const response = await noKeyring.call('/a');
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('not_configured');
    expect((await noKeyring.records())[0]?.reason).toBe('keyring_absent');

    const noCredential = await setupProxy({ service: { secret: null } });
    const missing = await noCredential.call('/a');
    expect(missing.status).toBe(503);
    expect(await errorCode(missing)).toBe('credential_unavailable');
    expect((await noCredential.records())[0]?.reason).toBe('credential_missing');
    expect(noCredential.upstreamCalls).toHaveLength(0);
  });

  it('maps upstream timeouts to 504 and network errors to 502', async () => {
    const fx = await setupProxy({ service: { timeoutMs: 1000 } });
    fx.setUpstream(() => {
      throw new TypeError('connect failed to https://api.upstream.test');
    });
    const unreachable = await fx.call('/a');
    expect(unreachable.status).toBe(502);
    expect(await errorCode(unreachable)).toBe('upstream_unreachable');

    fx.setUpstream(
      (call) =>
        new Promise((_, reject) => {
          call.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const timedOut = await fx.call('/a');
    expect(timedOut.status).toBe(504);
    expect(await errorCode(timedOut)).toBe('upstream_timeout');
    const records = await fx.records();
    expect(records.map((r) => [r.outcome, r.reason]).sort()).toEqual([
      ['error', 'upstream_timeout'],
      ['error', 'upstream_unreachable'],
    ]);
  });

  it('caps pre-trust records per isolate', async () => {
    const fx = await setupProxy();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < PRETRUST_LOG_BUDGET_PER_MINUTE + 5; i++) {
      await fx.call('/a', { token: 'a.b.c' });
    }
    warn.mockRestore();
    expect(PRETRUST_LOG_BUDGET_PER_MINUTE).toBe(10);
    expect(await fx.records()).toHaveLength(PRETRUST_LOG_BUDGET_PER_MINUTE);
  });
});
