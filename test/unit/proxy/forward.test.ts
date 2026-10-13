import { describe, expect, it } from 'vitest';
import type { Injection } from '../../../src/policy/types';
import { extractCallerToken } from '../../../src/proxy/caller-token';
import {
  buildUpstreamHeaders,
  type FetchUpstreamInput,
  fetchUpstream,
  filterResponseHeaders,
  parseLinkHeader,
  type ResponseContext,
} from '../../../src/proxy/forward';
import { NEVER_FORWARD, REQUEST_ALLOWLIST, RESPONSE_DROP } from '../../../src/proxy/headers';
import { injectCredentialHeaders } from '../../../src/proxy/inject';
import { buildUpstreamUrl } from '../../../src/proxy/path';

const SECRET = 'sk-test-0123456789abcdef';
const CALLER_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

describe('I-TOK-1: buildUpstreamHeaders', () => {
  const incoming = new Headers({
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'ci/1',
    authorization: `Bearer ${CALLER_JWT}`,
    'x-tokengate-token': CALLER_JWT,
    'x-api-key': CALLER_JWT,
    cookie: 'a=b',
    host: 'gw.example',
    'cf-connecting-ip': '1.2.3.4',
    'x-forwarded-for': '1.2.3.4',
    'x-http-method-override': 'DELETE',
    'x-github-api-version': '2022-11-28',
    'x-unknown': 'dropped',
  });

  it('forwards only allowlisted and service-listed headers', () => {
    const out = buildUpstreamHeaders(incoming, {
      injection: { kind: 'bearer' },
      forward_headers: ['X-GitHub-Api-Version'],
    });
    expect(Object.fromEntries(out)).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'ci/1',
      'x-github-api-version': '2022-11-28',
    });
  });

  it('never forwards NEVER_FORWARD headers even if a service lists them', () => {
    const out = buildUpstreamHeaders(incoming, {
      injection: { kind: 'bearer' },
      forward_headers: [
        'authorization',
        'x-tokengate-token',
        'cookie',
        'cf-connecting-ip',
        'x-forwarded-for',
        'x-http-method-override',
      ],
    });
    for (const name of out.keys())
      expect(name).not.toMatch(/authorization|tokengate|cookie|^cf-|forwarded|override/);
  });

  it.each(['x-original-url', 'x-rewrite-url', 'x-original-method', 'x-override-url'])(
    'never forwards the URL/method override header %s, even when a service lists it',
    (name) => {
      const out = buildUpstreamHeaders(new Headers({ [name]: '/admin/delete', accept: '*/*' }), {
        injection: { kind: 'bearer' },
        forward_headers: [name],
      });
      expect(out.has(name)).toBe(false);
      expect(out.get('accept')).toBe('*/*');
    },
  );

  it('drops caller copies of the injected header (I-INJ-1)', () => {
    const injection: Injection = { kind: 'header', name: 'X-Api-Key' };
    const out = buildUpstreamHeaders(incoming, { injection, forward_headers: ['x-api-key'] });
    expect(out.has('x-api-key')).toBe(false);
    injectCredentialHeaders(out, injection, SECRET);
    expect(out.get('x-api-key')).toBe(SECRET);
    expect([...out.values()].join('\n')).not.toContain(CALLER_JWT);
  });

  it('keeps the header constants free of overlap', () => {
    for (const name of REQUEST_ALLOWLIST) {
      expect(NEVER_FORWARD).not.toContain(name);
    }
  });
});

function context(overrides: Partial<ResponseContext> = {}): ResponseContext {
  return {
    upstreamUrl: new URL('https://api.example.com/v1/items?page=1'),
    baseUrl: 'https://api.example.com/v1',
    gatewayProxyBase: 'https://gw.example/proxy/svc',
    injection: { kind: 'bearer' },
    secret: SECRET,
    requestId: 'req_01TEST',
    ...overrides,
  };
}

