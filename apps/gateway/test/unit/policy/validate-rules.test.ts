import { describe, expect, it } from 'vitest';
import type { PolicyCredentialRule } from '../../../src/policy/limits';
import type { Condition, Injection, Rule } from '../../../src/policy/types';
import { ALLOWED_ALGS } from '../../../src/policy/validate';
import {
  canonicalIssuerError,
  type CredentialAccessRuleInput,
  type CredentialRuleContext,
  type GlobalAccessRuleInput,
  validateCredentialAccessRule,
  validateGlobalAccessRule,
} from '../../../src/policy/validate-rules';
import { credentialRule } from './access-rule-fixtures';
import { genericProfile, githubProfile, gitlabProfile } from './fixtures';

const owner: Condition = { claim: 'repository_owner_id', match: 'exact', values: ['1000'] };
const repo: Condition = { claim: 'repository_id', match: 'exact', values: ['2000'] };
const rules: Rule[] = [{ methods: ['POST'], path: '/api/chat.postMessage' }];
const bearer: CredentialRuleContext = { injection: { kind: 'bearer' }, rules: [] };

const github: CredentialAccessRuleInput = {
  name: 'GitHub',
  description: '',
  profile: 'github-actions',
  issuer: 'https://token.actions.githubusercontent.com',
  jwks_uri: 'https://token.actions.githubusercontent.com/.well-known/jwks',
  audience: 'tokengate:01JTESTAUDIENCE00000000000',
  allowed_algs: ['RS256'],
  max_token_age_seconds: 600,
  tenant_pin: [owner],
  anchor_claims: [],
  conditions: [owner, repo],
  rules,
};
const generic: CredentialAccessRuleInput = {
  ...github,
  name: 'Buildkite',
  profile: 'generic',
  issuer: 'https://agent.buildkite.com',
  jwks_uri: 'https://agent.buildkite.com/.well-known/jwks',
  tenant_pin: [{ claim: 'organization_slug', match: 'exact', values: ['acme'] }],
  anchor_claims: ['pipeline_id'],
  conditions: [{ claim: 'pipeline_id', match: 'exact', values: ['p1'] }],
};
const gitlab: CredentialAccessRuleInput = {
  ...github,
  profile: 'gitlab-ci',
  issuer: 'https://gitlab.com',
  jwks_uri: 'https://gitlab.com/oauth/discovery/keys',
  tenant_pin: [{ claim: 'namespace_id', match: 'exact', values: ['42'] }],
  conditions: [
    { claim: 'namespace_id', match: 'exact', values: ['42'] },
    { claim: 'project_id', match: 'exact', values: ['7'] },
  ],
};

const check = (input: Partial<CredentialAccessRuleInput>, context = bearer) =>
  validateCredentialAccessRule({ ...github, ...input }, githubProfile, null, context);
const checkConditions = (conditions: Condition[], r: Rule[] = rules) =>
  check({ conditions, rules: r });

describe('AR-3: canonicalIssuerError', () => {
  it.each([
    'https://gitlab.com',
    'https://gitlab.com/',
    'https://token.actions.githubusercontent.com',
    'https://token.actions.githubusercontent.com/acme',
    'https://issuer.example.com/a/~b',
  ])('accepts %s', (issuer) => {
    expect(canonicalIssuerError(issuer)).toBeNull();
  });

  it.each([
    ['https://gitlab.com:443', 'https://gitlab.com'],
    ['https://gitlab.com/./', 'https://gitlab.com'],
    ['https://gitlab.com/a/../b', 'https://gitlab.com/b'],
    ['https://gitlab.com/%7E', 'https://gitlab.com/~'],
    ['https://gitlab.com/a%2fb', 'https://gitlab.com/a%2Fb'],
    ['https://GitLab.com', 'https://gitlab.com'],
  ])('refuses %s and names %s', (issuer, canonical) => {
    expect(canonicalIssuerError(issuer)).toBe(`Write the issuer as ${canonical}.`);
  });

  it('refuses a value that is not a URL', () => {
    expect(canonicalIssuerError('not a url')).toBe('The issuer is not a valid URL.');
  });

  it.each([
    ['https://gitlab.com:443', 'https://gitlab.com'],
    ['https://gitlab.com/./', 'https://gitlab.com'],
    ['https://gitlab.com/%7E', 'https://gitlab.com/~'],
  ])('applies to both kinds of rule: %s', (issuer, canonical) => {
    const error = `Write the issuer as ${canonical}.`;
    const credential = validateCredentialAccessRule(
      { ...gitlab, issuer },
      gitlabProfile,
      null,
      bearer,
    );
    expect(credential.errors).toEqual([error]);
    const global = { ...noLimits, profile: 'gitlab-ci' as const, issuer };
    expect(validateGlobalAccessRule(global, gitlabProfile, null).errors).toEqual([error]);
  });
});

