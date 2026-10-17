// I-AUDIT-1: every admin op writes exactly one audit row, in the same db.batch as its change, and
// nothing when it fails. I-CRED-1: the plaintext credential never appears in op results, audit
// rows, Workers Logs lines, stored rows (other than sealed) or the export.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCredentialAccessRule,
  deleteCredentialAccessRule,
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
  createIssuerAccessRule,
  deleteIssuerAccessRule,
  duplicateIssuerAccessRule,
  setIssuerAccessRuleEnabled,
  updateIssuerAccessRule,
} from '../../src/admin/ops/issuer_access_rules';
import { rewrapCredentials } from '../../src/admin/ops/keyring';
import { addUpstreamHost, updateUpstreamHosts } from '../../src/admin/ops/upstream-hosts';
import type { CredentialAccessRule } from '../../src/db/types';
import type { Deps } from '../../src/deps';
import { newId } from '../../src/lib/ids';
import { testCredentialId } from '../unit/admin/ops/helpers';
import {
  ACTOR,
  anchoredConditions,
  auditRows,
  CONTEXT,
  dumpControlPlane,
  fakeNetwork,
  KEYRING_1_2,
  opsDeps,
  resetControlPlane,
  seedGithubProvider,
  seedIssuerAccessRule,
  seedService,
  serviceInput,
} from '../unit/admin/ops/helpers';

const CANARY = 'CANARY-tokengate-0123456789abcdefXYZ';
const VERIFY = { method: 'GET' as const, path: '/rate_limit', expect_status: 200 };

let deps: Deps;
let provider: CredentialAccessRule;
let serviceId: string;
let logLines: string[];

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
  provider = await seedGithubProvider(deps);
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

const seedOwnIssuerAccessRule = async (d: Deps) =>
  (await seedIssuerAccessRule(d, provider.id, serviceId)).id;
