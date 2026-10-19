import { describe, expect, it } from 'vitest';
import type { Injection } from '../../../src/policy/types';
import {
  normalizeCredential,
  normalizeInjection,
  type ServiceFieldsInput,
  validateBaseUrl,
  validateForwardHeaders,
  validateServiceFields,
} from '../../../src/policy/validate';

const open = { gatewayHosts: [], allowedUpstreamHosts: null };

describe('I-SSRF-1: validateBaseUrl', () => {
  it.each([
    ['https://slack.com/', 'https://slack.com'],
    ['https://slack.com', 'https://slack.com'],
    ['  https://api.openai.com/v1/  ', 'https://api.openai.com/v1'],
    ['https://API.Example.com:443/v1', 'https://api.example.com/v1'],
    ['https://api.example.com:8443/a/b', 'https://api.example.com:8443/a/b'],
    ['HTTPS://hooks.slack.com/services', 'https://hooks.slack.com/services'],
  ])('accepts %s', (raw, normalized) => {
    expect(validateBaseUrl(raw, open)).toEqual({ ok: true, normalized });
  });

  it.each([
    ['', 'empty'],
    ['http://api.example.com', 'plain http'],
    ['ftp://api.example.com', 'other scheme'],
    ['https:api.example.com', 'scheme without //'],
    ['https://user:pass@api.example.com', 'userinfo'],
    ['https://api.example.com/v1?x=1', 'query'],
    ['https://api.example.com/v1?', 'empty query'],
    ['https://api.example.com/v1#x', 'fragment'],
    ['https://api.example.com/a/../b', 'dot-dot segment'],
    ['https://api.example.com/a/./b', 'dot segment'],
    ['https://api.example.com/a%2fb', 'encoded slash'],
    ['https://api.example.com/a%2e%2e/b', 'encoded dots'],
    ['https://api.example.com/a//b', 'double slash'],
    ['https://api.example.com\\a', 'backslash'],
    ['https://api.example.com/a\tb', 'tab (silently removed by the URL parser)'],
    ['https://127.0.0.1', 'IPv4 literal'],
    ['https://0x7f.1', 'IPv4 in hex shorthand'],
    ['https://2130706433', 'IPv4 as an integer'],
    ['https://[::1]', 'IPv6 literal'],
    ['https://localhost', 'localhost'],
    ['https://api.localhost', 'subdomain of localhost'],
    ['https://localhost.', 'trailing dot'],
    ['https://intranet', 'single-label host'],
    ['https://tokengate.acme.workers.dev', 'workers.dev'],
    ['https://ünicode.example', 'non-ASCII host'],
    ['https://0177.0.0.1', 'IPv4 in octal'],
    ['https://127.0.0.1.', 'IPv4 with trailing dot'],
    ['https://127.0.0%2e1', 'percent-encoded IPv4'],
    ['https://loc%61lhost', 'percent-encoded localhost'],
    ['https://[::ffff:7f00:1]', 'IPv4-mapped IPv6'],
    ['https://api.example.com/a%5cb', 'encoded backslash'],
    ['https://api.example.com/a%00', 'encoded NUL'],
    ['https://api.example.com/a%252e', 'double encoding'],
    ['https://api.example.com/.%2e/x', 'mixed dot segment'],
    ['https://api.example.com\n/x', 'newline (silently removed by the URL parser)'],
    ['https://WORKERS.DEV', 'workers.dev apex in upper case'],
  ])('rejects %s (%s)', (raw) => {
    expect(validateBaseUrl(raw, open).ok).toBe(false);
  });

  it('rejects non-string input without throwing', () => {
    expect(validateBaseUrl(undefined as unknown as string, open).ok).toBe(false);
  });

  // The proxy re-validates the stored value at request time (docs/policies.md), so the stored form must
  // validate to itself.
  it.each([
    'https://API.example.com:443/v1/',
    'https://api.example.com/a{b}',
    'https://api.example.com/a"b^c',
    'https://api.example.com/%7e/x',
  ])('normalized form of %s validates to itself', (raw) => {
    const first = validateBaseUrl(raw, open);
    if (!first.ok) throw new Error(first.error);
    expect(validateBaseUrl(first.normalized, open)).toEqual(first);
  });

  it('rejects the gateway hosts, wildcard admin hosts included', () => {
    const ctx = { gatewayHosts: ['gate.acme.com', '*.admin.acme.com'], allowedUpstreamHosts: null };
    expect(validateBaseUrl('https://Gate.Acme.com/x', ctx).ok).toBe(false);
    expect(validateBaseUrl('https://eu.admin.acme.com/x', ctx).ok).toBe(false);
    expect(validateBaseUrl('https://api.acme.com/x', ctx).ok).toBe(true);
    expect(validateBaseUrl('https://admin.acme.com/x', ctx).ok).toBe(true);
  });

  it('enforces ALLOWED_UPSTREAM_HOSTS', () => {
    const ctx = { gatewayHosts: [], allowedUpstreamHosts: ['slack.com', '*.openai.com'] };
    expect(validateBaseUrl('https://slack.com', ctx).ok).toBe(true);
    expect(validateBaseUrl('https://api.openai.com/v1', ctx).ok).toBe(true);
    expect(validateBaseUrl('https://hooks.slack.com', ctx).ok).toBe(false);
    expect(validateBaseUrl('https://evilopenai.com', ctx).ok).toBe(false);
  });
});

