import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addTenantValue,
  createCredentialAccessRule,
  createOrMergeConsumer,
  defaultAudience,
  deleteCredentialAccessRule,
  deriveConsumerName,
  removeTenantValue,
  setCredentialAccessRuleEnabled,
  updateCredentialAccessRule,
} from '../../../../src/admin/ops/credential-access-rules';
import {
  createIssuerAccessRule,
  setIssuerAccessRuleEnabled,
} from '../../../../src/admin/ops/issuer_access_rules';
import { getCredentialAccessRule } from '../../../../src/db/credential-access-rules';
import { testCredentialId } from './helpers';
import {
  ACTOR,
  auditCount,
  auditRows,
  fakeNetwork,
  GITHUB_ISSUER,
  GITHUB_JWKS,
  OWNER_ID,
  opsDeps,
  resetControlPlane,
  seedGithubProvider,
  seedIssuerAccessRule,
  seedService,
} from './helpers';

const ACME_ISSUER = 'https://idp.acme.example';
const ACME_JWKS = 'https://idp.acme.example/keys';

function network() {
  return fakeNetwork(undefined, {
    [GITHUB_ISSUER]: GITHUB_JWKS,
    [ACME_ISSUER]: ACME_JWKS,
    'https://idp2.acme.example': 'https://idp2.acme.example/keys',
  });
}

beforeEach(resetControlPlane);

describe('defaultAudience', () => {
  it('is tokengate: + 26 base32 characters from the random source', () => {
    const audience = defaultAudience((n) => crypto.getRandomValues(new Uint8Array(n)));
    expect(audience).toMatch(/^tokengate:[a-z2-7]{26}$/);
    expect(defaultAudience((n) => new Uint8Array(n).fill(33))).toBe(`tokengate:${'b'.repeat(26)}`);
  });
});

