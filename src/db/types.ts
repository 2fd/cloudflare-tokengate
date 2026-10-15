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

export interface CallerProvider {
  id: string;
  name: string;
  profile: ProfileId;
  issuer: string;
  jwks_uri: string;
  audience: string;
  allowed_algs: string[];
  max_token_age_seconds: number;
  tenant_pin: Condition[];
  anchor_claims: string[];
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface Service {
  id: string;
  slug: string;
  name: string;
  description: string;
  base_url: string;
  injection: Injection;
  /** Exact stored JSON text of `injection`; part of the credential AAD (I-CRED-2). */
  injection_json: string;
  forward_headers: string[];
  timeout_ms: number;
  credential_sealed: string | null;
  credential_hint: string | null;
  credential_updated_at: number | null;
  credential_expires_at: number | null;
  verify: VerifyCheck | null;
  /**
   * The template the service was made from (src/admin/service-templates.ts), or null. Display and
   * preset data only, never part of the credential AAD (ADR 0004).
   */
  template_id: string | null;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface Grant {
  id: string;
  name: string;
  description: string;
  caller_provider_id: string;
  service_id: string;
  conditions: Condition[];
  rules: Rule[];
  enabled: boolean;
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

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
export type LabelledClaim = 'repository_owner_id' | 'repository_id' | 'namespace_id' | 'project_id';

/**
 * Human label for one numeric claim value, per caller provider, e.g. repository_id 987654321 →
 * "acme/api". Display and form derivation only: policy evaluation never reads it.
 */
export interface ClaimLabel {
  caller_provider_id: string;
  claim: LabelledClaim;
  value: string;
  label: string;
  updated_at: number;
  updated_by: string | null;
}