function filter(headers: Record<string, string>, ctx = context()): Record<string, string> {
  return Object.fromEntries(filterResponseHeaders(new Headers(headers), ctx));
}

describe('I-RESP-1: filterResponseHeaders', () => {
  it('drops RESPONSE_DROP headers and adds gateway headers', () => {
    const upstream: Record<string, string> = {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '10',
      'cache-control': 'public, max-age=60',
    };
    for (const name of RESPONSE_DROP) upstream[name.replace('*', 'spoof')] = 'x';
    expect(filter(upstream)).toEqual({
      'content-type': 'application/json',
      'x-ratelimit-remaining': '10',
      'cache-control': 'no-store',
      'x-tokengate-source': 'upstream',
      'x-tokengate-request-id': 'req_01TEST',
    });
  });

  it('does not let upstream spoof gateway headers', () => {
    const out = filter({ 'x-tokengate-source': 'gateway', 'x-tokengate-redacted': 'none' });
    expect(out['x-tokengate-source']).toBe('upstream');
    expect(out['x-tokengate-redacted']).toBeUndefined();
  });
});

describe('I-REDIR-1: Location rewriting', () => {
  it.each([
    [
      'absolute under base',
      'https://api.example.com/v1/items/2?x=1#f',
      'https://gw.example/proxy/svc/items/2?x=1#f',
    ],
    ['relative', '/v1/items/3', 'https://gw.example/proxy/svc/items/3'],
    ['relative to current path', 'next', 'https://gw.example/proxy/svc/next'],
    ['base itself', 'https://api.example.com/v1', 'https://gw.example/proxy/svc/'],
    [
      'percent-encoding preserved',
      '/v1/contents/a%2Fb%20c',
      'https://gw.example/proxy/svc/contents/a%2Fb%20c',
    ],
  ])('rewrites %s', (_, location, expected) => {
    expect(filter({ location }).location).toBe(expected);
  });

  it.each([
    ['outside base path', '/v2/items'],
    ['prefix but not a path boundary', '/v1beta/items'],
    ['dot segments resolving outside base', '/v1/../admin'],
    ['non-http scheme', 'javascript:alert(1)'],
    ['rewritten path not canonical', '/v1/a;b'],
  ])('drops same-origin %s and marks it blocked', (_, location) => {
    const out = filter({ location });
    expect(out.location).toBeUndefined();
    expect(out['x-tokengate-redirect-blocked']).toBe('1');
  });

  it('passes cross-origin redirects through unchanged', () => {
    const location = 'https://objects.example-cdn.com/file?sig=abc';
    expect(filter({ location }).location).toBe(location);
    expect(filter({ location: '//other.example/x' }).location).toBe('https://other.example/x');
  });

  it('removes the injected query parameter from a rewritten Location', () => {
    const ctx = context({
      injection: { kind: 'query', param: 'key' },
      upstreamUrl: new URL(`https://api.example.com/v1/items?key=${SECRET}`),
    });
    const out = filter({ location: `/v1/items?page=2&key=${SECRET}&KEY=${SECRET}` }, ctx);
    expect(out.location).toBe('https://gw.example/proxy/svc/items?page=2');
    expect(out['x-tokengate-redacted']).toBeUndefined();
  });

  it('removes the credential path segment from a rewritten Location', () => {
    const ctx = context({
      baseUrl: 'https://api.telegram.org',
      upstreamUrl: new URL(`https://api.telegram.org/bot${SECRET}/getMe`),
      injection: { kind: 'path', prefix: '/bot' },
    });
    expect(filter({ location: `/bot${SECRET}/getUpdates` }, ctx).location).toBe(
      'https://gw.example/proxy/svc/getUpdates',
    );
    const outside = filter({ location: '/botOTHER/getUpdates' }, ctx);
    expect(outside.location).toBeUndefined();
    expect(outside['x-tokengate-redirect-blocked']).toBe('1');
  });

  it('treats a scheme downgrade to http as another origin and redacts the path credential', () => {
    const ctx = context({
      baseUrl: 'https://api.telegram.org',
      upstreamUrl: new URL(`https://api.telegram.org/bot${SECRET}/getMe`),
      injection: { kind: 'path', prefix: '/bot' },
    });
    const out = filter({ location: `http://api.telegram.org/bot${SECRET}/getMe` }, ctx);
    expect(out.location).toBeUndefined();
    expect(out['x-tokengate-redacted']).toBe('location');
  });

  it('blocks a relative Location that climbs out of the credential segment', () => {
    const ctx = context({
      baseUrl: 'https://api.telegram.org',
      upstreamUrl: new URL(`https://api.telegram.org/bot${SECRET}/getMe`),
      injection: { kind: 'path', prefix: '/bot' },
    });
    for (const location of ['..', '../other', `/bot${SECRET}`.slice(0, -1)]) {
      const out = filter({ location }, ctx);
      expect(out.location, location).toBeUndefined();
      expect(out['x-tokengate-redirect-blocked'], location).toBe('1');
    }
  });

  it('drops a Location that smuggles the query credential after ";"', () => {
    const ctx = context({ injection: { kind: 'query', param: 'key' } });
    const out = filter({ location: '/v1/items?page=2;key=other' }, ctx);
    expect(out.location).toBeUndefined();
    expect(out['x-tokengate-redirect-blocked']).toBe('1');
  });

  it('redacts a cross-origin Location that carries the credential', () => {
    const out = filter({ location: `https://evil.example/?k=${SECRET}` });
    expect(out.location).toBeUndefined();
    expect(out['x-tokengate-redacted']).toBe('location');
  });
});

