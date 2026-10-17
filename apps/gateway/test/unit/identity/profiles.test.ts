import { describe, expect, it } from 'vitest';
import {
  getProfile,
  isSharedIssuer,
  PROFILES,
  SHARED_ISSUERS,
} from '../../../src/identity/profiles';
import type { Condition } from '../../../src/policy/types';
import { githubClaims, gitlabClaims } from '../../helpers/jwt';

const noProviderConfig = { anchor_claims: [] as string[], tenant_pin: [] as Condition[] };

describe('profile registry', () => {
  it('maps every ProfileId to the profile with that id', () => {
    for (const [id, profile] of Object.entries(PROFILES)) expect(profile.id).toBe(id);
  });

  it('returns null for unknown or inherited keys instead of a default', () => {
    expect(getProfile('github-actions')?.id).toBe('github-actions');
    for (const id of ['', 'GitHub-Actions', 'toString', '__proto__', 'constructor']) {
      expect(getProfile(id)).toBeNull();
    }
  });

  it('is frozen, including each profile and its defaults', () => {
    expect(Object.isFrozen(PROFILES)).toBe(true);
    for (const profile of Object.values(PROFILES)) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.defaults)).toBe(true);
      expect(Object.isFrozen(profile.defaults.allowedAlgs)).toBe(true);
    }
  });

  it('lists shared issuers of every profile, compared exactly', () => {
    expect(SHARED_ISSUERS).toEqual([
      'https://token.actions.githubusercontent.com',
      'https://gitlab.com',
    ]);
    expect(isSharedIssuer('https://gitlab.com')).toBe(true);
    for (const issuer of [
      'https://gitlab.example.com',
      'https://token.actions.githubusercontent.com/acme',
    ]) {
      expect(isSharedIssuer(issuer)).toBe(false);
    }
  });

  it('never defaults to symmetric or unsigned algorithms', () => {
    for (const profile of Object.values(PROFILES)) {
      expect(profile.defaults.allowedAlgs).toEqual(['RS256']);
      expect(profile.defaults.maxTokenAgeSeconds).toBeLessThanOrEqual(
        profile.defaults.maxTokenAgeLimitSeconds,
      );
    }
  });
});

describe('github-actions profile', () => {
  const profile = PROFILES['github-actions'];

  it('matches the documented profile (docs/policies.md)', () => {
    expect(profile.defaults).toEqual({
      issuer: 'https://token.actions.githubusercontent.com',
      allowedAlgs: ['RS256'],
      maxTokenAgeSeconds: 600,
      maxTokenAgeLimitSeconds: 900,
    });
    expect(profile.eventClaim).toBe('event_name');
    expect(profile.trustedEvents).toEqual(['push', 'workflow_dispatch', 'schedule', 'release']);
    expect(profile.tenantClaims).toEqual(['repository_owner_id', 'enterprise_id']);
    expect(profile.sharedIssuers).toEqual(['https://token.actions.githubusercontent.com']);
    expect(profile.anchorRules(noProviderConfig)).toEqual([
      ['repository_owner_id', 'repository_id'],
      ['repository_owner_id', 'job_workflow_ref'],
    ]);
    expect(profile.verifyRequiredClaims(noProviderConfig)).toEqual([
      'sub',
      'jti',
      'iat',
      'exp',
      'repository_id',
      'repository_owner_id',
      'event_name',
      'ref',
    ]);
  });

  it('never trusts PR, workflow_run, comment or Dependabot events by default', () => {
    for (const event of [
      'pull_request',
      'pull_request_target',
      'workflow_run',
      'issue_comment',
      'dynamic',
    ]) {
      expect(profile.trustedEvents).not.toContain(event);
    }
  });

  it('logs only allowlisted claims', () => {
    const allowlist = profile.logClaimAllowlist(noProviderConfig);
    expect(allowlist).toContain('repository_id');
    expect(allowlist).not.toContain('aud');
    expect(allowlist).not.toContain('jti');
  });

  it('returns fresh arrays so callers cannot mutate the profile', () => {
    profile.verifyRequiredClaims(noProviderConfig).push('x');
    profile.logClaimAllowlist(noProviderConfig).push('x');
    profile.anchorRules(noProviderConfig)[0]?.push('x');
    expect(profile.verifyRequiredClaims(noProviderConfig)).not.toContain('x');
    expect(profile.logClaimAllowlist(noProviderConfig)).not.toContain('x');
    expect(profile.anchorRules(noProviderConfig)[0]).toEqual([
      'repository_owner_id',
      'repository_id',
    ]);
  });

  it('displays repository, ref, event, environment and workflow', () => {
    expect(profile.display(githubClaims({ environment: 'production' }))).toEqual({
      subject: 'repo:acme/app:ref:refs/heads/main',
      repository: 'acme/app',
      ref: 'refs/heads/main',
      event: 'push',
      environment: 'production',
      workflow: 'acme/app/.github/workflows/deploy.yml@refs/heads/main',
    });
  });
});

