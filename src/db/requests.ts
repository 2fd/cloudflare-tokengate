// request_log reads and writes (TELEMETRY_DB). Inserts are INSERT OR IGNORE keyed by the request
// id, so queue redelivery and the queue-to-direct fallback never duplicate a record.
import { type Outcome, REQUEST_RECORD_COLUMNS, type RequestRecord } from '../telemetry/types';

/** D1 allows at most 100 bound parameters per statement. */
const MAX_BOUND_PARAMETERS = 100;
export const RECORDS_PER_INSERT = Math.floor(MAX_BOUND_PARAMETERS / REQUEST_RECORD_COLUMNS.length);

const INSERT_PREFIX = `INSERT OR IGNORE INTO request_log (${REQUEST_RECORD_COLUMNS.join(', ')}) VALUES `;
const ROW_PLACEHOLDERS = `(${REQUEST_RECORD_COLUMNS.map(() => '?').join(', ')})`;

/** Multi-row inserts, RECORDS_PER_INSERT rows each. Run them together in one db.batch(). */
export function insertRequestRecordsStatements(
  db: D1Database,
  records: readonly RequestRecord[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < records.length; start += RECORDS_PER_INSERT) {
    const chunk = records.slice(start, start + RECORDS_PER_INSERT);
    const sql = INSERT_PREFIX + chunk.map(() => ROW_PLACEHOLDERS).join(', ');
    const values = chunk.flatMap((record) =>
      REQUEST_RECORD_COLUMNS.map((column) => record[column]),
    );
    statements.push(db.prepare(sql).bind(...values));
  }
  return statements;
}

export interface RequestFilter {
  service_id?: string;
  outcome?: Outcome;
  /** Exact caller_repository. */
  repository?: string;
  /** Exact service_slug. */
  slug?: string;
  /** Keyset pagination: only ids lower (older) than this. */
  before?: string;
  /** Page size, 1..200 (default 50). */
  limit?: number;
}

export const DEFAULT_REQUEST_PAGE_SIZE = 50;
const MAX_REQUEST_PAGE_SIZE = 200;
/**
 * Rows one filtered page may examine when no index serves the filter (outcome, service slug, or
 * service and repository together). Bounds the D1 rows read per page load to about twice this,
 * whatever the table size.
 */
export const REQUEST_SCAN_ROWS = 10_000;

export interface RequestPage {
  /** Newest first. */
  records: RequestRecord[];
  /**
   * Set when the scan window ended before the page filled: older matches may exist below this
   * id. Pass it as `before` to search the next window.
   */
  olderBefore: string | null;
}

/** Newest first. Filters no index serves examine at most REQUEST_SCAN_ROWS rows (see searchRequests). */
export async function listRequests(
  db: D1Database,
  filter: RequestFilter = {},
): Promise<RequestRecord[]> {
  return (await searchRequests(db, filter)).records;
}

/**
 * One page of request records, newest first. The service and repository filters use their
 * indexes; any other filter is applied within a window of the REQUEST_SCAN_ROWS newest rows below
 * `before`, so a filter that matches nothing cannot walk the whole table.
 */
export async function searchRequests(
  db: D1Database,
  filter: RequestFilter = {},
): Promise<RequestPage> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    where.push(sql);
    binds.push(value);
  };
  if (filter.service_id) add('service_id = ?', filter.service_id);
  if (filter.outcome) add('outcome = ?', filter.outcome);
  if (filter.repository) add('caller_repository = ?', filter.repository);
  if (filter.slug) add('service_slug = ?', filter.slug);
  if (filter.before) add('id < ?', filter.before);
  const requested = Number.isFinite(filter.limit) ? Math.floor(filter.limit as number) : NaN;
  const limit = Number.isNaN(requested)
    ? DEFAULT_REQUEST_PAGE_SIZE
    : Math.min(MAX_REQUEST_PAGE_SIZE, Math.max(1, requested));

  const unindexed = Boolean(
    filter.outcome || filter.slug || (filter.service_id && filter.repository),
  );
  let floor: string | null = null;
  if (unindexed) {
    // Primary-key walk of at most REQUEST_SCAN_ROWS entries; null when fewer rows remain.
    const row = await db
      .prepare(
        `SELECT id FROM request_log ${filter.before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT 1 OFFSET ?`,
      )
      .bind(...(filter.before ? [filter.before] : []), REQUEST_SCAN_ROWS - 1)
      .first<{ id: string }>();
    floor = row?.id ?? null;
    if (floor !== null) add('id >= ?', floor);
  }
  const sql = `SELECT * FROM request_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  const { results } = await db
    .prepare(sql)
    .bind(...binds, limit)
    .all<Record<string, unknown>>();
  const records = results.map(requestFromRow);
  return { records, olderBefore: floor !== null && records.length < limit ? floor : null };
}

export async function getRequest(db: D1Database, id: string): Promise<RequestRecord | null> {
  const row = await db
    .prepare('SELECT * FROM request_log WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  return row ? requestFromRow(row) : null;
}

const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const numOrNull = (value: unknown): number | null =>
  value == null ? null : typeof value === 'number' ? value : Number(value);

export function requestFromRow(row: Record<string, unknown>): RequestRecord {
  return {
    id: String(row.id),
    ts: Number(row.ts),
    outcome: row.outcome as Outcome,
    reason: strOrNull(row.reason),
    status: Number(row.status),
    upstream_status: numOrNull(row.upstream_status),
    method: String(row.method),
    path: String(row.path),
    service_slug: strOrNull(row.service_slug),
    service_id: strOrNull(row.service_id),
    caller_provider_id: strOrNull(row.caller_provider_id),
    grant_id: strOrNull(row.grant_id),
    claims_verified: Number(row.claims_verified) === 1 ? 1 : 0,
    caller_subject: strOrNull(row.caller_subject),
    caller_repository: strOrNull(row.caller_repository),
    caller_claims: strOrNull(row.caller_claims),
    jti: strOrNull(row.jti),
    untrusted_iss: strOrNull(row.untrusted_iss),
    eval_trace: strOrNull(row.eval_trace),
    duration_ms: Number(row.duration_ms),
    upstream_ms: numOrNull(row.upstream_ms),
    weight: Number(row.weight ?? 1),
    ip: strOrNull(row.ip),
    user_agent: strOrNull(row.user_agent),
    colo: strOrNull(row.colo),
  };
}
