// I-AUDIT-1: every admin op writes exactly one audit row, in the same db.batch as its change, and
// nothing when it fails. I-CRED-1: the plaintext credential never appears in op results, audit
// rows, Workers Logs lines, stored rows (other than sealed) or the export.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addTenantValue,
  createCredentialAccessRule,
  deleteCredentialAccessRule,
  duplicateCredentialAccessRule,
  removeTenantValue,
  setCredentialAccessRuleEnabled,
  updateCredentialAccessRule,
} from '../../src/admin/ops/credential-access-rules';
import {
  createService,
  deleteService,
  rotateServiceSecret,
  setServiceCredential,
  testServiceCredential,
  updateServiceFields,
} from '../../src/admin/ops/credentials';
import { exportConfiguration } from '../../src/admin/ops/export';
import {
  createGlobalAccessRule,
  deleteGlobalAccessRule,
  setGlobalAccessRuleEnabled,
  updateGlobalAccessRule,
} from '../../src/admin/ops/global-access-rules';
import { rewrapCredentials } from '../../src/admin/ops/keyring';
import { addUpstreamHost, updateUpstreamHosts } from '../../src/admin/ops/upstream-hosts';
import type { CredentialAccessRule } from '../../src/db/types';
import type { Deps } from '../../src/deps';
import { newId } from '../../src/lib/ids';
import {
  ACTOR,
  anchoredConditions,
  auditRows,
  CONTEXT,
  dumpControlPlane,
  fakeNetwork,
  ROTATION_ENV,
  OWNER_ID,
  opsDeps,
  resetControlPlane,
  seedCredentialRule,
  seedGlobalRule,
  seedService,
  serviceInput,
} from '../unit/admin/ops/helpers';

const CANARY = 'CANARY-tokengate-0123456789abcdefXYZ';
const VERIFY = { method: 'GET' as const, path: '/rate_limit', expect_status: 200 };
const PIN = [{ claim: 'repository_owner_id', match: 'exact' as const, values: [OWNER_ID] }];
const READ = [{ methods: ['GET' as const], path: '/**' }];

let deps: Deps;
let rule: CredentialAccessRule;
let serviceId: string;
let logLines: string[];
let seeded = 0;

/** An upstream that echoes the credential back, in the body and in headers. */
function echoingNetwork() {
  return fakeNetwork((_url, init) => {
    const auth = new Headers(init.headers).get('authorization') ?? '';
    return new Response(JSON.stringify({ ok: true, seen: auth }), {
      status: 200,
      headers: { 'x-echo': auth },
    });
  });
}

beforeEach(async () => {
  await resetControlPlane();
  logLines = [];
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    });
  }
  deps = opsDeps({ fetch: echoingNetwork().fetch });
  serviceId = await seedService(deps, { secret: CANARY, verify: VERIFY });
  rule = await seedCredentialRule(deps, { credential_id: serviceId });
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface OpCase {
  name: string;
  /** Fixture rows created before measuring; returns the id the op acts on. */
  setup?: (deps: Deps) => Promise<string>;
  run: (deps: Deps, id: string) => Promise<{ ok: boolean }>;
}

/** A further credential access rule of the credential, with a unique name. */
const seedOwnRule = async (d: Deps) =>
  (await seedCredentialRule(d, { credential_id: serviceId, name: `rule ${++seeded}` })).id;
/** A global access rule of the GitHub issuer, with a unique name. */
const seedOwnGlobal =
  (overrides: Parameters<typeof seedGlobalRule>[1] = {}) =>
  async (d: Deps) =>
    (await seedGlobalRule(d, { name: `global ${++seeded}`, tenant_pin: PIN, ...overrides })).id;
const rotatedKeyring = (d: Deps): Deps => ({
  ...d,
  env: { ...d.env, ...ROTATION_ENV },
});

