import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { keyCheckValue } from '../../src/crypto/keyring';
import { resetSchemaStatusCacheForTests } from '../../src/db/migrations';
import { putSettingStatement } from '../../src/db/settings';
import { resetReadinessCacheForTests } from '../../src/health';
import { fromBase64, toBase64 } from '../../src/lib/encoding';
import { createTestApp } from '../helpers/app';

const NOW = Date.UTC(2026, 9, 13, 12, 30);
const KEK = toBase64(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));
const offline = {
  prepare: () => {
    throw new Error('D1 offline');
  },
  batch: async () => {
    throw new Error('D1 offline');
  },
} as unknown as D1Database;

const ALL_OK = { db: true, telemetry_db: true, keyring: true, cron: true, schema: true };

beforeEach(async () => {
  resetReadinessCacheForTests();
  resetSchemaStatusCacheForTests();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM settings'),
    env.DB.prepare('DELETE FROM grants'),
    env.DB.prepare('DELETE FROM services'),
  ]);
});

const cronRanAt = (at: number) =>
  putSettingStatement(env.DB, 'cron_last_success_at', at, at, null).run();

async function readyz(app: ReturnType<typeof createTestApp>) {
  const response = await app.request('/readyz');
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as { ok: boolean; checks: Record<string, boolean> },
  };
}

describe('/healthz', () => {
  it('answers 200 without touching storage', async () => {
    const app = createTestApp({ env: { DB: offline, TELEMETRY_DB: offline } });
    const response = await app.request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe('/readyz', () => {
  it('is 200 with every check true when the deployment is fully operational', async () => {
    await cronRanAt(NOW - 60 * 60_000);
    const app = createTestApp({ now: () => NOW, env: { TOKENGATE_KEK: KEK } });
    const { status, headers, body } = await readyz(app);
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({ ok: true, checks: ALL_OK });
  });

  it('passes before the first cron run, fails when the last success is older than 2 hours', async () => {
    const app = createTestApp({ now: () => NOW, env: { TOKENGATE_KEK: KEK } });
    expect(await readyz(app)).toMatchObject({ status: 200, body: { ok: true, checks: ALL_OK } });
    resetReadinessCacheForTests();
    await cronRanAt(NOW - 2 * 3_600_000 - 1);
    expect((await readyz(app)).body.checks.cron).toBe(false);
  });

  it('fails when the cron has only ever failed', async () => {
    await putSettingStatement(env.DB, 'cron_last_error_at', NOW, NOW, null).run();
    const app = createTestApp({ now: () => NOW, env: { TOKENGATE_KEK: KEK } });
    expect((await readyz(app)).body.checks.cron).toBe(false);
  });

  it('fails the keyring check when no keyring is set or a stored credential uses an unknown kid', async () => {
    await cronRanAt(NOW);
    expect(
      (await readyz(createTestApp({ now: () => NOW, env: { TOKENGATE_KEK: '' } }))).body,
    ).toEqual({
      ok: false,
      checks: { ...ALL_OK, keyring: false },
    });

    resetReadinessCacheForTests();
    await env.DB.prepare(
      `INSERT INTO services (id, slug, name, base_url, injection, credential_sealed, created_at, updated_at)
       VALUES ('svc_X', 'x', 'x', 'https://api.example.com', '{"kind":"bearer"}', ?, 0, 0)`,
    )
      .bind(JSON.stringify({ v: 1, kid: 'retired', iv: '', wdek: '', dek_iv: '', ct: '' }))
      .run();
    const { status, body } = await readyz(
      createTestApp({ now: () => NOW, env: { TOKENGATE_KEK: KEK } }),
    );
    expect(status).toBe(503);
    expect(body.checks.keyring).toBe(false);
  });

  it('reports each database independently and exposes booleans only', async () => {
    await cronRanAt(NOW);
    const app = createTestApp({
      now: () => NOW,
      env: { TOKENGATE_KEK: KEK, TELEMETRY_DB: offline },
    });
    const { status, body } = await readyz(app);
    expect(status).toBe(503);
    expect(body.checks).toEqual({ ...ALL_OK, telemetry_db: false, schema: false });
    for (const value of Object.values(body.checks)) expect(typeof value).toBe('boolean');
  });

  it('caches the answer for 10 seconds per isolate', async () => {
    let now = NOW;
    const app = createTestApp({ now: () => now, env: { TOKENGATE_KEK: KEK } });
    await cronRanAt(NOW - 3 * 3_600_000);
    expect((await readyz(app)).status).toBe(503);
    await cronRanAt(NOW);
    expect((await readyz(app)).status).toBe(503);
    now += 10_000;
    expect((await readyz(app)).status).toBe(200);
  });
});

describe('/readyz keyring check', () => {
  const insertSealed = (sealed: string) =>
    env.DB.prepare(
      `INSERT INTO services (id, slug, name, base_url, injection, credential_sealed, created_at, updated_at)
       VALUES ('svc_K', 'k', 'k', 'https://api.example.com', '{"kind":"bearer"}', ?, 0, 0)`,
    )
      .bind(sealed)
      .run();
  const sealedUnder = (kid: string) =>
    JSON.stringify({ v: 1, kid, iv: '', wdek: '', dek_iv: '', ct: '' });

  it('fails when TOKENGATE_KEK was replaced under the same kid (key check value changed)', async () => {
    await cronRanAt(NOW);
    await insertSealed(sealedUnder('k1'));
    const otherKcv = await keyCheckValue(new Uint8Array(32));
    await putSettingStatement(env.DB, 'keyring_kcv', { k1: otherKcv }, NOW, null).run();
    const app = createTestApp({ now: () => NOW, env: { TOKENGATE_KEK: KEK } });
    expect((await readyz(app)).body.checks).toEqual({ ...ALL_OK, keyring: false });

    resetReadinessCacheForTests();
    const kcv = await keyCheckValue(fromBase64(KEK));
    await putSettingStatement(env.DB, 'keyring_kcv', { k1: kcv }, NOW, null).run();
    expect((await readyz(app)).body).toEqual({ ok: true, checks: ALL_OK });
  });

  it('fails when a stored credential is not a sealed value', async () => {
    await cronRanAt(NOW);
    await insertSealed('{not json');
    const app = createTestApp({ now: () => NOW, env: { TOKENGATE_KEK: KEK } });
    expect((await readyz(app)).body.checks.keyring).toBe(false);
  });
});

describe('I-CRED-1: /readyz never reveals keyring or credential details', () => {
  it('answers with the fixed boolean shape only', async () => {
    await cronRanAt(NOW);
    const app = createTestApp({ now: () => NOW, env: { TOKENGATE_KEK: KEK } });
    const response = await app.request('/readyz');
    const text = await response.text();
    expect(Object.keys(JSON.parse(text))).toEqual(['ok', 'checks']);
    expect(text).not.toContain(KEK);
    expect(text).not.toMatch(/k1|kcv|keyring_/);
  });
});
