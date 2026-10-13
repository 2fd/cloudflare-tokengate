// request_log_max_rows enforcement by the hourly cron, and its interaction with rollups.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOUR_MS } from '../../../src/db/rollups';
import { putSettingStatement, SETTING_DEFAULTS } from '../../../src/db/settings';
import type { Deps } from '../../../src/deps';
import type { AppEnv } from '../../../src/env';
import { idLowerBound } from '../../../src/lib/ids';
import { runCron } from '../../../src/telemetry/cron';
import { DEFAULT_PURGE_LIMITS, purge } from '../../../src/telemetry/retention';
import { rollupHours } from '../../../src/telemetry/rollup';

const DAY = Date.UTC(2026, 9, 13);
const at = (hour: number, minute = 0) => DAY + hour * HOUR_MS + minute * 60_000;
const MAX_ROWS = 10_000; // the floor of request_log_max_rows

function makeDeps(now: number): Deps {
  return {
    env: env as unknown as AppEnv,
    fetch: async () => {
      throw new Error('no fetch in cron');
    },
    now: () => now,
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    waitUntil: () => {},
  };
}

/** Inserts `count` allowed request rows created at `ms`, in id order, generated in SQL. */
async function seedRequests(ms: number, count: number, tag: string): Promise<void> {
  const prefix = idLowerBound('req', ms).slice(0, 14) + tag.padEnd(6, '0').toUpperCase();
  await env.TELEMETRY_DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
     INSERT INTO request_log (id, ts, outcome, status, method, path, claims_verified, duration_ms)
     SELECT ?1 || printf('%010d', i), ?3, 'allowed', 200, 'GET', '/', 1, 5 FROM n`,
  )
    .bind(prefix, count, ms)
    .run();
}

const rowCount = async () =>
  (await env.TELEMETRY_DB.prepare('SELECT COUNT(*) AS n FROM request_log').first<{ n: number }>())
    ?.n;

async function storedRollup(hour: number): Promise<number> {
  const row = await env.TELEMETRY_DB.prepare(
    'SELECT SUM(requests) AS n FROM request_rollup_hourly WHERE hour = ?',
  )
    .bind(hour)
    .first<{ n: number | null }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  await env.DB.batch([
    env.DB.prepare('DELETE FROM settings'),
    putSettingStatement(env.DB, 'request_log_max_rows', MAX_ROWS, 0, null),
  ]);
  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare('DELETE FROM request_log'),
    env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly'),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('request_log_max_rows', () => {
  it('is enforced by hourly runs, not only by the daily probe', async () => {
    await seedRequests(at(5, 10), 12_000, 'a');
    await rollupHours(makeDeps(at(6)), [at(5)]);
    // 12:07 is not the daily probe hour; the rollup estimate (12 000) reaches the cap.
    const summary = await runCron(makeDeps(at(12, 7)));
    expect(summary.purge.requestLog).toMatchObject({ byMaxRows: 2_000, more: false });
    expect(await rowCount()).toBe(MAX_ROWS);
  });

  it('hourly runs skip the probe while the rollup estimate is below the cap', async () => {
    // No rollups: the estimate is 0, so only the forced (daily) probe sees the excess.
    await seedRequests(at(5, 10), 12_000, 'a');
    const settings = { ...SETTING_DEFAULTS, request_log_max_rows: MAX_ROWS };
    const hourly = await purge(makeDeps(at(12, 7)), settings, {
      ...DEFAULT_PURGE_LIMITS,
      forceMaxRowsProbe: false,
    });
    expect(hourly.requestLog.byMaxRows).toBe(0);
    const daily = await purge(makeDeps(at(12, 7)), settings);
    expect(daily.requestLog.byMaxRows).toBe(2_000);
  });

  it('never deletes rows of hours a later run recomputes, so stored rollups are never lowered', async () => {
    await seedRequests(at(1, 10), 6_000, 'a');
    await seedRequests(at(2, 10), 6_000, 'b');
    for (const hour of [3, 4, 5, 6]) {
      await runCron(makeDeps(at(hour, 7)));
      expect(await storedRollup(at(1))).toBe(6_000);
      expect(await storedRollup(at(2))).toBe(6_000);
    }
    // Hour 01 left the recompute window at 05:07; its oldest rows were then trimmed to the cap.
    expect(await rowCount()).toBe(MAX_ROWS);
  });
});
