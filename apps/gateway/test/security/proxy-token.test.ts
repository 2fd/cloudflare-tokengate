import { describe, expect, it } from 'vitest';
import { githubClaims, unsecuredToken } from '../helpers/jwt';
import { setupProxy, TEST_SECRET, type UpstreamCall } from '../helpers/proxy-fixtures';

/** Everything the upstream received, as one string, to search for leaked values. */
function upstreamText(call: UpstreamCall | undefined): string {
  if (call === undefined) throw new Error('upstream was not called');
  return [call.url, ...[...call.headers].map(([k, v]) => `${k}: ${v}`), call.body ?? ''].join('\n');
}

describe('I-TOK-1: the caller token never reaches the upstream', () => {
  it('x-tokengate-token is not forwarded', async () => {
    const fx = await setupProxy();
    const token = await fx.token();
    expect((await fx.call('/a', { token })).status).toBe(200);
    expect(upstreamText(fx.upstreamCalls[0])).not.toContain(token);
  });

  it.each(['Bearer', 'bearer', 'token'])(
    'Authorization: %s <jwt> is not forwarded',
    async (scheme) => {
      const fx = await setupProxy({
        service: { injection: { kind: 'header', name: 'x-api-key' } },
      });
      const token = await fx.token();
      const response = await fx.call('/a', {
        token: null,
        headers: { authorization: `${scheme} ${token}` },
      });
      expect(response.status).toBe(200);
      const call = fx.upstreamCalls[0];
      expect(upstreamText(call)).not.toContain(token);
      expect(call?.headers.has('authorization')).toBe(false);
    },
  );

  it('the injection header carrying the caller token is replaced by the credential', async () => {
    const fx = await setupProxy({
      service: { injection: { kind: 'header', name: 'x-api-key', prefix: 'Key ' } },
    });
    const token = await fx.token();
    const response = await fx.call('/a', { token: null, headers: { 'x-api-key': `Key ${token}` } });
    expect(response.status).toBe(200);
    const call = fx.upstreamCalls[0];
    expect(upstreamText(call)).not.toContain(token);
    expect(call?.headers.get('x-api-key')).toBe(`Key ${TEST_SECRET}`);
  });
});

describe('I-TOK-2: ambiguous or non-JWS tokens are rejected', () => {
  it('different tokens in x-tokengate-token and Authorization → 400 token_ambiguous', async () => {
    const fx = await setupProxy();
    const response = await fx.call('/a', {
      token: await fx.token(),
      headers: { authorization: `Bearer ${await fx.token({ ref: 'refs/heads/other' })}` },
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('x-tokengate-error')).toBe('token_ambiguous');
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('the same token in both headers is accepted', async () => {
    const fx = await setupProxy();
    const token = await fx.token();
    const response = await fx.call('/a', { token, headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
  });

  it.each([
    ['opaque API key', 'sk-live-abcdef'],
    ['two segments', 'aaa.bbb'],
    ['alg none with empty signature', unsecuredToken({ kid: 'test-key-1' }, githubClaims())],
    ['JWS JSON serialization', '{"payload":"eyJzdWIiOiJ4In0"}'],
  ])('%s → 401 token_malformed', async (_label, token) => {
    const fx = await setupProxy();
    const response = await fx.call('/a', { token });
    expect(response.status).toBe(401);
    expect(response.headers.get('x-tokengate-error')).toBe('token_malformed');
    expect(fx.upstreamCalls).toHaveLength(0);
  });
});

describe('I-INJ-1: caller copies of the injected header or parameter are replaced', () => {
  it('bearer: a caller Authorization header (other scheme) is not forwarded', async () => {
    const fx = await setupProxy();
    const response = await fx.call('/a', { headers: { authorization: 'Basic ZXZpbDpldmls' } });
    expect(response.status).toBe(200);
    expect(fx.upstreamCalls[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_SECRET}`);
  });

  it('header: a caller x-api-key is replaced even when listed in forward_headers', async () => {
    const fx = await setupProxy({
      service: { injection: { kind: 'header', name: 'x-api-key' }, forwardHeaders: ['x-api-key'] },
    });
    const response = await fx.call('/a', { headers: { 'X-Api-Key': 'caller-chosen-key' } });
    expect(response.status).toBe(200);
    expect(fx.upstreamCalls[0]?.headers.get('x-api-key')).toBe(TEST_SECRET);
    expect(upstreamText(fx.upstreamCalls[0])).not.toContain('caller-chosen-key');
  });

  it.each(['?key=evil', '?KEY=evil', '?%6Bey=evil', '?key=evil&key=evil2&a=1'])(
    'query: caller copies %s are removed',
    async (search) => {
      const fx = await setupProxy({ service: { injection: { kind: 'query', param: 'key' } } });
      const response = await fx.call(`/a${search}`);
      expect(response.status).toBe(200);
      const url = new URL(fx.upstreamCalls[0]?.url ?? '');
      expect(url.searchParams.getAll('key')).toEqual([TEST_SECRET]);
      expect(url.href).not.toContain('evil');
    },
  );

  it('the credential appears only in the outbound request, not in the response', async () => {
    const fx = await setupProxy({
      upstream: (call) =>
        new Response('ok', { headers: { 'x-echo': call.headers.get('authorization') ?? '' } }),
    });
    const response = await fx.call('/a');
    expect(response.headers.get('x-echo')).toBeNull();
    expect(response.headers.get('x-tokengate-redacted')).toBe('x-echo');
  });
});
