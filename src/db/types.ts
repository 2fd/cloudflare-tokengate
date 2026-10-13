// Decoded row shapes. Repositories in src/db/* convert between these and D1 rows
// (JSON columns parsed, integer booleans converted).
import type { ProfileId } from '../identity/types';
import type { Condition, Injection, Rule, VerifyCheck } from '../policy/types';

export type Role = 'owner' | 'admin' | 'viewer';
export type UserStatus = 'invited' | 'active' | 'disabled';

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
}

export interface Session {
  id_hash: string;
  user_id: string;
  login_provider: string;
  identity_subject: string;
  csrf_token: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  idle_expires_at: number;
  ip: string | null;
  user_agent: string | null;
  revoked_at: number | null;
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
