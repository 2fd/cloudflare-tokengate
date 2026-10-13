// Profile for GitHub Actions OIDC tokens: what the gateway trusts about the issuer, which claims
// anchor a grant (I-AUTHZ-2), which events need opt-in (I-AUTHZ-3) and the tenant pin (I-TEN-1).
// Claim reference: https://docs.github.com/en/actions/reference/security/oidc
import type { IssuerProfile } from '../types';
import { buildDisplay } from './generic';

/** Shared by every GitHub customer; the enterprise-slug issuer (`.../<slug>`) is not shared. */
export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

// Events whose workflow file and ref come from the repository itself, not from an outside
// contributor. `pull_request`, `pull_request_target`, `workflow_run`, `issue_comment` and
// Dependabot's `dynamic` must be opted in explicitly by a grant.
const TRUSTED_EVENTS = Object.freeze(['push', 'workflow_dispatch', 'schedule', 'release']);

const REQUIRED_CLAIMS = Object.freeze([
  'sub',
  'jti',
  'iat',
  'exp',
  'repository_id',
  'repository_owner_id',
  'event_name',
  'ref',
]);

// Copied into the request log. Everything else in the token is dropped (I-LOG-1).
const LOG_CLAIMS = Object.freeze([
  'sub',
  'repository',
  'repository_id',
  'repository_owner',
  'repository_owner_id',
  'ref',
  'ref_type',
  'ref_protected',
  'event_name',
  'environment',
  'base_ref',
  'head_ref',
  'workflow_ref',
  'job_workflow_ref',
  'actor',
  'actor_id',
  'run_id',
  'run_attempt',
  'sha',
  'runner_environment',
  'enterprise_id',
]);

export const githubActionsProfile: IssuerProfile = {
  id: 'github-actions',
  label: 'GitHub Actions',
  defaults: {
    issuer: GITHUB_ACTIONS_ISSUER,
    // https://token.actions.githubusercontent.com/.well-known/openid-configuration
    // lists only RS256 in id_token_signing_alg_values_supported.
    allowedAlgs: ['RS256'],
    maxTokenAgeSeconds: 600,
    maxTokenAgeLimitSeconds: 900,
  },
  eventClaim: 'event_name',
  trustedEvents: TRUSTED_EVENTS,
  // Numeric, immutable IDs. Names (`repository_owner`) can be renamed and re-registered.
  tenantClaims: Object.freeze(['repository_owner_id', 'enterprise_id']),
  sharedIssuers: Object.freeze([GITHUB_ACTIONS_ISSUER]),
  anchorRules: () => [
    ['repository_owner_id', 'repository_id'],
    ['repository_owner_id', 'job_workflow_ref'],
  ],
  verifyRequiredClaims: () => [...REQUIRED_CLAIMS],
  logClaimAllowlist: () => [...LOG_CLAIMS],
  display: (claims) =>
    buildDisplay(claims, {
      repository: 'repository',
      ref: 'ref',
      event: 'event_name',
      environment: 'environment',
      workflow: 'job_workflow_ref',
    }),
};
