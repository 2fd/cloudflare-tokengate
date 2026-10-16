import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  accessStatus,
  credentialUnreadable,
  loadConnections,
  UNUSED_AFTER_MS,
} from '../../../src/admin/connections';
import { createGrant } from '../../../src/admin/ops/grants';
import { HOUR_MS } from '../../../src/db/rollups';
import type { CallerProvider } from '../../../src/db/types';
import type { Deps } from '../../../src/deps';
import type { AppEnv } from '../../../src/env';
import type { KeyringHealth } from '../../../src/health';
import { hourStart } from '../../../src/telemetry/rollup';
import {
  ACTOR,
  anchoredConditions,
  KEK_2,
  opsDeps,
  REPOSITORY_ID,
  resetControlPlane,
  seedGithubProvider,
  seedGrant,
  seedService,
} from './ops/helpers';

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 9, 14, 12, 30);
const CREATED = T0 - 40 * DAY_MS;

let deps: Deps;
let provider: CallerProvider;
let github: string;
let slack: string;

beforeEach(async () => {
  await resetControlPlane();
  await env.DB.prepare(
    "DELETE FROM settings WHERE key IN ('allowed_sample_rate', 'cron_last_success_at', 'keyring_kcv')",
  ).run();
  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly'),
    env.TELEMETRY_DB.prepare('DELETE FROM request_log'),
  ]);
  deps = opsDeps({ now: () => CREATED });
  provider = await seedGithubProvider(deps);
  github = await seedService(deps, { secret: 'ghp_0123456789abcdef0123' });
  slack = await seedService(deps, {
    slug: 'slack',
    name: 'Slack',
    base_url: 'https://slack.com/api',
    forward_headers: [],
  });
});

const at = (now: number, env?: Partial<AppEnv>) =>
  opsDeps({ now: () => now, ...(env ? { env } : {}) });

async function rollup(hour: number, grantId: string, requests: number, outcome = 'allowed') {
  await env.TELEMETRY_DB.prepare(
    `INSERT INTO request_rollup_hourly (hour, service_id, grant_id, outcome, status_class, requests,
       upstream_auth_fail, duration_sum_ms)
     VALUES (?, ?, ?, ?, 2, ?, 0, 0)`,
  )
    .bind(hour, github, grantId, outcome, requests)
    .run();
}