describe('validateCredentialAccessRule: token verification settings', () => {
  it('accepts valid rules', () => {
    const ok = { errors: [], warnings: [], warningDetails: [] };
    expect(check({})).toEqual(ok);
    expect(validateCredentialAccessRule(generic, genericProfile, null, bearer)).toEqual(ok);
    expect(validateCredentialAccessRule(gitlab, gitlabProfile, null, bearer)).toEqual(ok);
  });

  it('keeps the profile immutable', () => {
    const existing = credentialRule({ profile: 'generic' });
    expect(validateCredentialAccessRule(github, githubProfile, existing, bearer).errors).toContain(
      'profile cannot be changed after the credential access rule is created',
    );
  });

  it('refuses a profile that is not the selected one', () => {
    expect(check({ profile: 'generic' }).errors).toContain(
      'profile does not match the selected profile',
    );
  });

  it.each<[string, Partial<CredentialAccessRuleInput>]>([
    ['http issuer', { issuer: 'http://token.actions.githubusercontent.com' }],
    ['issuer with fragment', { issuer: 'https://issuer.example.com#x' }],
    ['issuer with userinfo', { issuer: 'https://u:p@issuer.example.com' }],
    ['issuer with a default port', { issuer: 'https://issuer.example.com:443' }],
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
    ['long description', { description: 'x'.repeat(2001) }],
    ['control characters in the description', { description: 'a\u0000b' }],
  ])('rejects %s', (_name, patch) => {
    expect(check(patch).errors).toHaveLength(1);
  });

  it('allows line breaks and tabs in the description', () => {
    expect(check({ description: 'line 1\nline 2\r\n\tindented' }).errors).toEqual([]);
  });

  describe('I-TEN-1: tenant pins', () => {
    it('requires a pin on shared issuers', () => {
      expect(check({ tenant_pin: [] }).errors).toHaveLength(1);
      expect(check({ issuer: `${github.issuer}/`, tenant_pin: [] }).errors).toHaveLength(1);
    });

    it('does not require a pin for a dedicated enterprise issuer', () => {
      const enterprise = {
        issuer: 'https://token.actions.githubusercontent.com/acme',
        tenant_pin: [],
      };
      expect(check(enterprise).errors).toEqual([]);
    });

    it('only allows exact, non-negated pins on tenant claims', () => {
      const cases: Condition[] = [
        { claim: 'repository_owner_id', match: 'glob', values: ['1*'] },
        { claim: 'repository_owner_id', match: 'exact', values: ['1000'], negate: true },
        { claim: 'repository_owner', match: 'exact', values: ['acme'] },
        { claim: 'repository_owner_id', match: 'exact', values: [] },
      ];
      for (const c of cases) expect(check({ tenant_pin: [c] }).errors.length).toBeGreaterThan(0);
    });

    it('refuses shared issuers under another profile', () => {
      const asGeneric = { ...generic, issuer: 'https://token.actions.githubusercontent.com' };
      expect(validateCredentialAccessRule(asGeneric, genericProfile, null, bearer).errors).toEqual([
        'issuers on token.actions.githubusercontent.com must use the github-actions profile',
      ]);
      expect(check({ issuer: 'https://gitlab.com' }).errors).toContain(
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
      const result = validateCredentialAccessRule(
        { ...generic, issuer },
        genericProfile,
        null,
        bearer,
      );
      expect(result.errors).toContainEqual(
        expect.stringMatching(/must use the (github-actions|gitlab-ci) profile/),
      );
    });

    it('warns when a generic rule has no pin', () => {
      const result = validateCredentialAccessRule(
        { ...generic, tenant_pin: [] },
        genericProfile,
        null,
        bearer,
      );
      expect(result.errors).toEqual([]);
      expect(result.warningDetails.map((detail) => detail.code)).toEqual(['no_tenant_pin']);
      expect(result.warnings).toHaveLength(1);
    });
  });

  describe('I-JWT-1: signing algorithm allowlist', () => {
    it.each(['none', 'None', 'HS256', 'HS384', 'HS512', 'ES512', 'rs256', ''])(
      'rejects %j',
      (alg) => {
        expect(check({ allowed_algs: [alg] }).errors).toEqual([
          `signing algorithm ${JSON.stringify(alg)} is not allowed`,
        ]);
      },
    );

    it('rejects a forbidden algorithm listed next to an allowed one', () => {
      expect(check({ allowed_algs: ['RS256', 'HS256'] }).errors).toHaveLength(1);
    });

    it.each([...ALLOWED_ALGS])('accepts %s', (alg) => {
      expect(check({ allowed_algs: [alg] }).errors).toEqual([]);
    });
  });

  it('requires anchor claims on generic rules', () => {
    const result = validateCredentialAccessRule(
      { ...generic, anchor_claims: [] },
      genericProfile,
      null,
      bearer,
    );
    expect(result.errors).toHaveLength(1);
  });

  it('allows the gitlab maximum token age of 3600', () => {
    const result = validateCredentialAccessRule(
      { ...gitlab, max_token_age_seconds: 3600 },
      gitlabProfile,
      null,
      bearer,
    );
    expect(result.errors).toEqual([]);
  });
});

describe('validateCredentialAccessRule: conditions and operations', () => {
  it('accepts an anchored rule', () => {
    expect(checkConditions([owner, repo])).toEqual({
      errors: [],
      warnings: [],
      warningDetails: [],
    });
  });

  describe('I-CRED-1: path-injection credentials', () => {
    const path: CredentialRuleContext = { injection: { kind: 'path' } as Injection, rules: [] };

    it('accepts POST-only rules without a warning', () => {
      expect(check({ rules: [{ methods: ['POST'], path: '/' }] }, path)).toEqual({
        errors: [],
        warnings: [],
        warningDetails: [],
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
      const { errors, warnings, warningDetails } = check({ rules: r }, path);
      expect(errors).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/URL path.*response body.*allow only POST/);
      expect(warningDetails[0]?.code).toBe('path_injection_non_post');
    });

    it('does not warn for other injection kinds', () => {
      expect(check({ rules: [{ methods: ['*'], path: '/**' }] }).warnings).toEqual([]);
    });
  });

  describe('I-AUTHZ-2: anchor rules on the rule itself', () => {
    it('accepts either anchor rule', () => {
      const workflow: Condition = {
        claim: 'job_workflow_ref',
        match: 'exact',
        values: ['acme/infra/.github/workflows/deploy.yml@refs/heads/main'],
      };
      expect(checkConditions([owner, workflow]).errors).toEqual([]);
    });

    it.each<[string, Condition[]]>([
      ['owner only', [owner]],
      ['repository only', [repo]],
      ['repository as glob', [owner, { ...repo, match: 'glob' }]],
      ['negated repository', [owner, { ...repo, negate: true }]],
      ['negated owner', [{ ...owner, negate: true }, repo]],
      ['workflow as glob', [owner, { claim: 'job_workflow_ref', match: 'glob', values: ['**'] }]],
    ])('rejects %s', (_name, conditions) => {
      expect(checkConditions(conditions).errors.some((e) => e.includes('I-AUTHZ-2'))).toBe(true);
    });

    it('uses the rule’s own anchor claims for generic profiles', () => {
      const anchored = [{ claim: 'pipeline_id', match: 'exact', values: ['p1'] }] as Condition[];
      const generic2 = (patch: Partial<CredentialAccessRuleInput>) =>
        validateCredentialAccessRule(
          { ...generic, tenant_pin: [], ...patch },
          genericProfile,
          null,
          bearer,
        ).errors;
      expect(generic2({ conditions: anchored })).toEqual([]);
      const unanchored = [{ claim: 'sub', match: 'exact', values: ['x'] }] as Condition[];
      expect(generic2({ conditions: unanchored })).toHaveLength(1);
      expect(generic2({ conditions: anchored, anchor_claims: [] })).toHaveLength(1);
    });
  });

  it('applies the tenant pin as the intersection of its conditions on one claim', () => {
    const narrowed: Condition[] = [
      { claim: 'repository_owner_id', match: 'exact', values: ['1000', '1001'] },
      { claim: 'repository_owner_id', match: 'exact', values: ['1000'] },
    ];
    const withOwner = (values: string[]) =>
      check({ tenant_pin: narrowed, conditions: [{ ...owner, values }, repo] }).errors;
    expect(withOwner(['1000'])).toEqual([]);
    expect(withOwner(['1001'])).toHaveLength(1);
  });

  it('applies tenant pin containment to generic rules', () => {
    const conditions: Condition[] = [
      { claim: 'pipeline_id', match: 'exact', values: ['p1'] },
      { claim: 'organization_slug', match: 'exact', values: ['evil'] },
    ];
    const result = validateCredentialAccessRule(
      { ...generic, conditions },
      genericProfile,
      null,
      bearer,
    );
    expect(result.errors).toHaveLength(1);
  });

  it('refuses owner values outside the tenant pin', () => {
    expect(checkConditions([{ ...owner, values: ['1000', '9999'] }, repo]).errors).toEqual([
      'repository_owner_id values ["9999"] are outside the tenant pin of this access rule',
    ]);
  });

  it.each<[string, Condition[], Rule[]]>([
    ['no conditions', [], rules],
    ['no rules', [owner, repo], []],
    ['too many rules', [owner, repo], Array.from({ length: 51 }, () => rules[0] as Rule)],
    ['rule without methods', [owner, repo], [{ methods: [], path: '/x' }]],
    ['unknown method', [owner, repo], [{ methods: ['TRACE' as 'GET'], path: '/x' }]],
    ['relative path', [owner, repo], [{ methods: ['GET'], path: 'api/x' }]],
    ['invalid path glob', [owner, repo], [{ methods: ['GET'], path: '/*/*/*/*/*/*/*/*/*' }]],
    ['path with space', [owner, repo], [{ methods: ['GET'], path: '/a b' }]],
    ['malformed condition', [owner, repo, { claim: 'ref', match: 'exact', values: [] }], rules],
    ['too many conditions', [owner, repo, ...Array.from({ length: 31 }, () => owner)], rules],
  ])('rejects %s', (_name, conditions, r) => {
    expect(checkConditions(conditions, r).errors.length).toBeGreaterThan(0);
  });

  describe('warnings', () => {
    const protectedRef: Condition = { claim: 'ref_protected', match: 'exact', values: ['true'] };

    it.each([['refs/heads/**'], ['*main'], ['**']])('warns on broad ref glob %s', (pattern) => {
      const ref: Condition = { claim: 'ref', match: 'glob', values: [pattern] };
      const result = checkConditions([owner, repo, ref, protectedRef]);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });

    it('does not warn on narrow globs', () => {
      const ref: Condition = { claim: 'ref', match: 'glob', values: ['refs/heads/release/*'] };
      expect(checkConditions([owner, repo, ref, protectedRef]).warnings).toEqual([]);
    });

    it('warns on ref or environment without ref_protected', () => {
      const env: Condition = { claim: 'environment', match: 'exact', values: ['prod'] };
      expect(checkConditions([owner, repo, env]).warnings).toHaveLength(1);
      expect(checkConditions([owner, repo, env, protectedRef]).warnings).toEqual([]);
    });

    it('warns on event globs', () => {
      const event: Condition = { claim: 'event_name', match: 'glob', values: ['push'] };
      expect(checkConditions([owner, repo, event]).warnings).toHaveLength(1);
    });

    it('warns on untrusted opt-ins and names pwn-request events', () => {
      const event: Condition = {
        claim: 'event_name',
        match: 'exact',
        values: ['push', 'pull_request', 'pull_request_target'],
      };
      const warnings = checkConditions([owner, repo, event]).warnings;
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('"pull_request" is not a trusted event');
      expect(warnings[1]).toContain('pwn request');
    });

    it('gives every warning a stable code, in the order of the messages (A7.7)', () => {
      const ref = (value: string): Condition => ({ claim: 'ref', match: 'glob', values: [value] });
      const event = (values: string[], match: 'exact' | 'glob' = 'exact'): Condition => ({
        claim: 'event_name',
        match,
        values,
      });
      const codes = (conditions: Condition[]) => {
        const result = checkConditions(conditions);
        expect(result.warningDetails.map((detail) => detail.message)).toEqual(result.warnings);
        return result.warningDetails.map((detail) => detail.code);
      };
      expect(codes([owner, repo, ref('refs/heads/**'), protectedRef])).toEqual(['broad_glob']);
      expect(codes([owner, repo, ref('refs/heads/main')])).toEqual(['unprotected_ref']);
      expect(codes([owner, repo, event(['push'], 'glob')])).toEqual(['event_glob']);
      expect(codes([owner, repo, event(['pull_request'])])).toEqual(['pull_request']);
      expect(codes([owner, repo, event(['workflow_run'])])).toEqual(['pwn_request']);
      expect(codes([owner, repo, event(['dynamic'])])).toEqual(['untrusted_event']);
    });

    it('applies the same warnings to the GitLab claim names', () => {
      const warn = (extra: Condition) =>
        validateCredentialAccessRule(
          { ...gitlab, conditions: [...gitlab.conditions, extra] },
          gitlabProfile,
          null,
          bearer,
        ).warnings;
      expect(warn({ claim: 'ref_path', match: 'glob', values: ['refs/heads/**'] })).toEqual([
        expect.stringContaining('ref_path glob'),
        expect.stringContaining('ref_protected'),
      ]);
      expect(
        warn({ claim: 'ci_config_ref_uri', match: 'glob', values: ['*/.gitlab-ci.yml@**'] }),
      ).toEqual([expect.stringContaining('ci_config_ref_uri glob')]);
      expect(
        warn({ claim: 'pipeline_source', match: 'exact', values: ['merge_request_event'] }),
      ).toEqual([expect.stringContaining('"merge_request_event" is not a trusted event')]);
    });

    it('does not count ref_protected listing "false" as protection', () => {
      const ref: Condition = { claim: 'ref', match: 'exact', values: ['refs/heads/main'] };
      const either: Condition = { ...protectedRef, values: ['true', 'false'] };
      expect(checkConditions([owner, repo, ref, either]).warnings).toHaveLength(1);
    });

    it('does not warn for trusted events or negated event conditions', () => {
      const trusted: Condition = { claim: 'event_name', match: 'exact', values: ['push'] };
      const negated: Condition = { ...trusted, values: ['workflow_run'], negate: true };
      expect(checkConditions([owner, repo, trusted, negated]).warnings).toEqual([]);
    });
  });
});

describe('AR-10: verification settings cap', () => {
  const stored = (index: number, overrides: Partial<PolicyCredentialRule> = {}) =>
    credentialRule({
      id: `acr_${index}`,
      jwks_uri: `https://token.actions.githubusercontent.com/jwks/${index}`,
      ...overrides,
    });
  const context = (rules: PolicyCredentialRule[]): CredentialRuleContext => ({
    injection: { kind: 'bearer' },
    rules,
  });
  const pairs = [1, 2, 3, 4].map((index) => stored(index));
  const PAIRS_ERROR =
    'The access rules of this credential already use 4 different JWKS URI and audience pairs for this issuer. Reuse one of them.';

  it('allows at most 4 JWKS URI and audience pairs per issuer', () => {
    expect(check({}, context(pairs.slice(0, 3))).errors).toEqual([]);
    expect(check({}, context(pairs)).errors).toEqual([PAIRS_ERROR]);
  });

  it('allows a rule that reuses a pair', () => {
    expect(check({ jwks_uri: pairs[0]?.jwks_uri }, context(pairs)).errors).toEqual([]);
  });

  it('skips the rule being updated', () => {
    const existing = pairs[3] as PolicyCredentialRule;
    const result = validateCredentialAccessRule(github, githubProfile, existing, context(pairs));
    expect(result.errors).toEqual([]);
  });

  it('counts only the rules of the same issuer key', () => {
    const otherIssuer = pairs.map((rule) => ({
      ...rule,
      issuer: 'https://token.actions.githubusercontent.com/acme',
      issuer_key: 'https://token.actions.githubusercontent.com/acme',
    }));
    expect(check({}, context(otherIssuer)).errors).toEqual([]);
    const folded = pairs.map((rule) => ({ ...rule, issuer: `${rule.issuer}/` }));
    expect(check({}, context(folded)).errors).toEqual([PAIRS_ERROR]);
  });

  it('allows at most 8 verification groups per issuer', () => {
    const groups = [60, 120, 180, 240, 300, 360, 420, 480].map((age, index) =>
      stored(index, { jwks_uri: github.jwks_uri, max_token_age_seconds: age }),
    );
    expect(check({ max_token_age_seconds: 480 }, context(groups)).errors).toEqual([]);
    expect(check({}, context(groups)).errors).toEqual([
      'The access rules of this credential already use 8 different token verification settings for this issuer. Reuse the settings of one of them.',
    ]);
    expect(check({}, context(groups.slice(1))).errors).toEqual([]);
  });

  it('ignores rules of an unknown profile, which never reach verification', () => {
    const groups = [60, 120, 180, 240, 300, 360, 420, 480].map((age, index) =>
      stored(index, {
        jwks_uri: github.jwks_uri,
        max_token_age_seconds: age,
        profile: (index === 0 ? 'retired' : 'github-actions') as PolicyCredentialRule['profile'],
      }),
    );
    expect(check({}, context(groups)).errors).toEqual([]);
  });
});

const noLimits: GlobalAccessRuleInput = {
  name: 'GitHub ceiling',
  description: '',
  profile: 'github-actions',
  issuer: 'https://token.actions.githubusercontent.com',
  jwks_uri: null,
  audience: null,
  allowed_algs: null,
  max_token_age_seconds: null,
  tenant_pin: null,
  anchor_claims: null,
  conditions: null,
  rules: null,
};
const allLimits: GlobalAccessRuleInput = {
  ...noLimits,
  jwks_uri: github.jwks_uri,
  audience: github.audience,
  allowed_algs: ['RS256'],
  max_token_age_seconds: 300,
  tenant_pin: [owner],
  anchor_claims: ['repository_id'],
  // No anchor requirement: a ceiling may name only the branch.
  conditions: [{ claim: 'ref', match: 'exact', values: ['refs/heads/main'] }],
  rules: [{ methods: ['GET'], path: '/**' }],
};
const checkGlobal = (patch: Partial<GlobalAccessRuleInput>) =>
  validateGlobalAccessRule({ ...allLimits, ...patch }, githubProfile, null);

describe('I-AUTHZ-5: validateGlobalAccessRule', () => {
  it('accepts a rule with every limit', () => {
    expect(checkGlobal({})).toEqual({ errors: [], warnings: [], warningDetails: [] });
  });

  it('accepts a rule with no limit, with a warning', () => {
    const result = validateGlobalAccessRule(noLimits, githubProfile, null);
    expect(result.errors).toEqual([]);
    expect(result.warningDetails.map((detail) => detail.code)).toEqual(['global_no_limit']);
    expect(result.warnings[0]).toMatch(/^This global access rule limits nothing\./);
  });

  it.each<[string, Partial<GlobalAccessRuleInput>]>([
    ['allowed_algs', { allowed_algs: [] }],
    ['tenant_pin', { tenant_pin: [] }],
    ['anchor_claims', { anchor_claims: [] }],
    ['conditions', { conditions: [] }],
    ['rules', { rules: [] }],
  ])('refuses an empty %s list', (_name, patch) => {
    const { errors } = checkGlobal(patch);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/: the list is empty\. Leave the box unticked for no limit\.$/);
  });

  it.each<[string, Partial<GlobalAccessRuleInput>]>([
    ['name', { name: '' }],
    ['description', { description: 'x'.repeat(2001) }],
    ['issuer', { issuer: 'http://token.actions.githubusercontent.com' }],
    ['issuer form', { issuer: 'https://token.actions.githubusercontent.com:443' }],
    ['issuer host profile', { issuer: 'https://gitlab.com' }],
    ['jwks_uri', { jwks_uri: 'http://example.com/jwks' }],
    ['audience', { audience: 'sts.amazonaws.com' }],
    ['allowed_algs not allowed', { allowed_algs: ['HS256'] }],
    ['allowed_algs twice', { allowed_algs: ['RS256', 'RS256'] }],
    ['allowed_algs not a list', { allowed_algs: 'RS256' as unknown as string[] }],
    ['max_token_age_seconds low', { max_token_age_seconds: 59 }],
    ['max_token_age_seconds over the profile limit', { max_token_age_seconds: 901 }],
    ['max_token_age_seconds fractional', { max_token_age_seconds: 60.5 }],
    ['tenant_pin glob', { tenant_pin: [{ ...owner, match: 'glob' }] }],
    ['tenant_pin negated', { tenant_pin: [{ ...owner, negate: true }] }],
    ['tenant_pin claim', { tenant_pin: [{ ...owner, claim: 'repository_owner' }] }],
    ['anchor_claims too many', { anchor_claims: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }],
    ['anchor_claims twice', { anchor_claims: ['a', 'a'] }],
    ['anchor_claims empty name', { anchor_claims: [''] }],
    ['conditions shape', { conditions: [{ claim: 'ref', match: 'exact', values: [] }] }],
    ['conditions too many', { conditions: Array.from({ length: 33 }, () => owner) }],
    ['rules shape', { rules: [{ methods: ['TRACE' as 'GET'], path: '/x' }] }],
    ['rules too many', { rules: Array.from({ length: 51 }, () => rules[0] as Rule) }],
  ])('refuses a malformed %s', (_name, patch) => {
    expect(checkGlobal(patch).errors).toHaveLength(1);
  });

  it('AR-5: keeps the issuer and the profile of a global access rule', () => {
    const message =
      'The issuer and the issuer type of a global access rule cannot change. Add a new global access rule and delete this one.';
    const existing = { profile: allLimits.profile, issuer: allLimits.issuer };
    expect(validateGlobalAccessRule(allLimits, githubProfile, existing).errors).toEqual([]);
    const enterprise = { ...allLimits, issuer: 'https://token.actions.githubusercontent.com/acme' };
    expect(validateGlobalAccessRule(enterprise, githubProfile, existing).errors).toEqual([message]);
    const asGeneric = {
      ...noLimits,
      profile: 'generic' as const,
      issuer: 'https://agent.buildkite.com',
    };
    const genericExisting = {
      profile: 'gitlab-ci' as const,
      issuer: 'https://agent.buildkite.com',
    };
    expect(validateGlobalAccessRule(asGeneric, genericProfile, genericExisting).errors).toEqual([
      message,
    ]);
  });

  it('allows anchor claims and any tenant claim on a generic issuer', () => {
    const result = validateGlobalAccessRule(
      {
        ...noLimits,
        profile: 'generic',
        issuer: 'https://agent.buildkite.com',
        anchor_claims: ['pipeline_id'],
        tenant_pin: [{ claim: 'organization_slug', match: 'exact', values: ['acme'] }],
      },
      genericProfile,
      null,
    );
    expect(result).toEqual({ errors: [], warnings: [], warningDetails: [] });
  });
});