describe('I-INJ-1: normalizeInjection', () => {
  it.each<[unknown, string]>([
    [{ kind: 'bearer', extra: 1 }, '{"kind":"bearer"}'],
    [{ name: 'x-api-key', kind: 'header' }, '{"kind":"header","name":"x-api-key"}'],
    [{ kind: 'header', name: 'x-api-key', prefix: '' }, '{"kind":"header","name":"x-api-key"}'],
    [
      { kind: 'header', name: 'x-key', prefix: 'Key ' },
      '{"kind":"header","name":"x-key","prefix":"Key "}',
    ],
    [{ kind: 'basic' }, '{"kind":"basic"}'],
    [{ kind: 'basic', username: 'api' }, '{"kind":"basic","username":"api"}'],
    [{ kind: 'query', param: 'api_key' }, '{"kind":"query","param":"api_key"}'],
    [{ kind: 'path' }, '{"kind":"path"}'],
    [{ kind: 'path', prefix: '' }, '{"kind":"path"}'],
    [{ kind: 'path', prefix: '/credentials' }, '{"kind":"path","prefix":"/credentials"}'],
  ])('normalizes %j', (raw, json) => {
    const result = normalizeInjection(raw);
    expect(result).toMatchObject({ ok: true, json });
  });

  it.each<[unknown, string]>([
    [null, 'not an object'],
    [{ kind: 'cookie' }, 'unknown kind'],
    [{ kind: 'header' }, 'missing name'],
    [{ kind: 'header', name: 'X-Api-Key' }, 'upper case name'],
    [{ kind: 'header', name: 'x api' }, 'space in name'],
    [{ kind: 'header', name: 'authorization' }, 'reserved header'],
    [{ kind: 'header', name: 'cookie' }, 'reserved header'],
    [{ kind: 'header', name: 'x-forwarded-for' }, 'reserved prefix'],
    [{ kind: 'header', name: 'x-tokengate-token' }, 'reserved prefix'],
    [{ kind: 'header', name: 'x-key', prefix: 'a\r\nb' }, 'CRLF in prefix'],
    [{ kind: 'basic', username: 'a:b' }, 'colon in username'],
    [{ kind: 'query', param: '' }, 'empty param'],
    [{ kind: 'query', param: 'a&b' }, 'param needing encoding'],
    [{ kind: 'path', prefix: 'bot' }, 'prefix without leading slash'],
    [{ kind: 'path', prefix: '/a/' }, 'trailing slash'],
    [{ kind: 'path', prefix: '/a/../b' }, 'dot segment'],
    [{ kind: 'path', prefix: '/a?b' }, 'query character'],
  ])('rejects %j (%s)', (raw) => {
    expect(normalizeInjection(raw).ok).toBe(false);
  });
});

