// Small IssuerProfile and CallerProvider fixtures for policy tests. They mirror docs/policies.md but are
// deliberately independent of src/identity/profiles so policy tests pin policy behavior only.
import type { CallerProvider } from '../../../src/db/types';
import type { Claims, IssuerProfile } from '../../../src/identity/types';

const display = (claims: Claims) => ({ subject: String(claims.sub ?? '') });

export const githubProfile: IssuerProfile = {
  id: 'github-actions',
  label: 'GitHub Actions',
  defaults: {
    issuer: 'https://token.actions.githubusercontent.com',
    allowedAlgs: ['RS256'],
    maxTokenAgeSeconds: 600,
    maxTokenAgeLimitSeconds: 900,
  },
  eventClaim: 'event_name',
  trustedEvents: ['push', 'workflow_dispatch', 'schedule', 'release'],
  tenantClaims: ['repository_owner_id', 'enterprise_id'],
  sharedIssuers: ['https://token.actions.githubusercontent.com'],
  anchorRules: () => [
    ['repository_owner_id', 'repository_id'],
    ['repository_owner_id', 'job_workflow_ref'],
  ],
  verifyRequiredClaims: () => ['sub', 'iat', 'exp'],
  logClaimAllowlist: () => ['sub', 'repository_id', 'ref', 'event_name'],
  display,
};

export const gitlabProfile: IssuerProfile = {
  id: 'gitlab-ci',
  label: 'GitLab CI',
  defaults: {
    issuer: 'https://gitlab.com',
    allowedAlgs: ['RS256'],
    maxTokenAgeSeconds: 600,
    maxTokenAgeLimitSeconds: 3600,
  },
  eventClaim: 'pipeline_source',
  trustedEvents: ['push', 'web', 'schedule', 'api', 'trigger'],
  tenantClaims: ['namespace_id'],
  sharedIssuers: ['https://gitlab.com'],
  anchorRules: () => [
    ['namespace_id', 'project_id'],
    ['namespace_id', 'ci_config_ref_uri'],
  ],
  verifyRequiredClaims: () => ['sub', 'iat', 'exp'],
  logClaimAllowlist: () => ['sub', 'project_id', 'pipeline_source'],
  display,
};

export const genericProfile: IssuerProfile = {
  id: 'generic',
  label: 'Generic OIDC',
  defaults: { allowedAlgs: ['RS256'], maxTokenAgeSeconds: 600, maxTokenAgeLimitSeconds: 3600 },
  trustedEvents: [],
  tenantClaims: [],
  sharedIssuers: [],
  anchorRules: (provider) => provider.anchor_claims.map((claim) => [claim]),
  verifyRequiredClaims: (provider) => ['sub', 'iat', 'exp', ...provider.anchor_claims],
  logClaimAllowlist: (provider) => ['sub', ...provider.anchor_claims],
  display,
};

export function provider(overrides: Partial<CallerProvider> = {}): CallerProvider {
  return {
    id: 'cpr_01JTESTPROVIDER000000000000',
    name: 'GitHub',
    profile: 'github-actions',
    issuer: 'https://token.actions.githubusercontent.com',
    jwks_uri: 'https://token.actions.githubusercontent.com/.well-known/jwks',
    audience: 'tokengate:01JTESTAUDIENCE00000000000',
    allowed_algs: ['RS256'],
    max_token_age_seconds: 600,
    tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: ['1000'] }],
    anchor_claims: [],
    enabled: true,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}
