import { describe, expect, it } from 'vitest';
import type { CredentialAccessRule } from '../../../src/db/types';
import type { IssuerProfile } from '../../../src/identity/types';
import {
  GITHUB_CONTEXTS,
  type GithubPresetInput,
  GITLAB_CONTEXTS,
  type GitlabPresetInput,
  githubAccessRulePreset,
  gitlabAccessRulePreset,
  PROTECTABLE_CONTEXTS,
  type VercelPresetInput,
  vercelAccessRulePreset,
  vercelPresetFromConditions,
} from '../../../src/policy/presets';
import type { Condition, Rule } from '../../../src/policy/types';
import { validateCredentialAccessRule } from '../../../src/policy/validate-rules';
import { githubProfile, gitlabProfile, provider, vercelProfile } from './fixtures';

/** The merged validator on `rule` with these jobs and operations (ADR 0026). */
function validateJobs(
  input: { conditions: Condition[]; rules: Rule[] },
  profile: IssuerProfile,
  rule: CredentialAccessRule,
) {
  return validateCredentialAccessRule({ ...rule, ...input }, profile, null, {
    injection: { kind: 'bearer' },
    rules: [],
  });
}

const base: GithubPresetInput = {
  ownerId: '1000',
  repositoryId: '2000',
  context: 'branch',
  pattern: 'main',
  requireProtectedRef: true,
  requireGithubHosted: false,
  workflowRef: null,
};
const gitlabBase: GitlabPresetInput = {
  namespaceId: '3000',
  projectId: '4000',
  context: 'branch',
  pattern: 'main',
  requireProtectedRef: true,
  configRef: null,
};
const rules: Rule[] = [{ methods: ['POST'], path: '/api/chat.postMessage' }];

const PATTERNS: Record<string, string> = {
  environment: 'production',
  branch: 'main',
  tag: 'v*',
  release: 'v*',
  pull_request: 'main',
  protected: '',
  any: '',
};