describe('validateForwardHeaders', () => {
  const header: Injection = { kind: 'header', name: 'x-api-key' };

  it('accepts lower-case tokens', () => {
    expect(validateForwardHeaders(['x-github-api-version', 'openai-beta'], header)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it.each([
    ['authorization'],
    ['cookie'],
    ['host'],
    ['x-forwarded-for'],
    ['cf-connecting-ip'],
    ['x-tokengate-token'],
    ['x-http-method-override'],
    ['x-original-url'],
    ['x-rewrite-url'],
    ['x-original-method'],
    ['x-override-url'],
    ['x-api-key'],
    ['X-Custom'],
    ['bad header'],
  ])('rejects %s', (name) => {
    expect(validateForwardHeaders([name], header).errors).toHaveLength(1);
  });

  it('rejects duplicates and warns on default headers', () => {
    expect(validateForwardHeaders(['x-a', 'x-a'], header).errors).toHaveLength(1);
    expect(validateForwardHeaders(['accept'], header).warnings).toHaveLength(1);
  });
});

describe('normalizeCredential', () => {
  const bearer: Injection = { kind: 'bearer' };

  it('trims and hints only the last 4 characters of long secrets', () => {
    expect(normalizeCredential('  sk-abcdefghijklmnopqrstuvwxyz\n', bearer)).toEqual({
      ok: true,
      value: 'sk-abcdefghijklmnopqrstuvwxyz',
      hint: '…wxyz (29 chars)',
    });
    expect(normalizeCredential('short-secret', bearer)).toEqual({
      ok: true,
      value: 'short-secret',
      hint: '12 chars',
    });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['abc def', 'internal space'],
    ['abc\tdef', 'tab'],
    ['abc\u0000def', 'NUL'],
    ['abc def', 'non-breaking space'],
    ['abcdéf', 'non-ASCII'],
  ])('rejects %j (%s)', (raw) => {
    expect(normalizeCredential(raw, bearer).ok).toBe(false);
  });

  it('accepts multi-segment path secrets (Slack webhooks) but no structure-changing characters', () => {
    const path: Injection = { kind: 'path' };
    expect(normalizeCredential('T000/B000/XXXX', path).ok).toBe(true);
    for (const raw of [
      'a?b',
      'a#b',
      'a%2fb',
      'a\\b',
      '.',
      '..',
      '/a',
      'a/',
      'a//b',
      'a/../b',
      'a/./b',
    ]) {
      expect(normalizeCredential(raw, path).ok).toBe(false);
    }
    expect(normalizeCredential('123456:ABC-DEF_ghi', path).ok).toBe(true);
  });

  it('requires user:password for basic without a username and hints the password', () => {
    const basic: Injection = { kind: 'basic' };
    expect(normalizeCredential('no-colon', basic).ok).toBe(false);
    expect(normalizeCredential(':password', basic).ok).toBe(false);
    expect(normalizeCredential('user:abcdefghijklmnopqrstuvwx', basic)).toMatchObject({
      ok: true,
      hint: '…uvwx (24 chars)',
    });
    expect(normalizeCredential('sk_live_abcdefghijklmnop1234:', basic)).toMatchObject({
      hint: '…1234 (28 chars)',
    });
    expect(
      normalizeCredential('pass:with:colons', { kind: 'basic', username: 'api' }),
    ).toMatchObject({ ok: true, hint: '16 chars' });
  });
});

describe('validateServiceFields', () => {
  const base: ServiceFieldsInput = {
    slug: 'slack',
    name: 'Slack',
    timeout_ms: 120_000,
    forward_headers: [],
    injection: { kind: 'bearer' },
    verify: { method: 'POST', path: '/api/auth.test', expect_status: 200, expect_ok_field: true },
  };

  it('accepts a valid service', () => {
    expect(validateServiceFields(base)).toEqual({ errors: [], warnings: [] });
  });

  it.each<[string, Partial<ServiceFieldsInput>]>([
    ['upper-case slug', { slug: 'Slack' }],
    ['slug starting with -', { slug: '-slack' }],
    ['slug too long', { slug: 'a'.repeat(64) }],
    ['empty name', { name: ' ' }],
    ['timeout too low', { timeout_ms: 999 }],
    ['timeout too high', { timeout_ms: 900_001 }],
    ['fractional timeout', { timeout_ms: 1500.5 }],
    ['reserved forward header', { forward_headers: ['cookie'] }],
    ['bad injection', { injection: { kind: 'header', name: 'host' } }],
    ['verify path with query', { verify: { method: 'GET', path: '/x?y', expect_status: 200 } }],
    ['verify path traversal', { verify: { method: 'GET', path: '/a/../b', expect_status: 200 } }],
    [
      'verify path encoded traversal',
      { verify: { method: 'GET', path: '/a/%2E%2e/b', expect_status: 200 } },
    ],
    [
      'verify path encoded slash',
      { verify: { method: 'GET', path: '/a%2fb', expect_status: 200 } },
    ],
    ['verify bad status', { verify: { method: 'GET', path: '/x', expect_status: 42 } }],
  ])('rejects %s', (_name, patch) => {
    expect(validateServiceFields({ ...base, ...patch }).errors.length).toBeGreaterThan(0);
  });

  it('warns about query injection', () => {
    const result = validateServiceFields({ ...base, injection: { kind: 'query', param: 'key' } });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});