const successes: Array<OpCase & { action: string }> = [
  {
    name: 'createService',
    action: 'service.create',
    run: (d) => createService(d, ACTOR, serviceInput({ slug: 'new', secret: CANARY }), CONTEXT),
  },
  {
    name: 'updateServiceFields',
    action: 'service.update',
    run: (d) => updateServiceFields(d, ACTOR, serviceId, { name: 'n' }),
  },
  {
    name: 'updateServiceFields (disable)',
    action: 'service.disable',
    run: (d) => updateServiceFields(d, ACTOR, serviceId, { enabled: false }),
  },
  {
    name: 'updateServiceFields (enable)',
    action: 'service.enable',
    run: (d) => updateServiceFields(d, ACTOR, serviceId, { enabled: true }),
  },
  {
    name: 'setServiceCredential',
    action: 'service.credential.set',
    run: (d) =>
      setServiceCredential(
        d,
        ACTOR,
        serviceId,
        { base_url: 'https://api.github.com', injection: { kind: 'bearer' }, secret: CANARY },
        CONTEXT,
      ),
  },
  {
    name: 'testServiceCredential',
    action: 'service.credential.test',
    run: (d) => testServiceCredential(d, ACTOR, serviceId, CONTEXT),
  },
  {
    name: 'deleteService',
    action: 'service.delete',
    setup: (d) => seedService(d, { slug: 'doomed' }),
    run: (d, id) => deleteService(d, ACTOR, id),
  },
  {
    name: 'deleteService (with its rules)',
    action: 'service.delete',
    setup: async (d) => {
      const id = await seedService(d, { slug: 'cascade' });
      return `${id}:${(await seedCredentialRule(d, { credential_id: id })).id}`;
    },
    run: (d, ids) => {
      const [id = '', ruleId = ''] = ids.split(':');
      return deleteService(d, ACTOR, id, { withRules: true, ruleIds: [ruleId] });
    },
  },
  {
    name: 'rotateServiceSecret',
    action: 'service.credential.set',
    run: (d) => rotateServiceSecret(d, ACTOR, serviceId, { secret: `${CANARY}-new` }, CONTEXT),
  },
  {
    name: 'addUpstreamHost',
    action: 'settings.upstream_hosts',
    setup: async (d) => {
      const set = await updateUpstreamHosts(d, ACTOR, 'api.github.com');
      if (!set.ok) throw new Error(set.errors.join());
      return '';
    },
    run: (d) => addUpstreamHost(d, ACTOR, 'https://api.openai.com/v1'),
  },
  {
    name: 'createCredentialAccessRule',
    action: 'credential_access_rule.create',
    run: (d) =>
      createCredentialAccessRule(d, ACTOR, {
        credential_id: serviceId,
        name: `created ${++seeded}`,
        profile: 'generic',
        issuer: 'https://idp.example.org',
        jwks_uri: 'https://idp.example.org/jwks',
        anchor_claims: ['sub'],
        tenant_pin: [{ claim: 'tenant', match: 'exact', values: ['acme'] }],
        conditions: [{ claim: 'sub', match: 'exact', values: ['ci-bot'] }],
        rules: READ,
      }),
  },
  {
    name: 'updateCredentialAccessRule',
    action: 'credential_access_rule.update',
    setup: seedOwnRule,
    run: (d, id) => updateCredentialAccessRule(d, ACTOR, id, { max_token_age_seconds: 120 }),
  },
  {
    name: 'setCredentialAccessRuleEnabled',
    action: 'credential_access_rule.disable',
    setup: seedOwnRule,
    run: (d, id) => setCredentialAccessRuleEnabled(d, ACTOR, id, false),
  },
  {
    name: 'setCredentialAccessRuleEnabled (enable)',
    action: 'credential_access_rule.enable',
    setup: seedOwnRule,
    run: (d, id) => setCredentialAccessRuleEnabled(d, ACTOR, id, true),
  },
  {
    name: 'addTenantValue',
    action: 'credential_access_rule.update',
    setup: seedOwnRule,
    run: (d, id) =>
      addTenantValue(d, ACTOR, id, {
        claim: 'repository_owner_id',
        entries: [{ value: `${++seeded}000`, label: 'other' }],
      }),
  },
  {
    name: 'removeTenantValue',
    action: 'credential_access_rule.update',
    setup: async (d) => {
      const id = await seedOwnRule(d);
      await addTenantValue(d, ACTOR, id, {
        claim: 'repository_owner_id',
        entries: [{ value: '5', label: 'other' }],
      });
      return id;
    },
    run: (d, id) => removeTenantValue(d, ACTOR, id, { claim: 'repository_owner_id', value: '5' }),
  },
  {
    name: 'duplicateCredentialAccessRule',
    action: 'credential_access_rule.duplicate',
    setup: seedOwnRule,
    run: (d, id) => duplicateCredentialAccessRule(d, ACTOR, id),
  },
  {
    name: 'deleteCredentialAccessRule',
    action: 'credential_access_rule.delete',
    setup: seedOwnRule,
    run: (d, id) => deleteCredentialAccessRule(d, ACTOR, id),
  },
  {
    name: 'createGlobalAccessRule',
    action: 'global_access_rule.create',
    run: (d) =>
      createGlobalAccessRule(d, ACTOR, {
        name: `created global ${++seeded}`,
        profile: 'github-actions',
        tenant_pin: PIN,
        confirm_new_ceiling: true,
        confirm_widening: true,
      }),
  },
  {
    name: 'updateGlobalAccessRule',
    action: 'global_access_rule.update',
    setup: seedOwnGlobal(),
    run: (d, id) => updateGlobalAccessRule(d, ACTOR, id, { rules: READ }),
  },
  {
    name: 'setGlobalAccessRuleEnabled',
    action: 'global_access_rule.disable',
    setup: seedOwnGlobal(),
    run: (d, id) => setGlobalAccessRuleEnabled(d, ACTOR, id, false, { confirm_last_disable: true }),
  },
  {
    name: 'setGlobalAccessRuleEnabled (enable)',
    action: 'global_access_rule.enable',
    setup: seedOwnGlobal({ enabled: false }),
    run: (d, id) => setGlobalAccessRuleEnabled(d, ACTOR, id, true, { confirm_widening: true }),
  },
  {
    name: 'deleteGlobalAccessRule',
    action: 'global_access_rule.delete',
    setup: seedOwnGlobal(),
    run: (d, id) => deleteGlobalAccessRule(d, ACTOR, id, { confirm_widening: true }),
  },
  {
    name: 'rewrapCredentials',
    action: 'keyring.rewrap',
    run: async (d) => {
      const result = await rewrapCredentials(rotatedKeyring(d), ACTOR);
      if (result.ok) await result.finished;
      return result;
    },
  },
  {
    name: 'exportConfiguration',
    action: 'config.export',
    run: (d) => exportConfiguration(d, ACTOR),
  },
];

