import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { HOUR_MS, LATENCY_BUCKETS, rollupFromRow } from '../../../src/db/rollups';
import type { AppEnv } from '../../../src/env';
import { newId } from '../../../src/lib/ids';
import {
  hourStart,
  lastClosedHours,
  lateRecordHours,
  rollupHours,
} from '../../../src/telemetry/rollup';
import { REQUEST_RECORD_COLUMNS, type RequestRecord } from '../../../src/telemetry/types';

const deps = { env: env as unknown as AppEnv };
const H = Date.UTC(2026, 9, 13, 10); // an hour start

let seq = 0;
const random = (n: number) => {
  seq++;
  return Uint8Array.from({ length: n }, (_, i) => (i === n - 1 ? seq & 0xff : (seq >> 8) & 0xff));
};

function record(ts: number, overrides: Partial<RequestRecord> = {}): RequestRecord {
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
    credential_access_rule_id: 'acr_A',
    global_access_rule_id: null,
    claims_verified: 1,
    caller_subject: null,
    caller_repository: null,
    caller_claims: null,
    jti: null,
    untrusted_iss: null,
    eval_trace: null,
    duration_ms: 10,
    upstream_ms: null,
    weight: 1,
    ip: null,
    user_agent: null,
    colo: null,
    ...overrides,
  };
}

async function insert(records: RequestRecord[]): Promise<void> {
  const sql = `INSERT INTO request_log (${REQUEST_RECORD_COLUMNS.join(', ')}) VALUES (${REQUEST_RECORD_COLUMNS.map(() => '?').join(', ')})`;
  await env.TELEMETRY_DB.batch(
    records.map((r) =>
      env.TELEMETRY_DB.prepare(sql).bind(...REQUEST_RECORD_COLUMNS.map((c) => r[c])),
    ),
  );
}

async function rollups(hour: number) {
  const { results } = await env.TELEMETRY_DB.prepare(
    'SELECT * FROM request_rollup_hourly WHERE hour = ? ORDER BY service_id, credential_access_rule_id, outcome, status_class',
  )
    .bind(hour)
    .all<Record<string, unknown>>();
  return results.map(rollupFromRow);
}

beforeEach(async () => {
  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare('DELETE FROM request_log'),
    env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly'),
  ]);
});

describe('hour helpers', () => {
  it('hourStart floors to the UTC hour', () => {
    expect(hourStart(H + 59 * 60_000 + 999)).toBe(H);
    expect(hourStart(H)).toBe(H);
  });

  it('lastClosedHours excludes the current hour, newest first', () => {
    expect(lastClosedHours(H + 7 * 60_000, 3)).toEqual([
      H - HOUR_MS,
      H - 2 * HOUR_MS,
      H - 3 * HOUR_MS,
    ]);
    expect(lastClosedHours(H, 1)).toEqual([H - HOUR_MS]);
  });

  it('lateRecordHours returns the hours the next cron window no longer covers', () => {
    const ids = [
      H - 3 * HOUR_MS + 1,
      H - 3 * HOUR_MS + 2,
      H - 30 * HOUR_MS,
      H - 2 * HOUR_MS,
      H,
    ].map((ts) => record(ts).id);
    // During 12:00-12:59 the next run recomputes at least 10:00 and 11:00 (13:07 run: 10-12).
    expect(lateRecordHours(ids, H + 59 * 60_000)).toEqual([H - 30 * HOUR_MS, H - 3 * HOUR_MS]);
    expect(lateRecordHours([...ids, 'req_bad'], H + 60_000)).toEqual([
      H - 30 * HOUR_MS,
      H - 3 * HOUR_MS,
    ]);
  });
});

