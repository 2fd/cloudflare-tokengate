// request_log reads and writes (TELEMETRY_DB). Inserts are INSERT OR IGNORE keyed by the request
// id, so queue redelivery and the queue-to-direct fallback never duplicate a record.
import { idLowerBound } from '../lib/ids';
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

/** The outcome classes of the Monitoring pages; `error` uses the same definition as trafficStats. */
export type OutcomeClass = 'allowed' | 'denied' | 'error';

export interface RequestFilter {
  /** A token id; null for requests refused before a token was resolved. */
  service_id?: string | null;
  /** A credential access rule id; null for requests with no resolved consumer. */
  credential_access_rule_id?: string | null;
  grant_id?: string;
  /** Exact stored outcome. */
  outcome?: Outcome;
  /**
   * allowed: outcome allowed. denied: outcome denied. error: gateway errors plus allowed
   * requests answered with 5xx (the Overview "Errors" count). Denied and error use the partial
   * index request_log_problems.
   */
  outcomeClass?: OutcomeClass;
  /** Exact recorded reason code. */
  reason?: string;
  /** Exact caller_repository. */
  repository?: string;
  /** Exact service_slug. */
  slug?: string;
  /** Only requests at or after this time (ms); an id bound, so the primary key serves it. */
  since?: number;
  /** Keyset pagination: only ids lower (older) than this. */
  before?: string;
  /** Keyset pagination: only ids higher (newer) than this; wins over `before`. */
  after?: string;
  /** Page size, 1..200 (default 50). */
  limit?: number;
}

export const DEFAULT_REQUEST_PAGE_SIZE = 50;
const MAX_REQUEST_PAGE_SIZE = 200;
/**
 * Rows one filtered page may examine when no index serves the filter (requestFilterIndexed: the
 * allowed class, consumer, reason, slug, or any two filters together). Bounds the D1 rows read per page load to about twice this,
 * whatever the table size.
 */
export const REQUEST_SCAN_ROWS = 10_000;

export interface RequestPage {
  /** Newest first, at most `limit`. With `after`, the oldest `limit` rows above it. */
  records: RequestRecord[];
  /**
   * Set when the scan window ended before the page filled: older matches may exist below this
   * id. Pass it as `before` to search the next window.
   */
  olderBefore: string | null;
  /** The same for `after`: newer matches may exist above this id. Pass it as `after`. */
  newerAfter: string | null;
}

/** Newest first. Filters no index serves examine at most REQUEST_SCAN_ROWS rows (see searchRequests). */
export async function listRequests(
  db: D1Database,
  filter: RequestFilter = {},
): Promise<RequestRecord[]> {
  return (await searchRequests(db, filter)).records;
}

/** The WHERE term of the partial index request_log_problems, repeated literally so it is used. */
export const PROBLEMS_TERM = "(outcome <> 'allowed' OR status >= 500)";

/**
 * True when one index serves the whole filter: the token, the repository or the issuer access rules
 * on its own (each has an `(x, id)` index), or the denied or error class (request_log_problems).
 * Time bounds and keyset cursors are id ranges and keep a filter indexed.
 */
export function requestFilterIndexed(filter: RequestFilter): boolean {
  const terms = [
    filter.service_id !== undefined,
    filter.credential_access_rule_id !== undefined,
    filter.grant_id !== undefined,
    filter.outcome !== undefined,
    filter.outcomeClass !== undefined,
    filter.reason !== undefined,
    filter.repository !== undefined,
    filter.slug !== undefined,
  ].filter(Boolean).length;
  if (terms === 0) return true;
  if (terms > 1) return false;
  return (
    filter.service_id !== undefined ||
    filter.repository !== undefined ||
    filter.grant_id !== undefined ||
    filter.outcomeClass === 'denied' ||
    filter.outcomeClass === 'error'
  );
}

/**
 * One page of request records, newest first. Filters an index serves read only matching rows;
 * any other filter is applied within a window of the REQUEST_SCAN_ROWS rows next to the cursor
 * (below `before`, or above `after`), so a filter that matches nothing cannot walk the whole table.
 */
export async function searchRequests(
  db: D1Database,
  filter: RequestFilter = {},
): Promise<RequestPage> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const add = (sql: string, ...values: unknown[]) => {
    where.push(sql);
    binds.push(...values);
  };
  if (filter.service_id === null) where.push('service_id IS NULL');
  else if (filter.service_id !== undefined) add('service_id = ?', filter.service_id);
  if (filter.credential_access_rule_id === null) where.push('credential_access_rule_id IS NULL');
  else if (filter.credential_access_rule_id !== undefined) {
    add('credential_access_rule_id = ?', filter.credential_access_rule_id);
  }
  if (filter.grant_id !== undefined) add('grant_id = ?', filter.grant_id);
  if (filter.outcome) add('outcome = ?', filter.outcome);
  if (filter.outcomeClass === 'allowed') where.push("outcome = 'allowed'");
  if (filter.outcomeClass === 'denied') where.push(PROBLEMS_TERM, "outcome = 'denied'");
  if (filter.outcomeClass === 'error') {
    where.push(PROBLEMS_TERM, "(outcome = 'error' OR (outcome = 'allowed' AND status >= 500))");
  }
  if (filter.reason !== undefined) add('reason = ?', filter.reason);
  if (filter.repository !== undefined) add('caller_repository = ?', filter.repository);
  if (filter.slug !== undefined) add('service_slug = ?', filter.slug);
  const sinceId = filter.since === undefined ? null : idLowerBound('req', filter.since);
  if (sinceId !== null) add('id >= ?', sinceId);
  const after = filter.after;
  if (after) add('id > ?', after);
  else if (filter.before) add('id < ?', filter.before);
  const requested = Number.isFinite(filter.limit) ? Math.floor(filter.limit as number) : NaN;
  const limit = Number.isNaN(requested)
    ? DEFAULT_REQUEST_PAGE_SIZE
    : Math.min(MAX_REQUEST_PAGE_SIZE, Math.max(1, requested));

  // Primary-key walk of at most REQUEST_SCAN_ROWS entries from the cursor; null when fewer remain.
  let bound: string | null = null;
  if (!requestFilterIndexed(filter)) {
    const cursor = after ? 'id > ?' : filter.before ? 'id < ?' : null;
    const row = await db
      .prepare(
        `SELECT id FROM request_log ${cursor ? `WHERE ${cursor}` : ''}
         ORDER BY id ${after ? 'ASC' : 'DESC'} LIMIT 1 OFFSET ?`,
      )
      .bind(...(cursor ? [after || filter.before] : []), REQUEST_SCAN_ROWS - 1)
      .first<{ id: string }>();
    bound = row?.id ?? null;
    if (bound !== null) add(after ? 'id <= ?' : 'id >= ?', bound);
  }
  const sql = `SELECT * FROM request_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id ${after ? 'ASC' : 'DESC'} LIMIT ?`;
  const { results } = await db
    .prepare(sql)
    .bind(...binds, limit)
    .all<Record<string, unknown>>();
  const records = results.map(requestFromRow);
  if (after) records.reverse();
  const short = bound !== null && records.length < limit;
  return {
    records,
    // A window that ends below the time bound already covered the whole range.
    olderBefore:
      !after && short && (sinceId === null || (bound !== null && bound > sinceId)) ? bound : null,
    newerAfter: after && short ? bound : null,
  };
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
    credential_access_rule_id: strOrNull(row.credential_access_rule_id),
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
