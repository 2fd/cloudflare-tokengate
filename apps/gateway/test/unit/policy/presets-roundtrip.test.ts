// The structured access form edits an access with the form it was made with only when the stored
// conditions rebuild exactly; anything else opens the rows editor (consumer-access.ts).
import { describe, expect, it } from 'vitest';
import {
  conditionSetKey,
  GITHUB_CONTEXTS,
  type GithubPresetInput,
  GITLAB_CONTEXTS,
  type GitlabPresetInput,
  githubGrantPreset,
  githubPresetFromConditions,
  gitlabGrantPreset,
  gitlabPresetFromConditions,
  PROTECTABLE_CONTEXTS,
} from '../../../src/policy/presets';
import type { Condition } from '../../../src/policy/types';

const PATTERNS: Record<string, string> = {
  environment: 'production',
  branch: 'release/*',
  tag: 'v*',
  release: 'v1.2.3',
  pull_request: 'main',
  protected: '',
  any: '',
};

function githubInputs(): GithubPresetInput[] {
  const out: GithubPresetInput[] = [];
  for (const context of GITHUB_CONTEXTS) {
    for (const requireProtectedRef of PROTECTABLE_CONTEXTS.includes(context)
      ? [true, false]
      : [true]) {
      for (const pin of [null, 'acme/infra/.github/workflows/deploy.yml@refs/heads/main']) {
        for (const hosted of [false, true]) {
          for (const repositoryId of pin === null ? ['2000'] : ['2000', null]) {
            out.push({
              ownerId: '1000',
              repositoryId,
              context,
              pattern: PATTERNS[context] ?? '',
              requireProtectedRef,
              requireGithubHosted: hosted,
              workflowRef: pin,
            });
          }
        }
      }
    }
  }
  return out;
}

function gitlabInputs(): GitlabPresetInput[] {
  const out: GitlabPresetInput[] = [];
  for (const context of GITLAB_CONTEXTS) {
    for (const requireProtectedRef of PROTECTABLE_CONTEXTS.includes(context)
      ? [true, false]
      : [true]) {
      for (const pin of [null, 'gitlab.com/acme-group/app//.gitlab-ci.yml@refs/heads/main']) {
        out.push({
          namespaceId: '3000',
          projectId: '4000',
          context,
          pattern: PATTERNS[context] ?? '',
          requireProtectedRef,
          configRef: pin,
        });
      }
    }
  }
  return out;
}

describe('structured presets round-trip', () => {
  it.each(githubInputs().map((input) => [JSON.stringify(input), input] as const))(
    'GitHub %s',
    (_name, input) => {
      const built = githubGrantPreset(input);
      expect(built.errors).toEqual([]);
      const back = githubPresetFromConditions(built.conditions);
      expect(back).not.toBeNull();
      // Same conditions (a release and a tag context can share a pattern only in their events).
      expect(conditionSetKey(githubGrantPreset(back as GithubPresetInput).conditions)).toBe(
        conditionSetKey(built.conditions),
      );
      expect(back).toEqual(input);
    },
  );

  it.each(gitlabInputs().map((input) => [JSON.stringify(input), input] as const))(
    'GitLab %s',
    (_name, input) => {
      const built = gitlabGrantPreset(input);
      expect(built.errors).toEqual([]);
      expect(gitlabPresetFromConditions(built.conditions)).toEqual(input);
    },
  );

  it('ignores condition order', () => {
    const built = githubGrantPreset({
      ...githubInputs()[0],
      context: 'branch',
      pattern: 'main',
    } as GithubPresetInput);
    expect(githubPresetFromConditions([...built.conditions].reverse())).not.toBeNull();
  });
});

describe('conditions that only the rows editor can show', () => {
  const owner: Condition = { claim: 'repository_owner_id', match: 'exact', values: ['1000'] };
  const repo: Condition = { claim: 'repository_id', match: 'exact', values: ['2000'] };

  it.each<[string, Condition[]]>([
    ['several repositories', [owner, { ...repo, values: ['2000', '2001'] }]],
    ['an extra condition', [owner, repo, { claim: 'actor', match: 'exact', values: ['octocat'] }]],
    [
      'another event set',
      [
        owner,
        repo,
        { claim: 'ref_type', match: 'exact', values: ['branch'] },
        { claim: 'ref', match: 'glob', values: ['refs/heads/main'] },
        { claim: 'event_name', match: 'exact', values: ['push'] },
      ],
    ],
    [
      'a negated condition',
      [owner, repo, { claim: 'ref', match: 'exact', values: ['x'], negate: true }],
    ],
    [
      'an environment glob',
      [owner, repo, { claim: 'environment', match: 'glob', values: ['prod-*'] }],
    ],
    [
      'a broad branch glob',
      [
        owner,
        repo,
        { claim: 'ref_type', match: 'exact', values: ['branch'] },
        { claim: 'ref', match: 'glob', values: ['refs/heads/**'] },
        { claim: 'event_name', match: 'exact', values: ['push', 'workflow_dispatch', 'schedule'] },
      ],
    ],
    ['no owner', [repo]],
    [
      'the pull_request_target event',
      [owner, repo, { claim: 'event_name', match: 'exact', values: ['pull_request_target'] }],
    ],
  ])('%s gives null', (_name, conditions) => {
    expect(githubPresetFromConditions(conditions)).toBeNull();
  });

  it('a GitLab merge request opt-in gives null', () => {
    expect(
      gitlabPresetFromConditions([
        { claim: 'namespace_id', match: 'exact', values: ['3000'] },
        { claim: 'project_id', match: 'exact', values: ['4000'] },
        { claim: 'pipeline_source', match: 'exact', values: ['merge_request_event'] },
      ]),
    ).toBeNull();
  });
});
