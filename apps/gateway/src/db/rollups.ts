// TELEMETRY_DB aggregates: the hourly rollup table and the live request_log aggregates the
// dashboard needs. Request windows are id ranges (ids are time-ordered ULIDs, src/lib/ids.ts), so
// every scan uses the primary key. Counts are sums of `weight` (1 / sample rate), not row counts.
import { idLowerBound } from '../lib/ids';
import type { Outcome } from '../telemetry/types';

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
  /** '' when unknown (request failed before the service or credential access rule was resolved). */
  service_id: string;
  credential_access_rule_id: string;
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
    COALESCE(credential_access_rule_id, '') AS credential_access_rule_id,
    outcome,
    status / 100 AS status_class,
    SUM(weight) AS requests,
    SUM(CASE WHEN outcome = 'allowed' AND upstream_status IN (401, 403) THEN weight ELSE 0 END) AS upstream_auth_fail,
    SUM(duration_ms * weight) AS duration_sum_ms,
    ${BUCKET_SUMS}
  FROM request_log
  WHERE id >= ?1 AND id < ?2
  GROUP BY COALESCE(service_id, ''), COALESCE(credential_access_rule_id, ''), outcome, status / 100`;

const ROLLUP_COLUMNS = [
  'hour',
  'service_id',
  'credential_access_rule_id',
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
       ON CONFLICT (hour, service_id, credential_access_rule_id, outcome, status_class) DO UPDATE SET ${ROLLUP_VALUE_SET}
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
    credential_access_rule_id: String(row.credential_access_rule_id ?? ''),
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

export interface RuleUsage {
  credential_access_rule_id: string;
  /** Newest hour with an allowed request. */
  last_hour: number;
  /** Allowed requests in the window. */
  requests: number;
}

/**
 * Allowed requests per credential access rule in stored rollups for hours in [sinceHour, beforeHour) (a primary-key
 * range scan: `hour` leads the key). The hours not rolled up yet come from
 * aggregateRequestLogStatement; mergeRuleUsage combines both. The rollup retention minimum
 * (30 days, SETTING_BOUNDS) keeps a 30-day window available.
 */
export function ruleUsageStatement(
  db: D1Database,
  sinceHour: number,
  beforeHour: number = Number.MAX_SAFE_INTEGER,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT credential_access_rule_id, MAX(hour) AS last_hour, SUM(requests) AS requests
       FROM request_rollup_hourly
       WHERE hour >= ? AND hour < ? AND credential_access_rule_id <> '' AND outcome = 'allowed'
       GROUP BY credential_access_rule_id`,
    )
    .bind(sinceHour, beforeHour);
}

/**
 * Usage per credential access rule id from ruleUsageStatement rows plus live aggregates (rollupFromRow of
 * aggregateRequestLogStatement) for the hours after them. Live rows count at their window start.
 */
export function mergeRuleUsage(
  stored: ReadonlyArray<Record<string, unknown>>,
  live: readonly RollupRow[],
): Map<string, RuleUsage> {
  const usage = new Map<string, RuleUsage>();
  const add = (ruleId: string, hour: number, requests: number) => {
    if (ruleId === '' || requests <= 0) return;
    const current = usage.get(ruleId);
    usage.set(ruleId, {
      credential_access_rule_id: ruleId,
      last_hour: Math.max(current?.last_hour ?? hour, hour),
      requests: (current?.requests ?? 0) + requests,
    });
  };
  for (const row of stored) {
    // oxlint-disable-next-line typescript/no-base-to-string -- D1 TEXT
    const ruleId = String(row.credential_access_rule_id ?? '');
    add(ruleId, Number(row.last_hour), Number(row.requests ?? 0));
  }
  for (const row of live) {
    if (row.outcome === 'allowed') add(row.credential_access_rule_id, row.hour, row.requests);
  }
  return usage;
}

// ---------------------------------------------------------------------------------------------
// Monitoring reads (the Overview). Stored rollups cover the closed hours; the hours not rolled up
// yet come from aggregateRequestLogStatement, one statement per live hour.

const VALUE_SUMS = [
  'requests',
  'upstream_auth_fail',
  'duration_sum_ms',
  ...LATENCY_BUCKETS.map((bucket) => bucket.column),
]
  .map((column) => `SUM(${column}) AS ${column}`)
  .join(', ');

/**
 * Stored rollups for hours in [fromHour, toHour), summed per (service, credential access rule, outcome, status
 * class) and labelled with `fromHour`: the same shape as rollupFromRow reads, aggregated in SQL so
 * a 30-day range reads one row per combination instead of one per hour.
 */
