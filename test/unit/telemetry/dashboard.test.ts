import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadKeyring } from '../../../src/crypto/keyring';
import { resetSchemaStatusCacheForTests } from '../../../src/db/migrations';
import { HOUR_MS, type RollupRow } from '../../../src/db/rollups';
import { putSettingStatement } from '../../../src/db/settings';
import type { AppEnv } from '../../../src/env';
import { toBase64 } from '../../../src/lib/encoding';
import { newId } from '../../../src/lib/ids';
import {
  dashboardBanners,
  loadDashboard,
  percentile,
  trafficStats,
} from '../../../src/telemetry/dashboard';

const DAY = 86_400_000;
const H = Date.UTC(2026, 9, 13, 12); // current hour
const NOW = H + 20 * 60_000;
const KEK = toBase64(Uint8Array.from({ length: 32 }, (_, i) => i));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

const deps = (overrides: Partial<AppEnv> = {}, now = NOW) => ({
  env: { ...(env as unknown as AppEnv), TOKENGATE_KEK: KEK, ...overrides },
  now: () => now,
});

function rollup(overrides: Partial<RollupRow>): RollupRow {
  return {
    hour: H - HOUR_MS,
    service_id: 'svc_A',
    grant_id: 'grt_A',
    outcome: 'allowed',
    status_class: 2,
    requests: 0,
    upstream_auth_fail: 0,
    duration_sum_ms: 0,
    buckets: [0, 0, 0, 0, 0, 0, 0, 0],
    ...overrides,
  };
}