const seedGeneric = async (d: Deps) => {
  const created = await createCredentialAccessRule(d, ACTOR, {
    credential_id: await testCredentialId(d),
    name: 'temp',
    profile: 'generic',
    issuer: 'https://temp.example.org',
    jwks_uri: 'https://temp.example.org/jwks',
    anchor_claims: ['sub'],
  });
  if (!created.ok) throw new Error(created.errors.join());
  return created.credentialAccessRule.id;
};
const rotatedKeyring = (d: Deps): Deps => ({
  ...d,
  env: { ...d.env, TOKENGATE_KEK: '', TOKENGATE_KEYRING: KEYRING_1_2 },
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
    name: 'deleteService (with its accesses)',
    action: 'service.delete',
    setup: async (d) => {
      const id = await seedService(d, { slug: 'cascade' });
      return `${id}:${(await seedIssuerAccessRule(d, provider.id, id)).id}`;
    },
    run: (d, ids) => {
      const [id = '', grantId = ''] = ids.split(':');
      return deleteService(d, ACTOR, id, { withAccesses: true, accessIds: [grantId] });
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
    run: async (d) =>
      createCredentialAccessRule(d, ACTOR, {
        credential_id: await testCredentialId(d),
        name: 'generic',
        profile: 'generic',
        issuer: 'https://idp.example.org',
        jwks_uri: 'https://idp.example.org/jwks',
        anchor_claims: ['sub'],
      }),
  },
  {
    name: 'updateCredentialAccessRule',
    action: 'credential_access_rule.update',
    run: (d) => updateCredentialAccessRule(d, ACTOR, provider.id, { max_token_age_seconds: 120 }),
  },
  {
    name: 'setCredentialAccessRuleEnabled',
    action: 'credential_access_rule.disable',
    run: (d) => setCredentialAccessRuleEnabled(d, ACTOR, provider.id, false),
  },
  {
    name: 'setCredentialAccessRuleEnabled (enable)',
    action: 'credential_access_rule.enable',
    run: (d) => setCredentialAccessRuleEnabled(d, ACTOR, provider.id, true),
  },
  {
    name: 'deleteCredentialAccessRule',
    action: 'credential_access_rule.delete',
    setup: seedGeneric,
    run: (d, id) => deleteCredentialAccessRule(d, ACTOR, id),
  },
  {
    name: 'createIssuerAccessRule',
    action: 'grant.create',
    run: (d) =>
      createIssuerAccessRule(d, ACTOR, {
        name: 'g',
        credential_access_rule_id: provider.id,
        service_id: serviceId,
        conditions: anchoredConditions(),
        rules: [{ methods: ['GET'], path: '/**' }],
      }),
  },
  {
    name: 'updateIssuerAccessRule',
    action: 'grant.update',
    setup: seedOwnIssuerAccessRule,
    run: (d, id) => updateIssuerAccessRule(d, ACTOR, id, { name: 'renamed' }),
  },
  {
    name: 'setIssuerAccessRuleEnabled',
    action: 'grant.disable',
    setup: seedOwnIssuerAccessRule,
    run: (d, id) => setIssuerAccessRuleEnabled(d, ACTOR, id, false),
  },
  {
    name: 'setIssuerAccessRuleEnabled (enable)',
    action: 'grant.enable',
    setup: seedOwnIssuerAccessRule,
    run: (d, id) => setIssuerAccessRuleEnabled(d, ACTOR, id, true),
  },
  {
    name: 'duplicateIssuerAccessRule',
    action: 'grant.duplicate',
    setup: seedOwnIssuerAccessRule,
    run: (d, id) => duplicateIssuerAccessRule(d, ACTOR, id),
  },
  {
    name: 'deleteIssuerAccessRule',
    action: 'grant.delete',
    setup: seedOwnIssuerAccessRule,
    run: (d, id) => deleteIssuerAccessRule(d, ACTOR, id),
  },
  {
    name: 'rewrapCredentials',
    action: 'keyring.rewrap',
    run: (d) => rewrapCredentials(rotatedKeyring(d), ACTOR),
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
    name: 'deleteService (referenced)',
    setup: seedOwnIssuerAccessRule,
    run: (d) => deleteService(d, ACTOR, serviceId),
  },
  {
    name: 'deleteService (accesses not the confirmed set)',
    setup: seedOwnIssuerAccessRule,
    run: (d) => deleteService(d, ACTOR, serviceId, { withAccesses: true, accessIds: [] }),
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
    run: async (d) =>
      createCredentialAccessRule(d, ACTOR, {
        credential_id: await testCredentialId(d),
        name: 'x',
        profile: 'github-actions',
      }),
  },
  {
    name: 'updateCredentialAccessRule (profile change)',
    run: (d) => updateCredentialAccessRule(d, ACTOR, provider.id, { profile: 'generic' }),
  },
  {
    name: 'deleteCredentialAccessRule (referenced)',
    setup: seedOwnIssuerAccessRule,
    run: (d) => deleteCredentialAccessRule(d, ACTOR, provider.id),
  },
  {
    name: 'createIssuerAccessRule (unanchored)',
    run: (d) =>
      createIssuerAccessRule(d, ACTOR, {
        name: 'g',
        credential_access_rule_id: provider.id,
        service_id: serviceId,
        conditions: [{ claim: 'sub', match: 'glob', values: ['**'] }],
        rules: [{ methods: ['GET'], path: '/**' }],
      }),
  },
  {
    name: 'createIssuerAccessRule (unacknowledged warnings)',
    run: (d) =>
      createIssuerAccessRule(d, ACTOR, {
        name: 'g',
        credential_access_rule_id: provider.id,
        service_id: serviceId,
        conditions: [...anchoredConditions(), { claim: 'ref', match: 'glob', values: ['*'] }],
        rules: [{ methods: ['GET'], path: '/**' }],
      }),
  },
  {
    name: 'updateIssuerAccessRule (invalid rules)',
    setup: seedOwnIssuerAccessRule,
    run: (d, id) => updateIssuerAccessRule(d, ACTOR, id, { rules: [] }),
  },
  {
    name: 'deleteIssuerAccessRule (missing)',
    run: (d) => deleteIssuerAccessRule(d, ACTOR, 'grt_nope'),
  },
  {
    name: 'setIssuerAccessRuleEnabled (non-boolean)',
    setup: seedOwnIssuerAccessRule,
    run: (d, id) => setIssuerAccessRuleEnabled(d, ACTOR, id, 'false' as never),
  },
  {
    name: 'updateCredentialAccessRule (unconfirmed trust change)',
    setup: seedOwnIssuerAccessRule,
    run: async (d) => {
      const issuer = 'https://token.actions.githubusercontent.com/acme';
      const network = fakeNetwork(undefined, { [issuer]: `${issuer}/.well-known/jwks` });
      const result = await updateCredentialAccessRule(
        { ...d, fetch: network.fetch },
        ACTOR,
        provider.id,
        {
          issuer,
        },
      );
      expect(result).toMatchObject({ reason: 'confirmation_required' });
      return result;
    },
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
