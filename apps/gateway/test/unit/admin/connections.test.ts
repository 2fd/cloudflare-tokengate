import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  accessStatus,
  credentialUnreadable,
  loadConnections,
  UNUSED_AFTER_MS,
} from '../../../src/admin/connections';
import { HOUR_MS } from '../../../src/db/rollups';
import type { Deps } from '../../../src/deps';
import type { AppEnv } from '../../../src/env';
import type { KeyringHealth } from '../../../src/health';
import { hourStart } from '../../../src/telemetry/rollup';
import {
  anchoredConditions,
  KEK_2,
  opsDeps,
  OWNER_ID,
  REPOSITORY_ID,
  resetControlPlane,
  seedCredentialRule,
  seedGlobalRule,
  seedService,
} from './ops/helpers';

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 9, 14, 12, 30);
const CREATED = T0 - 40 * DAY_MS;

let deps: Deps;
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

async function rollup(hour: number, ruleId: string, requests: number, outcome = 'allowed') {
  await env.TELEMETRY_DB.prepare(
    `INSERT INTO request_rollup_hourly (hour, service_id, credential_access_rule_id, outcome, status_class, requests,
       upstream_auth_fail, duration_sum_ms)
     VALUES (?, ?, ?, ?, 2, ?, 0, 0)`,
  )
    .bind(hour, github, ruleId, outcome, requests)
    .run();
}

/** A credential access rule of `credentialId` through the real op. */
const seedRule = (credentialId: string, name: string, at: Deps = deps) =>
  seedCredentialRule(at, { credential_id: credentialId, name });

