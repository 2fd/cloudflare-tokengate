// Workload-identity vocabulary: issuer profiles and the verified caller.
import type { CredentialAccessRule } from '../db/types';

export type ProfileId = 'github-actions' | 'gitlab-ci' | 'vercel' | 'generic';

/** Verified JWT payload. Values are untrusted shapes; read them through policy/conditions.ts. */
export type Claims = Record<string, unknown>;

/** Human-readable summary of a caller for UI and logs. Never used for authorization. */
export interface CallerDisplay {
  subject: string;
  repository?: string;
  ref?: string;
  event?: string;
  environment?: string;
  workflow?: string;
}

/**
 * Code-reviewed knowledge about one issuer type. Everything the gateway trusts about
 * GitHub Actions or GitLab CI lives in one profile file (src/identity/profiles/*).
 */
export interface IssuerProfile {
  id: ProfileId;
  label: string;
  defaults: {
    issuer?: string;
    allowedAlgs: string[];
    maxTokenAgeSeconds: number;
    maxTokenAgeLimitSeconds: number;
  };
  /** Claim naming the triggering event, if the platform has one. */
  eventClaim?: string;
  /** Events allowed without an explicit exact opt-in in the credential access rule (I-AUTHZ-3). */
  trustedEvents: readonly string[];
  /** Claims a tenant pin may use; empty array = any claim (generic). */
  tenantClaims: readonly string[];
  /** Issuers shared by many tenants; providers using them must have a tenant pin (I-TEN-1). */
  sharedIssuers: readonly string[];
  /**
   * A credential access rule must satisfy at least one rule: every claim in the rule has an exact, non-negated
   * condition (I-AUTHZ-2). For `generic`, rules come from the rule's own anchor_claims.
   */
  anchorRules(rule: Pick<CredentialAccessRule, 'anchor_claims'>): string[][];
  /** Claims jose must find in the token. */
  verifyRequiredClaims(rule: Pick<CredentialAccessRule, 'anchor_claims' | 'tenant_pin'>): string[];
  /** Claims copied into the request log; everything else is dropped (I-LOG-1). */
  logClaimAllowlist(rule: Pick<CredentialAccessRule, 'anchor_claims' | 'tenant_pin'>): string[];
  display(claims: Claims): CallerDisplay;
}

export interface CallerIdentity {
  credentialAccessRuleId: string;
  profile: ProfileId;
  claims: Claims;
  display: CallerDisplay;
  jti?: string;
}
