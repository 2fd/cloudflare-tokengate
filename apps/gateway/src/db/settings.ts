// The D1 `settings` table: admin-editable runtime settings and internal state keys, JSON values.
// Defaults and bounds live here so every reader agrees; bounds are re-applied on read, not only on save.
import { isAdminHostEntry, isUpstreamHostEntry } from '../config';

export interface Settings {
  request_log_retention_days: number;
  audit_log_retention_days: number;
  rollup_retention_days: number;
  /** Probability of keeping an allowed request record (denied and error records are always kept). */
  allowed_sample_rate: number;
  request_log_max_rows: number;
}

export const SETTING_DEFAULTS: Settings = {
  request_log_retention_days: 14,
  audit_log_retention_days: 365,
  rollup_retention_days: 400,
  allowed_sample_rate: 1,
  request_log_max_rows: 5_000_000,
};

/** Lower and upper bounds. Values outside are clamped when read and rejected when saved. */
export const SETTING_BOUNDS: Record<keyof Settings, { min: number; max: number }> = {
  request_log_retention_days: { min: 1, max: 3650 },
  audit_log_retention_days: { min: 90, max: 3650 },
  rollup_retention_days: { min: 30, max: 3650 },
  allowed_sample_rate: { min: 0, max: 1 },
  request_log_max_rows: { min: 10_000, max: 50_000_000 },
};

/**
 * Role and status of a user created by their first sign-in (not the first owner). The role is any
 * role except owner (I-LINK-1).
 */
export const JOIN_ROLES = ['viewer', 'token_manager', 'access_manager', 'admin'] as const;
export const JOIN_STATUSES = ['active', 'pending', 'suspended'] as const;
export type JoinRole = (typeof JOIN_ROLES)[number];
export type JoinStatus = (typeof JOIN_STATUSES)[number];

export interface JoinDefaults {
  role: JoinRole;
  status: JoinStatus;
}

export const JOIN_DEFAULTS: JoinDefaults = { role: 'viewer', status: 'active' };

/** Settings keys of the join defaults, edited on the users page (owners only). */
export type JoinKey = 'join_role' | 'join_status';

/** Stored join defaults; a missing or unknown stored value reads as its default. */
export async function getJoinDefaults(db: D1Database): Promise<JoinDefaults> {
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key IN ('join_role', 'join_status')")
    .all<{ key: string; value: string }>();
  const stored = new Map(results.map((row) => [row.key, parseJsonOrNull(row.value)]));
  const role = stored.get('join_role');
  const status = stored.get('join_status');
  return {
    role: (JOIN_ROLES as readonly unknown[]).includes(role)
      ? (role as JoinRole)
      : JOIN_DEFAULTS.role,
    status: (JOIN_STATUSES as readonly unknown[]).includes(status)
      ? (status as JoinStatus)
      : JOIN_DEFAULTS.status,
  };
}

function parseJsonOrNull(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Upstream host allowlist (I-SSRF-1), edited by owners in Service tokens › Allowed hosts. Stored as a JSON array of
 * lowercased entries (exact host or `*.<domain>`), or null for "any public https host".
 */
export const UPSTREAM_HOSTS_KEY = 'allowed_upstream_hosts';

/** null = unrestricted. A stored value that is not a valid list denies every host (fail closed). */
export function upstreamHostsFromValue(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  const value = parseJsonOrNull(raw);
  if (value === null) return raw.trim() === 'null' ? null : [];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === 'string' && isUpstreamHostEntry(entry))
  ) {
    return [];
  }
  return value as string[];
}

export function upstreamHostsStatement(db: D1Database): D1PreparedStatement {
  return db.prepare('SELECT value FROM settings WHERE key = ?').bind(UPSTREAM_HOSTS_KEY);
}

export async function getAllowedUpstreamHosts(db: D1Database): Promise<string[] | null> {
  const row = await upstreamHostsStatement(db).first<{ value: string }>();
  return upstreamHostsFromValue(row?.value);
}

/**
 * Admin host allowlist (I-DEPLOY-1): the hostnames /admin answers on, as a JSON array of lowercased
 * `isAdminHostEntry` entries. The first-owner bootstrap stores the hostname of that sign-in
 * (`bootstrapOwnerStatements`); owners edit it in Users › Sign-in. Absent until then.
 */
export const ADMIN_HOSTS_KEY = 'admin_hosts';

/** null = not set yet (any host). A stored value that is not a valid list denies every host. */
export function adminHostsFromValue(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  const value = parseJsonOrNull(raw);
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === 'string' && isAdminHostEntry(entry))
  ) {
    return [];
  }
  return value as string[];
}

export function adminHostsStatement(db: D1Database): D1PreparedStatement {
  return db.prepare('SELECT value FROM settings WHERE key = ?').bind(ADMIN_HOSTS_KEY);
}

export async function getAdminHosts(db: D1Database): Promise<string[] | null> {
  const row = await adminHostsStatement(db).first<{ value: string }>();
  return adminHostsFromValue(row?.value);
}

