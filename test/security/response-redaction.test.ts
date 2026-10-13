// I-CRED-1 / I-RESP-1: upstream-controlled response metadata (reason phrase, headers) and the
// admin verify preview never carry the credential, whatever encoding the upstream echoes it in.
import { describe, expect, it } from 'vitest';
import { maskSecret } from '../../src/admin/ops/verify';
import type { Injection } from '../../src/policy/types';
import { setupProxy, TEST_SECRET, type UpstreamCall } from '../helpers/proxy-fixtures';

/** Proxies one request for a service with `injection`/`secret` whose upstream answers `respond`. */
async function proxied(
  injection: Injection,
  secret: string,
  respond: (call: UpstreamCall) => Response,
): Promise<Response> {
  const fx = await setupProxy({
    service: { baseUrl: 'https://api.upstream.test/v1', injection, secret },
    upstream: respond,
  });
  return fx.call('/x');
}

/** Response status line and headers as one string. */
function metadata(response: Response): string {
  const headers = [...response.headers].map(([name, value]) => `${name}: ${value}`);
  return [`${response.status} ${response.statusText}`, ...headers].join('\n');
}

describe('I-CRED-1: the upstream reason phrase is never forwarded', () => {
  it('drops a status text that echoes the credential and keeps the status', async () => {
    const response = await proxied(
      { kind: 'bearer' },
      TEST_SECRET,
      (call) =>
        new Response('{}', {
          status: 401,
          statusText: `bad key ${call.headers.get('authorization')}`,
        }),
    );
    expect(response.status).toBe(401);
    expect(response.statusText).not.toContain(TEST_SECRET);
  });
});

describe('I-RESP-1: header redaction matches every encoding of the credential', () => {
  it('redacts base64 and base64url echoes at any byte alignment', async () => {
    for (const prefix of ['Bearer ', 'Bearer x', 'Bearer xy']) {
      for (const urlSafe of [false, true]) {
        const response = await proxied({ kind: 'bearer' }, TEST_SECRET, (call) => {
          const auth = (call.headers.get('authorization') ?? '').replace('Bearer ', prefix);
          const b64 = btoa(auth);
          const echo = urlSafe ? b64.replaceAll('+', '-').replaceAll('/', '_') : b64;
          return new Response('{}', { headers: { 'x-debug-auth': echo } });
        });
        expect(response.headers.get('x-debug-auth'), prefix).toBeNull();
        expect(response.headers.get('x-tokengate-redacted')).toBe('x-debug-auth');
      }
    }
  });

  it('redacts a query credential echoed in its WHATWG wire form (%27)', async () => {
    const secret = "abc'def~ghi0123456789";
    const response = await proxied({ kind: 'query', param: 'key' }, secret, (call) => {
      expect(call.url).toContain('abc%27def~ghi');
      return new Response('{}', {
        headers: {
          'x-debug-url': call.url,
          location: `https://cdn.other.test/cb?from=${call.url}`,
        },
      });
    });
    expect(response.headers.get('x-debug-url')).toBeNull();
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-tokengate-redacted')).toBe('location, x-debug-url');
  });

  it('redacts a cross-origin Location whose credential URL parsing re-encodes', async () => {
    for (const secret of ['tok{abc}=xyz0123456789', 'tok\\abc=xyz0123456789']) {
      const response = await proxied(
        { kind: 'bearer' },
        secret,
        () =>
          new Response(null, {
            status: 302,
            headers: { location: `https://other.test/u/${secret}` },
          }),
      );
      expect(response.headers.get('location'), secret).toBeNull();
      expect(response.headers.get('x-tokengate-redacted'), secret).toBe('location');
    }
  });

  it('redacts a header echoing only the token segment of a path secret (Discord)', async () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEfGhIjKlMnOpQrStUvWxYz01';
    const response = await proxied(
      { kind: 'path' },
      `1234567890123456789/${token}`,
      () => new Response('{}', { headers: { 'x-webhook-token': token } }),
    );
    expect(metadata(response)).not.toContain(token);
    expect(response.headers.get('x-tokengate-redacted')).toBe('x-webhook-token');
  });
});

describe('I-CRED-1: the verify preview masks every encoding of the credential', () => {
  it('masks the token field of a Discord webhook object', () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEfGhIjKlMnOpQrStUvWxYz01';
    const secret = `1234567890123456789/${token}`;
    const body = JSON.stringify({
      type: 1,
      id: '1234567890123456789',
      name: 'h',
      token,
      url: `https://discord.com/api/webhooks/${secret}`,
    });
    const masked = maskSecret(body, { kind: 'path' }, secret);
    expect(masked).not.toContain(token);
    expect(masked).toContain('"token":"[credential]"');
  });

  it('masks percent-encoded wire forms and base64 echoes', () => {
    const secret = "abc'def~ghi0123456789";
    const body = JSON.stringify({
      request_url: 'https://api.example.com/v1/x?key=abc%27def~ghi0123456789',
      mixed: 'abc%27def%7eghi%30123456789',
      auth: btoa(`Bearer ${secret}`),
    });
    const masked = maskSecret(body, { kind: 'query', param: 'key' }, secret);
    expect(masked).not.toMatch(/ghi/);
    expect(masked).not.toContain(btoa(`Bearer ${secret}`).slice(8, 20));
  });
});
