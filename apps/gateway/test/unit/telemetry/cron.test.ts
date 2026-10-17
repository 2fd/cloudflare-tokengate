import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, putSettingStatement } from '../../../src/db/settings';
import type { Deps } from '../../../src/deps';
import type { AppEnv } from '../../../src/env';
import { newId } from '../../../src/lib/ids';
import { runCron, sendCredentialExpiryNotices } from '../../../src/telemetry/cron';

const DAY = 86_400_000;
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

async function insertService(
  slug: string,
  expiresAt: number | null,
  sealed = true,
): Promise<string> {
  const id = newId('svc', H, random);
  await env.DB.prepare(
    `INSERT INTO credentials (id, slug, name, base_url, injection, credential_sealed, credential_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'https://api.example.com', '{"kind":"bearer"}', ?, ?, 0, 0)`,
  )
    .bind(id, slug, slug, sealed ? '{"v":1}' : null, expiresAt)
    .run();
  return id;
}

async function expiryEvents() {
  const { results } = await env.DB.prepare(
    "SELECT actor_type, target_id, summary, diff FROM audit_log WHERE action = 'credential.expiring' ORDER BY id",
  ).all<{ actor_type: string; target_id: string; summary: string; diff: string }>();
  return results.map((row) => ({ ...row, diff: JSON.parse(row.diff) }));
}

type ConsoleSpy = { mock: { calls: unknown[][] } };
let info: ConsoleSpy;
let error: ConsoleSpy;

beforeEach(async () => {
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await env.DB.batch([
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM settings'),
    env.DB.prepare('DELETE FROM issuer_access_rules'),
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
    const serviceId = await insertService('slack', H + 2 * DAY);
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
    // The expiry step is independent of the telemetry database.
    expect((await expiryEvents()).map((e) => e.target_id)).toEqual([serviceId]);
  });
});

describe('sendCredentialExpiryNotices', () => {
  it('writes one system audit event per service and threshold', async () => {
    let now = H;
    const deps = makeDeps(() => now);
    const expiresAt = H + 10 * DAY;
    const id = await insertService('github', expiresAt);
    await insertService('far', H + 30 * DAY);
    await insertService('no-credential', H + DAY, false);
    await insertService('no-expiry', null);

    expect(await sendCredentialExpiryNotices(deps)).toBe(1);
    expect(await sendCredentialExpiryNotices(deps)).toBe(0);
    now = expiresAt - 2 * DAY;
    expect(await sendCredentialExpiryNotices(deps)).toBe(1);
    now = expiresAt + DAY;
    expect(await sendCredentialExpiryNotices(deps)).toBe(0);

    const events = await expiryEvents();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.actor_type === 'system' && e.target_id === id)).toBe(true);
    expect(events.map((e) => e.diff.threshold_days)).toEqual([14, 3]);
    expect(events[0]?.summary).toBe(
      `Credential of service "github" expires within 14 days (${new Date(expiresAt).toISOString()})`,
    );
    expect(logged(info, 'audit.event')).toHaveLength(2);
  });

  it('sends only the most urgent notice when several thresholds are crossed at once', async () => {
    await insertService('late', H + DAY);
    expect(await sendCredentialExpiryNotices(makeDeps(() => H))).toBe(1);
    expect((await expiryEvents()).map((e) => e.diff.threshold_days)).toEqual([3]);
    expect(await sendCredentialExpiryNotices(makeDeps(() => H))).toBe(0);
  });

  it('notifies again after a new expiry date is entered, and reports expired credentials', async () => {
    const id = await insertService('rotated', H + 10 * DAY);
    const deps = makeDeps(() => H);
    await sendCredentialExpiryNotices(deps);
    await env.DB.prepare('UPDATE credentials SET credential_expires_at = ? WHERE id = ?')
      .bind(H - 1, id)
      .run();
    expect(await sendCredentialExpiryNotices(deps)).toBe(1);
    const expired = (await expiryEvents()).find((e) => e.diff.expires_at === H - 1);
    expect(expired?.summary).toBe(
      `Credential of service "rotated" expired at ${new Date(H - 1).toISOString()}`,
    );
    expect(expired?.diff).toEqual({ threshold_days: 3, expires_at: H - 1 });
  });

  it('drops dedupe state for credentials that left the window', async () => {
    const id = await insertService('gone', H + 10 * DAY);
    const deps = makeDeps(() => H);
    await sendCredentialExpiryNotices(deps);
    expect(Object.keys((await getState(env.DB, 'credential_expiry_notices')) ?? {})).toEqual([id]);
    await env.DB.prepare('DELETE FROM credentials WHERE id = ?').bind(id).run();
    await sendCredentialExpiryNotices(deps);
    expect(await getState(env.DB, 'credential_expiry_notices')).toEqual({});
  });
});

describe('I-AUDIT-1: credential.expiring events commit with their dedupe state (SQL compare-and-swap)', () => {
  it('writes each notice once when two cron invocations overlap', async () => {
    await insertService('overlap', H + DAY);
    const deps = makeDeps(() => H);
    const counts = await Promise.all([
      sendCredentialExpiryNotices(deps),
      sendCredentialExpiryNotices(deps),
    ]);
    expect(counts.sort()).toEqual([0, 1]);
    expect(await expiryEvents()).toHaveLength(1);
    expect(logged(info, 'audit.event')).toHaveLength(1);
  });

  it('writes nothing when the dedupe state changed after it was read', async () => {
    const id = await insertService('raced', H + DAY);
    const real = env.DB;
    // Another run commits its state between this run's read and its batch.
    const racing = new Proxy(real, {
      get(target, key) {
        if (key === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            await putSettingStatement(
              real,
              'credential_expiry_notices',
              { [id]: { expires_at: H + DAY, notified: [14, 3] } },
              H,
              null,
            ).run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(await sendCredentialExpiryNotices(makeDeps(() => H, { DB: racing }))).toBe(0);
    expect(await expiryEvents()).toHaveLength(0);
    expect(logged(info, 'audit.event')).toHaveLength(0);
    expect(await getState(env.DB, 'credential_expiry_notices')).toEqual({
      [id]: { expires_at: H + DAY, notified: [14, 3] },
    });
  });
});

describe('I-CRED-1: cron output never carries stored credential material', () => {
  it('keeps sealed values out of audit rows, settings and log lines', async () => {
    const canary = 'CANARY_SEALED_Y3JvbnNlY3JldA';
    const id = newId('svc', H, random);
    await env.DB.prepare(
      `INSERT INTO credentials (id, slug, name, base_url, injection, credential_sealed, credential_hint, credential_expires_at, created_at, updated_at)
       VALUES (?, 'canary', 'canary', 'https://api.example.com', '{"kind":"bearer"}', ?, 'xoxb…', ?, 0, 0)`,
    )
      .bind(id, JSON.stringify({ v: 1, kid: 'k1', ct: canary }), H + DAY)
      .run();
    await runCron(makeDeps(() => H + 7 * 60_000));
    const audit = await env.DB.prepare('SELECT * FROM audit_log').all();
    const settings = await env.DB.prepare('SELECT * FROM settings').all();
    const lines = [...info.mock.calls, ...error.mock.calls].map(([line]) => String(line));
    expect(audit.results).toHaveLength(1);
    expect(JSON.stringify([audit.results, settings.results, lines])).not.toContain(canary);
  });
});
