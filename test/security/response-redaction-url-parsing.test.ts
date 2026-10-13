// I-RESP-1: Location and Link values are re-serialized by URL parsing before the caller sees
// them; a credential the upstream echoed into them is still redacted.
import { describe, expect, it } from 'vitest';
import { setupProxy } from '../helpers/proxy-fixtures';

/** Proxies one request for a bearer service whose upstream answers with `headers`. */
async function proxied(secret: string, headers: Record<string, string>): Promise<Response> {
  const fx = await setupProxy({
    service: { baseUrl: 'https://api.upstream.test/v1', injection: { kind: 'bearer' }, secret },
    upstream: () => new Response(null, { status: 302, headers }),
  });
  return fx.call('/x');
}

describe('I-RESP-1: URL headers re-serialized by parsing stay redacted', () => {
  // URL parsing turns `\` into `/` in http(s) paths; percent-decoding cannot undo that.
  const secret = 'tok\\abc=xyz0123456789';
  const leaked = 'tok/abc=xyz0123456789';

  it('redacts a same-origin Location rewritten to the gateway', async () => {
    for (const location of [`https://api.upstream.test/v1/u/${secret}`, `/v1/u/${secret}`]) {
      const response = await proxied(secret, { location });
      expect(response.headers.get('location'), location).toBeNull();
      expect(response.headers.get('x-tokengate-redacted'), location).toBe('location');
    }
  });

  it('redacts a same-origin Link rewritten to the gateway', async () => {
    const response = await proxied(secret, {
      link: `<https://api.upstream.test/v1/u/${secret}>; rel="next"`,
    });
    expect(response.headers.get('link')).toBeNull();
    expect(response.headers.get('x-tokengate-redacted')).toBe('link');
    for (const [, value] of response.headers) expect(value).not.toContain(leaked);
  });

  it('checks a cross-origin Location as sent, before parsing removes dot segments', async () => {
    const dotted = 'ab/./cd/../ef0123456789xyzXYZ';
    const response = await proxied(dotted, { location: `https://other.test/${dotted}` });
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-tokengate-redacted')).toBe('location');
  });
});