/** Internal bookkeeping keys, not editable in the UI. */
export type StateKey =
  | 'bootstrap_completed_at'
  | 'cron_last_success_at'
  | 'cron_last_error'
  | 'cron_last_error_at'
  | 'keyring_kcv'
  | 'credential_expiry_notices'
  | 'rollup_watermark';

export function clampSetting(key: keyof Settings, value: unknown): number {
  const { min, max } = SETTING_BOUNDS[key];
  const n = typeof value === 'number' && Number.isFinite(value) ? value : SETTING_DEFAULTS[key];
  return Math.min(max, Math.max(min, n));
}

export function settingsFromRows(rows: Array<{ key: string; value: string }>): Settings {
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const out = { ...SETTING_DEFAULTS };
  for (const key of Object.keys(SETTING_DEFAULTS) as Array<keyof Settings>) {
    const raw = stored.get(key);
    if (raw === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    out[key] = clampSetting(key, parsed);
  }
  return out;
}

export function settingsStatement(db: D1Database): D1PreparedStatement {
  return db
    .prepare(
      `SELECT key, value FROM settings WHERE key IN (${Object.keys(SETTING_DEFAULTS)
        .map(() => '?')
        .join(', ')})`,
    )
    .bind(...Object.keys(SETTING_DEFAULTS));
}

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await settingsStatement(db).all<{ key: string; value: string }>();
  return settingsFromRows(results);
}

type SettingKey =
  | keyof Settings
  | StateKey
  | JoinKey
  | typeof UPSTREAM_HOSTS_KEY
  | typeof ADMIN_HOSTS_KEY;
type SqlGuard = { sql: string; binds: unknown[] };

export function putSettingStatement(
  db: D1Database,
  key: SettingKey,
  value: unknown,
  now: number,
  updatedBy: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(key, JSON.stringify(value), now, updatedBy);
}

/** The stored value of `key` is still exactly `raw` (null: the key is absent). */
export function settingValueGuard(key: SettingKey, raw: string | null): SqlGuard {
  return { sql: '(SELECT value FROM settings WHERE key = ?) IS ?', binds: [key, raw] };
}

/** putSettingStatement that writes only while `guard` holds (read-modify-write of a list). */
export function putSettingGuardedStatement(
  db: D1Database,
  key: SettingKey,
  value: unknown,
  now: number,
  updatedBy: string | null,
  guard: SqlGuard,
): D1PreparedStatement {
  // The WHERE is required anyway: SQLite parses an upsert after INSERT … SELECT only with one.
  return db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) SELECT ?, ?, ?, ? WHERE (${guard.sql})
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(key, JSON.stringify(value), now, updatedBy, ...guard.binds);
}

export async function getState<T = unknown>(db: D1Database, key: StateKey): Promise<T | null> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

/**
 * Records the key check value of the KEK that just sealed the credential of `serviceId`, so /readyz
 * and the dashboard can detect key material replaced under the same kid (src/health.ts). A
 * different recorded value is kept while any other credential is sealed under the kid: those may
 * still need the old material, and overwriting would hide that they cannot be opened. Run it in
 * the batch that writes the credential. confirmKeyCheckValueStatement is the explicit overwrite.
 */
export function recordKeyCheckValueStatement(
  db: D1Database,
  kid: string,
  kcv: string,
  now: number,
  serviceId: string,
): D1PreparedStatement {
  // Nested CASE: SQLite evaluates CASE lazily, and json_extract() raises on malformed JSON.
  return db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('keyring_kcv', json_object(?1, ?2), ?3, NULL)
       ON CONFLICT (key) DO UPDATE SET value = json_set(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$."' || ?1 || '"', ?2), updated_at = ?3
       WHERE CASE WHEN json_valid(settings.value)
                  THEN COALESCE(json_extract(settings.value, '$."' || ?1 || '"') = ?2, 1)
                  ELSE 1 END
          OR NOT EXISTS (SELECT 1 FROM services WHERE id <> ?4 AND
               CASE WHEN json_valid(credential_sealed) THEN json_extract(credential_sealed, '$.kid') END = ?1)`,
    )
    .bind(kid, kcv, now, serviceId);
}

/**
 * Sets a kid's recorded key check value, only while it is still `previous` (null: none recorded).
 * For the explicit path that has just opened every credential sealed under the kid with the loaded
 * key (rewrapCredentials), which proves no credential needs the old material.
 */
export function confirmKeyCheckValueStatement(
  db: D1Database,
  kid: string,
  kcv: string,
  previous: string | null,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('keyring_kcv', json_object(?1, ?2), ?3, NULL)
       ON CONFLICT (key) DO UPDATE SET value = json_set(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$."' || ?1 || '"', ?2), updated_at = ?3
       WHERE (CASE WHEN json_valid(settings.value) THEN json_extract(settings.value, '$."' || ?1 || '"') END) IS ?4`,
    )
    .bind(kid, kcv, now, previous);
}
