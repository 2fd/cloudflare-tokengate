// Decoded row shapes. Repositories in src/db/* convert between these and D1 rows
// (JSON columns parsed, integer booleans converted).
import type { ProfileId } from '../identity/types';
import type { Condition, Injection, Rule, VerifyCheck } from '../policy/types';

/** Admin roles (ADR 0018); src/admin/auth/rbac.ts maps each to its permissions. */
export type Role = 'owner' | 'admin' | 'token_manager' | 'access_manager' | 'viewer';
export type UserStatus = 'invited' | 'pending' | 'active' | 'suspended';

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: UserStatus;
  invite_expires_at: number | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
  /** Last refused sign-in of this user (not audited, like last_login_at). */
  last_refused_at: number | null;
  /** Login subject of that refused sign-in. */
  last_refused_subject: string | null;
}

/** Fields that both kinds of access rule share (ADR 0026). */
interface AccessRuleBase {
  id: string;
  name: string;
  description: string;
  profile: ProfileId;
  /** Exact; jose compares it with `iss`. */
  issuer: string;
  /** Stored `lower(rtrim(issuer, '/'))`; global access rules match on it (AR-3). */
  issuer_key: string;
  enabled: boolean;
  /** Milliseconds since the epoch, or null for no expiry. */
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Lets workloads whose tokens `issuer` signs, and that match `conditions`, use one credential for
 * `rules`. It holds its own token verification settings, so every limit is set.
 */
export interface CredentialAccessRule extends AccessRuleBase {
  kind: 'credential';
  credential_id: string;
  jwks_uri: string;
  audience: string;
  allowed_algs: string[];
  max_token_age_seconds: number;
  tenant_pin: Condition[];
  anchor_claims: string[];
  conditions: Condition[];
  rules: Rule[];
}

/**
 * A ceiling on every credential access rule with the same `issuer_key`. A null limit is "no limit".
 * It never lets a request in by itself; disabled or expired, it still caps its issuer (AR-4).
 */
export interface GlobalAccessRule extends AccessRuleBase {
  kind: 'global';
  credential_id: null;
  jwks_uri: string | null;
  audience: string | null;
  allowed_algs: string[] | null;
  max_token_age_seconds: number | null;
  tenant_pin: Condition[] | null;
  anchor_claims: string[] | null;
  conditions: Condition[] | null;
  rules: Rule[] | null;
}

/** A row of `access_rules` of either kind (a storage name, not a domain term). */
export type AccessRuleRow = CredentialAccessRule | GlobalAccessRule;

export interface Credential {
  id: string;
  slug: string;
  name: string;
  base_url: string;
  injection: Injection;
  /** Exact stored JSON text of `injection`; part of the credential AAD (I-CRED-2). */
  injection_json: string;
  forward_headers: string[];
  timeout_ms: number;
  credential_sealed: string | null;
  credential_hint: string | null;
  credential_updated_at: number | null;
  verify: VerifyCheck | null;
  /** The name came from the verify check (the Slack bot name); a manual rename clears it. */
  name_from_check: boolean;
  /**
   * The template the service was made from (src/admin/service-templates.ts), or null. Display and
   * preset data only, never part of the credential AAD (ADR 0004).
   */
  template_id: string | null;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

/** Historical internal name; the persisted domain entity is Credential. */
export type Service = Credential;

export interface AuditEvent {
  id: string;
  ts: number;
  actor_type: 'user' | 'system';
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  summary: string;
  diff: { before?: unknown; after?: unknown; [key: string]: unknown } | null;
  ip: string | null;
  user_agent: string | null;
}

/** Who performed an admin mutation; copied into the audit row. */
export interface Actor {
  type: 'user' | 'system';
  id: string | null;
  email: string | null;
  ip: string | null;
  userAgent: string | null;
}

/** Claims whose numeric IDs can carry a display label (`claim_labels`). */
export type LabelledClaim =
  | 'repository_owner_id'
  | 'repository_id'
  | 'namespace_id'
  | 'project_id'
  | 'owner_id';

/**
 * Human label for one claim ID, per access rule, e.g. repository_id 987654321 →
 * "acme/api". Display and form derivation only: policy evaluation never reads it.
 */
export interface ClaimLabel {
  access_rule_id: string;
  claim: LabelledClaim;
  value: string;
  label: string;
  updated_at: number;
  updated_by: string | null;
}
