import { describe, expect, it } from 'vitest';
import {
  jobsFormFromRule,
  accessWarningDetails,
  blankJobsForm,
  coveredRiskCodes,
  defaultOpsForm,
  deriveAccessName,
  deriveOwner,
  type JobsContext,
  type JobsForm,
  isAnyRef,
  jobsToRows,
  mostUsedContext,
  opsFormFromRules,
  ownerPrefix,
  parseExpiry,
  parseJobs,
  parseOps,
  parseRepositoryInput,
  readJobsForm,
  readOpsForm,
} from '../../../src/admin/rule-access';
import { getServiceTemplate } from '../../../src/admin/service-templates';
import { ruleSets } from '../../../src/db/suggestions';
import type { CredentialAccessRule, ClaimLabel } from '../../../src/db/types';
import { PROFILES } from '../../../src/identity/profiles';
import type { Condition } from '../../../src/policy/types';
import { provider as policyProvider } from '../policy/fixtures';

const github = PROFILES['github-actions'];
const gitlab = PROFILES['gitlab-ci'];
const DAY = 86_400_000;

function label(claim: ClaimLabel['claim'], value: string, text: string): ClaimLabel {
  return {
    access_rule_id: 'acr_a',
    claim,
    value,
    label: text,
    updated_at: 1,
    updated_by: null,
  };
}

const LABELS = [
  label('repository_owner_id', '1000', 'Acme'),
  label('repository_owner_id', '1001', 'acme-labs'),
  label('repository_id', '2000', 'acme/api'),
];

function githubProvider(values = ['1000', '1001']): CredentialAccessRule {
  return policyProvider({
    id: 'acr_a',
    tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values }],
  });
}

function ctx(overrides: Partial<JobsContext> = {}): JobsContext {
  return {
    profile: github,
    provider: githubProvider(),
    labels: LABELS,
    prefix: '',
    ...overrides,
  };
}

function jobs(overrides: Partial<JobsForm> = {}): JobsForm {
  return {
    ...blankJobsForm(github),
    repository: 'acme/api (2000)',
    context: 'branch',
    branch: 'main',
    ...overrides,
  };
}

describe('parseRepositoryInput (A7.8)', () => {
  it('accepts name (ID), name #ID, and a bare ID that already has a label', () => {
    expect(parseRepositoryInput('acme/web (2001)', github, LABELS)).toEqual({
      ok: true,
      value: { id: '2001', label: 'acme/web' },
    });
    expect(parseRepositoryInput('acme/web #2001', github, LABELS)).toEqual({
      ok: true,
      value: { id: '2001', label: 'acme/web' },
    });
    expect(parseRepositoryInput('2000', github, LABELS)).toEqual({
      ok: true,
      value: { id: '2000', label: 'acme/api' },
    });
    expect(parseRepositoryInput('  ', github, LABELS)).toEqual({ ok: true, value: null });
  });

  it('refuses a bare ID without a label and builds the fix from the typed name', () => {
    expect(parseRepositoryInput('2001', github, LABELS)).toMatchObject({ ok: false });
    const missing = parseRepositoryInput('acme/web', github, LABELS);
    expect(missing).toMatchObject({ ok: false });
    if (!missing.ok) {
      expect(missing.message).toContain('like acme/web (987654321)');
      expect(missing.message).toContain(`gh api repos/acme/web --jq '"\\(.full_name) (\\(.id))"'`);
    }
    expect(parseRepositoryInput('not a repo (1)', github, LABELS)).toMatchObject({ ok: false });
  });

  it('keeps IDs above 2^53 as strings', () => {
    expect(parseRepositoryInput('acme/big (18446744073709551615)', github, [])).toEqual({
      ok: true,
      value: { id: '18446744073709551615', label: 'acme/big' },
    });
  });

  it('reads GitLab projects with subgroups', () => {
    expect(parseRepositoryInput('acme-group/platform/app (7)', gitlab, [])).toEqual({
      ok: true,
      value: { id: '7', label: 'acme-group/platform/app' },
    });
    expect(ownerPrefix(gitlab, 'acme-group/platform/app')).toBe('acme-group/platform');
    expect(ownerPrefix(github, 'acme/api')).toBe('acme');
  });
});

