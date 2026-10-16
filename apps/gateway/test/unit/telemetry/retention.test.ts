import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { HOUR_MS } from '../../../src/db/rollups';
import { SETTING_DEFAULTS, type Settings } from '../../../src/db/settings';
import type { AppEnv } from '../../../src/env';
import { idLowerBound } from '../../../src/lib/ids';
import { purge, ROWS_ESTIMATE_SQL } from '../../../src/telemetry/retention';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 13, 12, 7);
const deps = { env: env as unknown as AppEnv, now: () => NOW };
const settings = (overrides: Partial<Settings> = {}): Settings => ({
  ...SETTING_DEFAULTS,
  ...overrides,
});

/** Inserts `count` request rows created at `ms`, in id order, generated in SQL. */
async function seedRequests(ms: number, count: number, tag = 'a'): Promise<void> {
  // ids: "req_" + 10-char time + 6-char tag/padding + 10-digit counter → valid, ordered ULIDs.
  const prefix = idLowerBound('req', ms).slice(0, 14) + tag.padEnd(6, '0').toUpperCase();
  await env.TELEMETRY_DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
     INSERT INTO request_log (id, ts, outcome, status, method, path, claims_verified, duration_ms)
     SELECT ?1 || printf('%010d', i), ?3, 'allowed', 200, 'GET', '/', 1, 5 FROM n`,
  )
    .bind(prefix, count, ms)
    .run();
}

const countRows = async (db: D1Database, table: string) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

beforeEach(async () => {
  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare('DELETE FROM request_log'),
    env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly'),
  ]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});

describe('purge: request_log', () => {
  it('deletes rows older than the retention by id range, keeping newer ones', async () => {
    await seedRequests(NOW - 15 * DAY, 3, 'old');
    await seedRequests(NOW - 13 * DAY, 2, 'new');
    const result = await purge(deps, settings({ request_log_retention_days: 14 }));
    expect(result.requestLog).toEqual({ byAge: 3, byMaxRows: 0, more: false });
    expect(await countRows(env.TELEMETRY_DB, 'request_log')).toBe(2);
  });

  it('deletes in chunks and reports more when the statement budget runs out', async () => {
    await seedRequests(NOW - 30 * DAY, 10);
    // One statement goes to the max-rows probe, two to deletes.
    const limits = { chunkRows: 3, maxStatements: 3, forceMaxRowsProbe: true };
    const first = await purge(deps, settings(), limits);
    expect(first.requestLog).toEqual({ byAge: 6, byMaxRows: 0, more: true });
    // 3 + 1 rows: the short chunk ends the age purge.
    const second = await purge(deps, settings(), limits);
    expect(second.requestLog).toEqual({ byAge: 4, byMaxRows: 0, more: false });
    expect(await countRows(env.TELEMETRY_DB, 'request_log')).toBe(0);
  });

  it('applies the 1-day retention floor', async () => {
    await seedRequests(NOW - 0.5 * DAY, 2);
    const result = await purge(deps, settings({ request_log_retention_days: 0 }));
    expect(result.requestLog.byAge).toBe(0);
  });

  it('keeps at most request_log_max_rows rows, deleting the oldest', async () => {
    // 10 000 is the floor for request_log_max_rows.
    await seedRequests(NOW - DAY, 30, 'old');
    await seedRequests(NOW - 1000, 10_000, 'new');
    const result = await purge(deps, settings({ request_log_max_rows: 5 }));
    expect(result.requestLog).toEqual({ byAge: 0, byMaxRows: 30, more: false });
    expect(await countRows(env.TELEMETRY_DB, 'request_log')).toBe(10_000);
    const oldest = await env.TELEMETRY_DB.prepare('SELECT MIN(ts) AS ts FROM request_log').first<{
      ts: number;
    }>();
    expect(oldest?.ts).toBe(NOW - 1000);
  });
});

describe('purge: rollups and audit log', () => {
  it('deletes rollups older than rollup_retention_days (floor 30)', async () => {
    const insert = (hour: number) =>
      env.TELEMETRY_DB.prepare(
        `INSERT INTO request_rollup_hourly (hour, service_id, grant_id, outcome, status_class, requests, upstream_auth_fail, duration_sum_ms)
         VALUES (?, '', '', 'allowed', 2, 1, 0, 1)`,
      ).bind(hour);
    const hour = Math.floor(NOW / HOUR_MS) * HOUR_MS;
    await env.TELEMETRY_DB.batch([insert(hour - 31 * DAY), insert(hour - 29 * DAY)]);
    const result = await purge(deps, settings({ rollup_retention_days: 1 }));
    expect(result.rollups).toBe(1);
    expect(await countRows(env.TELEMETRY_DB, 'request_rollup_hourly')).toBe(1);
  });

  it('never deletes audit events younger than 90 days, whatever the setting says', async () => {
    const insert = (id: string, ts: number) =>
      env.DB.prepare(
        "INSERT INTO audit_log (id, ts, actor_type, action, summary) VALUES (?, ?, 'system', 'x', 'x')",
      ).bind(id, ts);
    await env.DB.batch([insert('aud_old', NOW - 91 * DAY), insert('aud_new', NOW - 89 * DAY)]);
    const result = await purge(deps, settings({ audit_log_retention_days: 1 }));
    expect(result.auditLog).toBe(1);
    const left = await env.DB.prepare('SELECT id FROM audit_log').all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual(['aud_new']);
  });
});

describe('purge: database independence', () => {
  const offline = {
    prepare: () => {
      throw new Error('telemetry offline');
    },
    batch: async () => {
      throw new Error('telemetry offline');
    },
  } as unknown as D1Database;

  it('still purges the control plane when TELEMETRY_DB fails, then rethrows', async () => {
    await env.DB.prepare(
      "INSERT INTO audit_log (id, ts, actor_type, action, summary) VALUES ('aud_old', ?, 'system', 'x', 'x')",
    )
      .bind(NOW - 400 * DAY)
      .run();
    await expect(
      purge({ env: { ...deps.env, TELEMETRY_DB: offline }, now: () => NOW }, settings()),
    ).rejects.toThrow('telemetry offline');
    expect(await countRows(env.DB, 'audit_log')).toBe(0);
  });

  it('still purges request_log when DB fails, then rethrows', async () => {
    await seedRequests(NOW - 30 * DAY, 2);
    await expect(
      purge({ env: { ...deps.env, DB: offline }, now: () => NOW }, settings()),
    ).rejects.toThrow('telemetry offline');
    expect(await countRows(env.TELEMETRY_DB, 'request_log')).toBe(0);
  });

  it('reports both failures when both databases fail', async () => {
    await expect(
      purge(
        { env: { ...deps.env, DB: offline, TELEMETRY_DB: offline }, now: () => NOW },
        settings(),
      ),
    ).rejects.toBeInstanceOf(AggregateError);
  });
});

describe('ROWS_ESTIMATE_SQL (Data retention "Stored now")', () => {
  it('sums the rollups from the hour of the oldest stored record: an upper estimate', async () => {
    const hour = NOW - (NOW % 3_600_000) - 5 * 3_600_000;
    await seedRequests(hour + 1000, 3);
    await env.TELEMETRY_DB.prepare(
      `INSERT INTO request_rollup_hourly (hour, service_id, grant_id, outcome, status_class, requests, upstream_auth_fail, duration_sum_ms)
       VALUES (?, '', '', 'allowed', 2, 3, 0, 0), (?, '', '', 'allowed', 2, 100, 0, 0)`,
    )
      .bind(hour, hour - 3_600_000)
      .run();
    const row = await env.TELEMETRY_DB.prepare(ROWS_ESTIMATE_SQL).first<{ n: number }>();
    // The rollup of the hour before the oldest record is not counted.
    expect(row?.n).toBe(3);
  });
});