const failures: OpCase[] = [
  {
    name: 'createService (invalid)',
    run: (d) => createService(d, ACTOR, serviceInput({ slug: '-' }), CONTEXT),
  },
  {
    name: 'createService (duplicate slug)',
    run: (d) => createService(d, ACTOR, serviceInput(), CONTEXT),
  },
  {
    name: 'updateServiceFields (binding field)',
    run: (d) =>
      updateServiceFields(d, ACTOR, serviceId, { base_url: 'https://x.example' } as never),
  },
  {
    name: 'setServiceCredential (bad secret)',
    run: (d) =>
      setServiceCredential(
        d,
        ACTOR,
        serviceId,
        { base_url: 'https://api.github.com', injection: { kind: 'bearer' }, secret: ' ' },
        CONTEXT,
      ),
  },
  {
    name: 'testServiceCredential (missing service)',
    run: (d) => testServiceCredential(d, ACTOR, 'svc_nope', CONTEXT),
  },
  {
    name: 'deleteService (has rules)',
    run: (d) => deleteService(d, ACTOR, serviceId),
  },
  {
    name: 'deleteService (rules not the confirmed set)',
    setup: seedOwnRule,
    run: (d) => deleteService(d, ACTOR, serviceId, { withRules: true, ruleIds: [rule.id] }),
  },
  {
    name: 'rotateServiceSecret (unattested)',
    setup: async () => {
      await env.DB.prepare(
        "UPDATE credentials SET base_url = 'https://uploads.github.com' WHERE id = ?",
      )
        .bind(serviceId)
        .run();
      return '';
    },
    run: (d) => rotateServiceSecret(d, ACTOR, serviceId, { secret: CANARY }, CONTEXT),
  },
  {
    name: 'setServiceCredential (no credential, unconfirmed)',
    setup: (d) => seedService(d, { slug: 'bare' }),
    run: (d, id) =>
      setServiceCredential(
        d,
        ACTOR,
        id,
        { base_url: 'https://api.github.com', injection: { kind: 'bearer' }, secret: CANARY },
        CONTEXT,
      ),
  },
  {
    name: 'createCredentialAccessRule (no pin on shared issuer)',
    run: (d) =>
      createCredentialAccessRule(d, ACTOR, {
        credential_id: serviceId,
        name: 'x',
        profile: 'github-actions',
        conditions: anchoredConditions(),
        rules: READ,
      }),
  },
  {
    name: 'createCredentialAccessRule (unanchored)',
    run: (d) =>
      createCredentialAccessRule(d, ACTOR, {
        credential_id: serviceId,
        name: 'x',
        profile: 'github-actions',
        tenant_pin: PIN,
        conditions: [{ claim: 'sub', match: 'glob', values: ['**'] }],
        rules: READ,
      }),
  },
  {
    name: 'createCredentialAccessRule (unacknowledged warnings)',
    run: (d) =>
      createCredentialAccessRule(d, ACTOR, {
        credential_id: serviceId,
        name: 'x',
        profile: 'github-actions',
        tenant_pin: PIN,
        conditions: [...anchoredConditions(), { claim: 'ref', match: 'glob', values: ['*'] }],
        rules: READ,
      }),
  },
  {
    name: 'updateCredentialAccessRule (taken name)',
    setup: seedOwnRule,
    run: (d, id) => updateCredentialAccessRule(d, ACTOR, id, { name: rule.name.toUpperCase() }),
  },
  {
    name: 'updateCredentialAccessRule (profile change)',
    run: (d) => updateCredentialAccessRule(d, ACTOR, rule.id, { profile: 'generic' }),
  },
  {
    name: 'updateCredentialAccessRule (invalid rules)',
    run: (d) => updateCredentialAccessRule(d, ACTOR, rule.id, { rules: [] }),
  },
  {
    name: 'setCredentialAccessRuleEnabled (non-boolean)',
    run: (d) => setCredentialAccessRuleEnabled(d, ACTOR, rule.id, 'false' as never),
  },
  {
    name: 'removeTenantValue (used by its jobs)',
    run: (d) =>
      removeTenantValue(d, ACTOR, rule.id, { claim: 'repository_owner_id', value: OWNER_ID }),
  },
  {
    name: 'deleteCredentialAccessRule (missing)',
    run: (d) => deleteCredentialAccessRule(d, ACTOR, 'acr_nope'),
  },
  {
    name: 'createGlobalAccessRule (first ceiling, unconfirmed)',
    run: (d) =>
      createGlobalAccessRule(d, ACTOR, { name: 'g', profile: 'github-actions', tenant_pin: PIN }),
  },
  {
    name: 'createGlobalAccessRule (empty list)',
    run: (d) =>
      createGlobalAccessRule(d, ACTOR, {
        name: 'g',
        profile: 'github-actions',
        rules: [],
        confirm_new_ceiling: true,
      }),
  },
  {
    name: 'createGlobalAccessRule (sibling, unconfirmed widening)',
    setup: seedOwnGlobal(),
    run: (d) =>
      createGlobalAccessRule(d, ACTOR, {
        name: 'g',
        profile: 'github-actions',
        confirm_new_ceiling: true,
      }),
  },
  {
    name: 'updateGlobalAccessRule (unconfirmed widening)',
    setup: seedOwnGlobal(),
    run: (d, id) => updateGlobalAccessRule(d, ACTOR, id, { tenant_pin: null }),
  },
  {
    name: 'updateGlobalAccessRule (issuer change)',
    setup: seedOwnGlobal(),
    run: (d, id) =>
      updateGlobalAccessRule(d, ACTOR, id, { issuer: 'https://token.actions.example.com' }),
  },
  {
    name: 'setGlobalAccessRuleEnabled (enable, unconfirmed)',
    setup: seedOwnGlobal({ enabled: false }),
    run: (d, id) => setGlobalAccessRuleEnabled(d, ACTOR, id, true, {}),
  },
  {
    name: 'setGlobalAccessRuleEnabled (last disable, unconfirmed)',
    setup: seedOwnGlobal(),
    run: (d, id) => setGlobalAccessRuleEnabled(d, ACTOR, id, false, {}),
  },
  {
    name: 'deleteGlobalAccessRule (last, unconfirmed)',
    setup: seedOwnGlobal(),
    run: (d, id) => deleteGlobalAccessRule(d, ACTOR, id, {}),
  },
  {
    name: 'deleteGlobalAccessRule (a credential access rule id)',
    run: (d) => deleteGlobalAccessRule(d, ACTOR, rule.id, { confirm_widening: true }),
  },
  {
    name: 'rewrapCredentials (no keyring)',
    run: (d) => rewrapCredentials({ ...d, env: { ...d.env, TOKENGATE_KEK: '' } }, ACTOR),
  },
];

