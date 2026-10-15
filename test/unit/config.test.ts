import { describe, expect, it } from 'vitest';
import { parseAdminHostInput } from '../../src/admin/ops/admin-hosts';
import { parseUpstreamHostInput } from '../../src/admin/ops/upstream-hosts';
import {
  adminHostAllowed,
  type Config,
  hostListed,
  isAdminHostEntry,
  normalizeAccessTeamDomain,
  parseConfig,
  splitList,
  upstreamHostAllowed,
} from '../../src/config';
import { adminHostsFromValue, upstreamHostsFromValue } from '../../src/db/settings';
import type { AppEnv } from '../../src/env';

const AUD = 'a'.repeat(64);

function envWith(vars: Partial<AppEnv>): AppEnv {
  return { DB: {} as D1Database, TELEMETRY_DB: {} as D1Database, ...vars };
}

function errorsFor(config: Config, feature: Config['errors'][number]['feature']) {
  return config.errors.filter((error) => error.feature === feature);
}

describe('parseConfig: empty environment', () => {
  it('enables nothing and reports no errors', () => {
    const config = parseConfig(envWith({}));
    expect(config).toEqual({
      errors: [],
      login: { access: null, dev: null },
    });
  });

  it('treats empty and whitespace-only strings as unset', () => {
    const config = parseConfig(
      envWith({
        AUTH_ACCESS_TEAM_DOMAIN: '  ',
        AUTH_ACCESS_AUD: ' ',
        AUTH_ACCESS_DEVELOPMENT: '',
      }),
    );
    expect(config.errors).toEqual([]);
    expect(config.login).toEqual({ access: null, dev: null });
  });
});

describe('I-DEPLOY-1: admin host pinning against the stored admin hosts', () => {
  const at = (href: string) => new URL(href);

  it.each([
    ['https://gw.example.com/admin', true],
    ['http://gw.example.com/admin', true],
    ['http://localhost:8787/admin', true],
    ['https://tokengate.acme.workers.dev/admin', false],
    ['https://TokenGate.Acme.Workers.Dev/admin', false],
    ['https://workers.dev/admin', false],
  ])('before the first sign-in (null): %s → %s', (href, expected) => {
    expect(adminHostAllowed(null, at(href))).toBe(expected);
  });

  const hosts = ['gw.example.com', '*.admin.example.org', 'localhost'];
  it.each([
    ['https://gw.example.com/admin', true],
    ['https://GW.example.com:443/admin/users', true],
    ['https://gw.example.com:8443/admin', true],
    ['https://eu.admin.example.org/admin', true],
    ['https://a.b.admin.example.org/admin', true],
    ['http://localhost:8787/admin', true],
    ['https://localhost/admin', true],
    ['http://gw.example.com/admin', false],
    ['http://eu.admin.example.org/admin', false],
    ['https://admin.example.org/admin', false],
    ['https://gw.example.com.evil.com/admin', false],
    ['https://sub.gw.example.com/admin', false],
    ['https://tokengate.acme.workers.dev/admin', false],
    ['http://127.0.0.1:8787/admin', false],
  ])(`${hosts.join(',')}: %s → %s`, (href, expected) => {
    expect(adminHostAllowed(hosts, at(href))).toBe(expected);
  });

  it('an empty list (a stored value that is not valid) denies every host', () => {
    expect(adminHostAllowed([], at('https://gw.example.com/admin'))).toBe(false);
    expect(adminHostAllowed([], at('http://localhost:8787/admin'))).toBe(false);
  });
});

describe('admin host entries', () => {
  it.each([
    ['gw.example.com', true],
    ['*.example.com', true],
    ['localhost', true],
    ['127.0.0.1', true],
    ['[::1]', true],
    ['*.com', false],
    ['*', false],
    ['https://gw.example.com', false],
    ['gw.example.com:443', false],
    ['gw.example.com.', false],
    ['.example.com', false],
    ['tokengate.acme.workers.dev', false],
    ['workers.dev', false],
    ['*.workers.dev', false],
    ['*.acme.workers.dev', false],
    ['[fe80::1]', false],
  ])('%j → %s', (entry, expected) => {
    expect(isAdminHostEntry(entry)).toBe(expected);
  });

  it('parses the textarea: lowercased, deduplicated, keeps the current host', () => {
    expect(
      parseAdminHostInput(
        ' GW.example.com, ,*.Admin.example.org\ngw.example.com',
        'gw.example.com',
      ),
    ).toEqual({
      ok: true,
      hosts: ['gw.example.com', '*.admin.example.org'],
    });
    expect(parseAdminHostInput('*.example.com', 'eu.example.com')).toEqual({
      ok: true,
      hosts: ['*.example.com'],
    });
  });

  it.each([
    ['', 'gw.example.com'],
    [' \n ', 'gw.example.com'],
    ['other.example.com', 'gw.example.com'],
    ['*.example.com', 'example.com'],
    ['gw.example.com, tokengate.acme.workers.dev', 'gw.example.com'],
    ['gw.example.com https://x.example.com', 'gw.example.com'],
  ])('refuses %j while on %s', (raw, current) => {
    expect(parseAdminHostInput(raw, current)).toEqual({ ok: false, error: expect.any(String) });
  });

  it.each([
    [undefined, null],
    [
      '["gw.example.com","*.example.org","localhost"]',
      ['gw.example.com', '*.example.org', 'localhost'],
    ],
    ['[]', []],
    ['null', []],
    ['"gw.example.com"', []],
    ['["https://gw.example.com"]', []],
    ['["tokengate.acme.workers.dev"]', []],
    ['[1]', []],
    ['{', []],
  ])('stored admin hosts %j read as %j (malformed denies every host)', (raw, expected) => {
    expect(adminHostsFromValue(raw)).toEqual(expected);
  });

  it('hostListed matches exact hosts and strict subdomains of wildcards', () => {
    expect(hostListed('A.example.com', ['*.example.com'])).toBe(true);
    expect(hostListed('example.com', ['*.example.com'])).toBe(false);
    expect(hostListed('evilexample.com', ['*.example.com'])).toBe(false);
    expect(hostListed('gw.example.com', ['gw.example.com'])).toBe(true);
  });
});