describe('I-REDIR-1: Link rewriting', () => {
  it('rewrites link-values under base and keeps parameters', () => {
    const link =
      '<https://api.example.com/v1/items?page=2>; rel="next", <https://api.example.com/v1/items?page=9>; rel="last"';
    expect(filter({ link }).link).toBe(
      '<https://gw.example/proxy/svc/items?page=2>; rel="next", <https://gw.example/proxy/svc/items?page=9>; rel="last"',
    );
  });

  it('drops values outside base, including other origins', () => {
    const link =
      '</v2/other>; rel="alternate", <https://docs.example.org/x>; rel="help", </v1/a>; rel="next"';
    expect(filter({ link }).link).toBe('<https://gw.example/proxy/svc/a>; rel="next"');
  });

  it('removes the header when every value is dropped, or when malformed', () => {
    expect(filter({ link: '</admin>; rel="x"' }).link).toBeUndefined();
    expect(filter({ link: 'garbage' }).link).toBeUndefined();
    expect(filter({ link: '<https://api.example.com/v1/a; rel="x"' }).link).toBeUndefined();
  });

  it('removes the injected query parameter from link-values', () => {
    const ctx = context({ injection: { kind: 'query', param: 'api_key' } });
    const link = `<https://api.example.com/v1/items?api_key=${SECRET}&page=2>; rel="next"`;
    const out = filter({ link }, ctx);
    expect(out.link).toBe('<https://gw.example/proxy/svc/items?page=2>; rel="next"');
    expect(out['x-tokengate-redacted']).toBeUndefined();
  });

  it('parses quoted commas inside parameters', () => {
    expect(parseLinkHeader('<a>; title="x, y", <b>')).toEqual([
      { uri: 'a', params: '; title="x, y"' },
      { uri: 'b', params: '' },
    ]);
    expect(parseLinkHeader('<a>; title="unterminated')).toBeNull();
  });
});

