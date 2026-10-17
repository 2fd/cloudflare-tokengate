// Alerts: the problems of the deployment, as data (telemetry/dashboard.ts builds them). The
// Overview shows them as Needs attention items (views/monitoring.tsx toAttentionItems), and the
// shell health line and strip summarize them (shell-health.ts).
import type { User } from '../../db/types';
import type { Permission } from '../auth/rbac';

export type AlertCode =
  | 'keyring_unavailable'
  | 'key_missing'
  | 'key_changed'
  | 'credential_malformed'
  | 'key_not_active'
  | 'credential_expired'
  | 'credential_expiring'
  | 'credential_missing_used'
  | 'upstream_auth'
  | 'outside_hosts'
  | 'schema_behind'
  | 'schema_ahead'
  | 'schema_unknown'
  | 'config_problem'
  | 'cron_failing'
  | 'cron_stale'
  | 'cron_never'
  | 'access_expiring'
  | 'users_need_decision'
  | 'single_owner';

/** A person waiting for a decision; the name, when known, leads the Overview card. */
export type PendingUser = Pick<User, 'id' | 'email' | 'updated_at'> & { name?: string | null };

export interface Alert {
  code: AlertCode;
  level: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  /** Always shown. */
  objects: Array<{ href: string; label: string }>;
  /** Shown only to holders of `permission`; others see AskSomeone(permission). */
  fix?: {
    href: string;
    label: string;
    permission: Permission;
    /** A short visible label for a narrow card (the Overview): the rest is read by screen readers. */
    short?: { label: string; srSuffix: string };
  } | null;
  form?:
    | { kind: 'approve-pending'; users: PendingUser[] }
    | { kind: 'rewrap'; count: number }
    | null;
}