describe('githubAccessRulePreset', () => {
  it('builds the branch preset', () => {
    expect(githubAccessRulePreset(base)).toEqual({
      conditions: [
        { claim: 'repository_owner_id', match: 'exact', values: ['1000'] },
        { claim: 'repository_id', match: 'exact', values: ['2000'] },
        { claim: 'ref_type', match: 'exact', values: ['branch'] },
        { claim: 'ref', match: 'glob', values: ['refs/heads/main'] },
        { claim: 'event_name', match: 'exact', values: ['push', 'workflow_dispatch', 'schedule'] },
        { claim: 'ref_protected', match: 'exact', values: ['true'] },
      ],
      warnings: [],
      risks: [],
      errors: [],
    });
  });

  it.each([
    ['tag', 'refs/tags/v*', ['push']],
    ['release', 'refs/tags/v*', ['release']],
  ] as const)('builds the %s preset', (context, ref, events) => {
    const { conditions, errors } = githubAccessRulePreset({
      ...base,
      context,
      pattern: 'v*',
    });
    expect(errors).toEqual([]);
    expect(conditions).toContainEqual({ claim: 'ref_type', match: 'exact', values: ['tag'] });
    expect(conditions).toContainEqual({ claim: 'ref', match: 'glob', values: [ref] });
    expect(conditions).toContainEqual({ claim: 'event_name', match: 'exact', values: events });
  });

  it('builds the pull request preset with its risk, and no protection choice', () => {
    const { conditions, risks } = githubAccessRulePreset({
      ...base,
      context: 'pull_request',
      requireProtectedRef: false,
    });
    expect(conditions).toContainEqual({
      claim: 'event_name',
      match: 'exact',
      values: ['pull_request'],
    });
    expect(conditions).toContainEqual({ claim: 'base_ref', match: 'glob', values: ['main'] });
    expect(conditions.some((c) => c.claim === 'ref_protected')).toBe(false);
    expect(risks).toEqual(['pull_request']);
  });

  it('builds the protected and any contexts', () => {
    const protectedRefs = githubAccessRulePreset({
      ...base,
      context: 'protected',
      pattern: '',
    });
    expect(protectedRefs.conditions).toEqual([
      { claim: 'repository_owner_id', match: 'exact', values: ['1000'] },
      { claim: 'repository_id', match: 'exact', values: ['2000'] },
      { claim: 'ref_protected', match: 'exact', values: ['true'] },
    ]);
    expect(protectedRefs.risks).toEqual([]);
    const any = githubAccessRulePreset({ ...base, context: 'any', pattern: '' });
    expect(any.conditions).toHaveLength(2);
    expect(any.risks).toEqual(['any_ref']);
    expect(any.warnings).toHaveLength(1);
  });

  it('uses exact environments and refuses a wildcard in them', () => {
    const exact = githubAccessRulePreset({
      ...base,
      context: 'environment',
      pattern: 'prod',
    });
    expect(exact.conditions).toContainEqual({
      claim: 'environment',
      match: 'exact',
      values: ['prod'],
    });
    expect(exact.risks).toEqual([]);
    const glob = githubAccessRulePreset({
      ...base,
      context: 'environment',
      pattern: 'prod-*',
    });
    expect(glob.errors).toEqual([
      {
        field: 'pattern',
        message: 'Environment names cannot contain *; use Write conditions by hand for patterns.',
      },
    ]);
  });

  it('marks unprotected refs as a risk', () => {
    const result = githubAccessRulePreset({ ...base, requireProtectedRef: false });
    expect(result.risks).toEqual(['unprotected_ref']);
    expect(result.warnings).toHaveLength(1);
  });

  it('adds the runner and workflow toggles', () => {
    const workflowRef = 'acme/infra/.github/workflows/deploy.yml@refs/heads/main';
    const { conditions, errors } = githubAccessRulePreset({
      ...base,
      repositoryId: null,
      requireGithubHosted: true,
      workflowRef,
    });
    expect(errors).toEqual([]);
    expect(conditions).toContainEqual({
      claim: 'runner_environment',
      match: 'exact',
      values: ['github-hosted'],
    });
    expect(conditions).toContainEqual({
      claim: 'job_workflow_ref',
      match: 'exact',
      values: [workflowRef],
    });
  });

  it.each<[string, Partial<GithubPresetInput>, string]>([
    ['owner name instead of ID', { ownerId: 'acme' }, 'owner'],
    ['repository name instead of ID', { repositoryId: 'acme/app' }, 'repository'],
    ['neither a repository nor a workflow pin', { repositoryId: ' ' }, 'repository'],
    [
      'wildcard workflow pin',
      { workflowRef: 'acme/infra/.github/workflows/deploy.yml@**' },
      'workflow_ref',
    ],
    [
      'workflow pin without ref',
      { workflowRef: 'acme/infra/.github/workflows/deploy.yml' },
      'workflow_ref',
    ],
    ['empty pattern', { pattern: '  ' }, 'pattern'],
    ['leading wildcard', { pattern: '*' }, 'pattern'],
    ['double wildcard', { pattern: 'release/**' }, 'pattern'],
    ['whitespace', { pattern: 'my branch' }, 'pattern'],
  ])('reports %s on its field', (_name, patch, field) => {
    const { errors } = githubAccessRulePreset({ ...base, ...patch });
    expect(errors.map((error) => error.field)).toContain(field);
  });

  it.each(GITHUB_CONTEXTS)('produces an access that passes validation (%s)', (context) => {
    const { conditions, risks } = githubAccessRulePreset({
      ...base,
      context,
      pattern: PATTERNS[context] ?? '',
    });
    const result = validateJobs({ conditions, rules }, githubProfile, provider());
    expect(result.errors).toEqual([]);
    // Every warning the validator finds is one of the risks the selection names.
    expect(result.warningDetails.map((detail) => detail.code)).toEqual(
      context === 'pull_request' ? ['pull_request'] : [],
    );
    expect(risks).toEqual(
      context === 'pull_request' ? ['pull_request'] : context === 'any' ? ['any_ref'] : [],
    );
  });

  it.each(PROTECTABLE_CONTEXTS)(
    'unprotected %s carries exactly the unprotected_ref code in the validator too',
    (context) => {
      const { conditions, risks } = githubAccessRulePreset({
        ...base,
        context: context as GithubPresetInput['context'],
        pattern: PATTERNS[context] ?? '',
        requireProtectedRef: false,
      });
      const codes = validateJobs(
        { conditions, rules },
        githubProfile,
        provider(),
      ).warningDetails.map((detail) => detail.code);
      expect(codes).toEqual(['unprotected_ref']);
      expect(risks).toEqual(['unprotected_ref']);
    },
  );
});