export function edgeTotalsStatement(
  db: D1Database,
  fromHour: number,
  toHour: number,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ?1 AS hour, service_id, credential_access_rule_id, outcome, status_class, ${VALUE_SUMS}
       FROM request_rollup_hourly WHERE hour >= ?1 AND hour < ?2
       GROUP BY service_id, credential_access_rule_id, outcome, status_class`,
    )
    .bind(fromHour, toHour);
}

export interface SeriesRow {
  /** Start of the bucket (a UTC multiple of the bucket size). */
  bucket: number;
  outcome: Outcome;
  status_class: number;
  requests: number;
}

/** Stored requests per chart bucket of `bucketMs`, outcome and status class, for [fromHour, toHour). */
export function seriesStatement(
  db: D1Database,
  fromHour: number,
  toHour: number,
  bucketMs: number,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT hour - hour % ?3 AS bucket, outcome, status_class, SUM(requests) AS requests
       FROM request_rollup_hourly WHERE hour >= ?1 AND hour < ?2
       GROUP BY hour - hour % ?3, outcome, status_class`,
    )
    .bind(fromHour, toHour, bucketMs);
}

export function seriesFromRow(row: Record<string, unknown>): SeriesRow {
  return {
    bucket: Number(row.bucket),
    outcome: row.outcome as Outcome,
    status_class: Number(row.status_class),
    requests: Number(row.requests ?? 0),
  };
}

/** Denied records grouped by caller, token and reason (Top denials). */
export interface DenialGroup {
  /** '' when no credential access rule was resolved. */
  credential_access_rule_id: string;
  /** '' when no token was resolved. */
  service_id: string;
  service_slug: string | null;
  reason: string | null;
  claims_verified: 0 | 1;
  /** Verified: the repository, else the subject. Unverified: the unverified issuer. */
  caller: string | null;
  caller_kind: 'repository' | 'subject' | 'issuer' | 'none';
  /** Weighted count. */
  requests: number;
  latest_id: string;
  latest_ts: number;
  /** Newest record of the group whose token was verified (the only one that may prefill a form). */
  latest_verified_id: string | null;
}

export const DENIAL_SCAN_ROWS = 2000;
export const DENIAL_GROUPS_LIMIT = 10;

/**
 * Top denied callers since `sinceMs`: the newest `scanRows` denied records (through the partial
 * index request_log_problems, whose WHERE term is repeated literally), grouped by credential access rule, credential,
 * reason, verification and caller. Each row also says how many records were scanned, so the page
 * can say when the bound was hit.
 */
export function denialGroupsStatement(
  db: D1Database,
  sinceMs: number,
  scanRows: number = DENIAL_SCAN_ROWS,
  limit: number = DENIAL_GROUPS_LIMIT,
): D1PreparedStatement {
  return db
    .prepare(
      `WITH scanned AS (
         SELECT id, ts, reason, service_id, service_slug, credential_access_rule_id, claims_verified,
           caller_repository, caller_subject, untrusted_iss, weight
         FROM request_log
         WHERE (outcome <> 'allowed' OR status >= 500) AND outcome = 'denied' AND id >= ?1
         ORDER BY id DESC LIMIT ?2
       )
       SELECT COALESCE(credential_access_rule_id, '') AS credential_access_rule_id,
         COALESCE(service_id, '') AS service_id, MAX(service_slug) AS service_slug, reason,
         claims_verified,
         COALESCE(caller_repository, caller_subject, untrusted_iss) AS caller,
         CASE WHEN caller_repository IS NOT NULL THEN 'repository'
              WHEN caller_subject IS NOT NULL THEN 'subject'
              WHEN untrusted_iss IS NOT NULL THEN 'issuer' ELSE 'none' END AS caller_kind,
         SUM(weight) AS requests, MAX(id) AS latest_id, MAX(ts) AS latest_ts,
         MAX(CASE WHEN claims_verified = 1 THEN id END) AS latest_verified_id,
         (SELECT COUNT(*) FROM scanned) AS scanned
       FROM scanned
       GROUP BY 1, 2, 4, 5, 6, 7
       ORDER BY requests DESC, latest_id DESC
       LIMIT ?3`,
    )
    .bind(idLowerBound('req', sinceMs), scanRows, limit);
}

export function denialGroupFromRow(row: Record<string, unknown>): DenialGroup {
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const kind = row.caller_kind;
  return {
    credential_access_rule_id: text(row.credential_access_rule_id) ?? '',
    service_id: text(row.service_id) ?? '',
    service_slug: text(row.service_slug),
    reason: text(row.reason),
    claims_verified: Number(row.claims_verified) === 1 ? 1 : 0,
    caller: text(row.caller),
    caller_kind: kind === 'repository' || kind === 'subject' || kind === 'issuer' ? kind : 'none',
    requests: Number(row.requests ?? 0),
    latest_id: String(row.latest_id),
    latest_ts: Number(row.latest_ts),
    latest_verified_id: text(row.latest_verified_id),
  };
}

/**
 * Weighted allowed and other (denied, error) requests in stored rollups since `sinceHour`: the
 * Data retention page turns them into records kept per day at the current sample rate.
 */
export function outcomeTotalsStatement(db: D1Database, sinceHour: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN outcome = 'allowed' THEN requests ELSE 0 END), 0) AS allowed,
         COALESCE(SUM(CASE WHEN outcome <> 'allowed' THEN requests ELSE 0 END), 0) AS other
       FROM request_rollup_hourly WHERE hour >= ?`,
    )
    .bind(sinceHour);
}