describe('createCredentialAccessRule', () => {
  it('applies profile defaults, generates an audience and discovers the JWKS URI', async () => {
    const net = network();
    const result = await createCredentialAccessRule(opsDeps({ fetch: net.fetch }), ACTOR, {
      credential_id: await testCredentialId(opsDeps({ fetch: net.fetch })),
      name: ' GitHub Actions ',
      profile: 'github-actions',
      jwks_uri: 'https://attacker.example/jwks',
      tenant_pin: [
        { claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID], negate: false },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credentialAccessRule).toMatchObject({
      name: 'GitHub Actions',
      profile: 'github-actions',
      issuer: GITHUB_ISSUER,
      jwks_uri: GITHUB_JWKS,
      allowed_algs: ['RS256'],
      max_token_age_seconds: 600,
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
      enabled: true,
    });
    expect(result.credentialAccessRule.audience).toMatch(/^tokengate:[a-z2-7]{26}$/);
    expect(net.calls.map((call) => call.url)).toEqual([
      `${GITHUB_ISSUER}/.well-known/openid-configuration`,
    ]);
    const stored = await getCredentialAccessRule(env.DB, result.credentialAccessRule.id);
    expect(stored).toEqual(result.credentialAccessRule);
    const [audit] = await auditRows(result.credentialAccessRule.id);
    expect(audit?.action).toBe('credential_access_rule.create');
  });

  it('requires a tenant pin on the shared GitHub issuer (I-TEN-1)', async () => {
    const result = await createCredentialAccessRule(opsDeps({ fetch: network().fetch }), ACTOR, {
      credential_id: await testCredentialId(opsDeps({ fetch: network().fetch })),
      name: 'GitHub',
      profile: 'github-actions',
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (result.ok) return;
    expect(result.errors.join()).toMatch(/tenant pin is required/);
    expect((await auditRows()).filter((row) => row.action !== 'service.create')).toHaveLength(0);
  });

  it('lets a generic provider name its JWKS URI without discovery', async () => {
    const net = network();
    const result = await createCredentialAccessRule(opsDeps({ fetch: net.fetch }), ACTOR, {
      credential_id: await testCredentialId(opsDeps({ fetch: net.fetch })),
      name: 'Acme',
      profile: 'generic',
      issuer: 'https://idp.other.example',
      jwks_uri: 'https://idp.other.example/jwks.json',
      audience: 'tokengate:acme-gateway-01',
      anchor_claims: ['sub'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credentialAccessRule.jwks_uri).toBe('https://idp.other.example/jwks.json');
    expect(result.warnings.join()).toMatch(/no tenant pin/);
    expect(net.calls).toHaveLength(0);
  });

  it('reports discovery failures', async () => {
    const result = await createCredentialAccessRule(opsDeps({ fetch: network().fetch }), ACTOR, {
      credential_id: await testCredentialId(opsDeps({ fetch: network().fetch })),
      name: 'Unknown',
      profile: 'generic',
      issuer: 'https://unknown.example',
      anchor_claims: ['sub'],
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/^JWKS discovery failed/);
  });

  it('rejects unknown profiles and allows independent rules for the same issuer', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    expect(
      await createCredentialAccessRule(deps, ACTOR, {
        credential_id: await testCredentialId(deps),
        name: 'x',
        profile: 'constructor',
      }),
    ).toMatchObject({ ok: false, reason: 'invalid' });
    await seedGithubProvider(deps);
    const duplicate = await createCredentialAccessRule(deps, ACTOR, {
      credential_id: await testCredentialId(deps),
      name: 'GitHub again',
      profile: 'github-actions',
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: ['1'] }],
    });
    expect(duplicate).toMatchObject({ ok: true });
  });
});

describe('updateCredentialAccessRule', () => {
  async function seedGeneric(deps: ReturnType<typeof opsDeps>) {
    const result = await createCredentialAccessRule(deps, ACTOR, {
      credential_id: await testCredentialId(deps),
      name: 'Acme',
      profile: 'generic',
      issuer: ACME_ISSUER,
      audience: 'tokengate:acme-gateway-01',
      anchor_claims: ['sub'],
      tenant_pin: [{ claim: 'tenant', match: 'exact', values: ['acme'] }],
    });
    if (!result.ok) throw new Error(result.errors.join());
    return result.credentialAccessRule;
  }

  it('keeps the profile immutable', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGithubProvider(deps);
    const result = await updateCredentialAccessRule(deps, ACTOR, provider.id, {
      profile: 'generic',
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('audits only changed fields', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGithubProvider(deps);
    const result = await updateCredentialAccessRule(deps, ACTOR, provider.id, {
      max_token_age_seconds: 300,
    });
    expect(result.ok).toBe(true);
    const audit = (await auditRows(provider.id)).at(-1);
    expect(audit?.action).toBe('credential_access_rule.update');
    expect(audit?.diff).toMatchObject({
      before: { max_token_age_seconds: 600 },
      after: { max_token_age_seconds: 300 },
    });
  });

  it('refuses a save from a form opened at an older version', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGithubProvider(deps);
    const first = await updateCredentialAccessRule(deps, ACTOR, provider.id, {
      max_token_age_seconds: 300,
      expected_updated_at: provider.updated_at,
    });
    expect(first.ok).toBe(true);
    const stale = await updateCredentialAccessRule(deps, ACTOR, provider.id, {
      max_token_age_seconds: 120,
      expected_updated_at: provider.updated_at,
    });
    expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
    if (stale.ok) return;
    expect(stale.errors.join()).toContain('changed by someone else since you opened this page');
    expect((await auditRows(provider.id)).at(-1)?.diff).toMatchObject({
      after: { max_token_age_seconds: 300 },
    });
  });

  it('requires confirmation to change the issuer under enabled issuer_access_rules', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGeneric(deps);
    const serviceId = await seedService(deps);
    const created = await createIssuerAccessRule(deps, ACTOR, {
      name: 'acme ci',
      credential_access_rule_id: provider.id,
      service_id: serviceId,
      conditions: [{ claim: 'sub', match: 'exact', values: ['ci-bot'] }],
      rules: [{ methods: ['GET'], path: '/**' }],
    });
    if (!created.ok) throw new Error(created.errors.join());
    const grant = created.grant;

    const refused = await updateCredentialAccessRule(deps, ACTOR, provider.id, {
      issuer: 'https://idp2.acme.example',
    });
    expect(refused).toMatchObject({ ok: false, reason: 'confirmation_required' });
    if (refused.ok) return;
    expect(refused.errors.join()).toContain('"acme ci"');
    expect((await getCredentialAccessRule(env.DB, provider.id))?.issuer).toBe(ACME_ISSUER);

    const confirmed = await updateCredentialAccessRule(deps, ACTOR, provider.id, {
      issuer: 'https://idp2.acme.example',
      confirm_trust_change: true,
    });
    expect(confirmed.ok).toBe(true);
    expect(await getCredentialAccessRule(env.DB, provider.id)).toMatchObject({
      issuer: 'https://idp2.acme.example',
      jwks_uri: 'https://idp2.acme.example/keys',
    });
    expect((await auditRows(provider.id)).at(-1)?.diff).toMatchObject({
      trust_change_confirmed: true,
    });

    // Without enabled issuer_access_rules no confirmation is needed.
    await setIssuerAccessRuleEnabled(deps, ACTOR, grant.id, false);
    const unconfirmed = await updateCredentialAccessRule(deps, ACTOR, provider.id, {
      issuer: ACME_ISSUER,
    });
    expect(unconfirmed.ok).toBe(true);
  });

  it('enables and disables', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGithubProvider(deps);
    await setCredentialAccessRuleEnabled(deps, ACTOR, provider.id, false);
    expect((await getCredentialAccessRule(env.DB, provider.id))?.enabled).toBe(false);
    expect((await auditRows(provider.id)).at(-1)?.action).toBe('credential_access_rule.disable');
  });
});

describe('deleteCredentialAccessRule', () => {
  it('refuses while issuer_access_rules reference it, then deletes', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGithubProvider(deps);
    const serviceId = await seedService(deps);
    const grant = await seedIssuerAccessRule(deps, provider.id, serviceId);
    expect(await deleteCredentialAccessRule(deps, ACTOR, provider.id)).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    await env.DB.prepare('DELETE FROM issuer_access_rules WHERE id = ?').bind(grant.id).run();
    expect(await deleteCredentialAccessRule(deps, ACTOR, provider.id)).toEqual({
      ok: true,
      deletedAccesses: 0,
    });
    expect(await getCredentialAccessRule(env.DB, provider.id)).toBeNull();
    expect((await auditRows(provider.id)).at(-1)?.action).toBe('credential_access_rule.delete');
  });
});

describe('deriveConsumerName', () => {
  it.each<[string, Parameters<typeof deriveConsumerName>, string]>([
    ['one org', ['github-actions', GITHUB_ISSUER, ['acme']], 'GitHub Actions (acme)'],
    [
      'two orgs',
      ['github-actions', GITHUB_ISSUER, ['acme', 'acme-labs']],
      'GitHub Actions (acme, acme-labs)',
    ],
    [
      'a long list',
      ['github-actions', GITHUB_ISSUER, Array.from({ length: 12 }, (_, i) => `organization-${i}`)],
      'GitHub Actions (organization-0 +11)',
    ],
    ['gitlab.com', ['gitlab-ci', 'https://gitlab.com', ['acme-group']], 'GitLab (acme-group)'],
    [
      'self-managed GitLab',
      ['gitlab-ci', 'https://gitlab.example.com', ['x']],
      'GitLab (gitlab.example.com)',
    ],
    [
      'a generic issuer',
      ['generic', 'https://oidc.circleci.com/org/abc/', []],
      'oidc.circleci.com/org/abc',
    ],
  ])('%s', (_name, args, expected) => {
    expect(deriveConsumerName(...args)).toBe(expected);
  });
});

describe('createOrMergeConsumer, addTenantValue, removeTenantValue', () => {
  const labelsOf = async (id: string) =>
    (
      await env.DB.prepare(
        'SELECT value, label FROM claim_labels WHERE credential_access_rule_id = ? ORDER BY value',
      )
        .bind(id)
        .all()
    ).results;

  it('creates a credential access rule with a unique derived name and its labels in one audit row', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const first = await createOrMergeConsumer(deps, ACTOR, {
      credential_id: await testCredentialId(deps),
      profile: 'github-actions',
      issuer: '',
      tenants: [{ value: OWNER_ID, label: 'acme' }],
    });
    expect(first).toMatchObject({ ok: true, merged: false, changed: true });
    if (!first.ok) return;
    expect(first.credentialAccessRule.name).toBe('GitHub Actions (acme)');
    expect(await labelsOf(first.credentialAccessRule.id)).toEqual([
      { value: OWNER_ID, label: 'acme' },
    ]);
    expect(
      (await auditRows()).filter((row) => row.action !== 'service.create').map((row) => row.action),
    ).toEqual(['credential_access_rule.create']);
  });

  it('creates independent boundaries for the same issuer without widening earlier rules', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const credential_id = await testCredentialId(deps);
    const first = await createOrMergeConsumer(deps, ACTOR, {
      credential_id,
      profile: 'github-actions',
      issuer: '',
      tenants: [{ value: OWNER_ID, label: 'acme' }],
    });
    const second = await createOrMergeConsumer(deps, ACTOR, {
      credential_id,
      profile: 'github-actions',
      issuer: '',
      tenants: [{ value: '7654321', label: 'other' }],
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.credentialAccessRule.id).not.toBe(first.credentialAccessRule.id);
    expect(
      (await getCredentialAccessRule(env.DB, first.credentialAccessRule.id))?.tenant_pin,
    ).toEqual([{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }]);
  });

  it('keeps a typed name when the organizations change', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGithubProvider(deps);
    const added = await addTenantValue(deps, ACTOR, provider.id, {
      claim: 'repository_owner_id',
      entries: [{ value: '5', label: 'other' }],
    });
    expect(added.ok && added.credentialAccessRule.name).toBe('GitHub Actions');
  });

  it('refuses a non-numeric organization ID (UI rule on top of the validator)', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGithubProvider(deps);
    const result = await addTenantValue(deps, ACTOR, provider.id, {
      claim: 'repository_owner_id',
      entries: [{ value: 'acme', label: 'acme' }],
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    const created = await createCredentialAccessRule(deps, ACTOR, {
      credential_id: await testCredentialId(deps),
      profile: 'github-actions',
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: ['acme'] }],
    });
    expect(created).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('can revoke an organization used by existing accesses but keeps a nonempty organization limit', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGithubProvider(deps);
    await addTenantValue(deps, ACTOR, provider.id, {
      claim: 'repository_owner_id',
      entries: [{ value: '5', label: 'other' }],
    });
    const serviceId = await seedService(deps);
    await seedIssuerAccessRule(deps, provider.id, serviceId);
    expect(
      await removeTenantValue(deps, ACTOR, provider.id, {
        claim: 'repository_owner_id',
        value: OWNER_ID,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await removeTenantValue(deps, ACTOR, provider.id, {
        claim: 'repository_owner_id',
        value: '5',
      }),
    ).toMatchObject({ ok: false });
    expect(
      await removeTenantValue(deps, ACTOR, provider.id, {
        claim: 'repository_owner_id',
        value: OWNER_ID,
      }),
    ).toMatchObject({ ok: false });
  });

  it('reads a pin with two conditions on the claim as their intersection (I-TEN-1)', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGithubProvider(deps);
    // Stored before the UI kept one row per claim: effective organizations {2}.
    await env.DB.prepare('UPDATE credential_access_rules SET tenant_pin = ? WHERE id = ?')
      .bind(
        JSON.stringify([
          { claim: 'repository_owner_id', match: 'exact', values: ['1', '2'] },
          { claim: 'repository_owner_id', match: 'exact', values: ['2', '3'] },
        ]),
        provider.id,
      )
      .run();
    expect(
      await removeTenantValue(deps, ACTOR, provider.id, {
        claim: 'repository_owner_id',
        value: '1',
      }),
    ).toMatchObject({ ok: false, reason: 'invalid' });
    const added = await addTenantValue(deps, ACTOR, provider.id, {
      claim: 'repository_owner_id',
      entries: [{ value: '4', label: 'other' }],
    });
    expect(added.ok).toBe(true);
    // Organizations 1 and 3 stay out: only the admitted value plus the added one.
    expect((await getCredentialAccessRule(env.DB, provider.id))?.tenant_pin).toEqual([
      { claim: 'repository_owner_id', match: 'exact', values: ['2', '4'] },
    ]);
  });

  it('keeps enterprise restrictions independent between boundaries with the same issuer', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const first = await createOrMergeConsumer(deps, ACTOR, {
      credential_id: await testCredentialId(deps),
      profile: 'github-actions',
      issuer: '',
      tenants: [{ value: OWNER_ID, label: 'acme' }],
    });
    if (!first.ok) throw new Error('create failed');
    const merged = await createOrMergeConsumer(deps, ACTOR, {
      credential_id: await testCredentialId(deps),
      profile: 'github-actions',
      issuer: '',
      tenants: [{ value: '7654321', label: 'acme-labs' }],
      enterprise_id: '12345',
    });
    expect(merged).toMatchObject({ ok: true, merged: false });
    expect(
      (await getCredentialAccessRule(env.DB, first.credentialAccessRule.id))?.tenant_pin,
    ).toEqual([{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }]);
  });

  it('takes the generic algorithms from discovery within ALLOWED_ALGS', async () => {
    const base = network();
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await base.fetch(input, init);
      if (!String(input).endsWith('/openid-configuration') || response.status !== 200)
        return response;
      return Response.json({
        ...((await response.json()) as object),
        id_token_signing_alg_values_supported: ['HS256', 'ES384', 'none'],
      });
    };
    const created = await createCredentialAccessRule(opsDeps({ fetch: fetchImpl }), ACTOR, {
      credential_id: await testCredentialId(opsDeps({ fetch: fetchImpl })),
      profile: 'generic',
      issuer: ACME_ISSUER,
      anchor_claims: ['sub'],
    });
    expect(created.ok && created.credentialAccessRule).toMatchObject({
      allowed_algs: ['ES384'],
      jwks_uri: ACME_JWKS,
      name: 'idp.acme.example',
    });
  });
});