describe('githubAccessRulePreset ref patterns', () => {
  it.each(['branch', 'tag', 'release', 'pull_request'] as const)(
    'refuses a %s pattern that already has the refs/ prefix',
    (context) => {
      const result = githubAccessRulePreset({ ...base, context, pattern: 'refs/heads/main' });
      expect(result.errors[0]?.field).toBe('pattern');
      expect(result.errors[0]?.message).toMatch(/without the refs\//);
    },
  );

  it('never produces a glob event condition', () => {
    for (const context of GITHUB_CONTEXTS) {
      const { conditions } = githubAccessRulePreset({
        ...base,
        context,
        pattern: PATTERNS[context] ?? '',
      });
      const events = conditions.filter((c) => c.claim === 'event_name');
      expect(events.every((c) => c.match === 'exact' && c.negate !== true)).toBe(true);
    }
  });
});

describe('gitlabAccessRulePreset', () => {
  const gitlab = () =>
    provider({
      profile: 'gitlab-ci',
      issuer: 'https://gitlab.com',
      tenant_pin: [{ claim: 'namespace_id', match: 'exact', values: ['3000'] }],
    });

  it('builds bare GitLab refs with ref_type and leaves the pipeline source implicit', () => {
    expect(gitlabAccessRulePreset(gitlabBase).conditions).toEqual([
      { claim: 'namespace_id', match: 'exact', values: ['3000'] },
      { claim: 'project_id', match: 'exact', values: ['4000'] },
      { claim: 'ref_type', match: 'exact', values: ['branch'] },
      { claim: 'ref', match: 'glob', values: ['main'] },
      { claim: 'ref_protected', match: 'exact', values: ['true'] },
    ]);
  });

  it('pins a pipeline configuration and refuses a wildcard in it', () => {
    const configRef = 'gitlab.com/acme-group/app//.gitlab-ci.yml@refs/heads/main';
    const pinned = gitlabAccessRulePreset({ ...gitlabBase, projectId: null, configRef });
    expect(pinned.errors).toEqual([]);
    expect(pinned.conditions).toContainEqual({
      claim: 'ci_config_ref_uri',
      match: 'exact',
      values: [configRef],
    });
    expect(
      gitlabAccessRulePreset({
        ...gitlabBase,
        configRef: 'gitlab.com/acme/*//x.yml@refs/heads/main',
      }).errors[0]?.field,
    ).toBe('workflow_ref');
  });

  it.each(GITLAB_CONTEXTS)('produces an access that passes validation (%s)', (context) => {
    const { conditions } = gitlabAccessRulePreset({
      ...gitlabBase,
      context,
      pattern: PATTERNS[context] ?? '',
    });
    const result = validateJobs({ conditions, rules }, gitlabProfile, gitlab());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('vercelAccessRulePreset', () => {
  const TEAM = 'team_7Gw5ZMzpQA8h90F832KGp7nwbuh3';
  const PROJECT = 'prj_7Gw5ZMBpQA8h9GF832KGp7nwbuh3';
  const vercelBase: VercelPresetInput = {
    ownerId: TEAM,
    projectId: PROJECT,
    context: 'environment',
    pattern: 'production',
  };
  const vercelRule = (overrides: Partial<CredentialAccessRule> = {}) =>
    provider({
      profile: 'vercel',
      issuer: 'https://oidc.vercel.com/acme',
      issuer_key: 'https://oidc.vercel.com/acme',
      jwks_uri: 'https://oidc.vercel.com/acme/.well-known/jwks',
      tenant_pin: [{ claim: 'owner_id', match: 'exact', values: [TEAM] }],
      ...overrides,
    });

  it('pins the team, the project and one environment', () => {
    const built = vercelAccessRulePreset(vercelBase);
    expect(built.errors).toEqual([]);
    expect(built.risks).toEqual([]);
    expect(built.conditions).toEqual([
      { claim: 'owner_id', match: 'exact', values: [TEAM] },
      { claim: 'project_id', match: 'exact', values: [PROJECT] },
      { claim: 'environment', match: 'exact', values: ['production'] },
    ]);
    const validation = validateJobs(
      { conditions: built.conditions, rules },
      vercelProfile,
      vercelRule(),
    );
    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual([]);
  });

  it('without an environment admits the trusted ones only, as the any_ref risk', () => {
    const built = vercelAccessRulePreset({ ...vercelBase, context: 'any', pattern: '' });
    expect(built.errors).toEqual([]);
    expect(built.risks).toEqual(['any_ref']);
    expect(built.conditions.map((c) => c.claim)).toEqual(['owner_id', 'project_id']);
  });

  it('makes development an opt-in the validator warns about (I-AUTHZ-3)', () => {
    const built = vercelAccessRulePreset({ ...vercelBase, pattern: 'development' });
    expect(built.errors).toEqual([]);
    const validation = validateJobs(
      { conditions: built.conditions, rules },
      vercelProfile,
      vercelRule(),
    );
    expect(validation.errors).toEqual([]);
    expect(validation.warnings.join('\n')).toContain(
      'environment "development" is not a trusted event',
    );
  });

  it.each([
    ['a numeric team', { ownerId: '1234' }, 'owner'],
    ['a project name', { projectId: 'acme-web' }, 'repository'],
    ['no project', { projectId: '' }, 'repository'],
    ['a glob environment', { pattern: 'prod*' }, 'pattern'],
    ['no environment', { pattern: '' }, 'pattern'],
  ])('refuses %s', (_name, overrides, field) => {
    const built = vercelAccessRulePreset({ ...vercelBase, ...overrides });
    expect(built.errors.map((error) => error.field)).toContain(field);
  });

  it('round-trips through vercelPresetFromConditions', () => {
    for (const input of [vercelBase, { ...vercelBase, context: 'any' as const, pattern: '' }]) {
      const built = vercelAccessRulePreset(input);
      expect(vercelPresetFromConditions(built.conditions)).toEqual(input);
    }
    expect(
      vercelPresetFromConditions([
        ...vercelAccessRulePreset(vercelBase).conditions,
        { claim: 'user_id', match: 'exact', values: ['u1'] },
      ]),
    ).toBeNull();
  });

  it('the global issuer is shared: a rule on it needs the team pin (I-TEN-1)', () => {
    const global = {
      issuer: 'https://oidc.vercel.com',
      issuer_key: 'https://oidc.vercel.com',
      jwks_uri: 'https://oidc.vercel.com/.well-known/jwks',
    };
    const conditions = vercelAccessRulePreset(vercelBase).conditions;
    expect(
      validateJobs({ conditions, rules }, vercelProfile, vercelRule({ ...global, tenant_pin: [] }))
        .errors,
    ).toContain('a tenant pin is required: this issuer signs tokens for every tenant (I-TEN-1)');
    expect(validateJobs({ conditions, rules }, vercelProfile, vercelRule(global)).errors).toEqual(
      [],
    );
  });
});
