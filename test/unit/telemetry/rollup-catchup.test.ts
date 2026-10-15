// Rollups catch up on hours the fixed cron window missed: DLQ replays, failed and skipped runs.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertRequestRecordsStatements } from '../../../src/db/requests';
import { HOUR_MS } from '../../../src/db/rollups';
import type { Deps } from '../../../src/deps';
import type { AppEnv } from '../../../src/env';
import { toBase64 } from '../../../src/lib/encoding';
import { newId } from '../../../src/lib/ids';
import { runCron } from '../../../src/telemetry/cron';
import { loadOverview } from '../../../src/telemetry/dashboard';
import { consumeRequestLogBatch } from '../../../src/telemetry/queue-consumer';
import {
  ROLLUP_CATCHUP_HOURS_PER_RUN,
  ROLLUP_WATERMARK_KEY,
  readRollupWatermark,
} from '../../../src/telemetry/rollup';
import type { RequestRecord } from '../../../src/telemetry/types';

const DAY = Date.UTC(2026, 9, 13);
const at = (hour: number, minute = 0) => DAY + hour * HOUR_MS + minute * 60_000;
const KEK = toBase64(Uint8Array.from({ length: 32 }, (_, i) => i));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

function makeDeps(now: number, overrides: Partial<AppEnv> = {}): Deps {
  return {
    env: { ...(env as unknown as AppEnv), TOKENGATE_KEK: KEK, ...overrides },
    fetch: async () => {
      throw new Error('no fetch');
    },
    now: () => now,
    random,
    waitUntil: () => {},
  };
}

const offline = {
  prepare: () => {
    throw new Error('telemetry offline');
  },
  batch: async () => {
    throw new Error('telemetry offline');
  },
} as unknown as D1Database;

function record(ts: number): RequestRecord {
  return {
    id: newId('req', ts, random),
    ts,
    outcome: 'allowed',
    reason: null,
    status: 200,
    upstream_status: 200,
    method: 'GET',
    path: '/',
    service_slug: 'svc',
    service_id: 'svc_A',
    caller_provider_id: 'cpr_A',
    grant_id: 'grt_A',
    claims_verified: 1,
    caller_subject: null,
    caller_repository: null,
    caller_claims: null,
    jti: null,
    untrusted_iss: null,
    eval_trace: null,
    duration_ms: 10,
    upstream_ms: 5,
    weight: 1,
    ip: null,
    user_agent: null,
    colo: null,
  };
}

async function insert(records: RequestRecord[]): Promise<void> {
  await env.TELEMETRY_DB.batch(insertRequestRecordsStatements(env.TELEMETRY_DB, records));
}

function queueBatch(records: RequestRecord[]) {
  const state = { ackedAll: false, retried: false };
  const batch = {
    messages: records.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(0),
      body,
      attempts: 1,
      ack: () => {},
      retry: () => {},
    })),
    queue: 'tokengate-request-log-dlq',
    metadata: {} as MessageBatchMetadata,
    ackAll: () => {
      state.ackedAll = true;
    },
    retryAll: () => {
      state.retried = true;
    },
  } as unknown as MessageBatch<unknown>;
  return { batch, state };
}

