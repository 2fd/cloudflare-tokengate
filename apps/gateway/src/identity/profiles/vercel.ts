// Profile for Vercel OIDC tokens as `getVercelOidcToken({ audience })` of @vercel/oidc returns them
// (functions and builds): what the gateway trusts about the issuer, which claims anchor a grant
// (I-AUTHZ-2), which environments need opt-in (I-AUTHZ-3) and the tenant pin (I-TEN-1).
// Claim reference: https://vercel.com/docs/oidc/reference
import type { IssuerProfile } from '../types';
import { buildDisplay } from './generic';

/**
 * The "global" issuer mode: shared by every Vercel team. The default "team" issuer mode signs with
 * `<this>/<team slug>`, which is not shared. Both publish `<issuer>/.well-known/openid-configuration`.
 */
export const VERCEL_OIDC_ISSUER = 'https://oidc.vercel.com';

// Deployed code of the project. `development` tokens go to every team member through
// `vercel env pull` and the CLI refresh; Custom Environments are named by the team. Both must be
// opted in explicitly by a grant.
const TRUSTED_EVENTS = Object.freeze(['production', 'preview']);

// No `jti`: @vercel/oidc sets one only when the caller passes `jti` to the audience exchange.
const REQUIRED_CLAIMS = Object.freeze([
  'sub',
  'iat',
  'exp',
  'owner_id',
  'project_id',
  'environment',
]);

// Copied into the request log; everything else is dropped (I-LOG-1).
const LOG_CLAIMS = Object.freeze([
  'sub',
  'owner',
  'owner_id',
  'project',
  'project_id',
  'environment',
  'custom_environment_id',
  'user_id',
]);

export const vercelProfile: IssuerProfile = {
  id: 'vercel',
  label: 'Vercel',
  defaults: {
    issuer: VERCEL_OIDC_ISSUER,
    allowedAlgs: ['RS256'],
    // Function tokens live two hours and @vercel/oidc caches an exchanged token until its `exp`,
    // so one token is sent for up to two hours.
    maxTokenAgeSeconds: 7200,
    maxTokenAgeLimitSeconds: 7200,
  },
  eventClaim: 'environment',
  trustedEvents: TRUSTED_EVENTS,
  // Team ID (`team_…`): immutable. `owner` is the team slug, which can be renamed.
  tenantClaims: Object.freeze(['owner_id']),
  sharedIssuers: Object.freeze([VERCEL_OIDC_ISSUER]),
  anchorRules: () => [['owner_id', 'project_id']],
  verifyRequiredClaims: () => [...REQUIRED_CLAIMS],
  logClaimAllowlist: () => [...LOG_CLAIMS],
  display: (claims) =>
    buildDisplay(claims, {
      repository: 'project',
      event: 'environment',
      environment: 'environment',
    }),
};