describe('deleteCredentialAccessRule with its accesses', () => {
  it('deletes the credential access rule, exactly the listed accesses and its labels in one audited batch', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGithubProvider(deps);
    const serviceId = await seedService(deps);
    const a = await seedIssuerAccessRule(deps, provider.id, serviceId, 'a');
    const b = await seedIssuerAccessRule(deps, provider.id, serviceId, 'b');
    await env.DB.prepare(
      `INSERT INTO claim_labels (credential_access_rule_id, claim, value, label, updated_at) VALUES (?, 'repository_id', '1', 'acme/x', 1)`,
    )
      .bind(provider.id)
      .run();
    const before = await auditCount();
    const stale = await deleteCredentialAccessRule(deps, ACTOR, provider.id, {
      withAccesses: true,
      accessIds: [a.id],
    });
    expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await auditCount()).toBe(before);
    const result = await deleteCredentialAccessRule(deps, ACTOR, provider.id, {
      withAccesses: true,
      accessIds: [b.id, a.id],
    });
    expect(result).toEqual({ ok: true, deletedAccesses: 2 });
    expect(await getCredentialAccessRule(env.DB, provider.id)).toBeNull();
    const left = await env.DB.prepare('SELECT count(*) AS n FROM issuer_access_rules').first<{
      n: number;
    }>();
    expect(left?.n).toBe(0);
    const labelRows = await env.DB.prepare('SELECT count(*) AS n FROM claim_labels').first<{
      n: number;
    }>();
    expect(labelRows?.n).toBe(0);
    const rows = await auditRows(provider.id);
    expect(rows.at(-1)?.action).toBe('credential_access_rule.delete');
    expect(
      (
        (rows.at(-1)?.diff?.before ?? { issuer_access_rules: [] }) as {
          issuer_access_rules: Array<{ id: string }>;
        }
      ).issuer_access_rules
        .map((g) => g.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(await auditCount()).toBe(before + 1);
  });
});