describe('I-CRED-1: secret redaction in response headers', () => {
  it.each([
    ['raw', SECRET],
    ['URL-encoded', encodeURIComponent('sk/test+0123456789')],
  ])('drops headers containing the %s credential', (_, needle) => {
    const secret = needle === SECRET ? SECRET : 'sk/test+0123456789';
    const out = filter(
      { 'x-debug': `token=${needle}`, 'x-request-url': `https://h/?q=${needle}`, etag: '"1"' },
      context({ secret }),
    );
    expect(out['x-debug']).toBeUndefined();
    expect(out['x-request-url']).toBeUndefined();
    expect(out.etag).toBe('"1"');
    expect(out['x-tokengate-redacted']).toBe('x-debug, x-request-url');
  });

  it('drops headers echoing the basic credential in base64', () => {
    const injection: Injection = { kind: 'basic', username: 'api' };
    const out = filter({ 'x-echo-auth': `Basic ${btoa(`api:${SECRET}`)}` }, context({ injection }));
    expect(out['x-echo-auth']).toBeUndefined();
    expect(out['x-tokengate-redacted']).toBe('x-echo-auth');
  });

  it('drops headers echoing only the secret part of a "user:pass" basic credential', () => {
    const injection: Injection = { kind: 'basic' };
    const stripe = filter(
      { 'x-echo': 'key sk_live_0123456789abcdef' },
      context({ injection, secret: 'sk_live_0123456789abcdef:' }),
    );
    expect(stripe['x-echo']).toBeUndefined();
    const userPass = filter(
      { 'x-echo': `pw=${SECRET}` },
      context({ injection, secret: `api:${SECRET}` }),
    );
    expect(userPass['x-echo']).toBeUndefined();
  });

  it('never returns the credential in any header value', () => {
    const out = filterResponseHeaders(
      new Headers({ a: SECRET, b: `x${SECRET}y`, location: `/v1/${SECRET}` }),
      context(),
    );
    for (const value of out.values()) expect(value).not.toContain(SECRET);
  });
});

function input(
  overrides: Partial<FetchUpstreamInput> & Pick<FetchUpstreamInput, 'fetch'>,
): FetchUpstreamInput {
  return {
    url: new URL('https://api.example.com/v1/items'),
    method: 'POST',
    headers: new Headers({ authorization: `Bearer ${SECRET}` }),
    body: new Response('payload').body,
    timeoutMs: 1000,
    ...overrides,
  };
}

/** Records the fetch init and returns `response`. */
function recordingFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return response();
  }) as typeof fetch;
  return { calls, fakeFetch };
}