describe('deriveOwner', () => {
  it('matches the organization label case-insensitively', () => {
    expect(deriveOwner('acme', githubProvider(), github, LABELS)).toEqual({
      id: '1000',
      label: 'Acme',
    });
    expect(deriveOwner('ACME-LABS', githubProvider(), github, LABELS)?.id).toBe('1001');
    expect(deriveOwner('acme-x', githubProvider(), github, LABELS)).toBeNull();
  });

  it('uses the one unlabelled organization of a credential access rule', () => {
    expect(deriveOwner('anything', githubProvider(['5']), github, [])).toEqual({
      id: '5',
      label: 'anything',
    });
  });
});

describe('parseJobs', () => {
  it('builds the branch conditions with the derived owner and the repository label', () => {
    const parsed = parseJobs(jobs(), ctx());
    expect(parsed.errors).toEqual([]);
    expect(parsed.conditions?.slice(0, 2)).toEqual([
      { claim: 'repository_owner_id', match: 'exact', values: ['1000'] },
      { claim: 'repository_id', match: 'exact', values: ['2000'] },
    ]);
    expect(parsed.labels).toEqual([{ claim: 'repository_id', value: '2000', label: 'acme/api' }]);
  });

  it('asks for new_owner when the repository is of an unknown organization', () => {
    const parsed = parseJobs(jobs({ repository: 'acme-x/api (3)' }), ctx({ prefix: 'acr_a.' }));
    expect(parsed.unknownOwner).toBe('acme-x');
    expect(parsed.errors[0]?.field).toBe('acr_a.repository');
    expect(parsed.errors[0]?.message).toContain(
      'acme-x is not an organization of this rule. Add it under Issuer and tenant.',
    );
    const wrong = parseJobs(
      jobs({ repository: 'acme-x/api (3)', new_owner: 'other (9)' }),
      ctx({ prefix: 'acr_a.' }),
    );
    expect(wrong.errors[0]?.message).toContain('Enter the ID of acme-x');
    const added = parseJobs(jobs({ repository: 'acme-x/api (3)', new_owner: 'acme-x (9)' }), ctx());
    expect(added.errors).toEqual([]);
    expect(added.newOwner).toEqual({ id: '9', label: 'acme-x' });
    expect(added.conditions?.[0]).toEqual({
      claim: 'repository_owner_id',
      match: 'exact',
      values: ['9'],
    });
  });

  it('reads only the chosen context input: a decoy in a hidden card is ignored', () => {
    const parsed = parseJobs(
      jobs({ context: 'tag', tag: 'v*', release_tag: 'decoy-*', branch: 'evil' }),
      ctx(),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.conditions).toContainEqual({
      claim: 'ref',
      match: 'glob',
      values: ['refs/tags/v*'],
    });
    expect(JSON.stringify(parsed.conditions)).not.toContain('decoy');
    expect(JSON.stringify(parsed.conditions)).not.toContain('evil');
  });

  it('reads only the release tag for a release: a decoy tag in the hidden Tag card is ignored', () => {
    const parsed = parseJobs(
      jobs({ context: 'release', release_tag: 'v*', tag: 'decoy-*' }),
      ctx(),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.conditions).toContainEqual({
      claim: 'event_name',
      match: 'exact',
      values: ['release'],
    });
    expect(JSON.stringify(parsed.conditions)).not.toContain('decoy');
  });

  it('maps pattern errors to the input of the chosen context', () => {
    const parsed = parseJobs(
      jobs({ context: 'environment', environment: 'prod-*' }),
      ctx({ prefix: 'p.' }),
    );
    expect(parsed.errors).toEqual([
      {
        field: 'p.environment',
        message: 'Environment names cannot contain *; use Write conditions by hand for patterns.',
      },
    ]);
  });

  it('parses the rows editor with quoted values and negation', () => {
    const parsed = parseJobs(
      {
        ...blankJobsForm(github),
        editor: 'rows',
        cond: [
          { claim: 'repository_owner_id', match: 'exact', not: false, values: '1000' },
          { claim: 'repository_id', match: 'exact', not: false, values: '2000, 2001' },
          { claim: 'actor', match: 'glob', not: true, values: '"bot,x"' },
        ],
      },
      ctx(),
    );
    expect(parsed.conditions).toEqual([
      { claim: 'repository_owner_id', match: 'exact', values: ['1000'] },
      { claim: 'repository_id', match: 'exact', values: ['2000', '2001'] },
      { claim: 'actor', match: 'glob', values: ['bot,x'], negate: true },
    ]);
  });

  it('converts the structured input to rows losing nothing', () => {
    const rows = jobsToRows(jobs({ context: 'environment', environment: 'production' }), ctx());
    expect(rows.editor).toBe('rows');
    expect(rows.cond).toContainEqual({
      claim: 'environment',
      match: 'exact',
      not: false,
      values: 'production',
    });
    expect(parseJobs(rows, ctx()).conditions).toEqual(
      parseJobs(jobs({ context: 'environment', environment: 'production' }), ctx()).conditions,
    );
  });

  it('turns an access back into the form it was built with, or the rows editor', () => {
    const built = parseJobs(jobs({ ref_protection: 'unprotected' }), ctx()).conditions ?? [];
    const back = jobsFormFromRule({ conditions: built }, github, LABELS);
    expect(back).toMatchObject({
      editor: 'structured',
      repository: 'acme/api (2000)',
      context: 'branch',
      branch: 'main',
      ref_protection: 'unprotected',
    });
    const odd = jobsFormFromRule(
      { conditions: [...built, { claim: 'actor', match: 'exact', values: ['x'] }] },
      github,
      LABELS,
    );
    expect(odd.editor).toBe('rows');
    expect(odd.cond).toHaveLength(built.length + 1);
  });

  it('reads prefixed fields of one branch only', () => {
    const form = readJobsForm(
      {
        'acr_a.repository': 'acme/api (2000)',
        'acr_b.repository': 'decoy (1)',
        'acr_a.context': 'any',
      },
      'acr_a.',
      github,
    );
    expect(form.repository).toBe('acme/api (2000)');
    expect(form.context).toBe('any');
  });

  it('reads the typed "Another…" value only when no known one is picked', () => {
    // A picked repository wins over a stale typed one.
    const picked = readJobsForm(
      { repository: 'acme/api (2000)', repository_other: 'acme/old (9)' },
      '',
      github,
    );
    expect(picked.repository).toBe('acme/api (2000)');
    // "Another…" posts '' and the typed value.
    const typed = readJobsForm(
      {
        repository: '',
        repository_other: 'acme/web (3000)',
        environment: '',
        environment_other: 'staging',
      },
      '',
      github,
    );
    expect(typed.repository).toBe('acme/web (3000)');
    expect(typed.environment).toBe('staging');
    // A direct POST of the plain names keeps working.
    const plain = readJobsForm(
      { 'p.repository': 'acme/api (2000)', 'p.environment': 'production' },
      'p.',
      github,
    );
    expect(plain.repository).toBe('acme/api (2000)');
    expect(plain.environment).toBe('production');
  });
});

