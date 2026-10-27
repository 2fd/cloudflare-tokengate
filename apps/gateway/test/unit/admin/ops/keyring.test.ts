import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStoredCredential } from '../../../../src/admin/ops/credentials';
import {
  type KeyringStatus,
  keyringStatus,
  REWRAP_STALE_MS,
  type RewrapJob,
  rewrapCredentials,
  rewrapJob,
  rotationStep,
} from '../../../../src/admin/ops/keyring';
import { sealedKid } from '../../../../src/crypto/envelope';
import { loadKeyring } from '../../../../src/crypto/keyring';
import { getService } from '../../../../src/db/credentials';
import { putSettingStatement } from '../../../../src/db/settings';
import { TEST_ACCESS_ENV } from '../../../helpers/app';
import {
  ACTOR,
  auditCount,
  auditRows,
  KEK_1,
  KEK_2,
  opsDeps,
  resetControlPlane,
  ROTATION_ENV,
  seedService,
} from './helpers';

const rotated = (now?: () => number) => opsDeps({ env: ROTATION_ENV, now });

async function kidOf(id: string): Promise<string | null> {
  return sealedKid((await getService(env.DB, id))?.credential_sealed ?? null);
}

async function kidsOf(): Promise<{ old: string; next: string }> {
  const loaded = await loadKeyring({ ...TEST_ACCESS_ENV, ...ROTATION_ENV });
  if (!loaded.ok) throw new Error(loaded.error);
  return { old: loaded.keyring.currentKid as string, next: loaded.keyring.activeKid };
}

beforeEach(resetControlPlane);

describe('keyringStatus', () => {
  it('reports both secrets, their key ids and the credentials under each', async () => {
    const old = opsDeps();
    await seedService(old, { slug: 'a', secret: 'secret-a-0123456789' });
    await seedService(old, { slug: 'b', secret: 'secret-b-0123456789' });
    await seedService(old, { slug: 'c' });
    const kids = await kidsOf();

    expect(await keyringStatus(rotated())).toEqual({
      error: null,
      activeKid: kids.next,
      current: { kid: kids.old, credentials: 2 },
      next: { status: 'ready', kid: kids.next, credentials: 0 },
      credentialsByKid: { [kids.old]: 2 },
      missingKids: [],
      unreadableCredentials: 0,
      needsRewrap: 2,
    });
  });

  it('counts legacy k1 credentials under TOKENGATE_KEK', async () => {
    const id = await seedService(opsDeps(), { slug: 'a', secret: 'secret-a-0123456789' });
    await env.DB.prepare(
      "UPDATE credentials SET credential_sealed = json_set(credential_sealed, '$.kid', 'k1') WHERE id = ?",
    )
      .bind(id)
      .run();
    const kids = await kidsOf();
    expect(await keyringStatus(opsDeps())).toMatchObject({
      current: { kid: kids.old, credentials: 1 },
      needsRewrap: 0,
    });
    expect(await keyringStatus(rotated())).toMatchObject({
      current: { kid: kids.old, credentials: 1 },
      needsRewrap: 1,
    });
  });

  it('reports an unused TOKENGATE_KEYRING, missing kids, unreadable values and keyring errors', async () => {
    const id = await seedService(opsDeps(), { slug: 'a', secret: 'secret-a-0123456789' });
    await seedService(opsDeps(), { slug: 'b', secret: 'secret-b-0123456789' });
    await env.DB.prepare("UPDATE credentials SET credential_sealed = 'garbage' WHERE id = ?")
      .bind(id)
      .run();
    const kids = await kidsOf();
    const unused = await keyringStatus(
      opsDeps({ env: { TOKENGATE_KEYRING: toBase64Text('correct-horse-battery-staple-123') } }),
    );
    expect(unused).toMatchObject({
      next: { status: 'not_random', kid: null, credentials: 0 },
      needsRewrap: 0,
    });

    const status = await keyringStatus(
      opsDeps({ env: { TOKENGATE_KEK: '', TOKENGATE_KEYRING: KEK_2 } }),
    );
    expect(status).toMatchObject({
      current: null,
      missingKids: [kids.old],
      unreadableCredentials: 1,
      needsRewrap: 1,
    });

    const broken = await keyringStatus(opsDeps({ env: { TOKENGATE_KEK: '' } }));
    expect(broken).toMatchObject({
      error: 'keyring_absent',
      activeKid: null,
      current: null,
      next: { status: 'absent', kid: null },
      missingKids: [kids.old],
    });
  });
});