describe('Access login', () => {
  it.each([
    'acme',
    'ACME',
    'acme.cloudflareaccess.com',
    'https://acme.cloudflareaccess.com',
    'https://acme.cloudflareaccess.com/',
  ])('normalizes team domain %s', (raw) => {
    expect(normalizeAccessTeamDomain(raw)).toBe('https://acme.cloudflareaccess.com');
  });

  it.each([
    'https://evil.example.com',
    'acme.cloudflareaccess.com.evil.com',
    'a.b.cloudflareaccess.com',
    'http://acme.cloudflareaccess.com',
    'https://acme.cloudflareaccess.com/path',
    'acme/x',
    '-acme',
    '.cloudflareaccess.com',
  ])('rejects team domain %s', (raw) => {
    expect(normalizeAccessTeamDomain(raw)).toBeNull();
  });

  it('enables with team domain and AUD', () => {
    const config = parseConfig(envWith({ AUTH_ACCESS_TEAM_DOMAIN: 'acme', AUTH_ACCESS_AUD: AUD }));
    expect(config.errors).toEqual([]);
    expect(config.login.access).toEqual({
      teamDomain: 'https://acme.cloudflareaccess.com',
      aud: AUD,
    });
  });
});

describe('dev login', () => {
  it('enables AUTH_ACCESS_DEVELOPMENT, lowercased (requestIdentity limits it to loopback hosts)', () => {
    const config = parseConfig(envWith({ AUTH_ACCESS_DEVELOPMENT: ' Dev@Example.com ' }));
    expect(config.errors).toEqual([]);
    expect(config.login.dev).toEqual({ email: 'dev@example.com' });
  });

  it.each([
    { AUTH_ACCESS_TEAM_DOMAIN: 'acme', AUTH_ACCESS_AUD: AUD },
    { AUTH_ACCESS_TEAM_DOMAIN: 'acme' },
    { AUTH_ACCESS_AUD: AUD },
  ])('with any Access variable (%j), turns both logins off', (access) => {
    const config = parseConfig(envWith({ ...access, AUTH_ACCESS_DEVELOPMENT: 'dev@example.com' }));
    expect(config.login).toEqual({ access: null, dev: null });
    expect(config.errors.map((e) => [e.feature, e.variable])).toEqual([
      ['login.access', 'AUTH_ACCESS_DEVELOPMENT'],
      ['login.dev', 'AUTH_ACCESS_DEVELOPMENT'],
    ]);
    expect(JSON.stringify(config.errors)).not.toContain(AUD);
    expect(JSON.stringify(config.errors)).not.toContain('dev@example.com');
  });
});

