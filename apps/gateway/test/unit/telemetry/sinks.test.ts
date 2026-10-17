import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRequest } from '../../../src/db/requests';
import type { Deps } from '../../../src/deps';
import type { AppEnv } from '../../../src/env';
import { TokenBucket } from '../../../src/lib/bucket';
import {
  admitPretrustRecord,
  PRETRUST_LOG_BUDGET_PER_MINUTE,
  recordRequest,
  resetPretrustBudgetForTests,
} from '../../../src/telemetry/sinks';
import type { ArchiveRecord, RequestRecord } from '../../../src/telemetry/types';

const SECRET_IN_ERROR = 'error-text-with-sensitive-detail';

function record(id = 'req_01JT0000000000000000000001'): RequestRecord {
  return {
    id,
    ts: 1,
    outcome: 'denied',
    reason: 'no_matching_grant',
    status: 403,
    upstream_status: null,
    method: 'GET',
    path: '/a',
    service_slug: 'echo',
    service_id: 'svc_1',
    credential_access_rule_id: 'cpr_1',
    grant_id: null,
    claims_verified: 1,
    caller_subject: 's',
    caller_repository: 'acme/app',
    caller_claims: '{}',
    jti: null,
    untrusted_iss: null,
    eval_trace: '[]',
    duration_ms: 3,
    upstream_ms: null,
    weight: 1,
    ip: null,
    user_agent: null,
    colo: null,
  };
}

function deps(extra: Partial<AppEnv> = {}): Deps {
  return {
    env: { ...(env as unknown as AppEnv), ...extra },
    fetch: async () => {
      throw new Error('no fetch');
    },
    now: () => 0,
    random: (n) => new Uint8Array(n),
    waitUntil: () => {},
  };
}

const failing = () => {
  throw new Error(SECRET_IN_ERROR);
};

beforeEach(async () => {
  await env.TELEMETRY_DB.prepare('DELETE FROM request_log').run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordRequest', () => {
  it('inserts directly into TELEMETRY_DB when no queue is bound', async () => {
    await recordRequest(deps(), record());
    expect(await getRequest(env.TELEMETRY_DB, record().id)).toEqual(record());
  });

  it('sends to the queue when bound, without a direct insert', async () => {
    const sent: RequestRecord[] = [];
    const queue = {
      send: async (r: RequestRecord) => void sent.push(r),
    } as unknown as Queue<RequestRecord>;
    await recordRequest(deps({ REQUEST_LOG_QUEUE: queue }), record());
    expect(sent).toEqual([record()]);
    expect(await getRequest(env.TELEMETRY_DB, record().id)).toBeNull();
  });

  it('falls back to a direct insert when the queue send fails, logging a code only', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const queue = { send: failing } as unknown as Queue<RequestRecord>;
    await recordRequest(deps({ REQUEST_LOG_QUEUE: queue }), record());
    expect(await getRequest(env.TELEMETRY_DB, record().id)).not.toBeNull();
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      type: 'telemetry.sink_failed',
      code: 'request_log_queue_send_failed',
      request_id: record().id,
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain(SECRET_IN_ERROR);
  });

  it('sends archive records when REQUEST_ARCHIVE is bound', async () => {
    const archived: ArchiveRecord[] = [];
    const archive = { send: async (rs: ArchiveRecord[]) => void archived.push(...rs) };
    await recordRequest(deps({ REQUEST_ARCHIVE: archive as never }), record());
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ id: record().id, schema_version: 1 });
    expect(archived[0]).not.toHaveProperty('eval_trace');
  });

  it('never throws, whatever fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenDb = {
      prepare: () => ({ bind: () => ({}) }),
      batch: failing,
    } as unknown as D1Database;
    await expect(
      recordRequest(
        deps({
          TELEMETRY_DB: brokenDb,
          REQUEST_LOG_QUEUE: { send: failing } as unknown as Queue<RequestRecord>,
          REQUEST_ARCHIVE: { send: failing } as never,
        }),
        record(),
      ),
    ).resolves.toBeUndefined();
    const codes = error.mock.calls.map((call) => JSON.parse(String(call[0])).code);
    expect(codes.sort()).toEqual([
      'request_archive_send_failed',
      'request_log_insert_failed',
      'request_log_queue_send_failed',
    ]);
    expect(JSON.stringify(error.mock.calls)).not.toContain(SECRET_IN_ERROR);
  });

  it('is idempotent per request id', async () => {
    await recordRequest(deps(), record());
    await recordRequest(deps(), { ...record(), status: 500 });
    expect((await getRequest(env.TELEMETRY_DB, record().id))?.status).toBe(403);
  });
});

describe('TokenBucket', () => {
  it('allows a burst of `capacity`, then refills continuously', () => {
    const bucket = new TokenBucket(3, 3000);
    expect([0, 0, 0, 0].map((t) => bucket.take(t))).toEqual([true, true, true, false]);
    expect(bucket.take(999)).toBe(false);
    expect(bucket.take(1001)).toBe(true);
    expect(bucket.take(1001)).toBe(false);
    expect(bucket.take(100_000)).toBe(true);
    expect([1, 2, 3].map(() => bucket.take(100_000))).toEqual([true, true, false]);
  });

  it('does not refill when the clock goes backwards', () => {
    const bucket = new TokenBucket(1, 1000);
    expect(bucket.take(5000)).toBe(true);
    expect(bucket.take(0)).toBe(false);
    expect(bucket.take(5999)).toBe(false);
    expect(bucket.take(6001)).toBe(true);
  });

  it('rejects a non-positive capacity or period', () => {
    expect(() => new TokenBucket(0, 1000)).toThrow();
    expect(() => new TokenBucket(1, 0)).toThrow();
  });
});

describe('admitPretrustRecord', () => {
  beforeEach(() => {
    resetPretrustBudgetForTests();
  });

  it('admits the per-minute budget, then counts drops with one warning per minute', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const admitted = Array.from({ length: 100 }, () => admitPretrustRecord(0)).filter(Boolean);
    expect(admitted).toHaveLength(PRETRUST_LOG_BUDGET_PER_MINUTE);
    expect(warn).toHaveBeenCalledTimes(1);

    // One token is refilled every 60 s / budget.
    const oneToken = 60_000 / PRETRUST_LOG_BUDGET_PER_MINUTE + 1;
    expect(admitPretrustRecord(oneToken)).toBe(true);
    expect(admitPretrustRecord(oneToken)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(admitPretrustRecord(60_000)).toBe(true);
    for (let i = 0; i < 100; i++) admitPretrustRecord(60_000);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(warn.mock.calls[1]?.[0]))).toEqual({
      type: 'telemetry.pretrust_records_dropped',
      // Drops at 0 after the first warning, the drop at oneToken, and this one.
      count: 100 - PRETRUST_LOG_BUDGET_PER_MINUTE - 1 + 1 + 1,
    });
  });
});
