// Services repository. Writes take a SQL guard so the change and its audit row depend on the same
// predicate (I-AUDIT-1); only the credential statement writes base_url and injection, always with a
// new seal (I-CRED-2). Guarded updates set updated_at = MAX(now, updated_at + 1), making it a version.
import { canonicalJson } from '../lib/json';
import type { VerifyCheck } from '../policy/types';
import { serviceFromRow } from './rows';
import type { Service } from './types';

/** Boolean SQL expression plus its binds; evaluated as `... AND (sql)`. */
type SqlGuard = { sql: string; binds: unknown[] };

type Row = Record<string, unknown>;

export async function getService(db: D1Database, id: string): Promise<Service | null> {
  const row = await db.prepare('SELECT * FROM services WHERE id = ?').bind(id).first<Row>();
  return row ? serviceFromRow(row) : null;
}

export async function getServiceBySlug(db: D1Database, slug: string): Promise<Service | null> {
  const row = await db.prepare('SELECT * FROM services WHERE slug = ?').bind(slug).first<Row>();
  return row ? serviceFromRow(row) : null;
}

export async function listServices(db: D1Database): Promise<Service[]> {
  const { results } = await db.prepare('SELECT * FROM services ORDER BY slug').all<Row>();
  return results.map(serviceFromRow);
}

/** Column values of a new service row. `injection_json` is stored verbatim (it is part of the AAD). */
export interface NewServiceRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  base_url: string;
  injection_json: string;
  forward_headers: string[];
  timeout_ms: number;
  credential_sealed: string | null;
  credential_hint: string | null;
  credential_updated_at: number | null;
  credential_expires_at: number | null;
  verify: VerifyCheck | null;
  /** Display and preset data only (templateIdFor), never part of the AAD. */
  template_id: string | null;
  enabled: boolean;
  created_at: number;
}

export function insertServiceStatement(db: D1Database, row: NewServiceRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO services (id, slug, name, description, base_url, injection, forward_headers, timeout_ms,
         credential_sealed, credential_hint, credential_updated_at, credential_expires_at, verify,
         template_id, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.slug,
      row.name,
      row.description,
      row.base_url,
      row.injection_json,
      JSON.stringify(row.forward_headers),
      row.timeout_ms,
      row.credential_sealed,
      row.credential_hint,
      row.credential_updated_at,
      row.credential_expires_at,
      verifyJson(row.verify),
      row.template_id,
      row.enabled ? 1 : 0,
      row.created_at,
      row.created_at,
    );
}

/** Fields that do not take part in the credential binding. */
export interface ServiceFields {
  name: string;
  description: string;
  forward_headers: string[];
  timeout_ms: number;
  verify: VerifyCheck | null;
  enabled: boolean;
  credential_expires_at: number | null;
}

export function updateServiceFieldsStatement(
  db: D1Database,
  id: string,
  fields: ServiceFields,
  now: number,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE services SET name = ?, description = ?, forward_headers = ?, timeout_ms = ?, verify = ?,
         enabled = ?, credential_expires_at = ?, updated_at = MAX(?, updated_at + 1)
       WHERE id = ? AND (${guard.sql})`,
    )
    .bind(
      fields.name,
      fields.description,
      JSON.stringify(fields.forward_headers),
      fields.timeout_ms,
      verifyJson(fields.verify),
      fields.enabled ? 1 : 0,
      fields.credential_expires_at,
      now,
      id,
      ...guard.binds,
    );
}

/** Changes only `enabled`, so disabling never depends on the other stored fields being valid. */
export function setServiceEnabledStatement(
  db: D1Database,
  id: string,
  enabled: boolean,
  now: number,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE services SET enabled = ?, updated_at = MAX(?, updated_at + 1) WHERE id = ? AND (${guard.sql})`,
    )
    .bind(enabled ? 1 : 0, now, id, ...guard.binds);
}

/** The binding fields and the credential sealed for exactly these values. */
export interface ServiceCredentialValues {
  base_url: string;
  injection_json: string;
  credential_sealed: string;
  credential_hint: string | null;
  credential_expires_at: number | null;
  /** Recomputed from the new destination on every credential save (templateIdFor). */
  template_id: string | null;
}

