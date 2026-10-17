import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listRequests } from '../../../src/db/requests';
import type { Deps } from '../../../src/deps';
import type { AppEnv } from '../../../src/env';
import { consumeRequestLogBatch, RETRY_DELAY_SECONDS } from '../../../src/telemetry/queue-consumer';
import type { RequestRecord } from '../../../src/telemetry/types';

function record(n: number): RequestRecord {
  return {
    id: `req_01JT${String(n).padStart(22, '0')}`,
    ts: n,
    outcome: 'allowed',
    reason: null,
    status: 200,
    upstream_status: 200,
    method: 'GET',
    path: `/item/${n}`,
    service_slug: 'echo',
    service_id: 'svc_1',
    credential_access_rule_id: 'cpr_1',
    grant_id: 'grt_1',
    claims_verified: 1,
    caller_subject: 's',
    caller_repository: 'acme/app',
    caller_claims: '{}',
    jti: null,
    untrusted_iss: null,
    eval_trace: null,
    duration_ms: 5,
    upstream_ms: 4,
    weight: 2,
    ip: null,
    user_agent: null,
    colo: null,
  };
}

interface FakeBatch {
  batch: MessageBatch<unknown>;
  acked: string[];
  ackedAll: boolean;
  retriedAll: { delaySeconds?: number } | null;
}

function fakeBatch(bodies: unknown[]): FakeBatch {
  const state: FakeBatch = {
    batch: undefined as unknown as MessageBatch<unknown>,
    acked: [],
    ackedAll: false,
    retriedAll: null,
  };
  const messages = bodies.map((body, i) => ({
    id: `m${i}`,
    timestamp: new Date(0),
    body,
    attempts: 1,
    ack: () => state.acked.push(`m${i}`),
    retry: () => {},
  }));
  state.batch = {
    messages,
    queue: 'tokengate-request-log',
    metadata: {} as MessageBatchMetadata,
    ackAll: () => {
      state.ackedAll = true;
    },
    retryAll: (options) => {
      state.retriedAll = options ?? {};
    },
  } as MessageBatch<unknown>;
  return state;
}

function deps(db: D1Database = env.TELEMETRY_DB): Deps {
  return {
    env: { ...(env as unknown as AppEnv), TELEMETRY_DB: db },
    fetch: async () => {
      throw new Error('no fetch');
    },
    now: () => 0,
    random: (n) => new Uint8Array(n),
    waitUntil: () => {},
  };
}

beforeEach(async () => {
  await env.TELEMETRY_DB.prepare('DELETE FROM request_log').run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('consumeRequestLogBatch', () => {
  it('inserts a full batch of 100 records in one D1 batch and acks all', async () => {
    const records = Array.from({ length: 100 }, (_, i) => record(i + 1));
    const state = fakeBatch(records);
    const batchSpy = vi.spyOn(env.TELEMETRY_DB, 'batch');
    await consumeRequestLogBatch(state.batch, deps());
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(state.ackedAll).toBe(true);
    expect(state.retriedAll).toBeNull();
    const stored = await listRequests(env.TELEMETRY_DB, { limit: 200 });
    expect(stored).toHaveLength(100);
    expect(stored.find((r) => r.id === records[41]?.id)).toEqual(records[41]);
  });

  it('acks and drops invalid messages, logging only the message id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = fakeBatch([record(1), { id: 'req_x', secret: 'leak' }, 'text', record(2)]);
    await consumeRequestLogBatch(state.batch, deps());
    expect(state.acked).toEqual(['m1', 'm2']);
    expect(state.ackedAll).toBe(true);
    expect(await listRequests(env.TELEMETRY_DB)).toHaveLength(2);
    expect(JSON.stringify(error.mock.calls)).not.toContain('leak');
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      type: 'telemetry.invalid_queue_message',
      message_id: 'm1',
    });
  });

  it('does not touch D1 when every message is invalid', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const batchSpy = vi.spyOn(env.TELEMETRY_DB, 'batch');
    const state = fakeBatch([null, 42]);
    await consumeRequestLogBatch(state.batch, deps());
    expect(batchSpy).not.toHaveBeenCalled();
    expect(state.acked).toEqual(['m0', 'm1']);
  });

  it('retries the whole batch after a D1 error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      prepare: (sql: string) => env.TELEMETRY_DB.prepare(sql),
      batch: async () => {
        throw new Error('D1_ERROR: overloaded');
      },
    } as unknown as D1Database;
    const state = fakeBatch([record(1)]);
    await consumeRequestLogBatch(state.batch, deps(broken));
    expect(state.retriedAll).toEqual({ delaySeconds: RETRY_DELAY_SECONDS });
    expect(state.ackedAll).toBe(false);
  });

  it('is idempotent under redelivery', async () => {
    await consumeRequestLogBatch(fakeBatch([record(1), record(2)]).batch, deps());
    const redelivered = fakeBatch([record(1), record(2), record(3)]);
    await consumeRequestLogBatch(redelivered.batch, deps());
    expect(redelivered.ackedAll).toBe(true);
    expect(await listRequests(env.TELEMETRY_DB)).toHaveLength(3);
  });
});