describe('I-AUDIT-1: every successful op writes exactly one audit row', () => {
  it.each(successes.map((c) => [c.name, c] as const))('%s', async (_, c) => {
    const id = (await c.setup?.(deps)) ?? '';
    const before = new Set((await auditRows()).map((row) => row.id));
    const linesBefore = logLines.length;
    const result = await c.run(deps, id);
    expect(result.ok).toBe(true);
    const added = (await auditRows()).filter((row) => !before.has(row.id));
    expect(added).toHaveLength(1);
    const [row] = added;
    expect(row).toMatchObject({
      action: c.action,
      actor_type: 'user',
      actor_id: ACTOR.id,
      ip: ACTOR.ip,
    });
    // The committed event is emitted once to Workers Logs.
    const lines = logLines.slice(linesBefore).filter((line) => line.includes('"audit.event"'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"id":"${row?.id}"`);
  });
});

describe('I-AUDIT-1: failed ops write nothing', () => {
  it.each(failures.map((c) => [c.name, c] as const))('%s', async (_, c) => {
    const id = (await c.setup?.(deps)) ?? '';
    const before = await dumpControlPlane();
    const linesBefore = logLines.length;
    const result = await c.run(deps, id);
    expect(result.ok).toBe(false);
    expect(await dumpControlPlane()).toBe(before);
    expect(logLines.slice(linesBefore).some((line) => line.includes('"audit.event"'))).toBe(false);
  });
});

describe('I-AUDIT-1: the change and its audit row commit together', () => {
  it('a failing audit insert rolls back the change', async () => {
    const now = 1_800_000_000_000;
    const fixed = { ...deps, now: () => now, random: (n: number) => new Uint8Array(n).fill(7) };
    // Occupy the audit id the op will generate, so the audit insert fails inside the batch.
    const auditId = newId('aud', now, fixed.random);
    await env.DB.prepare(
      "INSERT INTO audit_log (id, ts, actor_type, action, summary) VALUES (?, 0, 'system', 'x', 'x')",
    )
      .bind(auditId)
      .run();
    await expect(
      createService(fixed, ACTOR, serviceInput({ slug: 'atomic' }), CONTEXT),
    ).rejects.toThrow();
    const row = await env.DB.prepare("SELECT id FROM credentials WHERE slug = 'atomic'").first();
    expect(row).toBeNull();
  });
});

describe('I-CRED-1: the plaintext credential appears nowhere but the sealed value', () => {
  it('op results, audit rows, log lines, stored rows and the export never contain it', async () => {
    const results: unknown[] = [];
    for (const c of successes) results.push(await c.run(deps, (await c.setup?.(deps)) ?? ''));
    const exported = await exportConfiguration(deps, ACTOR);
    results.push(exported);

    expect(JSON.stringify(results)).not.toContain(CANARY);
    expect(JSON.stringify(await auditRows())).not.toContain(CANARY);
    expect(logLines.join('\n')).not.toContain(CANARY);
    expect(await dumpControlPlane()).not.toContain(CANARY);
    if (exported.ok) expect(exported.json).not.toContain(CANARY);
  });

  it('the verify preview masks a credential echoed by the upstream', async () => {
    const result = await testServiceCredential(deps, ACTOR, serviceId, CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verify.bodyPreview).toContain('[credential]');
    expect(result.verify.bodyPreview).not.toContain(CANARY);
  });

  it('a failed verify result does not carry the credential either', async () => {
    const network = fakeNetwork(
      (_url, init) =>
        new Response(`bad token ${new Headers(init.headers).get('authorization')}`, {
          status: 401,
        }),
    );
    const failing = opsDeps({ fetch: network.fetch });
    const result = await setServiceCredential(
      failing,
      ACTOR,
      serviceId,
      { base_url: 'https://api.github.com', injection: { kind: 'bearer' }, secret: CANARY },
      CONTEXT,
    );
    expect(result).toMatchObject({ ok: false, reason: 'verify_failed' });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
});
