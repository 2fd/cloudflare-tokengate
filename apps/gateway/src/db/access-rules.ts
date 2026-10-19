// Access rules repository: credential access rules and global access rules in one table (ADR 0026).
// Writes take a SQL guard so the change and its audit row depend on the same predicate (I-AUDIT-1).
// Updates set updated_at = MAX(now, updated_at + 1), making it a version (accessRuleUnchangedGuard).
// Every write of `issuer` also writes `issuer_key = issuerKey(issuer)`; a CHECK refuses a row where
// the JS key and the SQL key differ (AR-3).
import { canonicalJson } from '../lib/json';
import { issuerKey } from '../policy/limits';
import type { Condition, Rule } from '../policy/types';
import { accessRuleFromRow } from './rows';
import type { AccessRuleRow, CredentialAccessRule, GlobalAccessRule } from './types';

/** Boolean SQL expression plus its binds; evaluated as `... AND (sql)`. */
type SqlGuard = { sql: string; binds: unknown[] };

type Row = Record<string, unknown>;

/** At most this many credential access rules per credential (trigger `access_rules_credential_cap`). */
export const CREDENTIAL_RULES_MAX = 100;
/** At most this many global access rules per issuer key (trigger `access_rules_global_cap`). */
export const GLOBAL_RULES_MAX = 20;

export async function getAccessRuleRow(db: D1Database, id: string): Promise<AccessRuleRow | null> {
  const row = await db.prepare('SELECT * FROM access_rules WHERE id = ?').bind(id).first<Row>();
  return row ? accessRuleFromRow(row) : null;
}

export async function getCredentialAccessRule(
  db: D1Database,
  id: string,
): Promise<CredentialAccessRule | null> {
  const rule = await getAccessRuleRow(db, id);
  return rule?.kind === 'credential' ? rule : null;
}

export async function getGlobalAccessRule(
  db: D1Database,
  id: string,
): Promise<GlobalAccessRule | null> {
  const rule = await getAccessRuleRow(db, id);
  return rule?.kind === 'global' ? rule : null;
}

export interface CredentialAccessRuleFilter {
  credential_id?: string;
  issuer_key?: string;
  enabled?: boolean;
}

/** Credential access rules in evaluation order (created_at, id). */
export async function listCredentialAccessRules(
  db: D1Database,
  filter: CredentialAccessRuleFilter = {},
): Promise<CredentialAccessRule[]> {
  const where = ['credential_id IS NOT NULL'];
  const binds: unknown[] = [];
  if (filter.credential_id !== undefined) {
    where.push('credential_id = ?');
    binds.push(filter.credential_id);
  }
  if (filter.issuer_key !== undefined) {
    where.push('issuer_key = ?');
    binds.push(filter.issuer_key);
  }
  if (filter.enabled !== undefined) {
    where.push('enabled = ?');
    binds.push(filter.enabled ? 1 : 0);
  }
  const { results } = await db
    .prepare(`SELECT * FROM access_rules WHERE ${where.join(' AND ')} ORDER BY created_at, id`)
    .bind(...binds)
    .all<Row>();
  return credentialRules(results.map(accessRuleFromRow));
}

/** Global access rules in every state, in evaluation order (created_at, id). */
export async function listGlobalAccessRules(
  db: D1Database,
  filter: { issuer_key?: string } = {},
): Promise<GlobalAccessRule[]> {
  const statement =
    filter.issuer_key === undefined
      ? db.prepare('SELECT * FROM access_rules WHERE credential_id IS NULL ORDER BY created_at, id')
      : db
          .prepare(
            'SELECT * FROM access_rules WHERE credential_id IS NULL AND issuer_key = ? ORDER BY created_at, id',
          )
          .bind(filter.issuer_key);
  const { results } = await statement.all<Row>();
  return globalRules(results.map(accessRuleFromRow));
}

export function credentialRules(rows: readonly AccessRuleRow[]): CredentialAccessRule[] {
  return rows.filter((row): row is CredentialAccessRule => row.kind === 'credential');
}

export function globalRules(rows: readonly AccessRuleRow[]): GlobalAccessRule[] {
  return rows.filter((row): row is GlobalAccessRule => row.kind === 'global');
}

/** Number of credential access rules per credential id (enabled or not). */
export async function ruleCountsByCredential(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      'SELECT credential_id, count(*) AS count FROM access_rules WHERE credential_id IS NOT NULL GROUP BY credential_id',
    )
    .all<{ credential_id: string; count: number }>();
  return new Map(results.map((row) => [row.credential_id, Number(row.count)]));
}

/**
 * Editable content of an access rule of either kind. A global access rule stores null for "no
 * limit"; a credential access rule sets every limit. `credential_id` and `profile` never change.
 */
export interface AccessRuleValues {
  name: string;
  description: string;
  issuer: string;
  jwks_uri: string | null;
  audience: string | null;
  allowed_algs: string[] | null;
  max_token_age_seconds: number | null;
  tenant_pin: Condition[] | null;
  anchor_claims: string[] | null;
  conditions: Condition[] | null;
  rules: Rule[] | null;
  enabled: boolean;
  expires_at: number | null;
}

const json = (value: unknown): string | null => (value === null ? null : canonicalJson(value));