async function rolledUp(hour: number): Promise<number> {
  const row = await env.TELEMETRY_DB.prepare(
    'SELECT SUM(requests) AS n FROM request_rollup_hourly WHERE hour = ?',
  )
    .bind(hour)
    .first<{ n: number | null }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await env.DB.prepare('DELETE FROM settings').run();
  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare('DELETE FROM request_log'),
    env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly'),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rollup catch-up', () => {
  it('counts records a DLQ replay delivers hours late on the dashboard', async () => {
    await runCron(makeDeps(at(11, 7)));
    expect(await readRollupWatermark(env.DB)).toBe(at(7));

    const replayed = record(at(7, 30));
    const { batch, state } = queueBatch([replayed]);
    await consumeRequestLogBatch(batch, makeDeps(at(12, 5)));
    expect(state).toEqual({ ackedAll: true, retried: false });
    expect(await rolledUp(at(7))).toBe(1);

    await runCron(makeDeps(at(12, 7)));
    const dashboard = await loadOverview(makeDeps(at(12, 20)), '24h');
    expect(dashboard.totals.requests).toBe(1);
  });

  it('retries a replayed batch whose late rollup fails, without duplicating records', async () => {
    const replayed = record(at(3));
    // The first batch call inserts the records; the second (the late-hour rollup) fails.
    let calls = 0;
    const failing = {
      prepare: (sql: string) => env.TELEMETRY_DB.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        calls++;
        if (calls === 2) throw new Error('D1_ERROR');
        return env.TELEMETRY_DB.batch(statements);
      },
    };
    const first = queueBatch([replayed]);
    await consumeRequestLogBatch(
      first.batch,
      makeDeps(at(12), { TELEMETRY_DB: failing as unknown as D1Database }),
    );
    expect(first.state).toEqual({ ackedAll: false, retried: true });
    expect(await rolledUp(at(3))).toBe(0);

    const retry = queueBatch([replayed]);
    await consumeRequestLogBatch(
      retry.batch,
      makeDeps(at(12), { TELEMETRY_DB: failing as unknown as D1Database }),
    );
    expect(retry.state.ackedAll).toBe(true);
    expect(await rolledUp(at(3))).toBe(1);
  });

  it('fills hours missed while TELEMETRY_DB was offline for more than 3 runs', async () => {
    await runCron(makeDeps(at(5, 7)));
    await insert([5, 6, 7, 8, 9].map((hour) => record(at(hour, 30))));
    for (const hour of [6, 7, 8, 9, 10]) {
      await expect(runCron(makeDeps(at(hour, 7), { TELEMETRY_DB: offline }))).rejects.toThrow();
    }
    expect(await readRollupWatermark(env.DB)).toBe(at(1));

    await runCron(makeDeps(at(11, 7)));
    for (const hour of [5, 6, 7, 8, 9]) expect(await rolledUp(at(hour))).toBe(1);
    expect(await readRollupWatermark(env.DB)).toBe(at(7));
  });

  it('fills hours missed when cron triggers did not fire', async () => {
    await runCron(makeDeps(at(2, 7)));
    await insert([record(at(3, 10)), record(at(4, 50))]);
    await runCron(makeDeps(at(12, 7)));
    expect(await rolledUp(at(3))).toBe(1);
    expect(await rolledUp(at(4))).toBe(1);
  });

  // The consumer leaves records of the last 2 closed hours to the next cron run; when that run is
  // skipped or fails, the watermark must still cover their hour.
  it.each([
    ['did not fire', false],
    ['failed', true],
  ])('counts records stored after a run when the next cron runs %s', async (_, failed) => {
    await runCron(makeDeps(at(2, 7)));
    const { batch, state } = queueBatch([record(at(1, 30)), record(at(0, 59))]);
    await consumeRequestLogBatch(batch, makeDeps(at(2, 30)));
    expect(state.ackedAll).toBe(true);
    if (failed) {
      for (const hour of [3, 4]) {
        await expect(runCron(makeDeps(at(hour, 7), { TELEMETRY_DB: offline }))).rejects.toThrow();
      }
    }
    await runCron(makeDeps(at(5, 7)));
    expect(await rolledUp(at(0))).toBe(1);
    expect(await rolledUp(at(1))).toBe(1);
  });

  it('catches up in bounded batches and advances the watermark only over rolled-up hours', async () => {
    const now = at(48 + 12, 7);
    await env.DB.prepare(
      'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, 0, NULL)',
    )
      .bind(ROLLUP_WATERMARK_KEY, JSON.stringify(at(0)))
      .run();
    await insert(Array.from({ length: 40 }, (_, i) => record(at(i + 1, 1))));

    await runCron(makeDeps(now));
    const firstWatermark = at(ROLLUP_CATCHUP_HOURS_PER_RUN);
    expect(await readRollupWatermark(env.DB)).toBe(firstWatermark);
    expect(await rolledUp(at(ROLLUP_CATCHUP_HOURS_PER_RUN))).toBe(1);
    expect(await rolledUp(at(ROLLUP_CATCHUP_HOURS_PER_RUN + 1))).toBe(0);

    await runCron(makeDeps(now + HOUR_MS));
    for (let hour = 1; hour <= 40; hour++) expect(await rolledUp(at(hour))).toBe(1);
    expect(await readRollupWatermark(env.DB)).toBe(at(2 * ROLLUP_CATCHUP_HOURS_PER_RUN));

    await runCron(makeDeps(now + 2 * HOUR_MS));
    expect(await readRollupWatermark(env.DB)).toBe(at(48 + 10));
  });

  it('starts from the oldest request_log row when no watermark is stored', async () => {
    await insert([record(at(1, 1)), record(at(6, 1))]);
    await runCron(makeDeps(at(12, 7)));
    expect(await rolledUp(at(1))).toBe(1);
    expect(await rolledUp(at(6))).toBe(1);
    expect(await readRollupWatermark(env.DB)).toBe(at(8));
  });

  it('never lowers a stored rollup when catching up over purged hours', async () => {
    const rows = [record(at(1, 1)), record(at(1, 2)), record(at(1, 3))];
    await insert(rows);
    await runCron(makeDeps(at(3, 7)));
    expect(await rolledUp(at(1))).toBe(3);

    // Purge two of the hour's rows, then force a full recompute by clearing the watermark.
    await env.TELEMETRY_DB.prepare('DELETE FROM request_log WHERE id IN (?, ?)')
      .bind(rows[0]?.id, rows[1]?.id)
      .run();
    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(ROLLUP_WATERMARK_KEY).run();
    await runCron(makeDeps(at(12, 7)));
    expect(await rolledUp(at(1))).toBe(3);
  });
});