describe('coveredRiskCodes (A7.7)', () => {
  it.each<[string, string, string[]]>([
    ['environment', 'protected', []],
    ['environment', 'unprotected', ['unprotected_ref']],
    ['branch', 'unprotected', ['unprotected_ref']],
    ['tag', 'unprotected', ['unprotected_ref']],
    ['release', 'unprotected', ['unprotected_ref']],
    ['protected', 'unprotected', []],
    ['pull_request', 'protected', ['pull_request']],
    ['pull_request', 'unprotected', ['pull_request']],
    ['any', 'protected', ['any_ref']],
    ['any', 'unprotected', ['any_ref']],
  ])('%s with %s refs covers %j', (context, protection, codes) => {
    expect([
      ...coveredRiskCodes({ editor: 'structured', context, ref_protection: protection }),
    ]).toEqual(codes);
  });

  it('the rows editor covers nothing (the digest decides)', () => {
    expect(
      coveredRiskCodes({ editor: 'rows', context: 'any', ref_protection: 'unprotected' }).size,
    ).toBe(0);
  });

  it('a choice for one risk does not cover another', () => {
    const covered = coveredRiskCodes({
      editor: 'structured',
      context: 'branch',
      ref_protection: 'unprotected',
    });
    expect(covered.has('pull_request')).toBe(false);
    expect(covered.has('any_ref')).toBe(false);
  });
});

