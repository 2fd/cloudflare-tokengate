// Hourly rollups of request_log into request_rollup_hourly. Each run recomputes the last closed
// hours, then catches up from a watermark in bounded batches, so hours missed by failed or skipped
// runs are filled in. Records the queue delivers after the cron window has passed their hour are
// rolled up by the credential access rule (lateRecordHours). Recomputes never lower a stored rollup
// (rollupHourStatement).
import { HOUR_MS, rollupHourStatement } from '../db/rollups';
import type { StateKey } from '../db/settings';
import type { Deps } from '../deps';
import { idTimestamp } from '../lib/ids';

/** Closed hours recomputed by every cron run; covers late queue deliveries and one missed run. */
export const ROLLUP_HOURS_PER_RUN = 3;

/** Older hours a cron run may recompute to catch up after failed or missed runs. */
export const ROLLUP_CATCHUP_HOURS_PER_RUN = 24;

/**
 * Settings key (control-plane DB) holding an hour start W such that every record of an hour <= W is
 * counted: it was stored before the run that wrote W, or the credential access rule rolls it up itself
 * (lateRecordHours). Hours after W may still get records only a cron run counts, so the next run
 * recomputes from W + 1 h. After a complete run W is the hour before the recompute window: a
 * record stored after the run for a window hour is not late for the credential access rule. Absent or invalid:
 * catch up from the oldest request_log row.
 */
export const ROLLUP_WATERMARK_KEY: StateKey = 'rollup_watermark';

export function hourStart(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** Start of the `count` most recent hours that have fully elapsed at `now`, newest first. */
export function lastClosedHours(now: number, count: number): number[] {
  const current = hourStart(now);
  return Array.from({ length: count }, (_, i) => current - (i + 1) * HOUR_MS);
}

/** Rolls up the given hours (ms timestamps of hour starts) in one TELEMETRY_DB batch. */
export async function rollupHours(
  deps: Pick<Deps, 'env'>,
  hours: number[],
): Promise<{ hours: number[]; rows: number }> {
  const unique = [...new Set(hours)].sort((a, b) => a - b);
  for (const hour of unique) {
    if (!Number.isSafeInteger(hour) || hour % HOUR_MS !== 0) {
      throw new RangeError(`rollup hour must be an hour start in ms, got ${hour}`);
    }
  }
  if (unique.length === 0) return { hours: [], rows: 0 };
  const db = deps.env.TELEMETRY_DB;
  const results = await db.batch(unique.map((hour) => rollupHourStatement(db, hour)));
  const rows = results.reduce((sum, result) => sum + result.meta.changes, 0);
  return { hours: unique, rows };
}

/**
 * Hours of the given request ids that the next cron run's fixed window no longer covers. The next
 * run starts at most one hour after `now` and recomputes ROLLUP_HOURS_PER_RUN closed hours, so
 * hours before hourStart(now) - (ROLLUP_HOURS_PER_RUN - 1) h are rolled up by the caller instead.
 */
export function lateRecordHours(ids: readonly string[], now: number): number[] {
  const firstCovered = hourStart(now) - (ROLLUP_HOURS_PER_RUN - 1) * HOUR_MS;
  const hours = new Set<number>();
  for (const id of ids) {
    const ms = idTimestamp(id);
    if (ms !== null && hourStart(ms) < firstCovered) hours.add(hourStart(ms));
  }
  return [...hours].sort((a, b) => a - b);
}

export interface RollupRun {
  /** Hours rolled up, oldest first. */
  hours: number[];
  /** Rollup rows inserted or raised. */
  rows: number;
  /** Watermark stored after this run (ROLLUP_WATERMARK_KEY). */
  watermark: number;
}

/**
 * The cron rollup step: the last ROLLUP_HOURS_PER_RUN closed hours, then up to
 * ROLLUP_CATCHUP_HOURS_PER_RUN older hours after the watermark, oldest first. The watermark only
 * advances over hours this run rolled up, so an outage of either database or skipped triggers delay
 * rollups but cannot skip hours that still have request_log rows.
 */
export async function runRollups(deps: Pick<Deps, 'env'>, now: number): Promise<RollupRun> {
  const recentHours = lastClosedHours(now, ROLLUP_HOURS_PER_RUN);
  const windowStart = hourStart(now) - ROLLUP_HOURS_PER_RUN * HOUR_MS;
  const recent = await rollupHours(deps, recentHours);

  const stored = await readRollupWatermark(deps.env.DB);
  const catchUp: number[] = [];
  let watermark = windowStart - HOUR_MS;
  if (stored === null || stored + HOUR_MS < windowStart) {
    const oldest = await deps.env.TELEMETRY_DB.prepare(
      'SELECT id FROM request_log ORDER BY id LIMIT 1',
    ).first<{ id: string }>();
    const oldestMs = oldest ? idTimestamp(oldest.id) : null;
    // Hours before the oldest stored row have nothing left to aggregate.
    const from = Math.max(
      stored === null ? Number.NEGATIVE_INFINITY : stored + HOUR_MS,
      oldestMs === null ? windowStart : hourStart(oldestMs),
    );
    const to = Math.min(windowStart, from + ROLLUP_CATCHUP_HOURS_PER_RUN * HOUR_MS);
    for (let hour = from; hour < to; hour += HOUR_MS) catchUp.push(hour);
    if (to < windowStart) watermark = to - HOUR_MS;
  }
  const older = await rollupHours(deps, catchUp);
  await deps.env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, NULL)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
       updated_by = NULL`,
  )
    .bind(ROLLUP_WATERMARK_KEY, JSON.stringify(watermark), now)
    .run();
  return { hours: [...older.hours, ...recent.hours], rows: recent.rows + older.rows, watermark };
}

export async function readRollupWatermark(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(ROLLUP_WATERMARK_KEY)
    .first<{ value: string }>();
  let value: unknown = null;
  try {
    value = row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
  return Number.isSafeInteger(value) && (value as number) % HOUR_MS === 0
    ? (value as number)
    : null;
}