describe('gitlab-ci profile', () => {
  const profile = PROFILES['gitlab-ci'];

  it('matches the documented profile (docs/policies.md)', () => {
    expect(profile.defaults).toEqual({
      issuer: 'https://gitlab.com',
      allowedAlgs: ['RS256'],
      maxTokenAgeSeconds: 600,
      maxTokenAgeLimitSeconds: 3600,
    });
    expect(profile.eventClaim).toBe('pipeline_source');
    expect(profile.trustedEvents).toEqual(['push', 'web', 'schedule', 'api', 'trigger']);
    expect(profile.tenantClaims).toEqual(['namespace_id']);
    expect(profile.sharedIssuers).toEqual(['https://gitlab.com']);
    expect(profile.anchorRules(noProviderConfig)).toEqual([
      ['namespace_id', 'project_id'],
      ['namespace_id', 'ci_config_ref_uri'],
    ]);
    expect(profile.verifyRequiredClaims(noProviderConfig)).toEqual([
      'sub',
      'jti',
      'iat',
      'exp',
      'project_id',
      'namespace_id',
      'pipeline_source',
      'ref',
    ]);
  });

  it('never trusts merge request pipelines, or child and downstream pipelines they can start', () => {
    for (const event of ['merge_request_event', 'parent_pipeline', 'pipeline']) {
      expect(profile.trustedEvents).not.toContain(event);
    }
  });

  it('never logs user_email', () => {
    expect(profile.logClaimAllowlist(noProviderConfig)).not.toContain('user_email');
  });

  it('displays project path, ref, pipeline source, environment and CI config', () => {
    expect(profile.display(gitlabClaims())).toEqual({
      subject: 'project_path:my-group/my-project:ref_type:branch:ref:main',
      repository: 'my-group/my-project',
      ref: 'main',
      event: 'push',
      workflow: 'gitlab.com/my-group/my-project//.gitlab-ci.yml@refs/heads/main',
    });
  });
});

describe('generic profile', () => {
  const profile = PROFILES.generic;
  const provider = {
    anchor_claims: ['organization_id', 'pipeline_id'],
    tenant_pin: [{ claim: 'organization_id', match: 'exact', values: ['o1'] }] as Condition[],
  };

  it('has no event guard, no shared issuers and accepts any tenant claim', () => {
    expect(profile.eventClaim).toBeUndefined();
    expect(profile.trustedEvents).toEqual([]);
    expect(profile.sharedIssuers).toEqual([]);
    expect(profile.tenantClaims).toEqual([]);
  });

  it('derives anchors, required claims and log allowlist from the credential access rule', () => {
    expect(profile.anchorRules(provider)).toEqual([['organization_id'], ['pipeline_id']]);
    expect(profile.verifyRequiredClaims(provider)).toEqual([
      'sub',
      'iat',
      'exp',
      'organization_id',
      'pipeline_id',
    ]);
    expect(profile.logClaimAllowlist(provider)).toEqual(['sub', 'organization_id', 'pipeline_id']);
  });

  it('displays the subject only', () => {
    expect(profile.display({ sub: 'pipeline:1', pipeline_slug: 'deploy' })).toEqual({
      subject: 'pipeline:1',
    });
  });
});

describe('display', () => {
  const profile = PROFILES['github-actions'];

  it('omits non-scalar claims and renders scalars as text', () => {
    expect(
      profile.display({
        sub: 42,
        repository: { name: 'acme/app' },
        ref: ['refs/heads/main'],
        event_name: true,
        environment: null,
      }),
    ).toEqual({ subject: '42', event: 'true' });
  });

  it('uses an empty subject when sub is missing', () => {
    expect(profile.display({}).subject).toBe('');
  });

  it('caps long values', () => {
    const display = profile.display(githubClaims({ ref: `refs/heads/${'a'.repeat(5000)}` }));
    expect(display.ref?.length).toBe(257);
    expect(display.ref?.endsWith('…')).toBe(true);
  });
});