describe('I-REDIR-1: fetchUpstream', () => {
  it('uses redirect manual and returns 3xx responses as-is', async () => {
    const { calls, fakeFetch } = recordingFetch(
      () =>
        new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }),
    );
    const result = await fetchUpstream(input({ fetch: fakeFetch }));
    expect(result.ok && result.response.status).toBe(302);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.redirect).toBe('manual');
    expect(calls[0]?.url).toBe('https://api.example.com/v1/items');
  });

  it.each(['GET', 'HEAD', 'get'])('sends no body for %s', async (method) => {
    const { calls, fakeFetch } = recordingFetch(() => new Response('ok'));
    await fetchUpstream(input({ fetch: fakeFetch, method }));
    expect(calls[0]?.init?.body).toBeNull();
    expect(calls[0]?.init?.method).toBe(method.toUpperCase());
  });

  it('streams the request body for other methods', async () => {
    const { calls, fakeFetch } = recordingFetch(() => new Response('ok'));
    const body = new Response('payload').body;
    await fetchUpstream(input({ fetch: fakeFetch, body }));
    expect(calls[0]?.init?.body).toBe(body);
  });

  it('measures upstreamMs with the injected clock', async () => {
    const { fakeFetch } = recordingFetch(() => new Response('ok'));
    const times = [100, 142];
    const result = await fetchUpstream(input({ fetch: fakeFetch, now: () => times.shift() ?? 0 }));
    expect(result.ok && result.upstreamMs).toBe(42);
  });

  it('times out while waiting for headers', async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const result = await fetchUpstream(input({ fetch: hanging, timeoutMs: 20 }));
    expect(result).toEqual({ ok: false, code: 'upstream_timeout', errorName: 'AbortError' });
  });

  it('does not time out a body that streams after headers arrived', async () => {
    let aborted = false;
    const slowBody = ((_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      const encoder = new TextEncoder();
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (init?.signal?.aborted) {
            controller.error(new DOMException('aborted', 'AbortError'));
            return;
          }
          if (sent === 3) {
            controller.close();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 30));
          controller.enqueue(encoder.encode(`chunk${sent++};`));
        },
      });
      return Promise.resolve(new Response(stream));
    }) as typeof fetch;

    const result = await fetchUpstream(input({ fetch: slowBody, timeoutMs: 20 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await result.response.text()).toBe('chunk0;chunk1;chunk2;');
    expect(aborted).toBe(false);
  });

  it('reports network errors by name only, never the message', async () => {
    const failing = (async () => {
      throw new TypeError(`connect failed https://api.example.com/v1?key=${SECRET}`);
    }) as typeof fetch;
    const result = await fetchUpstream(input({ fetch: failing }));
    expect(result).toEqual({ ok: false, code: 'upstream_unreachable', errorName: 'TypeError' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('does not echo unusual error names or non-Error throws', async () => {
    const weird = new Error('x');
    weird.name = `Bad name ${SECRET}`;
    const throwsWeird = (async () => {
      throw weird;
    }) as typeof fetch;
    const throwsString = (async () => {
      throw SECRET;
    }) as typeof fetch;
    for (const fakeFetch of [throwsWeird, throwsString]) {
      const result = await fetchUpstream(input({ fetch: fakeFetch }));
      expect(result).toEqual({ ok: false, code: 'upstream_unreachable', errorName: 'Error' });
    }
  });
});

describe('I-TOK-1: the caller token never reaches the upstream request', () => {
  const kinds: Injection[] = [
    { kind: 'bearer' },
    { kind: 'basic', username: 'u' },
    { kind: 'header', name: 'x-api-key', prefix: 'Key ' },
    { kind: 'query', param: 'key' },
    { kind: 'path', prefix: '/bot' },
  ];
  const sources: Array<Record<string, string>> = [
    { 'x-tokengate-token': CALLER_JWT },
    { authorization: `Bearer ${CALLER_JWT}` },
    { authorization: `token ${CALLER_JWT}` },
    { 'x-api-key': `Key ${CALLER_JWT}` },
  ];

  it.each(kinds)('$kind injection', (injection) => {
    for (const source of sources) {
      const incoming = new Headers({ ...source, accept: '*/*' });
      const token = extractCallerToken(incoming, injection);
      if (!token.ok) continue;
      // A service listing every source header in forward_headers must not change the outcome.
      const headers = buildUpstreamHeaders(incoming, {
        injection,
        forward_headers: ['x-tokengate-token', 'authorization', 'x-api-key'],
      });
      injectCredentialHeaders(headers, injection, SECRET);
      const url = buildUpstreamUrl({
        baseUrl: 'https://api.example.com',
        path: '/x',
        search: '',
        injection,
        secret: SECRET,
      });
      const outbound = [...headers].flat().join('\n') + (url.ok ? url.url.href : '');
      expect(outbound).not.toContain(CALLER_JWT);
    }
  });
});

describe('I-PATH-1 + I-INJ-1: end to end URL and headers', () => {
  it('produces a request that carries only the service credential', () => {
    const injection: Injection = { kind: 'query', param: 'key' };
    const url = buildUpstreamUrl({
      baseUrl: 'https://api.example.com/v1',
      path: '/items',
      search: '?key=caller',
      injection,
      secret: SECRET,
    });
    const headers = buildUpstreamHeaders(
      new Headers({ authorization: `Bearer ${CALLER_JWT}`, accept: '*/*' }),
      { injection, forward_headers: [] },
    );
    injectCredentialHeaders(headers, injection, SECRET);
    expect(url.ok && url.url.searchParams.getAll('key')).toEqual([SECRET]);
    expect(Object.fromEntries(headers)).toEqual({ accept: '*/*' });
  });
});
