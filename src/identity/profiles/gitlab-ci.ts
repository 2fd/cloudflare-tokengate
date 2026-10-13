// Profile for GitLab CI `id_tokens`: what the gateway trusts about the issuer, which claims anchor
// a grant (I-AUTHZ-2), which pipeline sources need opt-in (I-AUTHZ-3) and the tenant pin (I-TEN-1).
// Claim reference: https://docs.gitlab.com/ci/secrets/id_token_authentication/
import type { IssuerProfile } from '../types';
import { buildDisplay } from './generic';

/** gitlab.com is shared by every customer. Self-managed instances use their own URL as issuer. */
export const GITLAB_COM_ISSUER = 'https://gitlab.com';

// Pipeline sources started from the project itself. `merge_request_event`,
// `external_pull_request_event`, `chat`, `webide` and others must be opted in explicitly by a
// grant. So must `parent_pipeline` and `pipeline`: child and downstream pipelines report them
// whatever started the upstream pipeline, including (fork) merge request pipelines (I-AUTHZ-3).
const TRUSTED_EVENTS = Object.freeze(['push', 'web', 'schedule', 'api', 'trigger']);

const REQUIRED_CLAIMS = Object.freeze([
  'sub',
  'jti',
  'iat',
  'exp',
  'project_id',
  'namespace_id',
  'pipeline_source',
  'ref',
]);

// Copied into the request log; everything else is dropped (I-LOG-1). `user_email` is personal data.
const LOG_CLAIMS = Object.freeze([
  'sub',
  'project_id',
  'project_path',
  'namespace_id',
  'namespace_path',
  'ref',
  'ref_type',
  'ref_path',
  'ref_protected',
  'pipeline_source',
  'environment',
  'environment_protected',
  'deployment_tier',
  'ci_config_ref_uri',
  'ci_config_sha',
  'pipeline_id',
  'job_id',
  'user_id',
  'user_login',
  'sha',
  'runner_environment',
]);

export const gitlabCiProfile: IssuerProfile = {
  id: 'gitlab-ci',
  label: 'GitLab CI',
  defaults: {
    issuer: GITLAB_COM_ISSUER,
    allowedAlgs: ['RS256'],
    maxTokenAgeSeconds: 600,
    // GitLab tokens live as long as the job timeout, which can be hours.
    maxTokenAgeLimitSeconds: 3600,
  },
  eventClaim: 'pipeline_source',
  trustedEvents: TRUSTED_EVENTS,
  // Numeric, immutable ID. `namespace_path` can be renamed and re-registered.
  tenantClaims: Object.freeze(['namespace_id']),
  sharedIssuers: Object.freeze([GITLAB_COM_ISSUER]),
  anchorRules: () => [
    ['namespace_id', 'project_id'],
    ['namespace_id', 'ci_config_ref_uri'],
  ],
  verifyRequiredClaims: () => [...REQUIRED_CLAIMS],
  logClaimAllowlist: () => [...LOG_CLAIMS],
  display: (claims) =>
    buildDisplay(claims, {
      repository: 'project_path',
      ref: 'ref',
      event: 'pipeline_source',
      environment: 'environment',
      workflow: 'ci_config_ref_uri',
    }),
};
