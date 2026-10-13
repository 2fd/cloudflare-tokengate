import { describe, expect, it } from 'vitest';
import { type GithubPresetInput, githubGrantPreset } from '../../../src/policy/presets';
import type { Rule } from '../../../src/policy/types';
import { validateGrant } from '../../../src/policy/validate';
import { githubProfile, provider } from './fixtures';

const base: GithubPresetInput = {
  ownerId: '1000',
  repositoryIds: ['2000'],
  context: 'branch',
  pattern: 'main',
  requireProtectedRef: true,
  requireGithubHosted: false,
  workflowRef: null,
};
const rules: Rule[] = [{ methods: ['POST'], path: '/api/chat.postMessage' }];

describe('githubGrantPreset', () => {
  it('builds the branch preset', () => {
    expect(githubGrantPreset(base)).toEqual({
      conditions: [
        { claim: 'repository_owner_id', match: 'exact', values: ['1000'] },
        { claim: 'repository_id', match: 'exact', values: ['2000'] },
        { claim: 'ref_type', match: 'exact', values: ['branch'] },
        { claim: 'ref', match: 'glob', values: ['refs/heads/main'] },
        { claim: 'event_name', match: 'exact', values: ['push', 'workflow_dispatch', 'schedule'] },
        { claim: 'ref_protected', match: 'exact', values: ['true'] },
      ],
      warnings: [],
      errors: [],
    });
  });

  it.each([
    ['tag', 'refs/tags/v*', ['push']],
    ['release', 'refs/tags/v*', ['release']],
  ] as const)('builds the %s preset', (context, ref, events) => {
    const { conditions, errors } = githubGrantPreset({ ...base, context, pattern: 'v*' });
    expect(errors).toEqual([]);
    expect(conditions).toContainEqual({ claim: 'ref_type', match: 'exact', values: ['tag'] });
    expect(conditions).toContainEqual({ claim: 'ref', match: 'glob', values: [ref] });
    expect(conditions).toContainEqual({ claim: 'event_name', match: 'exact', values: events });
  });

  it('builds the pr preset', () => {
    const { conditions, warnings } = githubGrantPreset({
      ...base,
      context: 'pr',
      requireProtectedRef: false,
    });
    expect(conditions).toContainEqual({
      claim: 'event_name',
      match: 'exact',
      values: ['pull_request'],
    });
    expect(conditions).toContainEqual({ claim: 'base_ref', match: 'glob', values: ['main'] });
    expect(warnings).toHaveLength(1);
  });

  it('uses exact environments unless a glob is asked for, with a warning', () => {
    const exact = githubGrantPreset({ ...base, context: 'environment', pattern: 'prod' });
    expect(exact.conditions).toContainEqual({
      claim: 'environment',
      match: 'exact',
      values: ['prod'],
    });
    expect(exact.warnings).toEqual([]);
    const glob = githubGrantPreset({ ...base, context: 'environment', pattern: 'prod-*' });
    expect(glob.conditions).toContainEqual({
      claim: 'environment',
      match: 'glob',
      values: ['prod-*'],
    });
    expect(glob.warnings).toHaveLength(1);
  });

  it('warns when protected refs are turned off', () => {
    expect(githubGrantPreset({ ...base, requireProtectedRef: false }).warnings).toHaveLength(1);
  });

  it('adds the runner and workflow toggles', () => {
    const workflowRef = 'acme/infra/.github/workflows/deploy.yml@refs/heads/main';
    const { conditions, errors } = githubGrantPreset({
      ...base,
      repositoryIds: [],
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

  it.each<[string, Partial<GithubPresetInput>]>([
    ['owner name instead of ID', { ownerId: 'acme' }],
    ['repository name instead of ID', { repositoryIds: ['acme/app'] }],
    ['neither repositories nor workflow pin', { repositoryIds: [' '] }],
    ['wildcard workflow pin', { workflowRef: 'acme/infra/.github/workflows/deploy.yml@**' }],
    ['workflow pin without ref', { workflowRef: 'acme/infra/.github/workflows/deploy.yml' }],
    ['empty pattern', { pattern: '  ' }],
  ])('reports %s', (_name, patch) => {
    expect(githubGrantPreset({ ...base, ...patch }).errors.length).toBeGreaterThan(0);
  });

  it.each(['branch', 'tag', 'release', 'pr', 'environment'] as const)(
    'produces a grant that passes validation (%s)',
    (context) => {
      const { conditions } = githubGrantPreset({
        ...base,
        context,
        requireProtectedRef: context !== 'pr',
      });
      const result = validateGrant({ conditions, rules }, githubProfile, provider());
      expect(result.errors).toEqual([]);
      // pull_request is not a trusted event, so opting in to it is always flagged.
      expect(result.warnings).toHaveLength(context === 'pr' ? 1 : 0);
    },
  );
});

describe('githubGrantPreset ref patterns', () => {
  it.each(['branch', 'tag', 'release', 'pr'] as const)(
    'refuses a %s pattern that already has the refs/ prefix',
    (context) => {
      const result = githubGrantPreset({ ...base, context, pattern: 'refs/heads/main' });
      expect(result.errors).toContain(
        'enter the branch or tag name without the refs/heads/ or refs/tags/ prefix',
      );
    },
  );

  it('never produces a glob event condition', () => {
    for (const context of ['branch', 'tag', 'release', 'pr', 'environment'] as const) {
      const { conditions } = githubGrantPreset({ ...base, context });
      const events = conditions.filter((c) => c.claim === 'event_name');
      expect(events.every((c) => c.match === 'exact' && c.negate !== true)).toBe(true);
    }
  });
});
