import { describe, expect, it } from 'vitest';
import type { Condition, Injection, Rule } from '../../../src/policy/types';
import {
  ALLOWED_ALGS,
  type CallerProviderInput,
  normalizeCredential,
  normalizeInjection,
  type ServiceFieldsInput,
  validateBaseUrl,
  validateCallerProvider,
  validateForwardHeaders,
  validateGrant,
  validateServiceFields,
} from '../../../src/policy/validate';
import { genericProfile, githubProfile, gitlabProfile, provider } from './fixtures';

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
    [{ kind: 'path', prefix: '/services' }, '{"kind":"path","prefix":"/services"}'],
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

describe('validateCallerProvider', () => {
  const github: CallerProviderInput = {
    name: 'GitHub',
    profile: 'github-actions',
    issuer: 'https://token.actions.githubusercontent.com',
    jwks_uri: 'https://token.actions.githubusercontent.com/.well-known/jwks',
    audience: 'tokengate:01JTESTAUDIENCE00000000000',
    allowed_algs: ['RS256'],
    max_token_age_seconds: 600,
    tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: ['1000'] }],
    anchor_claims: [],
  };
  const generic: CallerProviderInput = {
    ...github,
    name: 'Buildkite',
    profile: 'generic',
    issuer: 'https://agent.buildkite.com',
    jwks_uri: 'https://agent.buildkite.com/.well-known/jwks',
    tenant_pin: [{ claim: 'organization_slug', match: 'exact', values: ['acme'] }],
    anchor_claims: ['pipeline_id'],
  };

  it('accepts valid providers', () => {
    expect(validateCallerProvider(github, githubProfile, null)).toEqual({
      errors: [],
      warnings: [],
    });
    expect(validateCallerProvider(generic, genericProfile, null)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('keeps the profile immutable', () => {
    const existing = provider({ profile: 'generic' });
    expect(validateCallerProvider(github, githubProfile, existing).errors).toContain(
      'profile cannot be changed after the caller provider is created',
    );
  });

  it.each<[string, Partial<CallerProviderInput>]>([
    ['http issuer', { issuer: 'http://token.actions.githubusercontent.com' }],
    ['issuer with fragment', { issuer: 'https://issuer.example.com#x' }],
    ['issuer with userinfo', { issuer: 'https://u:p@issuer.example.com' }],
    ['JWKS with query', { jwks_uri: 'https://issuer.example.com/jwks?x=1' }],
    ['no algorithms', { allowed_algs: [] }],
    ['HMAC algorithm', { allowed_algs: ['HS256'] }],
    ['alg none', { allowed_algs: ['none'] }],
    ['empty audience', { audience: '' }],
    ['short audience', { audience: 'tokengate:abc' }],
    ['GitHub default audience', { audience: 'https://github.com/acme-corp-org' }],
    ['GitHub default audience, other case', { audience: 'https://GitHub.com/acme-corp-org' }],
    ['AWS audience', { audience: 'sts.amazonaws.com' }],
    ['Azure audience', { audience: 'api://AzureADTokenExchange' }],
    ['GCP audience', { audience: 'https://iam.googleapis.com/projects/1/locations/global' }],
    ['GCP audience short form', { audience: '//iam.googleapis.com/projects/1/locations/global' }],
    ['max age too low', { max_token_age_seconds: 59 }],
    ['max age over profile limit', { max_token_age_seconds: 901 }],
    ['anchor claims on a fixed profile', { anchor_claims: ['repository_id'] }],
    ['empty name', { name: '' }],
  ])('rejects %s', (_name, patch) => {
    expect(validateCallerProvider({ ...github, ...patch }, githubProfile, null).errors.length).toBe(
      1,
    );
  });

  describe('I-TEN-1: tenant pins', () => {
    it('requires a pin on shared issuers', () => {
      const result = validateCallerProvider({ ...github, tenant_pin: [] }, githubProfile, null);
      expect(result.errors).toHaveLength(1);
      const slash = { ...github, issuer: `${github.issuer}/`, tenant_pin: [] };
      expect(validateCallerProvider(slash, githubProfile, null).errors).toHaveLength(1);
    });

    it('does not require a pin for a dedicated enterprise issuer', () => {
      const enterprise = {
        ...github,
        issuer: 'https://token.actions.githubusercontent.com/acme',
        tenant_pin: [],
      };
      expect(validateCallerProvider(enterprise, githubProfile, null).errors).toEqual([]);
    });

    it('only allows exact, non-negated pins on tenant claims', () => {
      const pin = (c: Condition) => ({ ...github, tenant_pin: [c] });
      const cases: Condition[] = [
        { claim: 'repository_owner_id', match: 'glob', values: ['1*'] },
        { claim: 'repository_owner_id', match: 'exact', values: ['1000'], negate: true },
        { claim: 'repository_owner', match: 'exact', values: ['acme'] },
        { claim: 'repository_owner_id', match: 'exact', values: [] },
      ];
      for (const c of cases) {
        expect(validateCallerProvider(pin(c), githubProfile, null).errors.length).toBeGreaterThan(
          0,
        );
      }
    });

    it('refuses shared issuers under another profile', () => {
      const asGeneric = { ...generic, issuer: 'https://token.actions.githubusercontent.com' };
      expect(validateCallerProvider(asGeneric, genericProfile, null).errors).toEqual([
        'issuers on token.actions.githubusercontent.com must use the github-actions profile',
      ]);
      const gitlabAsGithub = { ...github, issuer: 'https://gitlab.com' };
      expect(validateCallerProvider(gitlabAsGithub, githubProfile, null).errors).toContain(
        'issuers on gitlab.com must use the gitlab-ci profile',
      );
    });

    // Under `generic` the event guard does not run, so pull_request_target tokens would pass.
    it.each([
      'https://token.actions.githubusercontent.com/acme',
      'https://token.actions.githubusercontent.com/',
      'https://TOKEN.actions.githubusercontent.com',
      'https://gitlab.com/',
      'https://gitlab.com/acme',
    ])('binds every issuer on a CI host to its profile: %s', (issuer) => {
      const result = validateCallerProvider({ ...generic, issuer }, genericProfile, null);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/must use the (github-actions|gitlab-ci) profile/);
    });

    it('warns when a generic provider has no pin', () => {
      const result = validateCallerProvider({ ...generic, tenant_pin: [] }, genericProfile, null);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });
  });

  describe('I-JWT-1: signing algorithm allowlist', () => {
    it.each(['none', 'None', 'HS256', 'HS384', 'HS512', 'ES512', 'rs256', ''])(
      'rejects %j',
      (alg) => {
        const result = validateCallerProvider(
          { ...github, allowed_algs: [alg] },
          githubProfile,
          null,
        );
        expect(result.errors).toEqual([`signing algorithm ${JSON.stringify(alg)} is not allowed`]);
      },
    );

    it('rejects a forbidden algorithm listed next to an allowed one', () => {
      const algs = ['RS256', 'HS256'];
      const result = validateCallerProvider({ ...github, allowed_algs: algs }, githubProfile, null);
      expect(result.errors).toHaveLength(1);
    });

    it.each([...ALLOWED_ALGS])('accepts %s', (alg) => {
      const result = validateCallerProvider(
        { ...github, allowed_algs: [alg] },
        githubProfile,
        null,
      );
      expect(result.errors).toEqual([]);
    });
  });

  it('requires anchor claims on generic providers', () => {
    const result = validateCallerProvider({ ...generic, anchor_claims: [] }, genericProfile, null);
    expect(result.errors).toHaveLength(1);
  });

  it('allows the gitlab maximum token age of 3600', () => {
    const gitlab: CallerProviderInput = {
      ...github,
      profile: 'gitlab-ci',
      issuer: 'https://gitlab.com',
      jwks_uri: 'https://gitlab.com/oauth/discovery/keys',
      tenant_pin: [{ claim: 'namespace_id', match: 'exact', values: ['42'] }],
      max_token_age_seconds: 3600,
    };
    expect(validateCallerProvider(gitlab, gitlabProfile, null).errors).toEqual([]);
  });
});