function valueBinds(values: AccessRuleValues): unknown[] {
  return [
    values.name,
    values.description,
    values.issuer,
    issuerKey(values.issuer),
    values.jwks_uri,
    values.audience,
    values.allowed_algs === null ? null : JSON.stringify(values.allowed_algs),
    values.max_token_age_seconds,
    json(values.tenant_pin),
    values.anchor_claims === null ? null : JSON.stringify(values.anchor_claims),
    json(values.conditions),
    json(values.rules),
    values.enabled ? 1 : 0,
    values.expires_at,
  ];
}

/** Inserts only when `guard` holds (INSERT … SELECT … WHERE). */
export function insertAccessRuleStatement(
  db: D1Database,
  row: AccessRuleValues &
    Pick<AccessRuleRow, 'id' | 'credential_id' | 'profile' | 'created_by' | 'created_at'>,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO access_rules (id, credential_id, profile, name, description, issuer, issuer_key, jwks_uri,
         audience, allowed_algs, max_token_age_seconds, tenant_pin, anchor_claims, conditions, rules, enabled,
         expires_at, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (${guard.sql})`,
    )
    .bind(
      row.id,
      row.credential_id,
      row.profile,
      ...valueBinds(row),
      row.created_by,
      row.created_at,
      row.created_at,
      ...guard.binds,
    );
}

/** Updates everything but the id, the kind, the credential and the profile, which never change. */
export function updateAccessRuleStatement(
  db: D1Database,
  id: string,
  values: AccessRuleValues,
  now: number,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE access_rules SET name = ?, description = ?, issuer = ?, issuer_key = ?, jwks_uri = ?, audience = ?,
         allowed_algs = ?, max_token_age_seconds = ?, tenant_pin = ?, anchor_claims = ?, conditions = ?, rules = ?,
         enabled = ?, expires_at = ?, updated_at = MAX(?, updated_at + 1)
       WHERE id = ? AND (${guard.sql})`,
    )
    .bind(...valueBinds(values), now, id, ...guard.binds);
}

/** Changes only `enabled`, so a disable never depends on, or overwrites, the other stored fields. */
export function setAccessRuleEnabledStatement(
  db: D1Database,
  id: string,
  enabled: boolean,
  now: number,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE access_rules SET enabled = ?, updated_at = MAX(?, updated_at + 1) WHERE id = ? AND (${guard.sql})`,
    )
    .bind(enabled ? 1 : 0, now, id, ...guard.binds);
}

/** Deletes the rule; its claim labels cascade. */
export function deleteAccessRuleStatement(
  db: D1Database,
  id: string,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM access_rules WHERE id = ? AND (${guard.sql})`)
    .bind(id, ...guard.binds);
}

/** The rule still has exactly this `updated_at` (optimistic concurrency). */
export function accessRuleUnchangedGuard(id: string, updatedAt: number): SqlGuard {
  return {
    sql: 'EXISTS (SELECT 1 FROM access_rules WHERE id = ? AND updated_at = ?)',
    binds: [id, updatedAt],
  };
}

/** The rule exists. */
export function accessRuleExistsGuard(id: string): SqlGuard {
  return { sql: 'EXISTS (SELECT 1 FROM access_rules WHERE id = ?)', binds: [id] };
}

/**
 * Another global access rule of the issuer key exists, so deleting `id` is not the last delete
 * (AR-7): two concurrent unconfirmed deletes cannot both pass.
 */
export function otherGlobalRuleExistsGuard(key: string, id: string): SqlGuard {
  return {
    sql: 'EXISTS (SELECT 1 FROM access_rules WHERE credential_id IS NULL AND issuer_key = ? AND id <> ?)',
    binds: [key, id],
  };
}

/** The issuer key has no global access rule: an unconfirmed create stays the first ceiling (AR-21). */
export function noGlobalRuleGuard(key: string): SqlGuard {
  return {
    sql: 'NOT EXISTS (SELECT 1 FROM access_rules WHERE credential_id IS NULL AND issuer_key = ?)',
    binds: [key],
  };
}

/**
 * Another enabled global access rule of the issuer key exists, so disabling `id` is not the last
 * disable: an unconfirmed disable never leaves the issuer admitting nothing.
 */
export function otherEnabledGlobalRuleGuard(key: string, id: string): SqlGuard {
  return {
    sql: 'EXISTS (SELECT 1 FROM access_rules WHERE credential_id IS NULL AND issuer_key = ? AND id <> ? AND enabled = 1)',
    binds: [key, id],
  };
}

/**
 * The credential access rules of `credentialId` are exactly `ids`: none was added or removed since
 * the admin confirmed the list. A credential delete carries it, so it deletes exactly what the
 * confirmation showed, or nothing. Its bind count is fixed (the ids are one JSON array).
 */
export function exactCredentialRuleSetGuard(
  credentialId: string,
  ids: readonly string[],
): SqlGuard {
  const unique = JSON.stringify([...new Set(ids)]);
  return {
    sql: `(SELECT count(*) FROM access_rules WHERE credential_id = ?) = json_array_length(?)
      AND NOT EXISTS (SELECT 1 FROM access_rules WHERE credential_id = ?
        AND id NOT IN (SELECT value FROM json_each(?)))`,
    binds: [credentialId, unique, credentialId, unique],
  };
}

/** The credential exists and has no credential access rule. */
export function noCredentialRulesGuard(credentialId: string): SqlGuard {
  return {
    sql: 'EXISTS (SELECT 1 FROM credentials WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM access_rules WHERE credential_id = ?)',
    binds: [credentialId, credentialId],
  };
}