describe('parseOps', () => {
  const template = getServiceTemplate('github');
  const token = { injection: { kind: 'bearer' as const }, base_url: 'https://api.github.com' };

  it('substitutes {repo} with the repository label', () => {
    expect(
      parseOps(
        { op: ['read-repo'], rule: [] },
        { token, template, ruleSets: [], repositoryLabel: 'acme/api', prefix: '' },
      ),
    ).toEqual({ rules: [{ methods: ['GET'], path: '/repos/acme/api/**' }], errors: [] });
  });

  it('refuses a {repo} preset without a repository', () => {
    const result = parseOps(
      { op: ['read-repo'], rule: [] },
      { token, template, ruleSets: [], repositoryLabel: null, prefix: 'svc.' },
    );
    expect(result.errors[0]).toMatchObject({ field: 'svc.op' });
    expect(result.errors[0]?.message).toContain('needs a repository');
  });

  it('adds used rule sets and custom rows, deduplicated, with field errors per row', () => {
    const sets = ruleSets([{ conditions: [], rules: [{ methods: ['POST'], path: '/v1/items' }] }]);
    const result = parseOps(
      {
        op: [sets[0]?.id ?? '', 'unknown'],
        rule: [
          { m: ['POST'], path: '/v1/items' },
          { m: ['GET', 'HEAD'], path: '/v1/items/*' },
        ],
      },
      { token, template: null, ruleSets: sets, repositoryLabel: null, prefix: '' },
    );
    expect(result.rules).toEqual([
      { methods: ['POST'], path: '/v1/items' },
      { methods: ['GET', 'HEAD'], path: '/v1/items/*' },
    ]);
    const bad = parseOps(
      {
        op: [],
        rule: [
          { m: [], path: '/x' },
          { m: ['GET'], path: 'x' },
        ],
      },
      { token, template: null, ruleSets: [], repositoryLabel: null, prefix: '' },
    );
    expect(bad.errors.map((error) => error.field)).toEqual(['rule.0.m', 'rule.1.path']);
  });

  it('allows only POST / on a path-injected token, whatever is submitted', () => {
    const result = parseOps(
      { op: [], rule: [{ m: ['GET'], path: '/anything' }] },
      {
        token: { injection: { kind: 'path' }, base_url: 'https://hooks.slack.com/services' },
        template: null,
        ruleSets: [],
        repositoryLabel: null,
        prefix: '',
      },
    );
    expect(result).toEqual({ rules: [{ methods: ['POST'], path: '/' }], errors: [] });
  });

  it('reverse-matches stored rules into presets, sets and custom rows', () => {
    const form = opsFormFromRules(
      [
        { methods: ['GET'], path: '/repos/acme/api/**' },
        { methods: ['DELETE'], path: '/x' },
      ],
      template,
      [],
      'acme/api',
    );
    expect(form).toEqual({ op: ['read-repo'], rule: [{ m: ['DELETE'], path: '/x' }] });
    expect(defaultOpsForm(template, [])).toEqual({ op: ['read-repo'], rule: [] });
    const only = ruleSets([{ conditions: [], rules: [{ methods: ['GET'], path: '/a' }] }]);
    expect(defaultOpsForm(null, only)).toEqual({ op: [only[0]?.id], rule: [] });
  });

  it('reads method checkboxes of a row as a list', () => {
    expect(readOpsForm({ 'rule.0.m': ['GET', 'POST'], 'rule.0.path': '/a', op: 'x' }, '')).toEqual({
      op: ['x'],
      rule: [{ m: ['GET', 'POST'], path: '/a' }],
    });
  });
});

describe('parseExpiry', () => {
  const now = Date.UTC(2026, 9, 15, 13, 30);

  it.each([
    ['never', null],
    ['7d', now + 7 * DAY],
    ['30d', now + 30 * DAY],
    ['90d', now + 90 * DAY],
  ] as const)('%s', (expires, value) => {
    expect(parseExpiry({ expires, expires_on: '' }, now)).toEqual({ ok: true, value });
  });

  it('a date stops access at the end of that UTC day', () => {
    expect(parseExpiry({ expires: 'date', expires_on: '2026-10-16' }, now)).toEqual({
      ok: true,
      value: Date.UTC(2026, 9, 17),
    });
  });

  it.each(['', '2026-10-15', '2026-02-30', '2031-12-31', '16/10/2026'])(
    'refuses the date %j',
    (expires_on) => {
      expect(parseExpiry({ expires: 'date', expires_on }, now)).toMatchObject({
        ok: false,
        error: { field: 'expires_on' },
      });
    },
  );

  it('keeps the stored value only on edit', () => {
    expect(parseExpiry({ expires: 'keep', expires_on: '' }, now, 123)).toEqual({
      ok: true,
      value: 123,
    });
    expect(parseExpiry({ expires: 'keep', expires_on: '' }, now)).toMatchObject({ ok: false });
  });
});

