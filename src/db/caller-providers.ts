// Caller providers repository. Writes take a SQL guard so the change and its audit row depend on the
// same predicate (I-AUDIT-1). Updates set updated_at = MAX(now, updated_at + 1), making it a version
// (callerProviderVersionGuard).
import { canonicalJson } from '../lib/json';
import type { Condition } from '../policy/types';
import { callerProviderFromRow } from './rows';
import type { CallerProvider, Grant } from './types';

/** Boolean SQL expression plus its binds; evaluated as `... AND (sql)`. */
type SqlGuard = { sql: string; binds: unknown[] };

type Row = Record<string, unknown>;

export async function getCallerProvider(
  db: D1Database,
  id: string,
): Promise<CallerProvider | null> {
  const row = await db.prepare('SELECT * FROM caller_providers WHERE id = ?').bind(id).first<Row>();
  return row ? callerProviderFromRow(row) : null;
}

export async function listCallerProviders(db: D1Database): Promise<CallerProvider[]> {
  const { results } = await db.prepare('SELECT * FROM caller_providers ORDER BY name').all<Row>();
  return results.map(callerProviderFromRow);
}

/** Trust configuration of a caller provider (everything except identity and bookkeeping). */
export interface CallerProviderValues {
  name: string;
  issuer: string;
  jwks_uri: string;
  audience: string;
  allowed_algs: string[];
  max_token_age_seconds: number;
  tenant_pin: Condition[];
  anchor_claims: string[];
  enabled: boolean;
}

export function insertCallerProviderStatement(
  db: D1Database,
  row: CallerProviderValues & Pick<CallerProvider, 'id' | 'profile' | 'created_at'>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO caller_providers (id, name, profile, issuer, jwks_uri, audience, allowed_algs,
         max_token_age_seconds, tenant_pin, anchor_claims, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.name,
      row.profile,
      row.issuer,
      row.jwks_uri,
      row.audience,
      JSON.stringify(row.allowed_algs),
      row.max_token_age_seconds,
      canonicalJson(row.tenant_pin),
      JSON.stringify(row.anchor_claims),
      row.enabled ? 1 : 0,
      row.created_at,
      row.created_at,
    );
}

/** Updates everything but `profile`, which is immutable after creation. */
export function updateCallerProviderStatement(
  db: D1Database,
  id: string,
  values: CallerProviderValues,
  now: number,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE caller_providers SET name = ?, issuer = ?, jwks_uri = ?, audience = ?, allowed_algs = ?,
         max_token_age_seconds = ?, tenant_pin = ?, anchor_claims = ?, enabled = ?, updated_at = MAX(?, updated_at + 1)
       WHERE id = ? AND (${guard.sql})`,
    )
    .bind(
      values.name,
      values.issuer,
      values.jwks_uri,
      values.audience,
      JSON.stringify(values.allowed_algs),
      values.max_token_age_seconds,
      canonicalJson(values.tenant_pin),
      JSON.stringify(values.anchor_claims),
      values.enabled ? 1 : 0,
      now,
      id,
      ...guard.binds,
    );
}

/** Changes only `enabled`, so disabling never depends on the other stored fields being valid. */
export function setCallerProviderEnabledStatement(
  db: D1Database,
  id: string,
  enabled: boolean,
  now: number,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE caller_providers SET enabled = ?, updated_at = MAX(?, updated_at + 1) WHERE id = ? AND (${guard.sql})`,
    )
    .bind(enabled ? 1 : 0, now, id, ...guard.binds);
}

export function deleteCallerProviderStatement(
  db: D1Database,
  id: string,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM caller_providers WHERE id = ? AND (${guard.sql})`)
    .bind(id, ...guard.binds);
}

/** The caller provider row still has exactly this `updated_at` (optimistic concurrency). */
export function callerProviderVersionGuard(
  provider: Pick<CallerProvider, 'id' | 'updated_at'>,
): SqlGuard {
  return {
    sql: 'EXISTS (SELECT 1 FROM caller_providers WHERE id = ? AND updated_at = ?)',
    binds: [provider.id, provider.updated_at],
  };
}

/** The caller provider row exists. */
export function callerProviderExistsGuard(id: string): SqlGuard {
  return { sql: 'EXISTS (SELECT 1 FROM caller_providers WHERE id = ?)', binds: [id] };
}

/** No enabled grant uses the caller provider; required for an unconfirmed trust change. */
export function callerProviderWithoutEnabledGrantsGuard(id: string): SqlGuard {
  return {
    sql: 'NOT EXISTS (SELECT 1 FROM grants WHERE caller_provider_id = ? AND enabled = 1)',
    binds: [id],
  };
}

/**
 * Every enabled grant of the caller provider is one of `grants`, at the same version: no grant was
 * enabled or edited after the caller provider update validated them (I-AUTHZ-2).
 */
export function callerProviderEnabledGrantsUnchangedGuard(
  id: string,
  grants: ReadonlyArray<Pick<Grant, 'id' | 'updated_at'>>,
): SqlGuard {
  return {
    sql: `NOT EXISTS (SELECT 1 FROM grants WHERE caller_provider_id = ? AND enabled = 1
            AND id || '@' || updated_at NOT IN (SELECT value FROM json_each(?)))`,
    binds: [id, JSON.stringify(grants.map((grant) => `${grant.id}@${grant.updated_at}`))],
  };
}

/** The caller provider exists and no grant references it (grants are deleted first). */
export function callerProviderUnreferencedGuard(id: string): SqlGuard {
  return {
    sql: 'EXISTS (SELECT 1 FROM caller_providers WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM grants WHERE caller_provider_id = ?)',
    binds: [id, id],
  };
}