describe('loadConnections', () => {
  it('returns every consumer and token, the accesses with summaries, and claim labels', async () => {
    const grant = await seedGrant(deps, provider.id, github, 'read');
    await env.DB.prepare(
      `INSERT INTO claim_labels (caller_provider_id, claim, value, label, updated_at)
       VALUES (?, 'repository_id', ?, 'acme/api', 1)`,
    )
      .bind(provider.id, REPOSITORY_ID)
      .run();
    const result = await loadConnections(at(T0));
    expect(result.consumers.map((c) => c.id)).toEqual([provider.id]);
    expect(result.tokens.map((t) => t.slug).sort()).toEqual(['github', 'slack']);
    expect(result.labels.map((l) => l.label)).toEqual(['acme/api']);
    expect(result.accesses).toHaveLength(1);
    expect(result.accesses[0]).toMatchObject({
      grant: { id: grant.id },
      consumer: { id: provider.id },
      token: { id: github },
      status: 'active',
      subject: 'acme/api',
      context: 'any ref',
      operations: ['GET /repos/**'],
      lastUsedHour: null,
    });
    expect(result.usageAvailable).toBe(true);
  });

  it('filters the accesses by consumer and by token, never the axes', async () => {
    await seedGrant(deps, provider.id, github, 'read');
    const slackGrant = await seedGrant(deps, provider.id, slack, 'post');
    const byToken = await loadConnections(at(T0), { tokenId: slack });
    expect(byToken.accesses.map((a) => a.grant.id)).toEqual([slackGrant.id]);
    expect(byToken.tokens).toHaveLength(2);
    expect((await loadConnections(at(T0), { consumerId: 'cpr_none' })).accesses).toEqual([]);
    expect(
      (await loadConnections(at(T0), { consumerId: provider.id, tokenId: github })).accesses,
    ).toHaveLength(1);
  });

  it('marks accesses inactive for a disabled token or consumer or a missing credential', async () => {
    await seedGrant(deps, provider.id, slack, 'post');
    const noCredential = (await loadConnections(at(T0))).accesses[0];
    expect(noCredential).toMatchObject({
      status: 'inactive',
      statusDetail: 'token has no credential',
    });
    await env.DB.prepare('UPDATE caller_providers SET enabled = 0').run();
    expect((await loadConnections(at(T0))).accesses[0]?.statusDetail).toBe('consumer disabled');
    await env.DB.prepare('UPDATE services SET enabled = 0').run();
    expect((await loadConnections(at(T0))).accesses[0]?.statusDetail).toBe('token disabled');
    await env.DB.prepare('UPDATE grants SET enabled = 0').run();
    expect((await loadConnections(at(T0))).accesses[0]?.status).toBe('disabled');
  });

  it('marks a credential sealed under a key the keyring lacks as unreadable', async () => {
    await seedGrant(deps, provider.id, github, 'read');
    const other = await loadConnections(at(T0, { TOKENGATE_KEK: KEK_2 }));
    // The key id is still k1, so only the recorded key check value can tell the key was replaced.
    expect(other.unreadableTokenIds.has(github)).toBe(true);
    expect(other.accesses[0]).toMatchObject({
      status: 'inactive',
      statusDetail: 'credential unreadable',
    });
    expect((await loadConnections(at(T0))).unreadableTokenIds.size).toBe(0);
  });

  it('flags an expired credential as a warning, not as inactive', async () => {
    await seedGrant(deps, provider.id, github, 'read');
    await env.DB.prepare('UPDATE services SET credential_expires_at = ? WHERE id = ?')
      .bind(T0 - 1, github)
      .run();
    const [edge] = (await loadConnections(at(T0))).accesses;
    expect(edge?.status).toBe('active');
    expect(edge?.flags).toContainEqual({ status: 'credential_expired_warning' });
  });

  it('flags stored conditions with warnings as risk accepted', async () => {
    const result = await createGrant(deps, ACTOR, {
      name: 'any branch',
      caller_provider_id: provider.id,
      service_id: github,
      conditions: [...anchoredConditions(), { claim: 'ref', match: 'glob', values: ['*'] }],
      rules: [{ methods: ['GET'], path: '/repos/**' }],
      acknowledge_warnings: true,
    });
    expect(result.ok).toBe(true);
    await seedGrant(deps, provider.id, github, 'plain');
    // Both rows share created_at, so compare by name rather than by evaluation order.
    const flags = Object.fromEntries(
      (await loadConnections(at(T0))).accesses.map((a) => [
        a.grant.name,
        a.flags.map((f) => f.status),
      ]),
    );
    expect(flags).toEqual({ 'any branch': ['risk_accepted', 'unused'], plain: ['unused'] });
  });

  it('takes the last use from rollups and the live hour, and calls old idle accesses unused', async () => {
    const used = await seedGrant(deps, provider.id, github, 'used');
    const idle = await seedGrant(deps, provider.id, github, 'idle');
    const fresh = await seedGrant(opsDeps({ now: () => T0 - 2 * DAY_MS }), provider.id, github);
    const hour = hourStart(T0) - 5 * HOUR_MS;
    await rollup(hour, used.id, 3);
    await rollup(hour, idle.id, 4, 'denied');
    await rollup(hourStart(T0 - 31 * DAY_MS), idle.id, 9);

    const result = await loadConnections(at(T0));
    const byId = new Map(result.accesses.map((a) => [a.grant.id, a]));
    expect(byId.get(used.id)?.lastUsedHour).toBe(hour);
    expect(byId.get(used.id)?.flags).toEqual([]);
    expect(result.usage.get(used.id)?.requests).toBe(3);
    expect(byId.get(idle.id)?.lastUsedHour).toBeNull();
    expect(byId.get(idle.id)?.flags).toEqual([{ status: 'unused' }]);
    // Younger than the 30-day window: never unused.
    expect(byId.get(fresh.id)?.flags).toEqual([]);
    expect(CREATED).toBeLessThan(T0 - UNUSED_AFTER_MS);
  });

  it('words unused for sampling and never says it when nothing is recorded', async () => {
    const grant = await seedGrant(deps, provider.id, github, 'idle');
    const flagsAt = async (rate: number) => {
      await env.DB.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('allowed_sample_rate', ?, 1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
        .bind(JSON.stringify(rate))
        .run();
      const result = await loadConnections(at(T0));
      expect(result.sampleRate).toBe(rate);
      return result.accesses.find((a) => a.grant.id === grant.id)?.flags;
    };
    expect(await flagsAt(0.5)).toEqual([{ status: 'unused', detail: 'sampled' }]);
    expect(await flagsAt(0)).toEqual([]);
  });

  it('reports no usage, and nothing unused, when TELEMETRY_DB fails', async () => {
    await seedGrant(deps, provider.id, github, 'idle');
    const broken = at(T0);
    const failing = {
      batch: () => Promise.reject(new Error('down')),
      prepare: (sql: string) => env.TELEMETRY_DB.prepare(sql),
    } as unknown as D1Database;
    const result = await loadConnections({
      ...broken,
      env: { ...broken.env, TELEMETRY_DB: failing },
    });
    expect(result.usageAvailable).toBe(false);
    expect(result.accesses[0]?.flags).toEqual([]);
  });
});

describe('accessStatus', () => {
  const token = { id: 'svc_1', enabled: true, credential_sealed: '{}' };
  const consumer = { enabled: true };
  const none = new Set<string>();

  it('ranks disabled, expired, inactive, expiring, active', () => {
    const now = T0;
    const grant = (enabled: boolean, expires_at: number | null) => ({ enabled, expires_at });
    expect(accessStatus(grant(false, now - 1), null, null, none, now).status).toBe('disabled');
    expect(accessStatus(grant(true, now), null, null, none, now).status).toBe('expired');
    expect(accessStatus(grant(true, now + DAY_MS), { enabled: false }, token, none, now)).toEqual({
      status: 'inactive',
      detail: 'consumer disabled',
    });
    expect(accessStatus(grant(true, now + 2.5 * DAY_MS), consumer, token, none, now)).toEqual({
      status: 'expiring',
      detail: '3',
    });
    expect(accessStatus(grant(true, now + 15 * DAY_MS), consumer, token, none, now)).toEqual({
      status: 'active',
    });
    expect(accessStatus(grant(true, null), consumer, token, new Set(['svc_1']), now)).toEqual({
      status: 'inactive',
      detail: 'credential unreadable',
    });
  });
});

describe('credentialUnreadable', () => {
  const healthy: KeyringHealth = {
    ok: true,
    error: null,
    activeKid: 'k1',
    missingKids: [],
    changedKids: [],
    notActiveCount: 0,
    malformedCount: 0,
  };
  const storedSealed = async () => {
    const row = await env.DB.prepare('SELECT credential_sealed FROM services WHERE id = ?')
      .bind(github)
      .first<{ credential_sealed: string }>();
    return { credential_sealed: row?.credential_sealed ?? '' };
  };

  it('is false without a credential and true for malformed values or a missing keyring', async () => {
    const absent = { ...healthy, error: 'keyring_absent' as const };
    expect(credentialUnreadable({ credential_sealed: null }, absent)).toBe(false);
    expect(credentialUnreadable({ credential_sealed: 'not json' }, healthy)).toBe(true);
    const sealed = await storedSealed();
    expect(credentialUnreadable(sealed, healthy)).toBe(false);
    expect(credentialUnreadable(sealed, absent)).toBe(true);
  });

  it('follows the missing and changed key ids', async () => {
    const sealed = await storedSealed();
    expect(credentialUnreadable(sealed, { ...healthy, missingKids: ['k9'] })).toBe(false);
    expect(credentialUnreadable(sealed, { ...healthy, missingKids: ['k1'] })).toBe(true);
    expect(credentialUnreadable(sealed, { ...healthy, changedKids: ['k1'] })).toBe(true);
  });
});