describe('loadConnections', () => {
  it('returns every credential, the rules with summaries and global status, and claim labels', async () => {
    const rule = await seedRule(github, 'read');
    await env.DB.prepare(
      `INSERT INTO claim_labels (access_rule_id, claim, value, label, updated_at)
       VALUES (?, 'repository_id', ?, 'acme/api', 1)`,
    )
      .bind(rule.id, REPOSITORY_ID)
      .run();
    const result = await loadConnections(at(T0));
    expect(result.credentials.map((t) => t.slug).sort()).toEqual(['github', 'slack']);
    expect(result.labels.map((l) => l.label)).toEqual(['acme/api']);
    expect(result.globals).toEqual([]);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({
      rule: { id: rule.id },
      credential: { id: github },
      globalStatus: { kind: 'not_limited' },
      status: 'active',
      subject: 'acme/api',
      context: 'any ref',
      operations: ['GET /repos/**'],
      lastUsedHour: null,
    });
    expect(result.usageAvailable).toBe(true);
  });

  it('filters the rules by credential and by issuer key, never the axes', async () => {
    await seedRule(github, 'read');
    const slackRule = await seedRule(slack, 'post');
    const byCredential = await loadConnections(at(T0), { credentialId: slack });
    expect(byCredential.rules.map((edge) => edge.rule.id)).toEqual([slackRule.id]);
    expect(byCredential.credentials).toHaveLength(2);
    expect((await loadConnections(at(T0), { issuerKey: 'https://none.example' })).rules).toEqual(
      [],
    );
    expect(
      (
        await loadConnections(at(T0), {
          credentialId: github,
          issuerKey: slackRule.issuer_key,
        })
      ).rules,
    ).toHaveLength(1);
  });

  it('marks rules inactive for a disabled credential or a missing secret', async () => {
    await seedRule(slack, 'post');
    const noCredential = (await loadConnections(at(T0))).rules[0];
    expect(noCredential).toMatchObject({
      status: 'inactive',
      statusDetail: 'credential has no secret',
    });
    await env.DB.prepare('UPDATE credentials SET enabled = 0').run();
    expect((await loadConnections(at(T0))).rules[0]?.statusDetail).toBe('credential disabled');
    await env.DB.prepare('UPDATE access_rules SET enabled = 0').run();
    expect((await loadConnections(at(T0))).rules[0]?.status).toBe('disabled');
  });

  it('marks rules blocked or limited by the global access rules of their issuer (AR-8)', async () => {
    const rule = await seedRule(github, 'read');
    const global = await seedGlobalRule(deps, {
      name: 'other org',
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: ['999'] }],
    });
    const blocked = (await loadConnections(at(T0))).rules[0];
    expect(blocked?.status).toBe('global_blocked');
    expect(blocked?.globalStatus.kind).toBe('blocked');
    await env.DB.prepare('DELETE FROM access_rules WHERE id = ?').bind(global.id).run();
    await seedGlobalRule(deps, {
      name: 'main only',
      conditions: [{ claim: 'ref', match: 'exact', values: ['refs/heads/main'] }],
    });
    const limited = (await loadConnections(at(T0))).rules.find((edge) => edge.rule.id === rule.id);
    expect(limited?.status).toBe('active');
    expect(limited?.globalStatus.kind).toBe('limited');
    expect(limited?.flags).toContainEqual({ status: 'global_limited' });
    await env.DB.prepare('DELETE FROM access_rules WHERE credential_id IS NULL').run();
    await seedGlobalRule(deps, {
      name: 'acme',
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
    });
    const within = (await loadConnections(at(T0))).rules[0];
    expect(within?.globalStatus.kind).toBe('within');
  });

  it('marks a credential sealed under a key the keyring lacks as unreadable', async () => {
    await seedRule(github, 'read');
    const other = await loadConnections(at(T0, { TOKENGATE_KEK: KEK_2 }));
    // The key id is still k1, so only the recorded key check value can tell the key was replaced.
    expect(other.unreadableTokenIds.has(github)).toBe(true);
    expect(other.rules[0]).toMatchObject({
      status: 'inactive',
      statusDetail: 'credential unreadable',
    });
    expect((await loadConnections(at(T0))).unreadableTokenIds.size).toBe(0);
  });

  it('flags an expired credential as a warning, not as inactive', async () => {
    await seedRule(github, 'read');
    await env.DB.prepare('UPDATE credentials SET credential_expires_at = ? WHERE id = ?')
      .bind(T0 - 1, github)
      .run();
    const [edge] = (await loadConnections(at(T0))).rules;
    expect(edge?.status).toBe('active');
    expect(edge?.flags).toContainEqual({ status: 'credential_expired_warning' });
  });

  it('flags stored conditions with warnings as risk accepted', async () => {
    await seedCredentialRule(deps, {
      credential_id: github,
      name: 'any branch',
      conditions: [...anchoredConditions(), { claim: 'ref', match: 'glob', values: ['*'] }],
    });
    await seedRule(github, 'plain');
    // Both rows share created_at, so compare by name rather than by evaluation order.
    const flags = Object.fromEntries(
      (await loadConnections(at(T0))).rules.map((edge) => [
        edge.rule.name,
        edge.flags.map((f) => f.status),
      ]),
    );
    expect(flags).toEqual({ 'any branch': ['risk_accepted', 'unused'], plain: ['unused'] });
  });

  it('takes the last use from rollups and the live hour, and calls old idle accesses unused', async () => {
    const used = await seedRule(github, 'used');
    const idle = await seedRule(github, 'idle');
    const fresh = await seedRule(github, 'fresh', opsDeps({ now: () => T0 - 2 * DAY_MS }));
    const hour = hourStart(T0) - 5 * HOUR_MS;
    await rollup(hour, used.id, 3);
    await rollup(hour, idle.id, 4, 'denied');
    await rollup(hourStart(T0 - 31 * DAY_MS), idle.id, 9);

    const result = await loadConnections(at(T0));
    const byId = new Map(result.rules.map((edge) => [edge.rule.id, edge]));
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
    const idleRule = await seedRule(github, 'idle');
    const flagsAt = async (rate: number) => {
      await env.DB.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('allowed_sample_rate', ?, 1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
        .bind(JSON.stringify(rate))
        .run();
      const result = await loadConnections(at(T0));
      expect(result.sampleRate).toBe(rate);
      return result.rules.find((edge) => edge.rule.id === idleRule.id)?.flags;
    };
    expect(await flagsAt(0.5)).toEqual([{ status: 'unused', detail: 'sampled' }]);
    expect(await flagsAt(0)).toEqual([]);
  });

  it('reports no usage, and nothing unused, when TELEMETRY_DB fails', async () => {
    await seedRule(github, 'idle');
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
    expect(result.rules[0]?.flags).toEqual([]);
  });
});

describe('accessStatus', () => {
  const token = { id: 'svc_1', enabled: true, credential_sealed: '{}' };
  const none = new Set<string>();

  it('ranks disabled, expired, inactive, blocked, expiring, active', () => {
    const now = T0;
    const rule = (enabled: boolean, expires_at: number | null) => ({ enabled, expires_at });
    expect(accessStatus(rule(false, now - 1), null, none, now).status).toBe('disabled');
    expect(accessStatus(rule(true, now), null, none, now).status).toBe('expired');
    expect(
      accessStatus(rule(true, now + DAY_MS), { ...token, enabled: false }, none, now, {
        kind: 'blocked',
      }),
    ).toEqual({ status: 'inactive', detail: 'credential disabled' });
    expect(
      accessStatus(rule(true, now + 2.5 * DAY_MS), token, none, now, { kind: 'blocked' }),
    ).toEqual({ status: 'global_blocked' });
    expect(accessStatus(rule(true, now + 2.5 * DAY_MS), token, none, now)).toEqual({
      status: 'expiring',
      detail: '3',
    });
    expect(
      accessStatus(rule(true, now + 15 * DAY_MS), token, none, now, { kind: 'limited' }),
    ).toEqual({ status: 'active' });
    expect(accessStatus(rule(true, null), token, new Set(['svc_1']), now)).toEqual({
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
    const row = await env.DB.prepare('SELECT credential_sealed FROM credentials WHERE id = ?')
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