describe('validateGrant', () => {
  const owner: Condition = { claim: 'repository_owner_id', match: 'exact', values: ['1000'] };
  const repo: Condition = { claim: 'repository_id', match: 'exact', values: ['2000'] };
  const rules: Rule[] = [{ methods: ['POST'], path: '/api/chat.postMessage' }];
  const github = provider();
  const check = (conditions: Condition[], r: Rule[] = rules) =>
    validateGrant({ conditions, rules: r }, githubProfile, github);

  it('accepts an anchored grant', () => {
    expect(check([owner, repo])).toEqual({ errors: [], warnings: [] });
  });

  describe('I-CRED-1: path-injection services', () => {
    const path = { injection: { kind: 'path' } as Injection };
    const withService = (r: Rule[], service: { injection: Injection } | null) =>
      validateGrant({ conditions: [owner, repo], rules: r }, githubProfile, github, service);

    it('accepts POST-only rules without a warning', () => {
      expect(withService([{ methods: ['POST'], path: '/' }], path)).toEqual({
        errors: [],
        warnings: [],
      });
    });

    it.each<[string, Rule[]]>([
      ['GET', [{ methods: ['GET'], path: '/' }]],
      ['PATCH next to POST', [{ methods: ['POST', 'PATCH'], path: '/' }]],
      ['any method', [{ methods: ['*'], path: '/**' }]],
      [
        'a second rule',
        [
          { methods: ['POST'], path: '/' },
          { methods: ['DELETE'], path: '/' },
        ],
      ],
    ])('warns on %s', (_name, r) => {
      const { errors, warnings } = withService(r, path);
      expect(errors).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/URL path.*response body.*allow only POST/);
    });

    it('does not warn for other injection kinds or without a service', () => {
      const r: Rule[] = [{ methods: ['*'], path: '/**' }];
      expect(withService(r, { injection: { kind: 'bearer' } }).warnings).toEqual([]);
      expect(withService(r, null).warnings).toEqual([]);
    });
  });

  describe('I-AUTHZ-2: anchor rules', () => {
    it('accepts either anchor rule', () => {
      const workflow: Condition = {
        claim: 'job_workflow_ref',
        match: 'exact',
        values: ['acme/infra/.github/workflows/deploy.yml@refs/heads/main'],
      };
      expect(check([owner, workflow]).errors).toEqual([]);
    });

    it.each<[string, Condition[]]>([
      ['owner only', [owner]],
      ['repository only', [repo]],
      ['repository as glob', [owner, { ...repo, match: 'glob' }]],
      ['negated repository', [owner, { ...repo, negate: true }]],
      ['negated owner', [{ ...owner, negate: true }, repo]],
      ['workflow as glob', [owner, { claim: 'job_workflow_ref', match: 'glob', values: ['**'] }]],
    ])('rejects %s', (_name, conditions) => {
      const result = check(conditions);
      expect(result.errors.some((e) => e.includes('I-AUTHZ-2'))).toBe(true);
    });

    it('uses provider anchor claims for generic profiles', () => {
      const generic = provider({
        profile: 'generic',
        anchor_claims: ['pipeline_id'],
        tenant_pin: [],
      });
      const anchored = [{ claim: 'pipeline_id', match: 'exact', values: ['p1'] }] as Condition[];
      expect(
        validateGrant({ conditions: anchored, rules }, genericProfile, generic).errors,
      ).toEqual([]);
      const unanchored = [{ claim: 'sub', match: 'exact', values: ['x'] }] as Condition[];
      expect(
        validateGrant({ conditions: unanchored, rules }, genericProfile, generic).errors,
      ).toHaveLength(1);
      const noAnchors = provider({ profile: 'generic', anchor_claims: [], tenant_pin: [] });
      expect(
        validateGrant({ conditions: anchored, rules }, genericProfile, noAnchors).errors,
      ).toHaveLength(1);
    });
  });

  it('refuses a profile that does not belong to the caller provider', () => {
    const generic = provider({ profile: 'generic', anchor_claims: ['repository_id'] });
    expect(
      validateGrant({ conditions: [owner, repo], rules }, githubProfile, generic).errors,
    ).toEqual(['profile github-actions does not match the caller provider (generic)']);
  });

  it('applies the tenant pin as the intersection of its conditions on one claim', () => {
    const narrowed = provider({
      tenant_pin: [
        { claim: 'repository_owner_id', match: 'exact', values: ['1000', '1001'] },
        { claim: 'repository_owner_id', match: 'exact', values: ['1000'] },
      ],
    });
    const grant = (values: string[]) =>
      validateGrant({ conditions: [{ ...owner, values }, repo], rules }, githubProfile, narrowed);
    expect(grant(['1000']).errors).toEqual([]);
    expect(grant(['1001']).errors).toHaveLength(1);
  });

  it('applies tenant pin containment to generic providers', () => {
    const generic = provider({
      profile: 'generic',
      anchor_claims: ['pipeline_id'],
      tenant_pin: [{ claim: 'organization_slug', match: 'exact', values: ['acme'] }],
    });
    const conditions: Condition[] = [
      { claim: 'pipeline_id', match: 'exact', values: ['p1'] },
      { claim: 'organization_slug', match: 'exact', values: ['evil'] },
    ];
    expect(validateGrant({ conditions, rules }, genericProfile, generic).errors).toHaveLength(1);
  });

  it('refuses owner values outside the tenant pin', () => {
    const result = check([{ ...owner, values: ['1000', '9999'] }, repo]);
    expect(result.errors).toEqual([
      'repository_owner_id values ["9999"] are outside the caller provider\'s tenant pin',
    ]);
  });

  it.each<[string, Condition[], Rule[]]>([
    ['no conditions', [], rules],
    ['no rules', [owner, repo], []],
    ['rule without methods', [owner, repo], [{ methods: [], path: '/x' }]],
    ['unknown method', [owner, repo], [{ methods: ['TRACE' as 'GET'], path: '/x' }]],
    ['relative path', [owner, repo], [{ methods: ['GET'], path: 'api/x' }]],
    ['invalid path glob', [owner, repo], [{ methods: ['GET'], path: '/*/*/*/*/*/*/*/*/*' }]],
    ['path with space', [owner, repo], [{ methods: ['GET'], path: '/a b' }]],
    ['malformed condition', [owner, repo, { claim: 'ref', match: 'exact', values: [] }], rules],
  ])('rejects %s', (_name, conditions, r) => {
    expect(check(conditions, r).errors.length).toBeGreaterThan(0);
  });

  describe('warnings', () => {
    const protectedRef: Condition = { claim: 'ref_protected', match: 'exact', values: ['true'] };

    it.each([['refs/heads/**'], ['*main'], ['**']])('warns on broad ref glob %s', (pattern) => {
      const ref: Condition = { claim: 'ref', match: 'glob', values: [pattern] };
      const result = check([owner, repo, ref, protectedRef]);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });

    it('does not warn on narrow globs', () => {
      const ref: Condition = { claim: 'ref', match: 'glob', values: ['refs/heads/release/*'] };
      expect(check([owner, repo, ref, protectedRef]).warnings).toEqual([]);
    });

    it('warns on ref or environment without ref_protected', () => {
      const env: Condition = { claim: 'environment', match: 'exact', values: ['prod'] };
      expect(check([owner, repo, env]).warnings).toHaveLength(1);
      expect(check([owner, repo, env, protectedRef]).warnings).toEqual([]);
    });

    it('warns on event globs', () => {
      const event: Condition = { claim: 'event_name', match: 'glob', values: ['push'] };
      expect(check([owner, repo, event]).warnings).toHaveLength(1);
    });

    it('warns on untrusted opt-ins and names pwn-request events', () => {
      const event: Condition = {
        claim: 'event_name',
        match: 'exact',
        values: ['push', 'pull_request', 'pull_request_target'],
      };
      const warnings = check([owner, repo, event]).warnings;
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('"pull_request" is not a trusted event');
      expect(warnings[1]).toContain('pwn request');
    });

    it('applies the same warnings to the GitLab claim names', () => {
      const gitlab = provider({
        profile: 'gitlab-ci',
        issuer: 'https://gitlab.com',
        tenant_pin: [{ claim: 'namespace_id', match: 'exact', values: ['42'] }],
      });
      const anchored: Condition[] = [
        { claim: 'namespace_id', match: 'exact', values: ['42'] },
        { claim: 'project_id', match: 'exact', values: ['7'] },
      ];
      const check = (extra: Condition) =>
        validateGrant({ conditions: [...anchored, extra], rules }, gitlabProfile, gitlab);
      expect(
        check({ claim: 'ref_path', match: 'glob', values: ['refs/heads/**'] }).warnings,
      ).toEqual([
        expect.stringContaining('ref_path glob'),
        expect.stringContaining('ref_protected'),
      ]);
      expect(
        check({ claim: 'ci_config_ref_uri', match: 'glob', values: ['*/.gitlab-ci.yml@**'] })
          .warnings,
      ).toEqual([expect.stringContaining('ci_config_ref_uri glob')]);
      expect(
        check({ claim: 'pipeline_source', match: 'exact', values: ['merge_request_event'] })
          .warnings,
      ).toEqual([expect.stringContaining('"merge_request_event" is not a trusted event')]);
    });

    it('does not count ref_protected listing "false" as protection', () => {
      const ref: Condition = { claim: 'ref', match: 'exact', values: ['refs/heads/main'] };
      const either: Condition = { ...protectedRef, values: ['true', 'false'] };
      expect(check([owner, repo, ref, either]).warnings).toHaveLength(1);
    });

    it('does not warn for trusted events or negated event conditions', () => {
      const trusted: Condition = { claim: 'event_name', match: 'exact', values: ['push'] };
      const negated: Condition = { ...trusted, values: ['workflow_run'], negate: true };
      expect(check([owner, repo, trusted, negated]).warnings).toEqual([]);
    });
  });
});
