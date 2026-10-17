// Credential access rules repository. Writes take a SQL guard so the change and its audit row depend on the
// same predicate (I-AUDIT-1). Updates set updated_at = MAX(now, updated_at + 1), making it a version
// (credentialAccessRuleVersionGuard).
import { canonicalJson } from '../lib/json';
import type { Condition } from '../policy/types';
import { credentialAccessRuleFromRow } from './rows';
import type { CredentialAccessRule, IssuerAccessRule } from './types';

/** Boolean SQL expression plus its binds; evaluated as `... AND (sql)`. */
type SqlGuard = { sql: string; binds: unknown[] };

type Row = Record<string, unknown>;

export async function getCredentialAccessRule(
  db: D1Database,
  id: string,
): Promise<CredentialAccessRule | null> {
  const row = await db
    .prepare('SELECT * FROM credential_access_rules WHERE id = ?')
    .bind(id)
    .first<Row>();
  return row ? credentialAccessRuleFromRow(row) : null;
}

export async function listCredentialAccessRules(db: D1Database): Promise<CredentialAccessRule[]> {
  const { results } = await db
    .prepare('SELECT * FROM credential_access_rules ORDER BY name')
    .all<Row>();
  return results.map(credentialAccessRuleFromRow);
}

/** Trust configuration of a credential access rule (everything except identity and bookkeeping). */
export interface CredentialAccessRuleValues {
  credential_id: string;
  conditions: Condition[];
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

export function insertCredentialAccessRuleStatement(
  db: D1Database,
  row: CredentialAccessRuleValues & Pick<CredentialAccessRule, 'id' | 'profile' | 'created_at'>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO credential_access_rules (id, credential_id, conditions, name, profile, issuer, jwks_uri, audience, allowed_algs,
         max_token_age_seconds, tenant_pin, anchor_claims, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.credential_id,
      canonicalJson(row.conditions),
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
export function updateCredentialAccessRuleStatement(
  db: D1Database,
  id: string,
  values: CredentialAccessRuleValues,
  now: number,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE credential_access_rules SET conditions = ?, name = ?, issuer = ?, jwks_uri = ?, audience = ?, allowed_algs = ?,
         max_token_age_seconds = ?, tenant_pin = ?, anchor_claims = ?, enabled = ?, updated_at = MAX(?, updated_at + 1)
       WHERE id = ? AND (${guard.sql})`,
    )
    .bind(
      canonicalJson(values.conditions),
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
export function setCredentialAccessRuleEnabledStatement(
  db: D1Database,
  id: string,
  enabled: boolean,
  now: number,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE credential_access_rules SET enabled = ?, updated_at = MAX(?, updated_at + 1) WHERE id = ? AND (${guard.sql})`,
    )
    .bind(enabled ? 1 : 0, now, id, ...guard.binds);
}

export function deleteCredentialAccessRuleStatement(
  db: D1Database,
  id: string,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM credential_access_rules WHERE id = ? AND (${guard.sql})`)
    .bind(id, ...guard.binds);
}

/** The credential access rule row still has exactly this `updated_at` (optimistic concurrency). */
export function credentialAccessRuleVersionGuard(
  provider: Pick<CredentialAccessRule, 'id' | 'updated_at'>,
): SqlGuard {
  return {
    sql: 'EXISTS (SELECT 1 FROM credential_access_rules WHERE id = ? AND updated_at = ?)',
    binds: [provider.id, provider.updated_at],
  };
}

/** The credential access rule row exists. */
export function credentialAccessRuleExistsGuard(id: string): SqlGuard {
  return { sql: 'EXISTS (SELECT 1 FROM credential_access_rules WHERE id = ?)', binds: [id] };
}

/** No enabled grant uses the credential access rule; required for an unconfirmed trust change. */
export function credentialAccessRuleWithoutEnabledIssuerAccessRulesGuard(id: string): SqlGuard {
  return {
    sql: 'NOT EXISTS (SELECT 1 FROM issuer_access_rules WHERE credential_access_rule_id = ? AND enabled = 1)',
    binds: [id],
  };
}

/**
 * Every enabled grant of the credential access rule is one of `issuer_access_rules`, at the same version: no grant was
 * enabled or edited after the credential access rule update validated them (I-AUTHZ-2).
 */
export function credentialAccessRuleEnabledIssuerAccessRulesUnchangedGuard(
  id: string,
  issuer_access_rules: ReadonlyArray<Pick<IssuerAccessRule, 'id' | 'updated_at'>>,
): SqlGuard {
  return {
    sql: `NOT EXISTS (SELECT 1 FROM issuer_access_rules WHERE credential_access_rule_id = ? AND enabled = 1
            AND id || '@' || updated_at NOT IN (SELECT value FROM json_each(?)))`,
    binds: [
      id,
      JSON.stringify(issuer_access_rules.map((grant) => `${grant.id}@${grant.updated_at}`)),
    ],
  };
}

/**
 * Defers foreign key checks to the end of the batch's transaction (D1 runs a batch as one
 * transaction and resets the pragma after it). A cascade delete uses it to delete the caller
 * provider before its issuer_access_rules, so every statement still sees the grant set its guard checks.
 */
export function deferForeignKeysStatement(db: D1Database): D1PreparedStatement {
  return db.prepare('PRAGMA defer_foreign_keys = on');
}

/** The credential access rule exists and no grant references it (issuer_access_rules are deleted first). */
export function credentialAccessRuleUnreferencedGuard(id: string): SqlGuard {
  return {
    sql: 'EXISTS (SELECT 1 FROM credential_access_rules WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM issuer_access_rules WHERE credential_access_rule_id = ?)',
    binds: [id, id],
  };
}
