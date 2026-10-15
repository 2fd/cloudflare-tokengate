import { describe, expect, it } from 'vitest';
import {
  maskSecret,
  parseGithubTokenExpiration,
  runVerifyCheck,
  VERIFY_PREVIEW_BYTES,
} from '../../../../src/admin/ops/verify';
import { toBase64 } from '../../../../src/lib/encoding';
import type { Injection, VerifyCheck } from '../../../../src/policy/types';
import { fakeNetwork } from './helpers';

const SECRET = 'xoxb-1111-2222-abcdefghijklmnop';
const SLACK_CHECK: VerifyCheck = {
  method: 'POST',
  path: '/auth.test',
  expect_status: 200,
  expect_ok_field: true,
};

function target(verify: VerifyCheck, injection: Injection = { kind: 'bearer' }) {
  return { base_url: 'https://slack.com/api', injection, timeout_ms: 120_000, verify };
}

const deps = (fetchImpl: typeof fetch) => ({ fetch: fetchImpl, now: () => Date.now() });

describe('runVerifyCheck', () => {
  it('passes on the expected status and ok field, using redirect manual', async () => {
    const network = fakeNetwork(() => Response.json({ ok: true, team: 'T' }));
    const outcome = await runVerifyCheck(deps(network.fetch), target(SLACK_CHECK), SECRET);
    expect(outcome).toMatchObject({ status: 200, passed: true, error: null });
    expect(network.calls[0]).toMatchObject({
      url: 'https://slack.com/api/auth.test',
      method: 'POST',
      redirect: 'manual',
    });
  });

  it('fails when the ok field is false even with HTTP 200', async () => {
    const network = fakeNetwork(() => Response.json({ ok: false, error: 'invalid_auth' }));
    const outcome = await runVerifyCheck(deps(network.fetch), target(SLACK_CHECK), SECRET);
    expect(outcome).toMatchObject({ status: 200, passed: false });
    expect(outcome.error).toMatch(/"ok": true/);
  });

  it('does not follow redirects', async () => {
    const network = fakeNetwork(
      () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }),
    );
    const outcome = await runVerifyCheck(deps(network.fetch), target(SLACK_CHECK), SECRET);
    expect(outcome).toMatchObject({ status: 302, passed: false });
    expect(network.calls).toHaveLength(1);
  });

  it('masks every encoding of the credential and caps the preview at 200 bytes', async () => {
    const echoed = `{"echo":"${SECRET}","url":"${encodeURIComponent(`${SECRET}/`)}","pad":"${'é'.repeat(300)}"}`;
    const network = fakeNetwork(() => new Response(echoed, { status: 200 }));
    const outcome = await runVerifyCheck(
      deps(network.fetch),
      target({ method: 'GET', path: '/x', expect_status: 200 }),
      SECRET,
    );
    expect(outcome.bodyPreview).not.toContain(SECRET);
    expect(outcome.bodyPreview).toContain('[credential]');
    expect(new TextEncoder().encode(outcome.bodyPreview).length).toBeLessThanOrEqual(
      VERIFY_PREVIEW_BYTES,
    );
    expect(outcome.bodyPreview.endsWith('�')).toBe(false);
  });

  it('masks a secret that straddles the preview boundary', async () => {
    const body = `${'a'.repeat(190)}${SECRET}`;
    const network = fakeNetwork(() => new Response(body, { status: 200 }));
    const outcome = await runVerifyCheck(
      deps(network.fetch),
      target({ method: 'GET', path: '/x', expect_status: 200 }),
      SECRET,
    );
    expect(outcome.bodyPreview).toBe(`${'a'.repeat(190)}[credentia`);
    expect(outcome.bodyPreview).not.toContain(SECRET.slice(0, 5));
  });

  it('puts query-injected credentials in the URL only', async () => {
    const network = fakeNetwork(() => Response.json({}));
    await runVerifyCheck(
      deps(network.fetch),
      target({ method: 'GET', path: '/me', expect_status: 200 }, { kind: 'query', param: 'key' }),
      SECRET,
    );
    expect(network.calls[0]?.url).toBe(`https://slack.com/api/me?key=${SECRET}`);
    expect(network.calls[0]?.headers.get('authorization')).toBeNull();
  });

  it('reports unreachable upstreams by error name only', async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError(`connect failed for ${SECRET}`);
    };
    const outcome = await runVerifyCheck(deps(failing), target(SLACK_CHECK), SECRET);
    expect(outcome).toEqual({
      status: null,
      passed: false,
      bodyPreview: '',
      expiresAt: null,
      error: 'the upstream could not be reached (TypeError)',
    });
  });

  it('refuses a credential that cannot be a header value without calling upstream', async () => {
    const network = fakeNetwork();
    const outcome = await runVerifyCheck(deps(network.fetch), target(SLACK_CHECK), 'a\nb');
    expect(outcome.passed).toBe(false);
    expect(network.calls).toHaveLength(0);
  });
});

describe('maskSecret', () => {
  it('masks raw, URL-encoded and basic base64 forms', () => {
    const secret = 'user:p@ss/word';
    const basic = toBase64(new TextEncoder().encode(secret));
    const text = `${secret} ${encodeURIComponent(secret)} ${basic}`;
    const masked = maskSecret(text, { kind: 'basic' }, secret);
    expect(masked).not.toContain('p@ss');
    expect(masked).not.toContain(encodeURIComponent('p@ss/word'));
    expect(masked).not.toContain(basic.replace(/=+$/, ''));
  });
});

describe('parseGithubTokenExpiration', () => {
  it.each([
    ['2026-12-01 00:00:00 UTC', Date.UTC(2026, 11, 1)],
    ['2026-12-01 10:30:00 -0800', Date.UTC(2026, 11, 1, 18, 30)],
    ['2026-12-01 10:30:00 +0130', Date.UTC(2026, 11, 1, 9, 0)],
  ])('parses %s', (value, expected) => {
    expect(parseGithubTokenExpiration(value)).toBe(expected);
  });

  it.each([null, '', '2026-02-30 00:00:00 UTC', '2026-12-01T00:00:00Z', '2026-12-01 24:00:00 UTC'])(
    'rejects %s',
    (value) => {
      expect(parseGithubTokenExpiration(value)).toBeNull();
    },
  );
});

describe('runVerifyCheck: template check headers', () => {
  it('sends them, and the credential injected after them always wins', async () => {
    const network = fakeNetwork(() => Response.json({ data: [] }));
    const check: VerifyCheck = {
      method: 'GET',
      path: '/v1/models',
      expect_status: 200,
      headers: { 'anthropic-version': '2023-06-01' },
    };
    const outcome = await runVerifyCheck(
      deps(network.fetch),
      {
        base_url: 'https://api.anthropic.com',
        injection: { kind: 'header', name: 'x-api-key' },
        timeout_ms: 60_000,
        verify: check,
      },
      SECRET,
    );
    expect(outcome.passed).toBe(true);
    expect(network.calls[0]?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(network.calls[0]?.headers.get('x-api-key')).toBe(SECRET);
  });
});
