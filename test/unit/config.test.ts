import { describe, expect, it } from 'vitest';
import {
  adminOriginAllowed,
  type Config,
  canonicalOrigin,
  normalizeAccessTeamDomain,
  parseConfig,
  splitList,
  upstreamHostAllowed,
} from '../../src/config';
import type { AppEnv } from '../../src/env';

const SECRET = 'sekrit-value-that-must-never-leak';
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
      publicUrl: null,
      errors: [],
      login: { access: null, dev: null },
      bootstrapOwnerEmails: [],
      allowedUpstreamHosts: null,
    });
  });

  it('treats empty and whitespace-only strings as unset', () => {
    const config = parseConfig(
      envWith({
        PUBLIC_URL: '',
        AUTH_ACCESS_TEAM_DOMAIN: '  ',
        AUTH_ACCESS_AUD: ' ',
        AUTH_DEV_EMAIL: '',
        ALLOWED_UPSTREAM_HOSTS: '',
      }),
    );
    expect(config.errors).toEqual([]);
    expect(config.login).toEqual({ access: null, dev: null });
    expect(config.allowedUpstreamHosts).toBeNull();
  });
});

describe('PUBLIC_URL', () => {
  it.each([
    ['https://gw.example.com', 'https://gw.example.com'],
    ['https://gw.example.com/', 'https://gw.example.com'],
    ['https://GW.Example.com:8443', 'https://gw.example.com:8443'],
    ['http://localhost:8787', 'http://localhost:8787'],
    ['http://127.0.0.1:8787/', 'http://127.0.0.1:8787'],
    ['http://[::1]:8787', 'http://[::1]:8787'],
  ])('accepts %s', (raw, origin) => {
    const config = parseConfig(envWith({ PUBLIC_URL: raw }));
    expect(config.errors).toEqual([]);
    expect(config.publicUrl?.origin).toBe(origin);
    expect(config.publicUrl?.href).toBe(`${origin}/`);
  });

  it.each([
    'gw.example.com',
    'not a url',
    'http://gw.example.com',
    'ftp://gw.example.com',
    'https://user:pass@gw.example.com',
    'https://gw.example.com/admin',
    'https://gw.example.com/?x=1',
    'https://gw.example.com/?',
    'https://gw.example.com/#frag',
    'https://gw.example.com.',
    'https://gw.example.com%2e',
    'https://gw.example.com\u3002',
    'http://localhost.example.com',
  ])('rejects %s and leaves publicUrl null', (raw) => {
    const config = parseConfig(envWith({ PUBLIC_URL: raw }));
    expect(config.publicUrl).toBeNull();
    expect(config.errors).toEqual([
      { feature: 'public_url', variable: 'PUBLIC_URL', message: expect.any(String) },
    ]);
  });

  it('does not echo the configured value in errors', () => {
    const config = parseConfig(envWith({ PUBLIC_URL: `https://${SECRET}@gw.example.com` }));
    expect(JSON.stringify(config.errors)).not.toContain(SECRET);
  });
});

describe('canonicalOrigin', () => {
  const request = new URL('https://other.example.net/admin?x=1');

  it('uses PUBLIC_URL when set', () => {
    const config = parseConfig(envWith({ PUBLIC_URL: 'https://gw.example.com/' }));
    expect(canonicalOrigin(config, request)).toBe('https://gw.example.com');
  });

  it('falls back to the request origin', () => {
    expect(canonicalOrigin(parseConfig(envWith({})), request)).toBe('https://other.example.net');
  });
});

describe('I-DEPLOY-1: admin host pinning when PUBLIC_URL is set', () => {
  const at = (href: string) => new URL(href);

  it('serves any origin when PUBLIC_URL is unset', () => {
    const config = parseConfig(envWith({}));
    expect(adminOriginAllowed(config, at('https://tokengate.acme.workers.dev/admin'))).toBe(true);
  });

  it.each([
    ['https://gw.example.com/admin', true],
    ['https://GW.example.com:443/admin/users', true],
    ['https://tokengate.acme.workers.dev/admin', false],
    ['http://gw.example.com/admin', false],
    ['https://gw.example.com:8443/admin', false],
    ['https://gw.example.com.evil.com/admin', false],
    ['https://sub.gw.example.com/admin', false],
  ])('PUBLIC_URL=https://gw.example.com: %s → %s', (href, expected) => {
    const config = parseConfig(envWith({ PUBLIC_URL: 'https://gw.example.com' }));
    expect(adminOriginAllowed(config, at(href))).toBe(expected);
  });

  it.each(['http://gw.example.com', 'https://gw.example.com/tokengate', 'gw.example.com'])(
    'malformed PUBLIC_URL %s denies every origin instead of disabling pinning',
    (raw) => {
      const config = parseConfig(envWith({ PUBLIC_URL: raw }));
      expect(config.publicUrl).toBeNull();
      for (const href of [
        'https://gw.example.com/admin',
        'http://gw.example.com/admin',
        'https://tokengate.acme.workers.dev/admin',
      ]) {
        expect(adminOriginAllowed(config, at(href)), href).toBe(false);
      }
    },
  );
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

  it('enables with team domain, AUD and an https custom-domain PUBLIC_URL', () => {
    const config = parseConfig(
      envWith({
        PUBLIC_URL: 'https://gw.example.com',
        AUTH_ACCESS_TEAM_DOMAIN: 'acme',
        AUTH_ACCESS_AUD: AUD,
      }),
    );
    expect(config.errors).toEqual([]);
    expect(config.login.access).toEqual({
      teamDomain: 'https://acme.cloudflareaccess.com',
      aud: AUD,
    });
  });
});