describe('rollupHours', () => {
  it('sums weights per (service, credential access rule, outcome, status class) for requests inside the hour', async () => {
    await insert([
      record(H, { weight: 2 }),
      record(H + 1000, { status: 201, weight: 2 }),
      record(H + 2000, { status: 404, upstream_status: 404 }),
      record(H + 3000, {
        outcome: 'denied',
        status: 403,
        upstream_status: null,
        credential_access_rule_id: null,
        reason: 'no_matching_rule',
      }),
      // Pre-trust failure: no service or credential access rule known.
      record(H + 4000, {
        outcome: 'denied',
        status: 401,
        service_id: null,
        credential_access_rule_id: null,
      }),
      // Outside the hour on both sides.
      record(H - 1, { weight: 100 }),
      record(H + HOUR_MS, { weight: 100 }),
    ]);
    const result = await rollupHours(deps, [H]);
    expect(result).toEqual({ hours: [H], rows: 4 });

    const rows = await rollups(H);
    const summary = rows.map((r) => [
      r.service_id,
      r.credential_access_rule_id,
      r.outcome,
      r.status_class,
      r.requests,
    ]);
    expect(summary).toEqual([
      ['', '', 'denied', 4, 1],
      ['svc_A', '', 'denied', 4, 1],
      ['svc_A', 'acr_A', 'allowed', 2, 4],
      ['svc_A', 'acr_A', 'allowed', 4, 1],
    ]);
  });

  it('counts upstream auth failures only for allowed requests answered 401/403', async () => {
    await insert([
      record(H, { status: 401, upstream_status: 401, weight: 3 }),
      record(H + 1, { status: 403, upstream_status: 403 }),
      record(H + 2, { status: 404, upstream_status: 404 }),
      record(H + 3, { outcome: 'denied', status: 403, upstream_status: null }),
    ]);
    await rollupHours(deps, [H]);
    const rows = await rollups(H);
    const allowed4xx = rows.find((r) => r.outcome === 'allowed' && r.status_class === 4);
    const denied = rows.find((r) => r.outcome === 'denied');
    expect(allowed4xx?.upstream_auth_fail).toBe(4);
    expect(allowed4xx?.requests).toBe(5);
    expect(denied?.upstream_auth_fail).toBe(0);
  });

  it('places durations in disjoint buckets at the documented bounds, weighted', async () => {
    const durations = [
      0, 50, 51, 100, 101, 250, 251, 500, 501, 1000, 1001, 2500, 2501, 5000, 5001, 60000,
    ];
    await insert(durations.map((duration_ms, i) => record(H + i, { duration_ms, weight: 0.5 })));
    await rollupHours(deps, [H]);
    const [row] = await rollups(H);
    expect(LATENCY_BUCKETS.map((b) => b.column)).toEqual([
      'le_50',
      'le_100',
      'le_250',
      'le_500',
      'le_1000',
      'le_2500',
      'le_5000',
      'gt_5000',
    ]);
    // Two values per bucket except le_50 (0, 50) and gt_5000 (5001, 60000): all 2 × 0.5.
    expect(row?.buckets).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(row?.requests).toBe(8);
    expect(row?.duration_sum_ms).toBe(durations.reduce((a, b) => a + b, 0) * 0.5);
  });

  it('is idempotent and never lowers a stored hour after request_log rows are purged', async () => {
    const first = record(H);
    await insert([first, record(H + 1), record(H + 2, { credential_access_rule_id: 'acr_B' })]);
    await rollupHours(deps, [H]);
    expect(await rollupHours(deps, [H])).toEqual({ hours: [H], rows: 0 });

    // A retention purge removes some rows of an hour that is already rolled up.
    await env.TELEMETRY_DB.prepare(
      "DELETE FROM request_log WHERE credential_access_rule_id = 'acr_B' OR id = ?",
    )
      .bind(first.id)
      .run();
    expect(await rollupHours(deps, [H])).toEqual({ hours: [H], rows: 0 });
    expect((await rollups(H)).map((r) => [r.credential_access_rule_id, r.requests])).toEqual([
      ['acr_A', 2],
      ['acr_B', 1],
    ]);
  });

  it('raises a stored hour when late records arrive', async () => {
    await insert([record(H, { duration_ms: 10 })]);
    await rollupHours(deps, [H]);
    await insert([
      record(H + 5, { duration_ms: 3000 }),
      record(H + 6, { credential_access_rule_id: 'acr_B' }),
    ]);
    expect(await rollupHours(deps, [H])).toEqual({ hours: [H], rows: 2 });
    const rows = await rollups(H);
    expect(rows.map((r) => [r.credential_access_rule_id, r.requests, r.duration_sum_ms])).toEqual([
      ['acr_A', 2, 3010],
      ['acr_B', 1, 10],
    ]);
    expect(rows[0]?.buckets).toEqual([1, 0, 0, 0, 0, 0, 1, 0]);
  });

  it('recomputes several hours in one call and leaves other hours alone', async () => {
    await insert([record(H - HOUR_MS), record(H), record(H + HOUR_MS)]);
    await rollupHours(deps, [H + HOUR_MS]);
    expect(await rollupHours(deps, [H, H - HOUR_MS, H])).toEqual({
      hours: [H - HOUR_MS, H],
      rows: 2,
    });
    expect(await rollups(H - HOUR_MS)).toHaveLength(1);
    expect(await rollups(H + HOUR_MS)).toHaveLength(1);
  });

  it('rejects timestamps that are not hour starts', async () => {
    await expect(rollupHours(deps, [H + 1])).rejects.toThrow(RangeError);
    expect(await rollupHours(deps, [])).toEqual({ hours: [], rows: 0 });
  });
});
