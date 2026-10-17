// IssuerAccessRules repository. Writes take a SQL guard so the change and its audit row depend on the same
// predicate (I-AUDIT-1). Updates set updated_at = MAX(now, updated_at + 1), making it a version
// (grantVersionGuard).
import { canonicalJson } from '../lib/json';
import type { Condition, Rule } from '../policy/types';
import { grantFromRow } from './rows';
import type { IssuerAccessRule } from './types';

/** Boolean SQL expression plus its binds; evaluated as `... AND (sql)`. */
type SqlGuard = { sql: string; binds: unknown[] };

type Row = Record<string, unknown>;

export async function getIssuerAccessRule(
  db: D1Database,
  id: string,
): Promise<IssuerAccessRule | null> {
  const row = await db
    .prepare('SELECT * FROM issuer_access_rules WHERE id = ?')
    .bind(id)
    .first<Row>();
  return row ? grantFromRow(row) : null;
}

export interface IssuerAccessRuleFilter {
  service_id?: string;
  credential_access_rule_id?: string;
  enabled?: boolean;
}

/** IssuerAccessRules in evaluation order (created_at, id). */
export async function listIssuerAccessRules(
  db: D1Database,
  filter: IssuerAccessRuleFilter = {},
): Promise<IssuerAccessRule[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.service_id !== undefined) {
    where.push('service_id = ?');
    binds.push(filter.service_id);
  }
  if (filter.credential_access_rule_id !== undefined) {
    where.push('credential_access_rule_id = ?');
    binds.push(filter.credential_access_rule_id);
  }
  if (filter.enabled !== undefined) {
    where.push('enabled = ?');
    binds.push(filter.enabled ? 1 : 0);
  }
  const sql = `SELECT * FROM issuer_access_rules ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, id`;
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<Row>();
  return results.map(grantFromRow);
}

/** Number of issuer_access_rules per service id (all issuer_access_rules, enabled or not). */
export async function grantCountsByService(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db
    .prepare('SELECT service_id, count(*) AS count FROM issuer_access_rules GROUP BY service_id')
    .all<{ service_id: string; count: number }>();
  return new Map(results.map((row) => [row.service_id, Number(row.count)]));
}

/** Editable grant content. Credential access rule and service are fixed at creation. */
export interface IssuerAccessRuleValues {
  name: string;
  description: string;
  conditions: Condition[];
  rules: Rule[];
  enabled: boolean;
  expires_at: number | null;
}

/** Inserts only when `guard` holds (INSERT … SELECT … WHERE). */
export function insertIssuerAccessRuleStatement(
  db: D1Database,
  row: IssuerAccessRuleValues &
    Pick<
      IssuerAccessRule,
      'id' | 'credential_access_rule_id' | 'service_id' | 'created_by' | 'created_at'
    >,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO issuer_access_rules (id, name, description, credential_access_rule_id, service_id, conditions, rules,
         enabled, expires_at, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (${guard.sql})`,
    )
    .bind(
      row.id,
      row.name,
      row.description,
      row.credential_access_rule_id,
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

export function updateIssuerAccessRuleStatement(
  db: D1Database,
  id: string,
  values: IssuerAccessRuleValues,
  now: number,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE issuer_access_rules SET name = ?, description = ?, conditions = ?, rules = ?, enabled = ?, expires_at = ?,
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

export function deleteIssuerAccessRuleStatement(
  db: D1Database,
  id: string,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM issuer_access_rules WHERE id = ? AND (${guard.sql})`)
    .bind(id, ...guard.binds);
}

/** The grant row still has exactly this `updated_at` (optimistic concurrency). */
export function grantVersionGuard(grant: Pick<IssuerAccessRule, 'id' | 'updated_at'>): SqlGuard {
  return {
    sql: 'EXISTS (SELECT 1 FROM issuer_access_rules WHERE id = ? AND updated_at = ?)',
    binds: [grant.id, grant.updated_at],
  };
}

/** Changes only `enabled`, so a disable never overwrites a concurrent content edit. */
export function setIssuerAccessRuleEnabledStatement(
  db: D1Database,
  id: string,
  enabled: boolean,
  now: number,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE issuer_access_rules SET enabled = ?, updated_at = MAX(?, updated_at + 1) WHERE id = ? AND (${guard.sql})`,
    )
    .bind(enabled ? 1 : 0, now, id, ...guard.binds);
}

/** The grant row exists. */
export function grantExistsGuard(id: string): SqlGuard {
  return { sql: 'EXISTS (SELECT 1 FROM issuer_access_rules WHERE id = ?)', binds: [id] };
}

/**
 * Deletes the issuer_access_rules with these ids while `guard` holds (cascade deletes, see exactIssuerAccessRuleSetGuard).
 * The ids are one JSON bind: D1 allows at most 100 bound parameters per statement.
 */
export function deleteIssuerAccessRulesByIdsStatement(
  db: D1Database,
  ids: readonly string[],
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM issuer_access_rules WHERE id IN (SELECT value FROM json_each(?)) AND (${guard.sql})`,
    )
    .bind(JSON.stringify([...new Set(ids)]), ...guard.binds);
}

/**
 * The issuer_access_rules that reference `ownerId` (a service or a credential access rule) are exactly `ids`: none was
 * added or removed since the admin confirmed the list. A cascade delete carries it on every
 * statement, so it deletes exactly what the confirmation showed, or nothing. Its bind count is
 * fixed (the ids are one JSON array), whatever the number of issuer_access_rules.
 */
export function exactIssuerAccessRuleSetGuard(
  column: 'service_id' | 'credential_access_rule_id',
  ownerId: string,
  ids: readonly string[],
): SqlGuard {
  if (column !== 'service_id' && column !== 'credential_access_rule_id') {
    throw new Error(`exactIssuerAccessRuleSetGuard: unknown column ${String(column)}`);
  }
  const unique = JSON.stringify([...new Set(ids)]);
  return {
    sql: `(SELECT count(*) FROM issuer_access_rules WHERE ${column} = ?) = json_array_length(?)
      AND NOT EXISTS (SELECT 1 FROM issuer_access_rules WHERE ${column} = ?
        AND id NOT IN (SELECT value FROM json_each(?)))`,
    binds: [ownerId, unique, ownerId, unique],
  };
}
