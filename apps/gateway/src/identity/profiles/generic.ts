// Profile for any OIDC issuer (Buildkite, CircleCI, Kubernetes, ...). The gateway knows nothing about
// its claims, so anchors (I-AUTHZ-2) come from the credential access rule's `anchor_claims` and no event
// guard applies. Also exports the display helpers shared by all profiles.
import { claimText } from '../../policy/conditions';
import type { Condition } from '../../policy/types';
import type { CallerDisplay, Claims, IssuerProfile } from '../types';

const DISPLAY_MAX_LENGTH = 256;

/**
 * Text of a scalar claim for UI and logs only (never authorization), using the same scalar rules
 * as conditions. Capped so a hostile token cannot bloat logs.
 */
export function displayText(claims: Claims, name: string): string | undefined {
  const text = claimText(claims, name);
  if (text === null) return undefined;
  return text.length > DISPLAY_MAX_LENGTH ? `${text.slice(0, DISPLAY_MAX_LENGTH)}…` : text;
}

/** Builds a CallerDisplay, dropping fields the token does not carry. */
export function buildDisplay(
  claims: Claims,
  fields: { [K in keyof CallerDisplay]?: string },
): CallerDisplay {
  const display: CallerDisplay = { subject: displayText(claims, 'sub') ?? '' };
  for (const [field, claim] of Object.entries(fields) as Array<[keyof CallerDisplay, string]>) {
    const text = displayText(claims, claim);
    if (text !== undefined) display[field] = text;
  }
  return display;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function pinClaims(tenantPin: Condition[]): string[] {
  return tenantPin.map((condition) => condition.claim);
}

export const genericProfile: IssuerProfile = {
  id: 'generic',
  label: 'Generic OIDC',
  defaults: {
    allowedAlgs: ['RS256'],
    maxTokenAgeSeconds: 600,
    maxTokenAgeLimitSeconds: 3600,
  },
  trustedEvents: [],
  // Empty = a tenant pin may use any claim.
  tenantClaims: [],
  sharedIssuers: [],
  anchorRules: (provider) => provider.anchor_claims.map((claim) => [claim]),
  verifyRequiredClaims: (provider) => unique(['sub', 'iat', 'exp', ...provider.anchor_claims]),
  logClaimAllowlist: (provider) =>
    unique(['sub', ...provider.anchor_claims, ...pinClaims(provider.tenant_pin)]),
  display: (claims) => buildDisplay(claims, {}),
};