describe('I-CFG-1: malformed config disables the affected feature; never runs half-configured', () => {
  const access = { AUTH_ACCESS_TEAM_DOMAIN: 'acme', AUTH_ACCESS_AUD: AUD };

  const cases: Array<{
    name: string;
    env: Partial<AppEnv>;
    feature: Config['errors'][number]['feature'];
    variable: string;
    disabled: (config: Config) => unknown;
  }> = [
    {
      name: 'Access team domain without AUD',
      env: { AUTH_ACCESS_TEAM_DOMAIN: 'acme' },
      feature: 'login.access',
      variable: 'AUTH_ACCESS_AUD',
      disabled: (c) => c.login.access,
    },
    {
      name: 'Access AUD without team domain',
      env: { AUTH_ACCESS_AUD: AUD },
      feature: 'login.access',
      variable: 'AUTH_ACCESS_TEAM_DOMAIN',
      disabled: (c) => c.login.access,
    },
    {
      name: 'Access team domain on a foreign host',
      env: { ...access, AUTH_ACCESS_TEAM_DOMAIN: 'https://evil.com' },
      feature: 'login.access',
      variable: 'AUTH_ACCESS_TEAM_DOMAIN',
      disabled: (c) => c.login.access,
    },
    {
      name: 'Access AUD with whitespace inside',
      env: { ...access, AUTH_ACCESS_AUD: 'abc def' },
      feature: 'login.access',
      variable: 'AUTH_ACCESS_AUD',
      disabled: (c) => c.login.access,
    },
    {
      name: 'dev login with an invalid email',
      env: { AUTH_ACCESS_DEVELOPMENT: 'dev' },
      feature: 'login.dev',
      variable: 'AUTH_ACCESS_DEVELOPMENT',
      disabled: (c) => c.login.dev,
    },
  ];

  it.each(cases)('$name', ({ env, feature, variable, disabled }) => {
    const config = parseConfig(envWith(env));
    expect(disabled(config)).toBeNull();
    expect(errorsFor(config, feature).map((e) => e.variable)).toContain(variable);
    expect(JSON.stringify(config.errors)).not.toContain(AUD);
  });

  it('a broken login reports only its own feature', () => {
    expect(
      parseConfig(envWith({ ...access, AUTH_ACCESS_AUD: 'abc def' })).errors.map((e) => e.feature),
    ).toEqual(['login.access']);
    expect(
      parseConfig(envWith({ AUTH_ACCESS_DEVELOPMENT: 'dev' })).errors.map((e) => e.feature),
    ).toEqual(['login.dev']);
  });

  it.each([
    'api.slack.com,https://api.openai.com',
    'api.slack.com:443',
    '*.com',
    '*',
    '**.slack.com',
    'api.*.com',
    'api..slack.com',
    '-bad.example.com',
  ])('rejects the allowlist input %j', (raw) => {
    expect(parseUpstreamHostInput(raw)).toEqual({ ok: false, error: expect.any(String) });
  });

  it.each([
    ['"not-a-list"', []],
    ['[]', []],
    ['["https://x"]', []],
    ['[1]', []],
    ['{', []],
    ['null', null],
    [undefined, null],
    ['["api.slack.com","*.openai.com"]', ['api.slack.com', '*.openai.com']],
  ])('stored allowlist %j reads as %j (malformed denies every host)', (raw, expected) => {
    expect(upstreamHostsFromValue(raw)).toEqual(expected);
  });
});

describe('upstream host allowlist', () => {
  it('parses exact hosts and wildcard suffixes, lowercased and deduplicated', () => {
    expect(parseUpstreamHostInput(' API.Slack.com, ,*.OpenAI.com ,\napi.slack.com')).toEqual({
      ok: true,
      hosts: ['api.slack.com', '*.openai.com'],
    });
    expect(parseUpstreamHostInput(' \n ')).toEqual({ ok: true, hosts: null });
  });

  it.each([
    ['api.slack.com', true],
    ['API.SLACK.COM', true],
    ['slack.com', false],
    ['files.slack.com', false],
    ['api.slack.com.evil.com', false],
    ['evilapi.slack.com', false],
    ['api.openai.com', true],
    ['a.b.openai.com', true],
    ['openai.com', false],
    ['evilopenai.com', false],
    ['api.slack.com.', false],
    ['api.slack.com:443', false],
    ['.openai.com', false],
    ['a..openai.com', false],
    ['', false],
  ])('%j → %s', (host, expected) => {
    expect(upstreamHostAllowed(host, ['api.slack.com', '*.openai.com'])).toBe(expected);
  });

  it('allows any host when unrestricted', () => {
    expect(upstreamHostAllowed('anything.example', null)).toBe(true);
  });
});

describe('I-CFG-1: hostile values never throw and never appear in errors', () => {
  const MARK = 'leakmarker';
  const variables = [
    'AUTH_ACCESS_TEAM_DOMAIN',
    'AUTH_ACCESS_AUD',
    'AUTH_ACCESS_DEVELOPMENT',
  ] as const;
  const hostile = [
    `https://${MARK}:${MARK}@x.example.com/${MARK}?${MARK}#${MARK}`,
    `${MARK}\u0000\n,${MARK}`,
    `javascript:${MARK}`,
    `*.${MARK}`,
    `${MARK}.`.repeat(100),
    `[${MARK}]`,
  ];

  it.each(hostile)('every variable set to %j', (raw) => {
    const env = envWith(Object.fromEntries(variables.map((name) => [name, raw])));
    const config = parseConfig(env);
    expect(JSON.stringify(config.errors)).not.toContain(MARK);
    expect(config.login.access).toBeNull();
    expect(config.login.dev).toBeNull();
  });
});

describe('splitList', () => {
  it.each([
    [undefined, []],
    ['', []],
    [' , ,', []],
    ['a', ['a']],
    [' a , b,,c ', ['a', 'b', 'c']],
  ])('%j → %j', (raw, expected) => {
    expect(splitList(raw)).toEqual(expected);
  });
});
