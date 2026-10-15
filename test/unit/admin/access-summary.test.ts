import { describe, expect, it } from 'vitest';
import { accessSummary } from '../../../src/admin/access-summary';
import type { ClaimLabel } from '../../../src/db/types';
import { githubGrantPreset } from '../../../src/policy/presets';
import type { Condition, Rule } from '../../../src/policy/types';

const exact = (claim: string, ...values: string[]): Condition => ({
  claim,
  match: 'exact',
  values,
});
const glob = (claim: string, ...values: string[]): Condition => ({ claim, match: 'glob', values });

const LABELS: ClaimLabel[] = [
  { caller_provider_id: 'cpr_a', claim: 'repository_owner_id', value: '4242', label: 'acme' },
  { caller_provider_id: 'cpr_a', claim: 'repository_id', value: '987654321', label: 'acme/api' },
  { caller_provider_id: 'cpr_a', claim: 'project_id', value: '77', label: 'group/project' },
].map((label) => ({ ...label, updated_at: 1, updated_by: null }) as ClaimLabel);

const RULES: Rule[] = [
  { methods: ['POST'], path: '/chat.postMessage' },
  { methods: ['GET', 'HEAD'], path: '/repos/acme/api/**' },
];

function summary(conditions: Condition[], rules: Rule[] = RULES) {
  return accessSummary({ conditions, rules }, LABELS);
}

function github(
  context: 'branch' | 'tag' | 'release' | 'pull_request' | 'environment',
  pattern: string,
  requireProtectedRef = true,
) {
  return githubGrantPreset({
    ownerId: '4242',
    repositoryId: '987654321',
    context,
    pattern,
    requireProtectedRef,
    requireGithubHosted: false,
    workflowRef: null,
  }).conditions;
}

describe('accessSummary', () => {
  it('names repositories by their label, else by ID, and lists every rule', () => {
    expect(summary(github('environment', 'production'))).toEqual({
      subject: 'acme/api',
      context: 'environment production',
      operations: ['POST /chat.postMessage', 'GET,HEAD /repos/acme/api/**'],
    });
    expect(
      summary([exact('repository_owner_id', '4242'), exact('repository_id', '987654321', '5')])
        .subject,
    ).toBe('acme/api, 5');
  });

  it('describes each GitHub preset context', () => {
    expect(summary(github('branch', 'main')).context).toBe('branch main');
    expect(summary(github('tag', 'v*')).context).toBe('tag v*');
    expect(summary(github('release', 'v*')).context).toBe('release v*');
    expect(summary(github('pull_request', 'main', false)).context).toBe('PR into main');
  });

  it('describes protected-only and unconstrained accesses', () => {
    const anchors = [exact('repository_owner_id', '4242'), exact('repository_id', '987654321')];
    expect(summary([...anchors, exact('ref_protected', 'true')]).context).toBe('protected refs');
    expect(summary(anchors).context).toBe('any ref');
    expect(summary([...anchors, glob('ref', 'refs/pull/*')]).context).toBe('ref refs/pull/*');
  });

  it('reads GitLab bare refs with their ref_type and labels projects', () => {
    const base = [exact('namespace_id', '9'), exact('project_id', '77')];
    expect(summary([...base, exact('ref_type', 'branch'), exact('ref', 'main')])).toMatchObject({
      subject: 'group/project',
      context: 'branch main',
    });
    expect(summary([...base, exact('ref_type', 'tag'), glob('ref', 'v*')]).context).toBe('tag v*');
  });

  it('falls back to workflow pins, the organization, the subject, then the first exact claim', () => {
    expect(
      summary([
        exact('repository_owner_id', '4242'),
        exact('job_workflow_ref', 'acme/infra/.github/workflows/deploy.yml@refs/heads/main'),
      ]).subject,
    ).toBe('workflow acme/infra/.github/workflows/deploy.yml@refs/heads/main');
    expect(summary([exact('repository_owner_id', '4242')]).subject).toBe('any repository of acme');
    expect(summary([exact('sub', 'system:serviceaccount:ci:deployer')]).subject).toBe(
      'system:serviceaccount:ci:deployer',
    );
    expect(summary([exact('pipeline_id', 'p-1')]).subject).toBe('pipeline_id p-1');
  });

  it('ignores negated conditions and labels of other claims', () => {
    const conditions: Condition[] = [
      { claim: 'repository_id', match: 'exact', values: ['1'], negate: true },
      exact('repository_owner_id', '987654321'),
      { claim: 'environment', match: 'exact', values: ['dev'], negate: true },
    ];
    expect(summary(conditions)).toMatchObject({
      subject: 'any repository of 987654321',
      context: 'any ref',
    });
  });
});
