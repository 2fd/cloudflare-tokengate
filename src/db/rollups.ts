// TELEMETRY_DB aggregates: the hourly rollup table and the live request_log aggregates the
// dashboard needs. Request windows are id ranges (ids are time-ordered ULIDs, src/lib/ids.ts), so
// every scan uses the primary key. Counts are sums of `weight` (1 / sample rate), not row counts.
import { idLowerBound } from '../lib/ids';
import type { Outcome, RequestRecord } from '../telemetry/types';

/**
 * Disjoint latency buckets on `duration_ms` (time to response headers): each request falls in
 * exactly one bucket, `le_100` counts 50 < d <= 100, `gt_5000` counts d > 5000.
 * Column names are fixed by migrations-telemetry/0001_initial.sql.
 */
export const LATENCY_BUCKETS = [
  { column: 'le_50', upper: 50 },
  { column: 'le_100', upper: 100 },
  { column: 'le_250', upper: 250 },
  { column: 'le_500', upper: 500 },
  { column: 'le_1000', upper: 1000 },
  { column: 'le_2500', upper: 2500 },
  { column: 'le_5000', upper: 5000 },
  { column: 'gt_5000', upper: null },
] as const;

export interface RollupRow {
  /** Hour start, ms since epoch (UTC). For live aggregates: start of the aggregated window. */
  hour: number;
  /** '' when unknown (request failed before the service or grant was resolved). */
  service_id: string;
  grant_id: string;
  outcome: Outcome;
  /** floor(status / 100) of the status the gateway returned. */
  status_class: number;
  requests: number;
  /** Allowed requests whose upstream answered 401 or 403. */
  upstream_auth_fail: number;
  duration_sum_ms: number;
  /** Weighted counts in LATENCY_BUCKETS order. */
  buckets: number[];
}

export const HOUR_MS = 3_600_000;

// Generated from LATENCY_BUCKETS so the SQL and the percentile math cannot disagree.
const BUCKET_SUMS = LATENCY_BUCKETS.map(({ column, upper }, i) => {
  const lower = LATENCY_BUCKETS[i - 1]?.upper;
  const range: string[] = [];
  if (lower != null) range.push(`duration_ms > ${lower}`);
  if (upper !== null) range.push(`duration_ms <= ${upper}`);
  return `SUM(CASE WHEN ${range.join(' AND ')} THEN weight ELSE 0 END) AS ${column}`;
}).join(',\n    ');

/** Aggregate of request_log over ids in [?1, ?2), labelled with hour ?3. */
const AGGREGATE_SELECT = `SELECT ?3 AS hour,
    COALESCE(service_id, '') AS service_id,
    COALESCE(grant_id, '') AS grant_id,
    outcome,
    status / 100 AS status_class,
    SUM(weight) AS requests,
    SUM(CASE WHEN outcome = 'allowed' AND upstream_status IN (401, 403) THEN weight ELSE 0 END) AS upstream_auth_fail,
    SUM(duration_ms * weight) AS duration_sum_ms,
    ${BUCKET_SUMS}
  FROM request_log
  WHERE id >= ?1 AND id < ?2
  GROUP BY COALESCE(service_id, ''), COALESCE(grant_id, ''), outcome, status / 100`;

const ROLLUP_COLUMNS = [
  'hour',
  'service_id',
  'grant_id',
  'outcome',
  'status_class',
  'requests',
  'upstream_auth_fail',
  'duration_sum_ms',
  ...LATENCY_BUCKETS.map((bucket) => bucket.column),
].join(', ');

function idRange(fromMs: number, toMs: number): [string, string] {
  return [idLowerBound('req', fromMs), idLowerBound('req', toMs)];
}

const ROLLUP_VALUE_SET = [
  'requests',
  'upstream_auth_fail',
  'duration_sum_ms',
  ...LATENCY_BUCKETS.map((bucket) => bucket.column),
]
  .map((column) => `${column} = excluded.${column}`)
  .join(', ');

/**
 * Upserts the aggregate of one hour of request_log into its rollup rows. A stored row is replaced
 * only when the fresh aggregate counts more requests, and rows absent from the aggregate are kept:
 * request_log rows only disappear through retention purges, so a recompute after a purge can add
 * late records but never lowers what an earlier run stored. Idempotent.
 */
