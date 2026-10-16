// Retention purge run by the hourly cron. Setting bounds are re-applied here (clampSetting), so not
// even a direct D1 edit can shorten the audit trail below its 90-day floor. request_log deletes are
// chunked and capped per run (D1 query time and statement limits); `more` reports leftover rows.
import { HOUR_MS, purgeRollupsStatement } from '../db/rollups';
import { clampSetting, type Settings } from '../db/settings';
import type { Deps } from '../deps';
import { idLowerBound } from '../lib/ids';
import { hourStart, ROLLUP_HOURS_PER_RUN } from './rollup';

const DAY_MS = 86_400_000;

export interface PurgeLimits {
  /** Rows per request_log DELETE. */
  chunkRows: number;
  /** request_log statements (max-rows estimate and probe, deletes) per run. */
  maxStatements: number;
  /**
   * Run the exact request_log_max_rows probe even when the rollup estimate is below the cap. The
   * probe reads up to max-rows rows, so the cron forces it once a day (src/telemetry/cron.ts);
   * that run also covers rows the estimate misses (failed rollups, rollups already purged).
   */
  forceMaxRowsProbe: boolean;
}

export const DEFAULT_PURGE_LIMITS: PurgeLimits = {
  chunkRows: 5000,
  maxStatements: 40,
  forceMaxRowsProbe: true,
};

export interface PurgeResult {
  requestLog: {
    /** Deleted for being older than request_log_retention_days. */
    byAge: number;
    /** Deleted to keep at most request_log_max_rows rows. */
    byMaxRows: number;
    /** True when the statement budget ran out before the table was within limits. */
    more: boolean;
  };
  rollups: number;
  auditLog: number;
}

export async function purge(
  deps: Pick<Deps, 'env' | 'now'>,
  settings: Settings,
  limits: PurgeLimits = DEFAULT_PURGE_LIMITS,
): Promise<PurgeResult> {
  const now = deps.now();
  const cutoff = (key: keyof Settings) => now - clampSetting(key, settings[key]) * DAY_MS;
  // The databases are purged independently so an outage of one does not stop the other.
  const [telemetry, control] = await Promise.allSettled([
    purgeTelemetry(deps.env.TELEMETRY_DB, settings, now, cutoff, limits),
    purgeControlPlane(deps.env.DB, cutoff),
  ]);
  if (telemetry.status === 'rejected' || control.status === 'rejected') {
    const errors = [telemetry, control].flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(errors, 'purge failed on both databases');
  }
  return { ...telemetry.value, ...control.value };
}

async function purgeTelemetry(
  db: D1Database,
  settings: Settings,
  now: number,
  cutoff: (key: keyof Settings) => number,
  limits: PurgeLimits,
): Promise<Pick<PurgeResult, 'requestLog' | 'rollups'>> {
  const budget = { remaining: limits.maxStatements };
  // The max-rows bound depends only on the newest rows, so it is found first and the age purge
  // cannot move it. Both deletes go oldest first and share the budget: rows past both limits are
  // counted once, as byAge.
  const maxRows = clampSetting('request_log_max_rows', settings.request_log_max_rows);
  const capBound = await maxRowsBound(db, maxRows, now, limits.forceMaxRowsProbe, budget);
  const ageBound = idLowerBound('req', cutoff('request_log_retention_days'));
  const byAge = await deleteRequestLogBelow(db, ageBound, limits.chunkRows, budget);
  const byMaxRows =
    capBound !== null && capBound > ageBound
      ? await deleteRequestLogBelow(db, capBound, limits.chunkRows, budget)
      : { deleted: 0, done: true };
  const rollups = await purgeRollupsStatement(db, cutoff('rollup_retention_days')).run();
  return {
    requestLog: {
      byAge: byAge.deleted,
      byMaxRows: byMaxRows.deleted,
      more: !(byAge.done && byMaxRows.done),
    },
    rollups: rollups.meta.changes,
  };
}

async function purgeControlPlane(
  db: D1Database,
  cutoff: (key: keyof Settings) => number,
): Promise<Pick<PurgeResult, 'auditLog'>> {
  const audit = await db
    .prepare('DELETE FROM audit_log WHERE ts < ?')
    .bind(cutoff('audit_log_retention_days'))
    .run();
  return { auditLog: audit.meta.changes };
}

/** Deletes request_log rows with id < bound, oldest first, one chunk per statement. */
async function deleteRequestLogBelow(
  db: D1Database,
  bound: string,
  chunkRows: number,
  budget: { remaining: number },
): Promise<{ deleted: number; done: boolean }> {
  let deleted = 0;
  while (budget.remaining > 0) {
    budget.remaining--;
    const result = await db
      .prepare(
        'DELETE FROM request_log WHERE id IN (SELECT id FROM request_log WHERE id < ? ORDER BY id LIMIT ?)',
      )
      .bind(bound, chunkRows)
      .run();
    deleted += result.meta.changes;
    if (result.meta.changes < chunkRows) return { deleted, done: true };
  }
  return { deleted, done: false };
}

/**
 * Upper estimate of the stored request_log rows that are already rolled up: rollup counts are
 * sums of weights (>= 1 per row) from the hour of the oldest stored row on. Reads one rollup row
 * per group and hour instead of one row per request.
 */
export const ROWS_ESTIMATE_SQL = `SELECT COALESCE(SUM(requests), 0) AS n FROM request_rollup_hourly
  WHERE hour >= (SELECT ts - ts % ${HOUR_MS} FROM request_log ORDER BY id LIMIT 1)`;

/**
 * The id below which rows exceed `maxRows`, or null when the table is within the cap. Unless
 * forced, the exact probe (which reads up to `maxRows` rows) runs only when the rollup estimate
 * reaches the cap. The bound never reaches into the current hour or the closed hours every rollup
 * run recomputes: rows deleted before their hour is rolled up would never be counted.
 * request_log_max_rows is therefore a soft cap, exceeded by at most the current hour and
 * ROLLUP_HOURS_PER_RUN closed ones. Rows of older hours still behind the rollup watermark
 * (src/telemetry/rollup.ts) are not protected.
 */
async function maxRowsBound(
  db: D1Database,
  maxRows: number,
  now: number,
  force: boolean,
  budget: { remaining: number },
): Promise<string | null> {
  if (!force) {
    budget.remaining--;
    const estimate = await db.prepare(ROWS_ESTIMATE_SQL).first<{ n: number }>();
    if (Number(estimate?.n ?? 0) < maxRows) return null;
  }
  budget.remaining--;
  const oldestKept = await db
    .prepare('SELECT id FROM request_log ORDER BY id DESC LIMIT 1 OFFSET ?')
    .bind(maxRows - 1)
    .first<{ id: string }>();
  if (!oldestKept) return null;
  const firstRecomputed = idLowerBound('req', hourStart(now) - ROLLUP_HOURS_PER_RUN * HOUR_MS);
  return oldestKept.id < firstRecomputed ? oldestKept.id : firstRecomputed;
}
