import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listRequests } from '../../src/db/requests';
import type { Deps } from '../../src/deps';
import type { AppEnv } from '../../src/env';
import { consumeRequestLogBatch } from '../../src/telemetry/queue-consumer';
import { isRequestRecord } from '../../src/telemetry/record';
import type { RequestRecord } from '../../src/telemetry/types';
import { setupProxy } from '../helpers/proxy-fixtures';

afterEach(() => vi.restoreAllMocks());

// The shape workerd fetch() returns for `HTTP/1.1 999 X`: the Response constructor cannot build it.
// workerd passes through any status line it can parse as an int32, e.g. 1000, 65535, 42, 99 (from
// "099"), 0 (from "4294967296") and negative values (-1 from "4294967295").
const rawStatus = (status: number) => () =>
  ({ status, headers: new Headers(), body: null }) as unknown as Response;

function consumerDeps(): Deps {
  return {
    env: env as unknown as AppEnv,
    fetch: async () => {
      throw new Error('no fetch');
    },
    now: () => Date.now(),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    waitUntil: () => {},
  };
}

/** Delivers `records` to the queue consumer as one batch; returns the acked message ids. */
async function deliver(records: RequestRecord[]): Promise<string[]> {
  const acked: string[] = [];
  const batch = {
    messages: records.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(),
      attempts: 1,
      body,
      ack: () => acked.push(`m${i}`),
      retry: () => {},
    })),
    queue: 'tokengate-request-log',
    metadata: {},
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<unknown>;
  await consumeRequestLogBatch(batch, consumerDeps());
  return acked;
}

describe('upstream statuses outside 200-599', () => {
  it.each([999, 600, 199, 101, 100, 1000, 65535, 99, 42, 0, -1, 2 ** 31 - 1, -(2 ** 31)])(
    'maps %i to 502 upstream_unreachable with reason upstream_invalid_status',
    async (status) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fx = await setupProxy({ upstream: rawStatus(status) });
      const response = await fx.call('/charge', { method: 'POST', body: '{}' });
      expect(response.status).toBe(502);
      expect(response.headers.get('x-tokengate-error')).toBe('upstream_unreachable');
      const body = await response.json<{ error: { message: string } }>();
      expect(body.error.message).toContain('may have processed the request');
      expect(fx.upstreamCalls).toHaveLength(1);
      const [record] = await fx.records();
      expect(record).toMatchObject({
        outcome: 'error',
        reason: 'upstream_invalid_status',
        upstream_status: status,
      });
      expect(error).not.toHaveBeenCalled();
      expect(warn.mock.calls.map((call) => JSON.parse(String(call[0])))).toContainEqual(
        expect.objectContaining({ type: 'proxy.upstream_failed', error: 'InvalidStatus' }),
      );
    },
  );

  it.each([999, 1000, 65535, 99, 42, 0, -1, 2 ** 31 - 1, -(2 ** 31)])(
    'the record for status %i passes the queue consumer and is stored',
    async (status) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const queued: RequestRecord[] = [];
      const fx = await setupProxy({
        upstream: rawStatus(status),
        env: {
          REQUEST_LOG_QUEUE: { send: async (record: RequestRecord) => void queued.push(record) },
        } as never,
      });
      expect((await fx.call('/charge', { method: 'POST', body: '{}' })).status).toBe(502);
      expect(await fx.records()).toEqual([]);
      expect(queued).toHaveLength(1);
      expect(queued.map(isRequestRecord)).toEqual([true]);

      expect(await deliver(queued)).toEqual([]);
      expect(error).not.toHaveBeenCalled();
      const stored = await listRequests(env.TELEMETRY_DB, { limit: 10 });
      expect(stored).toEqual([
        expect.objectContaining({
          id: queued[0]?.id,
          reason: 'upstream_invalid_status',
          upstream_status: status,
        }),
      ]);
    },
  );

  it('passes 599 through unchanged', async () => {
    const fx = await setupProxy({ upstream: () => new Response('x', { status: 599 }) });
    const response = await fx.call('/a');
    expect(response.status).toBe(599);
    expect(response.headers.get('x-tokengate-source')).toBe('upstream');
  });
});