async function insertRollups(rows: RollupRow[]): Promise<void> {
  await env.TELEMETRY_DB.batch(
    rows.map((r) =>
      env.TELEMETRY_DB.prepare(
        `INSERT INTO request_rollup_hourly (hour, service_id, grant_id, outcome, status_class, requests, upstream_auth_fail, duration_sum_ms,
           le_50, le_100, le_250, le_500, le_1000, le_2500, le_5000, gt_5000)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        r.hour,
        r.service_id,
        r.grant_id,
        r.outcome,
        r.status_class,
        r.requests,
        r.upstream_auth_fail,
        r.duration_sum_ms,
        ...r.buckets,
      ),
    ),
  );
}

async function insertRequest(
  ts: number,
  fields: {
    outcome?: string;
    status?: number;
    upstream_status?: number | null;
    duration_ms?: number;
    service_id?: string | null;
    service_slug?: string | null;
    reason?: string | null;
  },
): Promise<string> {
  const id = newId('req', ts, random);
  await env.TELEMETRY_DB.prepare(
    `INSERT INTO request_log (id, ts, outcome, reason, status, upstream_status, method, path, service_slug, service_id, grant_id, claims_verified, duration_ms, weight)
     VALUES (?, ?, ?, ?, ?, ?, 'GET', '/', ?, ?, 'grt_A', 1, ?, 1)`,
  )
    .bind(
      id,
      ts,
      fields.outcome ?? 'allowed',
      fields.reason ?? null,
      fields.status ?? 200,
      fields.upstream_status === undefined ? 200 : fields.upstream_status,
      fields.service_slug === undefined ? 'alpha' : fields.service_slug,
      fields.service_id === undefined ? 'svc_A' : fields.service_id,
      fields.duration_ms ?? 30,
    )
    .run();
  return id;
}

async function insertService(
  id: string,
  slug: string,
  sealed: string | null,
  expiresAt: number | null,
) {
  await env.DB.prepare(
    `INSERT INTO services (id, slug, name, base_url, injection, credential_sealed, credential_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'https://api.example.com', '{"kind":"bearer"}', ?, ?, 0, 0)`,
  )
    .bind(id, slug, `${slug} API`, sealed, expiresAt)
    .run();
}

// Users are not deleted between tests: the last-owner trigger (I-OWNER-1) forbids it.
async function insertOwner(id: string, email: string) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, email, role, status, created_at, updated_at) VALUES (?, ?, 'owner', 'active', 0, 0)",
  )
    .bind(id, email)
    .run();
}

const setCronSuccess = (at: number) =>
  putSettingStatement(env.DB, 'cron_last_success_at', at, at, null).run();

beforeEach(async () => {
  resetSchemaStatusCacheForTests();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM settings'),
    env.DB.prepare('DELETE FROM grants'),
    env.DB.prepare('DELETE FROM services'),
    env.DB.prepare('DELETE FROM user_identities'),
  ]);
  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare('DELETE FROM request_log'),
    env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly'),
  ]);
});

describe('percentile', () => {
  it('interpolates inside the bucket holding the rank', () => {
    // 10 requests in (100, 250]: median at 100 + 0.5 × 150.
    expect(percentile([0, 0, 10, 0, 0, 0, 0, 0], 0.5)).toEqual({ ms: 175, overflow: false });
    // 50 in [0, 50], 50 in (50, 100]: p50 is the top of the first bucket, p95 at 50 + 0.9 × 50.
    expect(percentile([50, 50, 0, 0, 0, 0, 0, 0], 0.5)).toEqual({ ms: 50, overflow: false });
    expect(percentile([50, 50, 0, 0, 0, 0, 0, 0], 0.95)?.ms).toBeCloseTo(95);
  });

  it('reports the open-ended bucket as overflow at its lower bound', () => {
    expect(percentile([1, 0, 0, 0, 0, 0, 0, 9], 0.95)).toEqual({ ms: 5000, overflow: true });
  });

  it('is null without data', () => {
    expect(percentile([0, 0, 0, 0, 0, 0, 0, 0], 0.5)).toBeNull();
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe('trafficStats', () => {
  it('counts gateway errors and upstream 5xx as errors; percentiles use allowed requests only', () => {
    const stats = trafficStats([
      rollup({ requests: 6, buckets: [6, 0, 0, 0, 0, 0, 0, 0] }),
      rollup({ status_class: 5, requests: 2, buckets: [0, 0, 0, 0, 0, 0, 0, 2] }),
      rollup({
        outcome: 'denied',
        status_class: 4,
        requests: 3,
        buckets: [0, 0, 0, 0, 0, 0, 0, 3],
      }),
      rollup({ outcome: 'error', status_class: 5, requests: 1 }),
      rollup({
        status_class: 4,
        requests: 2,
        upstream_auth_fail: 2,
        buckets: [2, 0, 0, 0, 0, 0, 0, 0],
      }),
    ]);
    expect(stats).toMatchObject({
      requests: 14,
      allowed: 10,
      denied: 3,
      errors: 3,
      upstreamAuthFailures: 2,
    });
    expect(stats.errorRate).toBeCloseTo(3 / 14);
    // Allowed: 8 in [0, 50] and 2 above 5000. Median at 5/8 of the first bucket.
    expect(stats.p50).toEqual({ ms: 31.25, overflow: false });
    expect(stats.p95).toEqual({ ms: 5000, overflow: true });
  });
});

describe('loadDashboard', () => {
  it('merges 23 hours of rollups with the live current hour when the cron ran this hour', async () => {
    await insertService('svc_A', 'alpha', null, null);
    await setCronSuccess(H + 7 * 60_000);
    await insertRollups([
      rollup({ hour: H - HOUR_MS, requests: 4, buckets: [4, 0, 0, 0, 0, 0, 0, 0] }),
      rollup({ hour: H - 23 * HOUR_MS, outcome: 'denied', status_class: 4, requests: 2 }),
      // Outside the 24 h window.
      rollup({ hour: H - 24 * HOUR_MS, requests: 1000 }),
      rollup({
        hour: H - 2 * HOUR_MS,
        service_id: '',
        grant_id: '',
        outcome: 'denied',
        status_class: 4,
        requests: 1,
      }),
    ]);
    await insertRequest(H + 60_000, { duration_ms: 70 });
    await insertRequest(H + 61_000, { outcome: 'error', status: 502, upstream_status: null });

    const data = await loadDashboard(deps());
    expect(data.window).toEqual({ from: H - 23 * HOUR_MS, liveFrom: H });
    expect(data.totals).toMatchObject({ requests: 9, allowed: 5, denied: 3, errors: 1 });
    expect(data.services.map((s) => [s.serviceId, s.slug, s.name, s.requests])).toEqual([
      ['svc_A', 'alpha', 'alpha API', 8],
      ['', null, null, 1],
    ]);
  });

  it('aggregates the previous hour live until the cron has rolled it up', async () => {
    await setCronSuccess(H - HOUR_MS + 7 * 60_000);
    // A stale rollup of the previous hour (written mid-hour) must not be double counted.
    await insertRollups([rollup({ hour: H - HOUR_MS, requests: 1 })]);
    await insertRequest(H - HOUR_MS + 1000, {});
    await insertRequest(H - 1, {});
    await insertRequest(H + 1000, {});

    const data = await loadDashboard(deps());
    expect(data.window.liveFrom).toBe(H - HOUR_MS);
    expect(data.totals.requests).toBe(3);
  });

  it('lists recent denials of the last 24 hours, newest first', async () => {
    await insertRequest(NOW - 2 * DAY, { outcome: 'denied', status: 403, reason: 'old' });
    const first = await insertRequest(NOW - 2000, {
      outcome: 'denied',
      status: 403,
      reason: 'no_matching_grant',
    });
    const second = await insertRequest(NOW - 1000, {
      outcome: 'denied',
      status: 401,
      reason: 'tenant_mismatch',
      service_id: null,
    });
    await insertRequest(NOW - 500, {});

    const data = await loadDashboard(deps());
    expect(data.recentDenials.map((d) => [d.id, d.reason])).toEqual([
      [second, 'tenant_mismatch'],
      [first, 'no_matching_grant'],
    ]);
  });

  it('flags services whose upstream rejects the credential (>= 5 and >= 50% in 15 minutes)', async () => {
    for (let i = 0; i < 5; i++)
      await insertRequest(NOW - 60_000 + i, { status: 401, upstream_status: 401 });
    for (let i = 0; i < 4; i++) await insertRequest(NOW - 50_000 + i, {});
    // Another service: 5 failures but only a third of its traffic.
    for (let i = 0; i < 5; i++)
      await insertRequest(NOW - 40_000 + i, {
        status: 403,
        upstream_status: 403,
        service_id: 'svc_B',
        service_slug: 'beta',
      });
    for (let i = 0; i < 10; i++)
      await insertRequest(NOW - 30_000 + i, { service_id: 'svc_B', service_slug: 'beta' });
    // Older than 15 minutes.
    for (let i = 0; i < 5; i++)
      await insertRequest(NOW - 20 * 60_000 + i, {
        status: 401,
        upstream_status: 401,
        service_id: 'svc_C',
        service_slug: 'gamma',
      });

    const data = await loadDashboard(deps());
    expect(data.alerts.upstreamAuthFailures).toEqual([
      { service_id: 'svc_A', service_slug: 'alpha', forwarded: 9, auth_failures: 5 },
    ]);
  });

  it('reports expiring credentials, keyring problems, cron state, schema and owner count', async () => {
    const sealed = (kid: string) =>
      JSON.stringify({ v: 1, kid, iv: '', wdek: '', dek_iv: '', ct: '' });
    await insertService('svc_A', 'alpha', sealed('k1'), NOW + 3 * DAY);
    await insertService('svc_B', 'beta', sealed('k0'), NOW - 1);
    await insertService('svc_C', 'gamma', 'not json', NOW + 30 * DAY);
    await insertService('svc_D', 'delta', null, NOW + DAY);
    await insertOwner('usr_1', 'owner@example.com');

    const data = await loadDashboard(deps());
    expect(data.alerts.expiringCredentials).toEqual([
      { serviceId: 'svc_B', slug: 'beta', name: 'beta API', expiresAt: NOW - 1, expired: true },
      {
        serviceId: 'svc_A',
        slug: 'alpha',
        name: 'alpha API',
        expiresAt: NOW + 3 * DAY,
        expired: false,
      },
    ]);
    expect(data.alerts.keyring).toEqual({
      ok: false,
      error: null,
      activeKid: 'k1',
      missingKids: ['k0'],
      changedKids: [],
      notActiveCount: 1,
      malformedCount: 1,
    });
    expect(data.alerts.cron).toMatchObject({ lastSuccessAt: null, stale: true, failing: false });
    expect(data.alerts.schema).toEqual({ DB: 'ok', TELEMETRY_DB: 'ok' });
    expect(data.alerts.activeOwners).toBe(1);

    const banners = dashboardBanners(data);
    expect(banners.map((b) => b.level)).toEqual([
      'error', // missing kid
      'error', // malformed credential
      'error', // beta expired
      'warning', // alpha expiring
      'info', // cron never ran
      'info', // credential under a non-active key
      'info', // single owner
    ]);
    expect(banners[0]?.text).toContain('k0');
    expect(banners.some((b) => b.text.includes('TOKENGATE_KEK'))).toBe(false);
  });

  it('reports a missing keyring and a failing cron', async () => {
    const at = NOW - 30 * 60_000;
    await env.DB.batch([
      putSettingStatement(env.DB, 'cron_last_success_at', at - HOUR_MS, at, null),
      putSettingStatement(env.DB, 'cron_last_error', 'purge: Error: D1 overloaded', at, null),
      putSettingStatement(env.DB, 'cron_last_error_at', at, at, null),
    ]);
    const data = await loadDashboard(deps({ TOKENGATE_KEK: '' }));
    expect(data.alerts.keyring).toMatchObject({
      ok: false,
      error: 'keyring_absent',
      activeKid: null,
    });
    expect(data.alerts.cron).toMatchObject({ failing: true, stale: false });
    const texts = dashboardBanners(data).map((b) => `${b.level}: ${b.text}`);
    expect(texts[0]).toMatch(/^error: Keyring unavailable \(keyring_absent\)/);
    expect(texts).toContain(
      `error: The hourly maintenance job failed at ${new Date(at).toISOString()}: purge: Error: D1 overloaded`,
    );
  });
});

describe('loadDashboard: keyring key check values', () => {
  const sealed = (kid: string) =>
    JSON.stringify({ v: 1, kid, iv: '', wdek: '', dek_iv: '', ct: '' });
  const recordKcv = (map: Record<string, string>) =>
    putSettingStatement(env.DB, 'keyring_kcv', map, NOW, null).run();

  it('flags a kid whose key material changed since credentials were sealed', async () => {
    await insertService('svc_A', 'alpha', sealed('k1'), null);
    await recordKcv({ k1: '0000000000000000' });
    const data = await loadDashboard(deps());
    expect(data.alerts.keyring).toMatchObject({ ok: false, changedKids: ['k1'] });
    const [first] = dashboardBanners(data);
    expect(first).toMatchObject({ level: 'error' });
    expect(first?.text).toContain('k1');
    expect(first?.text).not.toContain(KEK);
  });

  it('accepts the recorded key check value and ignores kids without credentials', async () => {
    await insertService('svc_A', 'alpha', sealed('k1'), null);
    const loaded = await loadKeyring(deps().env);
    if (!loaded.ok) throw new Error(loaded.error);
    await recordKcv({ k1: loaded.keyring.kcv.k1 as string, retired: 'ffffffffffffffff' });
    const data = await loadDashboard(deps());
    expect(data.alerts.keyring).toMatchObject({ ok: true, changedKids: [], missingKids: [] });
  });

  it('ignores a malformed keyring_kcv value instead of failing the dashboard', async () => {
    await insertService('svc_A', 'alpha', sealed('k1'), null);
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('keyring_kcv', 'not json', 0)",
    ).run();
    expect((await loadDashboard(deps())).alerts.keyring.ok).toBe(true);
  });
});

describe('I-CRED-1: dashboard data never carries stored credential material', () => {
  it('exposes neither sealed values nor key material in data or banners', async () => {
    const canary = 'CANARY_SEALED_c2VjcmV0';
    await insertService(
      'svc_A',
      'alpha',
      JSON.stringify({ v: 1, kid: 'k0', iv: canary, wdek: canary, dek_iv: canary, ct: canary }),
      NOW + DAY,
    );
    await insertService('svc_B', 'beta', `{"broken": "${canary}"`, NOW - 1);
    await insertRequest(NOW - 1000, {
      outcome: 'denied',
      status: 403,
      reason: 'no_matching_grant',
    });
    const data = await loadDashboard(deps());
    const rendered = JSON.stringify({ data, banners: dashboardBanners(data) });
    expect(rendered).not.toContain(canary);
    expect(rendered).not.toContain(KEK);
  });
});