export function updateServiceCredentialStatement(
  db: D1Database,
  id: string,
  values: ServiceCredentialValues,
  now: number,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE services SET base_url = ?, injection = ?, credential_sealed = ?, credential_hint = ?,
         credential_updated_at = ?, credential_expires_at = ?, template_id = ?,
         updated_at = MAX(?, updated_at + 1)
       WHERE id = ? AND (${guard.sql})`,
    )
    .bind(
      values.base_url,
      values.injection_json,
      values.credential_sealed,
      values.credential_hint,
      now,
      values.credential_expires_at,
      values.template_id,
      now,
      id,
      ...guard.binds,
    );
}

/** Rewrap compare-and-swap: replaces the sealed value only if it is still `oldSealed`. */
export function rewrapCredentialStatement(
  db: D1Database,
  id: string,
  newSealed: string,
  oldSealed: string,
): D1PreparedStatement {
  return db
    .prepare('UPDATE services SET credential_sealed = ? WHERE id = ? AND credential_sealed = ?')
    .bind(newSealed, id, oldSealed);
}

export function deleteServiceStatement(
  db: D1Database,
  id: string,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM services WHERE id = ? AND (${guard.sql})`)
    .bind(id, ...guard.binds);
}

/** The service row still has exactly this `updated_at` (optimistic concurrency). */
export function serviceVersionGuard(service: Pick<Service, 'id' | 'updated_at'>): SqlGuard {
  return {
    sql: 'EXISTS (SELECT 1 FROM services WHERE id = ? AND updated_at = ?)',
    binds: [service.id, service.updated_at],
  };
}

/** The binding fields and sealed credential are unchanged since `service` was read. */
export function serviceCredentialGuard(
  service: Pick<Service, 'id' | 'base_url' | 'injection_json' | 'credential_sealed'>,
): SqlGuard {
  return {
    sql: 'EXISTS (SELECT 1 FROM services WHERE id = ? AND base_url = ? AND injection = ? AND credential_sealed IS ?)',
    binds: [service.id, service.base_url, service.injection_json, service.credential_sealed],
  };
}

/** The service exists and no grant references it (grants are deleted first). */
export function serviceUnreferencedGuard(id: string): SqlGuard {
  return {
    sql: 'EXISTS (SELECT 1 FROM services WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM grants WHERE service_id = ?)',
    binds: [id, id],
  };
}

/** Rows needed to open, re-seal or count sealed credentials. */
export interface SealedCredentialRow {
  id: string;
  slug: string;
  base_url: string;
  injection_json: string;
  credential_sealed: string;
}

export async function listSealedCredentials(db: D1Database): Promise<SealedCredentialRow[]> {
  const { results } = await db
    .prepare(
      'SELECT id, slug, base_url, injection, credential_sealed FROM services WHERE credential_sealed IS NOT NULL ORDER BY slug',
    )
    .all<{
      id: string;
      slug: string;
      base_url: string;
      injection: string;
      credential_sealed: string;
    }>();
  return results.map((row) => ({
    id: row.id,
    slug: row.slug,
    base_url: row.base_url,
    injection_json: row.injection,
    credential_sealed: row.credential_sealed,
  }));
}

/**
 * Number of sealed credentials per key id. `kid` is null for values that are not JSON or have no
 * string `kid` (they cannot be opened).
 */
export async function credentialCountsByKid(
  db: D1Database,
): Promise<Array<{ kid: string | null; count: number }>> {
  // JSON functions raise on malformed JSON; the outer CASE guarantees json_valid runs first.
  const { results } = await db
    .prepare(
      `SELECT CASE WHEN json_valid(credential_sealed) THEN
                CASE WHEN json_type(credential_sealed, '$.kid') = 'text'
                     THEN json_extract(credential_sealed, '$.kid') END
              END AS kid,
              count(*) AS count
       FROM services WHERE credential_sealed IS NOT NULL GROUP BY 1 ORDER BY 1`,
    )
    .all<{ kid: string | null; count: number }>();
  return results.map((row) => ({ kid: row.kid, count: Number(row.count) }));
}

function verifyJson(verify: VerifyCheck | null): string | null {
  return verify === null ? null : canonicalJson(verify);
}

/** The service row exists. */
export function serviceExistsGuard(id: string): SqlGuard {
  return { sql: 'EXISTS (SELECT 1 FROM services WHERE id = ?)', binds: [id] };
}