describe('rewrapCredentials', () => {
  it('re-seals every credential under the next key in the background, with one audit row', async () => {
    const a = await seedService(opsDeps(), { slug: 'a', secret: 'secret-a-0123456789' });
    const b = await seedService(opsDeps(), { slug: 'b', secret: 'secret-b-0123456789' });
    const deps = rotated();
    const kids = await kidsOf();
    const before = await auditCount();

    const result = await rewrapCredentials(deps, ACTOR);
    if (!result.ok) throw new Error(result.errors.join());
    expect(result).toMatchObject({ ok: true, activeKid: kids.next, queued: 2, confirmedKids: [] });
    const job = await result.finished;
    expect(job).toMatchObject({
      state: 'done',
      active_kid: kids.next,
      started_by: ACTOR.email,
      total: 2,
      written: 2,
      skipped: 0,
    });
    expect(await rewrapJob(deps)).toEqual(job);
    expect(await kidOf(a)).toBe(kids.next);
    expect(await kidOf(b)).toBe(kids.next);
    expect(await auditCount()).toBe(before + 1);
    const audit = (await auditRows(kids.next)).at(-1);
    expect(audit).toMatchObject({ action: 'keyring.rewrap', target_type: 'keyring' });
    expect(audit?.diff).toEqual({
      active_kid: kids.next,
      candidates: 2,
      from_kids: { [kids.old]: 2 },
    });

    // After the hand-over (TOKENGATE_KEK = the new key, no TOKENGATE_KEYRING) it opens alone.
    const handedOver = await loadKeyring({ ...TEST_ACCESS_ENV, TOKENGATE_KEK: KEK_2 });
    if (!handedOver.ok) throw new Error(handedOver.error);
    const service = await getService(env.DB, a);
    if (!service) throw new Error('missing');
    expect(await openStoredCredential(handedOver.keyring, service)).toEqual({
      ok: true,
      plaintext: 'secret-a-0123456789',
    });

    // Idempotent: nothing left to rewrap, so nothing is written or audited.
    expect(await rewrapCredentials(deps, ACTOR)).toMatchObject({ ok: true, queued: 0 });
    expect(await auditCount()).toBe(before + 1);
  });

  it('refuses to start while a job runs, and starts again once it stopped', async () => {
    await seedService(opsDeps(), { slug: 'a', secret: 'secret-a-0123456789' });
    const now = 1_800_000_000_000;
    const running: RewrapJob = {
      state: 'running',
      active_kid: (await kidsOf()).next,
      started_at: now - 1000,
      started_by: 'other@example.com',
      heartbeat_at: now - 1000,
      total: 5,
      written: 2,
      skipped: 0,
    };
    await putSettingStatement(env.DB, 'keyring_rewrap', running, now, null).run();
    const before = await auditCount();

    const refused = await rewrapCredentials(
      rotated(() => now),
      ACTOR,
    );
    expect(refused).toMatchObject({
      ok: false,
      reason: 'conflict',
      errors: ['A re-encryption is already running. Wait for it to finish.'],
    });
    expect(await auditCount()).toBe(before);

    const later = now + REWRAP_STALE_MS;
    const restarted = await rewrapCredentials(
      rotated(() => later),
      ACTOR,
    );
    if (!restarted.ok) throw new Error(restarted.errors.join());
    expect(restarted.queued).toBe(1);
    expect(await restarted.finished).toMatchObject({
      state: 'done',
      written: 1,
      started_at: later,
    });
  });

  it('accepts a changed check value of the legacy kid when every credential under it opens', async () => {
    const id = await seedService(opsDeps(), { slug: 'a', secret: 'secret-a-0123456789' });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE credentials SET credential_sealed = json_set(credential_sealed, '$.kid', 'k1') WHERE id = ?",
      ).bind(id),
      env.DB.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (\'keyring_kcv\', \'{"k1":"0000000000000000"}\', 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      ),
    ]);
    const result = await rewrapCredentials(opsDeps(), ACTOR);
    if (!result.ok) throw new Error(result.errors.join());
    expect(result).toMatchObject({ queued: 0, confirmedKids: ['k1'] });
    expect(await result.finished).toMatchObject({ state: 'done', total: 0 });
    expect(await kidOf(id)).toBe('k1');
    expect((await auditRows()).at(-1)?.diff).toMatchObject({ confirmed_kids: ['k1'] });
  });

  it('refuses and writes nothing when a referenced kid is missing', async () => {
    await seedService(opsDeps(), { slug: 'a', secret: 'secret-a-0123456789' });
    const other = toBase64Bytes((i) => 0x20 + i * 7);
    const id = await seedService(opsDeps({ env: { TOKENGATE_KEK: other } }), {
      slug: 'b',
      secret: 'secret-b-0123456789',
    });
    const otherKid = await kidOf(id);
    const before = await auditCount();
    const result = await rewrapCredentials(rotated(), ACTOR);
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    if (result.ok) return;
    expect(result.errors).toEqual([
      `The credential of service b was encrypted with key "${otherKid}", which is not in the keyring. Add the key back, or set the credential again.`,
      'Nothing was re-encrypted.',
    ]);
    expect(await kidOf(id)).toBe(otherKid);
    expect(await auditCount()).toBe(before);
    expect(await rewrapJob(rotated())).toBeNull();
  });

  it('refuses when a credential fails to open (tampered binding)', async () => {
    const id = await seedService(opsDeps(), { slug: 'a', secret: 'secret-a-0123456789' });
    await env.DB.prepare(
      "UPDATE credentials SET base_url = 'https://evil.example.net' WHERE id = ?",
    )
      .bind(id)
      .run();
    const result = await rewrapCredentials(rotated(), ACTOR);
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    if (result.ok) return;
    expect(result.errors.join()).toMatch(
      /The stored credential of service a cannot be opened: it does not match the service's current base URL or injection/,
    );
    expect(result.errors.join()).not.toMatch(/credential_binding_mismatch/);
  });

  it('refuses without a valid keyring', async () => {
    const result = await rewrapCredentials(opsDeps({ env: { TOKENGATE_KEK: 'bad' } }), ACTOR);
    expect(result).toMatchObject({
      ok: false,
      reason: 'unavailable',
      errors: [
        'A configured key is not exactly 32 bytes encoded as base64.',
        'Nothing was re-encrypted.',
      ],
    });
    expect(KEK_1).not.toBe(KEK_2);
  });
});

