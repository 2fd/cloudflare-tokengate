// Grants repository. Writes take a SQL guard so the change and its audit row depend on the same
// predicate (I-AUDIT-1). Updates set updated_at = MAX(now, updated_at + 1), making it a version
// (grantVersionGuard).
import { canonicalJson } from '../lib/json';
import type { Condition, Rule } from '../policy/types';
import { grantFromRow } from './rows';
import type { Grant } from './types';

/** Boolean SQL expression plus its binds; evaluated as `... AND (sql)`. */
type SqlGuard = { sql: string; binds: unknown[] };

type Row = Record<string, unknown>;

export async function getGrant(db: D1Database, id: string): Promise<Grant | null> {
  const row = await db.prepare('SELECT * FROM grants WHERE id = ?').bind(id).first<Row>();
  return row ? grantFromRow(row) : null;
}

export interface GrantFilter {
  service_id?: string;
  caller_provider_id?: string;
  enabled?: boolean;
}

/** Grants in evaluation order (created_at, id). */
export async function listGrants(db: D1Database, filter: GrantFilter = {}): Promise<Grant[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.service_id !== undefined) {
    where.push('service_id = ?');
    binds.push(filter.service_id);
  }
  if (filter.caller_provider_id !== undefined) {
    where.push('caller_provider_id = ?');
    binds.push(filter.caller_provider_id);
  }
  if (filter.enabled !== undefined) {
    where.push('enabled = ?');
    binds.push(filter.enabled ? 1 : 0);
  }
  const sql = `SELECT * FROM grants ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, id`;
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<Row>();
  return results.map(grantFromRow);
}

/** Number of grants per service id (all grants, enabled or not). */
export async function grantCountsByService(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db
    .prepare('SELECT service_id, count(*) AS count FROM grants GROUP BY service_id')
    .all<{ service_id: string; count: number }>();
  return new Map(results.map((row) => [row.service_id, Number(row.count)]));
}

/** Editable grant content. Caller provider and service are fixed at creation. */
export interface GrantValues {
  name: string;
  description: string;
  conditions: Condition[];
  rules: Rule[];
  enabled: boolean;
  expires_at: number | null;
}

/** Inserts only when `guard` holds (INSERT … SELECT … WHERE). */
export function insertGrantStatement(
  db: D1Database,
  row: GrantValues &
    Pick<Grant, 'id' | 'caller_provider_id' | 'service_id' | 'created_by' | 'created_at'>,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO grants (id, name, description, caller_provider_id, service_id, conditions, rules,
         enabled, expires_at, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (${guard.sql})`,
    )
    .bind(
      row.id,
      row.name,
      row.description,
      row.caller_provider_id,
      row.service_id,
      canonicalJson(row.conditions),
      canonicalJson(row.rules),
      row.enabled ? 1 : 0,
      row.expires_at,
      row.created_by,
      row.created_at,
      row.created_at,
      ...guard.binds,
    );
}

export function updateGrantStatement(
  db: D1Database,
  id: string,
  values: GrantValues,
  now: number,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE grants SET name = ?, description = ?, conditions = ?, rules = ?, enabled = ?, expires_at = ?,
         updated_at = MAX(?, updated_at + 1)
       WHERE id = ? AND (${guard.sql})`,
    )
    .bind(
      values.name,
      values.description,
      canonicalJson(values.conditions),
      canonicalJson(values.rules),
      values.enabled ? 1 : 0,
      values.expires_at,
      now,
      id,
      ...guard.binds,
    );
}

export function deleteGrantStatement(
  db: D1Database,
  id: string,
  guard: SqlGuard,
): D1PreparedStatement {
  return db.prepare(`DELETE FROM grants WHERE id = ? AND (${guard.sql})`).bind(id, ...guard.binds);
}

/** The grant row still has exactly this `updated_at` (optimistic concurrency). */
export function grantVersionGuard(grant: Pick<Grant, 'id' | 'updated_at'>): SqlGuard {
  return {
    sql: 'EXISTS (SELECT 1 FROM grants WHERE id = ? AND updated_at = ?)',
    binds: [grant.id, grant.updated_at],
  };
}

/** Changes only `enabled`, so a disable never overwrites a concurrent content edit. */
export function setGrantEnabledStatement(
  db: D1Database,
  id: string,
  enabled: boolean,
  now: number,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE grants SET enabled = ?, updated_at = MAX(?, updated_at + 1) WHERE id = ? AND (${guard.sql})`,
    )
    .bind(enabled ? 1 : 0, now, id, ...guard.binds);
}

/** The grant row exists. */
export function grantExistsGuard(id: string): SqlGuard {
  return { sql: 'EXISTS (SELECT 1 FROM grants WHERE id = ?)', binds: [id] };
}