export function rollupHourStatement(db: D1Database, hour: number): D1PreparedStatement {
  const [from, to] = idRange(hour, hour + HOUR_MS);
  // SQLite needs the WHERE in AGGREGATE_SELECT to parse an upsert on INSERT … SELECT
  // (https://www.sqlite.org/lang_upsert.html, "Parsing Ambiguity").
  return db
    .prepare(
      `INSERT INTO request_rollup_hourly (${ROLLUP_COLUMNS}) ${AGGREGATE_SELECT}
       ON CONFLICT (hour, service_id, grant_id, outcome, status_class) DO UPDATE SET ${ROLLUP_VALUE_SET}
       WHERE excluded.requests > request_rollup_hourly.requests`,
    )
    .bind(from, to, hour);
}

/** Stored rollups for hours in [fromHour, toHour). */
export function listRollupsStatement(
  db: D1Database,
  fromHour: number,
  toHour: number,
): D1PreparedStatement {
  return db
    .prepare(`SELECT ${ROLLUP_COLUMNS} FROM request_rollup_hourly WHERE hour >= ? AND hour < ?`)
    .bind(fromHour, toHour);
}

/** Live aggregate of request_log over [fromMs, toMs), same shape as stored rollups. */
export function aggregateRequestLogStatement(
  db: D1Database,
  fromMs: number,
  toMs: number,
): D1PreparedStatement {
  const [from, to] = idRange(fromMs, toMs);
  return db.prepare(AGGREGATE_SELECT).bind(from, to, fromMs);
}

export function purgeRollupsStatement(db: D1Database, beforeHour: number): D1PreparedStatement {
  return db.prepare('DELETE FROM request_rollup_hourly WHERE hour < ?').bind(beforeHour);
}

export function rollupFromRow(row: Record<string, unknown>): RollupRow {
  return {
    hour: Number(row.hour),
    // oxlint-disable-next-line typescript/no-base-to-string -- D1 TEXT or NULL
    service_id: String(row.service_id ?? ''),
    // oxlint-disable-next-line typescript/no-base-to-string -- D1 TEXT or NULL
    grant_id: String(row.grant_id ?? ''),
    outcome: row.outcome as Outcome,
    status_class: Number(row.status_class),
    requests: Number(row.requests ?? 0),
    upstream_auth_fail: Number(row.upstream_auth_fail ?? 0),
    duration_sum_ms: Number(row.duration_sum_ms ?? 0),
    buckets: LATENCY_BUCKETS.map((bucket) => Number(row[bucket.column] ?? 0)),
  };
}

export interface UpstreamAuthFailureRow {
  service_id: string;
  service_slug: string | null;
  /** Allowed requests that reached the upstream. */
  forwarded: number;
  /** Of those, upstream answered 401 or 403. */
  auth_failures: number;
}

/**
 * Services whose upstream rejected the injected credential for at least `minFailures` requests
 * and at least `minRatio` of forwarded requests since `sinceMs`.
 */
export function upstreamAuthFailuresStatement(
  db: D1Database,
  sinceMs: number,
  minFailures: number,
  minRatio: number,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT COALESCE(service_id, '') AS service_id, MAX(service_slug) AS service_slug,
         SUM(weight) AS forwarded,
         SUM(CASE WHEN upstream_status IN (401, 403) THEN weight ELSE 0 END) AS auth_failures
       FROM request_log
       WHERE id >= ? AND outcome = 'allowed' AND upstream_status IS NOT NULL
       GROUP BY COALESCE(service_id, '')
       HAVING auth_failures >= ? AND auth_failures >= forwarded * ?
       ORDER BY auth_failures DESC`,
    )
    .bind(idLowerBound('req', sinceMs), minFailures, minRatio);
}

export type RecentDenial = Pick<
  RequestRecord,
  | 'id'
  | 'ts'
  | 'reason'
  | 'status'
  | 'method'
  | 'path'
  | 'service_slug'
  | 'service_id'
  | 'caller_provider_id'
  | 'claims_verified'
  | 'caller_subject'
  | 'caller_repository'
  | 'untrusted_iss'
>;

/** Newest denied requests since `sinceMs` (the bound keeps the backwards scan finite). */
export function recentDenialsStatement(
  db: D1Database,
  sinceMs: number,
  limit: number,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT id, ts, reason, status, method, path, service_slug, service_id, caller_provider_id,
         claims_verified, caller_subject, caller_repository, untrusted_iss
       FROM request_log
       WHERE id >= ? AND outcome = 'denied'
       ORDER BY id DESC LIMIT ?`,
    )
    .bind(idLowerBound('req', sinceMs), limit);
}
