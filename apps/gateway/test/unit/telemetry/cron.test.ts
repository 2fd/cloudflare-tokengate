import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getState } from '../../../src/db/settings';
import type { Deps } from '../../../src/deps';
import type { AppEnv } from '../../../src/env';
import { newId } from '../../../src/lib/ids';
import { runCron } from '../../../src/telemetry/cron';

const HOUR = 3_600_000;
const H = Date.UTC(2026, 9, 13, 12);

function makeDeps(now: () => number, overrides: Partial<AppEnv> = {}): Deps {
  return {
    env: { ...(env as unknown as AppEnv), ...overrides },
    fetch: async () => {
      throw new Error('no fetch in cron');
    },
    now,
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    waitUntil: () => {},
  };
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

type ConsoleSpy = { mock: { calls: unknown[][] } };
let info: ConsoleSpy;
let error: ConsoleSpy;

beforeEach(async () => {
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await env.DB.batch([
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM settings'),
    env.DB.prepare('DELETE FROM access_rules'),
    env.DB.prepare('DELETE FROM credentials'),
  ]);
  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare('DELETE FROM request_log'),
    env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly'),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const logged = (spy: ConsoleSpy, type: string) =>
  spy.mock.calls
    .map(([line]) => JSON.parse(String(line)))
    .filter((entry: { type: string }) => entry.type === type);

describe('runCron', () => {
  it('rolls up the last closed hours, purges, and records the heartbeat', async () => {
    const now = H + 7 * 60_000;
    await env.TELEMETRY_DB.prepare(
      `INSERT INTO request_log (id, ts, outcome, status, method, path, claims_verified, duration_ms)
       VALUES (?, ?, 'allowed', 200, 'GET', '/', 1, 10)`,
    )
      .bind(newId('req', H - HOUR + 1, random), H - HOUR + 1)
      .run();

    const summary = await runCron(makeDeps(() => now));
    expect(summary.rollupRows).toBe(1);
    expect(summary.purge.requestLog.more).toBe(false);

    const rolled = await env.TELEMETRY_DB.prepare(
      'SELECT hour, requests FROM request_rollup_hourly',
    ).all();
    expect(rolled.results).toEqual([{ hour: H - HOUR, requests: 1 }]);
    expect(await getState(env.DB, 'cron_last_success_at')).toBe(now);
    expect(logged(info, 'cron.done')).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('records the failure, keeps running the other steps, and rethrows', async () => {
    const broken = {
      prepare: () => {
        throw new Error('telemetry offline');
      },
      batch: async () => {
        throw new Error('telemetry offline');
      },
    } as unknown as D1Database;
    const now = H + 7 * 60_000;

    await expect(runCron(makeDeps(() => now, { TELEMETRY_DB: broken }))).rejects.toThrow(
      'telemetry offline',
    );
    expect(await getState(env.DB, 'cron_last_success_at')).toBeNull();
    expect(await getState(env.DB, 'cron_last_error_at')).toBe(now);
    const message = await getState<string>(env.DB, 'cron_last_error');
    expect(message).toContain('rollup: Error: telemetry offline');
    expect(message).toContain('purge: Error: telemetry offline');
    expect(logged(error, 'cron.failed')[0]).toMatchObject({ steps: ['rollup', 'purge'] });
  });
});

describe('I-CRED-1: cron output never carries stored credential material', () => {
  it('keeps sealed values out of audit rows, settings and log lines', async () => {
    const canary = 'CANARY_SEALED_Y3JvbnNlY3JldA';
    const id = newId('svc', H, random);
    await env.DB.prepare(
      `INSERT INTO credentials (id, slug, name, base_url, injection, credential_sealed, credential_hint, created_at, updated_at)
       VALUES (?, 'canary', 'canary', 'https://api.example.com', '{"kind":"bearer"}', ?, 'xoxb…', 0, 0)`,
    )
      .bind(id, JSON.stringify({ v: 1, kid: 'k1', ct: canary }))
      .run();
    await runCron(makeDeps(() => H + 7 * 60_000));
    const audit = await env.DB.prepare('SELECT * FROM audit_log').all();
    const settings = await env.DB.prepare('SELECT * FROM settings').all();
    const lines = [...info.mock.calls, ...error.mock.calls].map(([line]) => String(line));
    // The cron writes no audit rows (credentials no longer carry an expiry to notify about).
    expect(audit.results).toHaveLength(0);
    expect(JSON.stringify([audit.results, settings.results, lines])).not.toContain(canary);
  });
});