describe('deriveAccessName', () => {
  it('names the token, the subject and the context', () => {
    const conditions =
      parseJobs(jobs({ context: 'environment', environment: 'production' }), ctx()).conditions ??
      [];
    expect(deriveAccessName('Slack', conditions, LABELS)).toBe(
      'Slack for acme/api (environment production)',
    );
    expect(deriveAccessName('x'.repeat(120), conditions, LABELS)).toHaveLength(100);
  });
});

describe('any-ref risk of stored conditions (A7.7)', () => {
  const anchor = [
    { claim: 'repository_owner_id', match: 'exact' as const, values: ['1000'] },
    { claim: 'repository_id', match: 'exact' as const, values: ['2000'] },
  ];

  it('flags conditions that constrain no ref, environment, protection or event', () => {
    expect(isAnyRef(anchor, github)).toBe(true);
    expect(isAnyRef([...anchor, { claim: 'actor', match: 'exact', values: ['x'] }], github)).toBe(
      true,
    );
    expect(
      isAnyRef([...anchor, { claim: 'ref_protected', match: 'exact', values: ['true'] }], github),
    ).toBe(false);
    expect(
      isAnyRef([...anchor, { claim: 'event_name', match: 'exact', values: ['push'] }], github),
    ).toBe(false);
    expect(
      isAnyRef(
        [...anchor, { claim: 'environment', match: 'exact', values: ['prod'], negate: true }],
        github,
      ),
    ).toBe(true);
    expect(isAnyRef([{ claim: 'sub', match: 'exact', values: ['x'] }], PROFILES.generic)).toBe(
      false,
    );
  });

  it('an exact claim that names the job ref or commit constrains it; a reusable workflow pin does not', () => {
    const sub = (value: string, match: Condition['match'] = 'exact'): Condition[] => [
      ...anchor,
      { claim: 'sub', match, values: [value] },
    ];
    expect(isAnyRef(sub('repo:acme/api:environment:production'), github)).toBe(false);
    expect(isAnyRef(sub('repo:acme/api:ref:refs/heads/main'), github)).toBe(false);
    expect(isAnyRef(sub('repo:acme/api:pull_request'), github)).toBe(false);
    expect(
      isAnyRef(
        [
          ...anchor,
          { claim: 'sub', match: 'exact', values: ['project_path:g/app:ref_type:branch:ref:main'] },
        ],
        gitlab,
      ),
    ).toBe(false);
    // A customized GitHub sub without the ref, and a glob, leave the ref open.
    expect(isAnyRef(sub('repository_owner_id:4242:repository_id:987654321'), github)).toBe(true);
    expect(isAnyRef(sub('repo:acme/api:*', 'glob'), github)).toBe(true);
    for (const claim of ['workflow_ref', 'sha', 'head_ref']) {
      expect(isAnyRef([...anchor, { claim, match: 'exact', values: ['x'] }], github), claim).toBe(
        false,
      );
    }
    for (const claim of ['job_workflow_ref', 'ci_config_ref_uri']) {
      expect(isAnyRef([...anchor, { claim, match: 'exact', values: ['x'] }], github), claim).toBe(
        true,
      );
    }
  });

  it('adds any_ref once to the validator details', () => {
    expect(accessWarningDetails([], anchor, github).map((d) => d.code)).toEqual(['any_ref']);
    const once = accessWarningDetails([{ code: 'any_ref', message: 'm' }], anchor, github);
    expect(once).toHaveLength(1);
  });
});

describe('mostUsedContext', () => {
  const shape = (conditions: Condition[]) => ({ conditions, rules: [] });
  const anchor: Condition[] = [
    { claim: 'repository_owner_id', match: 'exact', values: ['1000'] },
    { claim: 'repository_id', match: 'exact', values: ['2000'] },
  ];

  it('never defaults to a risky context, however often it is used', () => {
    const any = shape(anchor);
    const branch = shape(
      parseJobs(jobs({ context: 'branch', branch: 'main' }), ctx()).conditions ?? [],
    );
    expect(mostUsedContext([any, any, any], github)).toBe('environment');
    expect(mostUsedContext([any, any, branch], github)).toBe('branch');
  });
});
