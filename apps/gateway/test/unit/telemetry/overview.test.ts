// Overview traffic: the range rule, the chart series and the edge totals against the raw records,
// and the "Errors" definition shared with the Requests outcome=error filter.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetSchemaStatusCacheForTests } from '../../../src/db/migrations';
import { searchRequests } from '../../../src/db/requests';
import {
  aggregateRequestLogStatement,
  HOUR_MS,
  rollupFromRow,
  rollupHourStatement,
} from '../../../src/db/rollups';
import { putSettingStatement } from '../../../src/db/settings';
import type { AppEnv } from '../../../src/env';
import { newId } from '../../../src/lib/ids';
import { loadOverview, trafficStats } from '../../../src/telemetry/dashboard';
import {
  bucketStarts,
  DAY_MS,
  RANGE_BUCKET_MS,
  RANGE_BUCKETS,
  rangeStart,
} from '../../../src/telemetry/ranges';

const H = Date.UTC(2026, 9, 13, 14); // current hour
const NOW = H + 25 * 60_000;
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const deps = { env: env as unknown as AppEnv, now: () => NOW };

async function insert(
  ts: number,
  outcome: 'allowed' | 'denied' | 'error',
  status: number,
  serviceId: string | null = 'svc_A',
): Promise<void> {
  await env.TELEMETRY_DB.prepare(
    `INSERT INTO request_log (id, ts, outcome, status, method, path, service_id, grant_id, claims_verified, duration_ms, weight)
     VALUES (?, ?, ?, ?, 'GET', '/', ?, ?, 1, 40, 1)`,
  )
    .bind(
      newId('req', ts, random),
      ts,
      outcome,
      status,
      serviceId,
      outcome === 'allowed' ? 'grt_A' : null,
    )
    .run();
}

beforeEach(async () => {
  resetSchemaStatusCacheForTests();
  await env.DB.prepare('DELETE FROM settings').run();
  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare('DELETE FROM request_log'),
    env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly'),
  ]);
});

describe('rangeStart', () => {
  it('gives 24, 28 and 30 UTC-aligned buckets, the last one holding now', () => {
    for (const range of ['24h', '7d', '30d'] as const) {
      const starts = bucketStarts(range, NOW);
      expect(starts).toHaveLength(RANGE_BUCKETS[range]);
      expect(starts[0]).toBe(rangeStart(range, NOW));
      for (const start of starts) expect(start % RANGE_BUCKET_MS[range]).toBe(0);
      const last = starts.at(-1) as number;
      expect(last <= NOW && NOW < last + RANGE_BUCKET_MS[range]).toBe(true);
    }
    expect(rangeStart('24h', NOW)).toBe(H - 23 * HOUR_MS);
    expect(rangeStart('7d', NOW)).toBe(Date.UTC(2026, 9, 13, 12) - 27 * 6 * HOUR_MS);
    expect(rangeStart('30d', NOW)).toBe(Date.UTC(2026, 9, 13) - 29 * DAY_MS);
    expect(rangeStart('1h', NOW)).toBe(NOW - HOUR_MS);
  });
});

describe('loadOverview traffic', () => {
  it('series and edge totals over rollups plus live hours equal trafficStats of the raw records', async () => {
    // Closed hours (rolled up), the previous hour and the current one (live).
    const hours = [H - 30 * HOUR_MS, H - 20 * HOUR_MS, H - 5 * HOUR_MS, H - HOUR_MS, H];
    for (const [i, hour] of hours.entries()) {
      await insert(hour + 1000, 'allowed', 200);
      await insert(hour + 2000, 'allowed', 503);
      await insert(hour + 3000, 'denied', 403, i % 2 === 0 ? 'svc_A' : null);
      await insert(hour + 4000, 'error', 502);
    }
    const closed = hours.filter((hour) => hour < H - HOUR_MS);
    await env.TELEMETRY_DB.batch(closed.map((hour) => rollupHourStatement(env.TELEMETRY_DB, hour)));
    // The cron ran this hour: the previous hour is rolled up too.
    await env.TELEMETRY_DB.batch([rollupHourStatement(env.TELEMETRY_DB, H - HOUR_MS)]);
    await putSettingStatement(env.DB, 'cron_last_success_at', H + 60_000, H, null).run();

    for (const range of ['24h', '7d', '30d'] as const) {
      const data = await loadOverview(deps, range);
      const from = rangeStart(range, NOW);
      const raw = (
        await env.TELEMETRY_DB.batch([
          aggregateRequestLogStatement(env.TELEMETRY_DB, from, NOW + HOUR_MS),
        ])
      )[0]?.results.map((row) => rollupFromRow(row as Record<string, unknown>));
      const expected = trafficStats(raw ?? []);
      expect(data.totals, range).toEqual(expected);
      const sum = data.series.reduce((acc, b) => acc + b.allowed + b.denied + b.errors, 0);
      expect(sum, range).toBe(expected.requests);
      expect(
        data.series.reduce((acc, b) => acc + b.errors, 0),
        range,
      ).toBe(expected.errors);
      expect(data.series.at(-1)?.partial, range).toBe(true);
      // The token totals add up to the same requests, '' for those refused before a token.
      expect(
        data.tokens.reduce((acc, t) => acc + t.requests, 0),
        range,
      ).toBe(expected.requests);
      expect(
        data.tokens.some((t) => t.serviceId === ''),
        range,
      ).toBe(true);
    }
    // 24 hours leaves out the hour 30 h ago; 7 days includes it.
    expect((await loadOverview(deps, '24h')).totals.requests).toBe(16);
    expect((await loadOverview(deps, '7d')).totals.requests).toBe(20);
  });

  it('puts the live current hour in the last bucket', async () => {
    await insert(H + 1000, 'allowed', 200);
    await insert(H + 2000, 'denied', 403);
    const data = await loadOverview(deps, '24h');
    expect(data.series.at(-1)).toEqual({
      start: H,
      allowed: 1,
      denied: 1,
      errors: 0,
      partial: true,
    });
    expect(data.series.slice(0, -1).every((b) => b.allowed + b.denied + b.errors === 0)).toBe(true);
  });

  it('"Errors" is the same count as the Requests outcome=error filter', async () => {
    await insert(H + 1000, 'allowed', 200);
    await insert(H + 2000, 'allowed', 500);
    await insert(H + 3000, 'error', 502);
    await insert(H + 4000, 'denied', 403);
    const data = await loadOverview(deps, '24h');
    const listed = await searchRequests(env.TELEMETRY_DB, {
      outcomeClass: 'error',
      since: rangeStart('24h', NOW),
    });
    expect(data.totals.errors).toBe(2);
    expect(listed.records).toHaveLength(data.totals.errors);
    const allowed = await searchRequests(env.TELEMETRY_DB, { outcomeClass: 'allowed' });
    expect(allowed.records).toHaveLength(data.totals.allowed);
    const denied = await searchRequests(env.TELEMETRY_DB, { outcomeClass: 'denied' });
    expect(denied.records).toHaveLength(data.totals.denied);
  });

  it('reports an unreadable request log instead of zero traffic as fact', async () => {
    const broken = {
      ...deps,
      env: {
        ...(env as unknown as AppEnv),
        TELEMETRY_DB: {
          prepare: (sql: string) => env.TELEMETRY_DB.prepare(sql),
          batch: async () => {
            throw new Error('D1_ERROR');
          },
        } as unknown as D1Database,
      },
    };
    const data = await loadOverview(broken, '24h');
    expect(data.telemetryAvailable).toBe(false);
    expect(data.totals.requests).toBe(0);
  });
});