describe('rotationStep', () => {
  const NOW = 1_800_000_000_000;
  const status = (overrides: Partial<KeyringStatus> = {}): KeyringStatus => ({
    error: null,
    activeKid: 'aaaaaaaaaaaaaaaa',
    current: { kid: 'aaaaaaaaaaaaaaaa', credentials: 0 },
    next: { status: 'absent', kid: null, credentials: 0 },
    credentialsByKid: {},
    missingKids: [],
    unreadableCredentials: 0,
    needsRewrap: 0,
    ...overrides,
  });
  const ready = { status: 'ready' as const, kid: 'bbbbbbbbbbbbbbbb', credentials: 0 };
  const job = (overrides: Partial<RewrapJob> = {}): RewrapJob => ({
    state: 'running',
    active_kid: 'bbbbbbbbbbbbbbbb',
    started_at: NOW - 5000,
    started_by: 'owner@example.com',
    heartbeat_at: NOW - 1000,
    total: 10,
    written: 4,
    skipped: 0,
    ...overrides,
  });

  it('has no step while the keyring does not load', () => {
    expect(rotationStep(status({ error: 'keyring_absent' }), [], null, NOW)).toBeNull();
  });

  it('1: TOKENGATE_KEYRING is not set', () => {
    expect(rotationStep(status(), [], null, NOW)).toEqual({ n: 1 });
  });

  it.each(['malformed', 'not_32_bytes', 'dev_placeholder', 'not_random'] as const)(
    '2: TOKENGATE_KEYRING is %s',
    (problem) => {
      expect(
        rotationStep(
          status({ next: { status: problem, kid: null, credentials: 0 } }),
          [],
          null,
          NOW,
        ),
      ).toEqual({ n: 2, problem });
    },
  );

  it('3: credentials are under the previous key; a stopped or failed job is reported', () => {
    const pending = status({ next: ready, activeKid: ready.kid, needsRewrap: 3 });
    expect(rotationStep(pending, [], null, NOW)).toEqual({ n: 3, pending: 3, stopped: null });
    const stale = job({ heartbeat_at: NOW - REWRAP_STALE_MS });
    expect(rotationStep(pending, [], stale, NOW)).toEqual({ n: 3, pending: 3, stopped: stale });
    const failed = job({ state: 'failed', error: 'D1 is down' });
    expect(rotationStep(pending, [], failed, NOW)).toEqual({ n: 3, pending: 3, stopped: failed });
    const done = job({ state: 'done', written: 10 });
    expect(rotationStep(pending, [], done, NOW)).toEqual({ n: 3, pending: 3, stopped: null });
    expect(rotationStep(status({ next: ready }), ['k1'], null, NOW)).toMatchObject({ n: 3 });
  });

  it('4: a job is running', () => {
    const running = job();
    expect(rotationStep(status({ next: ready, needsRewrap: 6 }), [], running, NOW)).toEqual({
      n: 4,
      job: running,
    });
  });

  it('5: every credential is under the new key; the hand-over depends on the secrets', () => {
    expect(rotationStep(status({ next: ready, activeKid: ready.kid }), [], null, NOW)).toEqual({
      n: 5,
      handover: 'move',
    });
    expect(
      rotationStep(
        status({ next: { status: 'same', kid: 'aaaaaaaaaaaaaaaa', credentials: 0 } }),
        [],
        null,
        NOW,
      ),
    ).toEqual({ n: 5, handover: 'delete' });
    expect(
      rotationStep(status({ current: null, next: ready, activeKid: ready.kid }), [], null, NOW),
    ).toEqual({ n: 5, handover: 'set_kek' });
  });
});

function toBase64Text(text: string): string {
  return btoa(text);
}

function toBase64Bytes(byte: (i: number) => number): string {
  return btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => byte(i) & 0xff)));
}