describe('dev login', () => {
  it.each([
    'http://localhost:8787',
    'http://127.0.0.1:8787',
    'http://[::1]:8787',
    'https://localhost',
  ])('enables AUTH_DEV_EMAIL on loopback PUBLIC_URL %s', (publicUrl) => {
    const config = parseConfig(
      envWith({ PUBLIC_URL: publicUrl, AUTH_DEV_EMAIL: ' Dev@Example.com ' }),
    );
    expect(config.errors).toEqual([]);
    expect(config.login.dev).toEqual({ email: 'dev@example.com' });
  });

  it('Access stays enabled next to a dev login it overrides', () => {
    const config = parseConfig(
      envWith({
        PUBLIC_URL: 'https://localhost',
        AUTH_ACCESS_TEAM_DOMAIN: 'acme',
        AUTH_ACCESS_AUD: AUD,
        AUTH_DEV_EMAIL: 'dev@example.com',
      }),
    );
    expect(config.login.access).not.toBeNull();
    expect(config.login.dev).not.toBeNull();
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
      env: { PUBLIC_URL: 'https://gw.example.com', AUTH_ACCESS_TEAM_DOMAIN: 'acme' },
      feature: 'login.access',
      variable: 'AUTH_ACCESS_AUD',
      disabled: (c) => c.login.access,
    },
    {
      name: 'Access AUD without team domain',
      env: { PUBLIC_URL: 'https://gw.example.com', AUTH_ACCESS_AUD: AUD },
      feature: 'login.access',
      variable: 'AUTH_ACCESS_TEAM_DOMAIN',
      disabled: (c) => c.login.access,
    },
    {
      name: 'Access team domain on a foreign host',
      env: {
        ...access,
        PUBLIC_URL: 'https://gw.example.com',
        AUTH_ACCESS_TEAM_DOMAIN: 'https://evil.com',
      },
      feature: 'login.access',
      variable: 'AUTH_ACCESS_TEAM_DOMAIN',
      disabled: (c) => c.login.access,
    },
    {
      name: 'Access AUD with whitespace inside',
      env: { ...access, PUBLIC_URL: 'https://gw.example.com', AUTH_ACCESS_AUD: 'abc def' },
      feature: 'login.access',
      variable: 'AUTH_ACCESS_AUD',
      disabled: (c) => c.login.access,
    },
    {
      name: 'Access without PUBLIC_URL',
      env: access,
      feature: 'login.access',
      variable: 'PUBLIC_URL',
      disabled: (c) => c.login.access,
    },
    {
      name: 'Access with PUBLIC_URL on workers.dev',
      env: { ...access, PUBLIC_URL: 'https://tokengate.acme.workers.dev' },
      feature: 'login.access',
      variable: 'PUBLIC_URL',
      disabled: (c) => c.login.access,
    },
    {
      name: 'Access with PUBLIC_URL on workers.dev (mixed case)',
      env: { ...access, PUBLIC_URL: 'https://TokenGate.Acme.Workers.Dev' },
      feature: 'login.access',
      variable: 'PUBLIC_URL',
      disabled: (c) => c.login.access,
    },
    {
      name: 'Access with http localhost PUBLIC_URL',
      env: { ...access, PUBLIC_URL: 'http://localhost:8787' },
      feature: 'login.access',
      variable: 'PUBLIC_URL',
      disabled: (c) => c.login.access,
    },
    {
      name: 'Access with malformed PUBLIC_URL',
      env: { ...access, PUBLIC_URL: 'http://gw.example.com' },
      feature: 'login.access',
      variable: 'PUBLIC_URL',
      disabled: (c) => c.login.access,
    },
    {
      name: 'dev login without PUBLIC_URL',
      env: { AUTH_DEV_EMAIL: 'dev@example.com' },
      feature: 'login.dev',
      variable: 'PUBLIC_URL',
      disabled: (c) => c.login.dev,
    },
    {
      name: 'dev login on a public PUBLIC_URL',
      env: { AUTH_DEV_EMAIL: 'dev@example.com', PUBLIC_URL: 'https://gw.example.com' },
      feature: 'login.dev',
      variable: 'PUBLIC_URL',
      disabled: (c) => c.login.dev,
    },
    {
      name: 'dev login on a workers.dev PUBLIC_URL',
      env: { AUTH_DEV_EMAIL: 'dev@example.com', PUBLIC_URL: 'https://tokengate.acme.workers.dev' },
      feature: 'login.dev',
      variable: 'PUBLIC_URL',
      disabled: (c) => c.login.dev,
    },
    {
      name: 'dev login on a host that only starts with localhost',
      env: { AUTH_DEV_EMAIL: 'dev@example.com', PUBLIC_URL: 'https://localhost.example.com' },
      feature: 'login.dev',
      variable: 'PUBLIC_URL',
      disabled: (c) => c.login.dev,
    },
    {
      name: 'dev login with a malformed PUBLIC_URL',
      env: { AUTH_DEV_EMAIL: 'dev@example.com', PUBLIC_URL: 'http://localhost:8787/admin' },
      feature: 'login.dev',
      variable: 'PUBLIC_URL',
      disabled: (c) => c.login.dev,
    },
    {
      name: 'dev login with an invalid email',
      env: { AUTH_DEV_EMAIL: 'dev', PUBLIC_URL: 'http://localhost:8787' },
      feature: 'login.dev',
      variable: 'AUTH_DEV_EMAIL',
      disabled: (c) => c.login.dev,
    },
    {
      name: 'http PUBLIC_URL on a public host',
      env: { PUBLIC_URL: 'http://gw.example.com' },
      feature: 'public_url',
      variable: 'PUBLIC_URL',
      disabled: (c) => c.publicUrl,
    },
    {
      name: 'PUBLIC_URL with a path',
      env: { PUBLIC_URL: 'https://gw.example.com/tokengate' },
      feature: 'public_url',
      variable: 'PUBLIC_URL',
      disabled: (c) => c.publicUrl,
    },
  ];

  it.each(cases)('$name', ({ env, feature, variable, disabled }) => {
    const config = parseConfig(envWith(env));
    expect(disabled(config)).toBeNull();
    expect(errorsFor(config, feature).map((e) => e.variable)).toContain(variable);
    expect(JSON.stringify(config.errors)).not.toContain(SECRET);
    expect(JSON.stringify(config.errors)).not.toContain(AUD);
  });

  it('a broken feature does not disable unrelated features', () => {
    const config = parseConfig(
      envWith({
        PUBLIC_URL: 'https://gw.example.com',
        ...access,
        AUTH_DEV_EMAIL: 'dev@example.com',
        ALLOWED_UPSTREAM_HOSTS: 'api.slack.com',
      }),
    );
    expect(config.login.access).not.toBeNull();
    expect(config.login.dev).toBeNull();
    expect(config.allowedUpstreamHosts).toEqual(['api.slack.com']);
    expect(config.errors.map((e) => e.feature)).toEqual(['login.dev']);
  });

  it.each([
    ',',
    'api.slack.com,https://api.openai.com',
    'api.slack.com:443',
    '*.com',
    '*',
    '**.slack.com',
    'api.*.com',
    'api..slack.com',
    '-bad.example.com',
  ])('malformed ALLOWED_UPSTREAM_HOSTS %j denies every host', (raw) => {
    const config = parseConfig(envWith({ ALLOWED_UPSTREAM_HOSTS: raw }));
    expect(config.allowedUpstreamHosts).toEqual([]);
    expect(errorsFor(config, 'upstream_hosts')).toEqual([
      {
        feature: 'upstream_hosts',
        variable: 'ALLOWED_UPSTREAM_HOSTS',
        message: expect.any(String),
      },
    ]);
    expect(upstreamHostAllowed('api.slack.com', config.allowedUpstreamHosts)).toBe(false);
  });
});

describe('ALLOWED_UPSTREAM_HOSTS', () => {
  it('parses exact hosts and wildcard suffixes, lowercased', () => {
    const config = parseConfig(
      envWith({ ALLOWED_UPSTREAM_HOSTS: ' API.Slack.com, ,*.OpenAI.com ,' }),
    );
    expect(config.errors).toEqual([]);
    expect(config.allowedUpstreamHosts).toEqual(['api.slack.com', '*.openai.com']);
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
    'PUBLIC_URL',
    'BOOTSTRAP_OWNER_EMAILS',
    'ALLOWED_UPSTREAM_HOSTS',
    'AUTH_ACCESS_TEAM_DOMAIN',
    'AUTH_ACCESS_AUD',
    'AUTH_DEV_EMAIL',
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
    expect(config.allowedUpstreamHosts).not.toBeNull();
  });
});

describe('BOOTSTRAP_OWNER_EMAILS', () => {
  it('trims, lowercases and drops empty entries', () => {
    const config = parseConfig(
      envWith({ BOOTSTRAP_OWNER_EMAILS: ' Alice@Example.com,, bob@example.org ,' }),
    );
    expect(config.bootstrapOwnerEmails).toEqual(['alice@example.com', 'bob@example.org']);
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
