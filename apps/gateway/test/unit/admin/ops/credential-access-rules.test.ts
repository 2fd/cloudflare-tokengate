import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addTenantValue,
  createCredentialAccessRule,
  defaultAudience,
  deleteCredentialAccessRule,
  duplicateCredentialAccessRule,
  removeTenantValue,
  setCredentialAccessRuleEnabled,
  updateCredentialAccessRule,
} from '../../../../src/admin/ops/credential-access-rules';
import {
  getCredentialAccessRule,
  insertAccessRuleStatement,
} from '../../../../src/db/access-rules';
import {
  ACTOR,
  anchoredConditions,
  auditCount,
  auditRows,
  fakeNetwork,
  GITHUB_ISSUER,
  GITHUB_JWKS,
  OWNER_ID,
  opsDeps,
  REPOSITORY_ID,
  resetControlPlane,
  seedCredentialRule,
  seedGlobalRule,
  seedService,
  testCredentialId,
} from './helpers';

const ACME_ISSUER = 'https://idp.acme.example';
const ACME_JWKS = 'https://idp.acme.example/keys';
const RULES = [{ methods: ['GET' as const], path: '/repos/**' }];
const BRANCH_GLOB = { claim: 'ref', match: 'glob' as const, values: ['refs/heads/*'] };
const OWNER_PIN = [{ claim: 'repository_owner_id', match: 'exact' as const, values: [OWNER_ID] }];

function network() {
  return fakeNetwork(undefined, {
    [GITHUB_ISSUER]: GITHUB_JWKS,
    [ACME_ISSUER]: ACME_JWKS,
    'https://idp2.acme.example': 'https://idp2.acme.example/keys',
  });
}

/** A GitHub rule input on the test credential; `overrides` replace fields. */
async function githubInput(deps: ReturnType<typeof opsDeps>) {
  return {
    credential_id: await testCredentialId(deps),
    name: 'deploy',
    profile: 'github-actions',
    tenant_pin: OWNER_PIN,
    conditions: anchoredConditions(),
    rules: RULES,
  };
}

/** A generic rule with its own JWKS URI and audience (no discovery). */
async function genericInput(deps: ReturnType<typeof opsDeps>) {
  return {
    credential_id: await testCredentialId(deps),
    name: 'Acme',
    profile: 'generic',
    issuer: ACME_ISSUER,
    audience: 'tokengate:acme-gateway-01',
    anchor_claims: ['sub'],
    tenant_pin: [{ claim: 'tenant', match: 'exact' as const, values: ['acme'] }],
    conditions: [{ claim: 'sub', match: 'exact' as const, values: ['ci-bot'] }],
    rules: [{ methods: ['GET' as const], path: '/**' }],
  };
}

let deps: ReturnType<typeof opsDeps>;

beforeEach(async () => {
  await resetControlPlane();
  deps = opsDeps({ fetch: network().fetch });
});

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
    const netDeps = opsDeps({ fetch: net.fetch });
    const result = await createCredentialAccessRule(netDeps, ACTOR, {
      ...(await githubInput(netDeps)),
      name: ' deploy ',
      // The GitHub profile ignores a JWKS URI from the form.
      jwks_uri: 'https://attacker.example/jwks',
      tenant_pin: [{ ...OWNER_PIN[0]!, negate: false }],
      conditions: [
        ...anchoredConditions(),
        { claim: 'event_name', match: 'exact', values: ['push'], negate: false },
      ],
      rules: [{ methods: ['GET'], path: '/repos/**', extra: 1 } as never],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rule).toMatchObject({
      kind: 'credential',
      name: 'deploy',
      profile: 'github-actions',
      issuer: GITHUB_ISSUER,
      issuer_key: GITHUB_ISSUER,
      jwks_uri: GITHUB_JWKS,
      allowed_algs: ['RS256'],
      max_token_age_seconds: 600,
      tenant_pin: OWNER_PIN,
      rules: RULES,
      enabled: true,
      created_by: ACTOR.email,
    });
    expect(result.rule.id).toMatch(/^acr_/);
    expect(result.rule.conditions[2]).toEqual({
      claim: 'event_name',
      match: 'exact',
      values: ['push'],
    });
    expect(result.rule.audience).toMatch(/^tokengate:[a-z2-7]{26}$/);
    expect(result.globalStatus).toEqual({ kind: 'not_limited' });
    expect(net.calls.map((call) => call.url)).toEqual([
      `${GITHUB_ISSUER}/.well-known/openid-configuration`,
    ]);
    expect(await getCredentialAccessRule(env.DB, result.rule.id)).toEqual(result.rule);
    expect((await auditRows(result.rule.id)).map((row) => row.action)).toEqual([
      'credential_access_rule.create',
    ]);
  });

  it('reuses the audience and the JWKS URI of the newest rule of the credential and issuer', async () => {
    const net = network();
    const netDeps = opsDeps({ fetch: net.fetch });
    const first = await seedCredentialRule(netDeps);
    const second = await createCredentialAccessRule(netDeps, ACTOR, {
      ...(await githubInput(netDeps)),
      name: 'other repo',
      conditions: [
        { claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] },
        { claim: 'repository_id', match: 'exact', values: ['111'] },
      ],
    });
    expect(second.ok && second.rule).toMatchObject({
      audience: first.audience,
      jwks_uri: GITHUB_JWKS,
    });
    // One discovery for the first rule only.
    expect(net.calls).toHaveLength(1);
  });

  it('requires a tenant pin on the shared GitHub issuer (I-TEN-1)', async () => {
    const input = await githubInput(deps);
    const before = await auditCount();
    const result = await createCredentialAccessRule(deps, ACTOR, {
      ...input,
      tenant_pin: [],
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (result.ok) return;
    expect(result.errors.join()).toMatch(/tenant pin is required/);
    expect(await auditCount()).toBe(before);
  });

  it('refuses jobs without an anchor condition (I-AUTHZ-2)', async () => {
    const input = await githubInput(deps);
    const before = await auditCount();
    const result = await createCredentialAccessRule(deps, ACTOR, {
      ...input,
      conditions: OWNER_PIN,
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (result.ok) return;
    expect(result.errors.join()).toMatch(/I-AUTHZ-2/);
    expect(await auditCount()).toBe(before);
  });

  it('refuses owner IDs outside its own tenant pin', async () => {
    const result = await createCredentialAccessRule(deps, ACTOR, {
      ...(await githubInput(deps)),
      conditions: [
        { claim: 'repository_owner_id', match: 'exact', values: ['9999'] },
        { claim: 'repository_id', match: 'exact', values: ['1'] },
      ],
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (result.ok) return;
    expect(result.errors.join()).toMatch(/outside the tenant pin/);
  });

  it('lets a generic issuer name its JWKS URI without discovery', async () => {
    const net = network();
    const netDeps = opsDeps({ fetch: net.fetch });
    const result = await createCredentialAccessRule(netDeps, ACTOR, {
      ...(await genericInput(netDeps)),
      issuer: 'https://idp.other.example',
      jwks_uri: 'https://idp.other.example/jwks.json',
      tenant_pin: [],
      acknowledge_warnings: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rule.jwks_uri).toBe('https://idp.other.example/jwks.json');
    expect(result.warnings.join()).toMatch(/no tenant pin/);
    expect(net.calls).toHaveLength(0);
  });

  it('reports discovery failures', async () => {
    const result = await createCredentialAccessRule(deps, ACTOR, {
      ...(await genericInput(deps)),
      issuer: 'https://unknown.example',
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/^JWKS discovery failed/);
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
    const algDeps = opsDeps({ fetch: fetchImpl });
    const created = await createCredentialAccessRule(algDeps, ACTOR, await genericInput(algDeps));
    expect(created.ok && created.rule).toMatchObject({
      allowed_algs: ['ES384'],
      jwks_uri: ACME_JWKS,
    });
  });

  it('rejects unknown profiles, unknown credentials and past expiry', async () => {
    const input = await githubInput(deps);
    expect(
      await createCredentialAccessRule(deps, ACTOR, { ...input, profile: 'constructor' }),
    ).toMatchObject({ ok: false, reason: 'invalid' });
    const missing = await createCredentialAccessRule(deps, ACTOR, {
      ...input,
      credential_id: 'svc_missing',
    });
    expect(missing).toMatchObject({
      ok: false,
      errors: ['Select a credential for this access rule.'],
    });
    const expired = await createCredentialAccessRule(deps, ACTOR, { ...input, expires_at: 1 });
    expect(expired).toMatchObject({ ok: false, errors: ['expiry must be in the future'] });
    expect(await auditCount()).toBe(1); // service.create only
  });

  it('names an unnamed rule "Rule", unique per credential', async () => {
    const input = { ...(await githubInput(deps)), name: '' };
    const first = await createCredentialAccessRule(deps, ACTOR, input);
    const second = await createCredentialAccessRule(deps, ACTOR, input);
    expect(first.ok && first.rule.name).toBe('Rule');
    expect(second.ok && second.rule.name).toBe('Rule (2)');
  });

  it('requires acknowledgement of warnings and records them in the audit row', async () => {
    const input = {
      ...(await githubInput(deps)),
      conditions: [...anchoredConditions(), BRANCH_GLOB],
    };
    const first = await createCredentialAccessRule(deps, ACTOR, input);
    expect(first).toMatchObject({ ok: false, reason: 'acknowledgement_required' });
    if (first.ok) return;
    expect(first.warnings.join()).toMatch(/ref_protected/);

    const second = await createCredentialAccessRule(deps, ACTOR, {
      ...input,
      acknowledge_warnings: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const [audit] = await auditRows(second.rule.id);
    expect(audit?.diff?.warnings).toEqual(first.warnings);
  });

  it('requires acknowledgement for methods other than POST on a path-injection credential', async () => {
    const webhookId = await seedService(deps, {
      slug: 'discord-webhook',
      name: 'Discord webhook',
      base_url: 'https://discord.com/api/webhooks',
      injection: { kind: 'path' },
      forward_headers: [],
    });
    const input = { ...(await githubInput(deps)), credential_id: webhookId, name: 'notify' };
    for (const methods of [['GET'], ['*'], ['POST', 'PATCH']] as const) {
      const result = await createCredentialAccessRule(deps, ACTOR, {
        ...input,
        rules: [{ methods: [...methods], path: '/' }],
      });
      expect(result, methods.join()).toMatchObject({
        ok: false,
        reason: 'acknowledgement_required',
      });
      if (result.ok) return;
      expect(result.warnings.join()).toMatch(/URL path.*allow only POST/);
    }
    const post = await createCredentialAccessRule(deps, ACTOR, {
      ...input,
      rules: [{ methods: ['POST'], path: '/' }],
    });
    expect(post).toMatchObject({ ok: true, warnings: [] });
  });

  it('writes the typed labels in the create batch and records them and the risks in the audit', async () => {
    const result = await createCredentialAccessRule(deps, ACTOR, {
      ...(await githubInput(deps)),
      labels: [
        { claim: 'repository_owner_id', value: OWNER_ID, label: 'acme' },
        { claim: 'repository_id', value: REPOSITORY_ID, label: 'acme/api' },
      ],
      accepted_risks: ['unprotected_ref'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const labels = await env.DB.prepare(
      'SELECT access_rule_id, claim, value, label, updated_by FROM claim_labels ORDER BY claim',
    ).all();
    expect(labels.results).toEqual([
      {
        access_rule_id: result.rule.id,
        claim: 'repository_id',
        value: REPOSITORY_ID,
        label: 'acme/api',
        updated_by: ACTOR.id,
      },
      {
        access_rule_id: result.rule.id,
        claim: 'repository_owner_id',
        value: OWNER_ID,
        label: 'acme',
        updated_by: ACTOR.id,
      },
    ]);
    const [audit] = await auditRows(result.rule.id);
    expect(audit?.diff).toMatchObject({
      accepted_risks: ['unprotected_ref'],
      labels: { after: { [`repository_id:${REPOSITORY_ID}`]: 'acme/api' } },
    });
  });

  it('refuses labels that are not numeric IDs and non-numeric organization IDs', async () => {
    const input = await githubInput(deps);
    const label = await createCredentialAccessRule(deps, ACTOR, {
      ...input,
      labels: [{ claim: 'repository_id', value: 'acme', label: 'acme/api' }],
    });
    expect(label).toMatchObject({ ok: false, reason: 'invalid' });
    const pin = await createCredentialAccessRule(deps, ACTOR, {
      ...input,
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: ['acme'] }],
    });
    expect(pin).toMatchObject({ ok: false, reason: 'invalid' });
    const rows = await env.DB.prepare('SELECT count(*) AS n FROM access_rules').first<{
      n: number;
    }>();
    expect(rows?.n).toBe(0);
  });

  it('warns about the global access rules of its issuer and still saves (AR-8)', async () => {
    await seedGlobalRule(deps, { rules: [{ methods: ['GET'], path: '/repos/acme/**' }] });
    const limited = await createCredentialAccessRule(deps, ACTOR, await githubInput(deps));
    expect(limited.ok).toBe(true);
    if (!limited.ok) return;
    expect(limited.globalStatus.kind).toBe('limited');
    expect(limited.warningDetails.at(-1)?.code).toBe('global_limited');

    await seedGlobalRule(deps, { name: 'gitlab only', allowed_algs: ['ES256'] });
    const other = await createCredentialAccessRule(deps, ACTOR, {
      ...(await githubInput(deps)),
      name: 'deploy 2',
    });
    // One global rule may admit part of it: still limited, not blocked.
    expect(other.ok && other.globalStatus.kind).toBe('limited');
  });

  it('reports a blocked rule when no global access rule can hold for it', async () => {
    await seedGlobalRule(deps, { allowed_algs: ['ES256'] });
    const result = await createCredentialAccessRule(deps, ACTOR, await githubInput(deps));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.globalStatus.kind).toBe('blocked');
    expect(result.warnings.at(-1)).toMatch(
      /^The global access rules of this issuer refuse every request of this rule: /,
    );
  });

  it('refuses a new rule past the cap of 100 per credential', async () => {
    const rule = await seedCredentialRule(deps);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
       INSERT INTO access_rules (id, credential_id, profile, name, description, issuer, issuer_key, jwks_uri,
         audience, allowed_algs, max_token_age_seconds, tenant_pin, anchor_claims, conditions, rules, enabled,
         expires_at, created_by, created_at, updated_at)
       SELECT printf('acr_CAP%023d', i), credential_id, profile, name || ' ' || i, description, issuer,
         issuer_key, jwks_uri, audience, allowed_algs, max_token_age_seconds, tenant_pin, anchor_claims,
         conditions, rules, enabled, expires_at, created_by, created_at, updated_at
       FROM n, access_rules WHERE id = ?`,
    )
      .bind(rule.id)
      .run();
    const before = await auditCount();
    const result = await createCredentialAccessRule(deps, ACTOR, {
      ...(await githubInput(deps)),
      name: 'one too many',
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'invalid',
      errors: ['A credential can have at most 100 access rules.'],
    });
    expect(await auditCount()).toBe(before);
  });

  it('refuses a taken name of the same credential (any case) as a conflict', async () => {
    await seedCredentialRule(deps, { name: 'deploy' });
    const clash = await updateCredentialAccessRule(
      deps,
      ACTOR,
      (await seedCredentialRule(deps, { name: 'other' })).id,
      { name: 'DEPLOY' },
    );
    expect(clash).toMatchObject({ ok: false, reason: 'conflict', errors: ['This name is taken.'] });
  });
});

describe('updateCredentialAccessRule', () => {
  it('keeps the profile and the credential immutable', async () => {
    const rule = await seedCredentialRule(deps);
    expect(
      await updateCredentialAccessRule(deps, ACTOR, rule.id, { profile: 'generic' }),
    ).toMatchObject({ ok: false, reason: 'invalid' });
    const other = await seedService(deps, { slug: 'other', name: 'Other' });
    const moved = await updateCredentialAccessRule(deps, ACTOR, rule.id, {
      credential_id: other,
    } as never);
    expect(moved.ok && moved.rule.credential_id).toBe(rule.credential_id);
  });

  it('updates content, re-validates, and audits only changed fields', async () => {
    const rule = await seedCredentialRule(deps);
    const result = await updateCredentialAccessRule(deps, ACTOR, rule.id, {
      rules: [{ methods: ['GET', 'POST'], path: '/repos/**' }],
      max_token_age_seconds: 300,
    });
    expect(result.ok).toBe(true);
    const audit = (await auditRows(rule.id)).at(-1);
    expect(audit?.action).toBe('credential_access_rule.update');
    expect(audit?.summary).toBe(
      'Changed credential access rule read repo: maximum token age, operations',
    );
    expect(audit?.diff).toMatchObject({
      before: { rules: RULES, max_token_age_seconds: 600 },
      after: {
        rules: [{ methods: ['GET', 'POST'], path: '/repos/**' }],
        max_token_age_seconds: 300,
      },
    });
  });

  it('refuses a save from a form opened at an older version', async () => {
    const rule = await seedCredentialRule(deps);
    const first = await updateCredentialAccessRule(deps, ACTOR, rule.id, {
      name: 'first',
      expected_updated_at: rule.updated_at,
    });
    expect(first.ok).toBe(true);
    const before = await auditCount();
    const stale = await updateCredentialAccessRule(deps, ACTOR, rule.id, {
      name: 'second',
      expected_updated_at: rule.updated_at,
    });
    expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
    if (stale.ok) return;
    expect(stale.errors.join()).toContain('changed by someone else since you opened this page');
    expect((await getCredentialAccessRule(env.DB, rule.id))?.name).toBe('first');
    expect(await auditCount()).toBe(before);
  });

  it('refuses invalid content without writing', async () => {
    const rule = await seedCredentialRule(deps);
    const before = await auditCount();
    const result = await updateCredentialAccessRule(deps, ACTOR, rule.id, { conditions: [] });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await getCredentialAccessRule(env.DB, rule.id)).toEqual(rule);
    expect(await auditCount()).toBe(before);
  });

  it('changes the issuer with rediscovery and no confirmation', async () => {
    const rule = await seedCredentialRule(deps, await genericInput(deps));
    const result = await updateCredentialAccessRule(deps, ACTOR, rule.id, {
      issuer: 'https://idp2.acme.example',
    });
    expect(result.ok).toBe(true);
    expect(await getCredentialAccessRule(env.DB, rule.id)).toMatchObject({
      issuer: 'https://idp2.acme.example',
      issuer_key: 'https://idp2.acme.example',
      jwks_uri: 'https://idp2.acme.example/keys',
    });
  });

  it('a save that only changes a label is one update with the label diff', async () => {
    const rule = await seedCredentialRule(deps);
    const label = { claim: 'repository_id' as const, value: REPOSITORY_ID, label: 'acme/api' };
    expect((await updateCredentialAccessRule(deps, ACTOR, rule.id, { labels: [label] })).ok).toBe(
      true,
    );
    const renamed = await updateCredentialAccessRule(deps, ACTOR, rule.id, {
      labels: [{ ...label, label: 'acme/api-renamed' }],
    });
    expect(renamed).toMatchObject({ ok: true, changed: true, labelsChanged: true });
    const unchanged = await updateCredentialAccessRule(deps, ACTOR, rule.id, {
      labels: [{ ...label, label: 'acme/api-renamed' }],
    });
    expect(unchanged).toMatchObject({ ok: true, changed: false });
    expect((await auditRows(rule.id)).map((row) => row.action)).toEqual([
      'credential_access_rule.create',
      'credential_access_rule.update',
      'credential_access_rule.update',
    ]);
  });
});

describe('setCredentialAccessRuleEnabled', () => {
  it('always disables, even when the stored row no longer validates', async () => {
    const rule = await seedCredentialRule(deps);
    // Drop the anchor outside the ops (they refuse it), so the stored row no longer validates.
    await env.DB.prepare(
      `UPDATE access_rules SET conditions = ?, updated_at = updated_at + 1 WHERE id = ?`,
    )
      .bind(JSON.stringify(OWNER_PIN), rule.id)
      .run();
    const disabled = await setCredentialAccessRuleEnabled(deps, ACTOR, rule.id, false);
    expect(disabled.ok).toBe(true);
    expect((await getCredentialAccessRule(env.DB, rule.id))?.enabled).toBe(false);
    expect((await auditRows(rule.id)).at(-1)?.action).toBe('credential_access_rule.disable');

    const enabled = await setCredentialAccessRuleEnabled(deps, ACTOR, rule.id, true);
    expect(enabled).toMatchObject({ ok: false, reason: 'invalid' });
    expect((await getCredentialAccessRule(env.DB, rule.id))?.enabled).toBe(false);
  });

  it('enables a valid rule', async () => {
    const rule = await seedCredentialRule(deps);
    await setCredentialAccessRuleEnabled(deps, ACTOR, rule.id, false);
    const result = await setCredentialAccessRuleEnabled(deps, ACTOR, rule.id, true);
    expect(result.ok).toBe(true);
    expect((await auditRows(rule.id)).at(-1)).toMatchObject({
      action: 'credential_access_rule.enable',
      summary: 'Enabled credential access rule read repo',
    });
  });
});

describe('duplicateCredentialAccessRule', () => {
  it('copies to the same credential with " (copy)", its labels and the source id', async () => {
    const rule = await seedCredentialRule(deps, {
      name: 'deploy',
      labels: [{ claim: 'repository_id', value: REPOSITORY_ID, label: 'acme/api' }],
    });
    const result = await duplicateCredentialAccessRule(deps, ACTOR, rule.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rule).toMatchObject({
      name: 'deploy (copy)',
      credential_id: rule.credential_id,
      enabled: true,
      audience: rule.audience,
      conditions: rule.conditions,
      rules: rule.rules,
    });
    expect(result.rule.id).not.toBe(rule.id);
    const labels = await env.DB.prepare('SELECT label FROM claim_labels WHERE access_rule_id = ?')
      .bind(result.rule.id)
      .all<{ label: string }>();
    expect(labels.results).toEqual([{ label: 'acme/api' }]);
    const [audit] = await auditRows(result.rule.id);
    expect(audit).toMatchObject({ action: 'credential_access_rule.duplicate' });
    expect(audit?.diff?.source_id).toBe(rule.id);
  });

  it('copies to another credential with the same name, validated against the target', async () => {
    const rule = await seedCredentialRule(deps, { name: 'deploy' });
    const webhookId = await seedService(deps, {
      slug: 'discord-webhook',
      name: 'Discord webhook',
      base_url: 'https://discord.com/api/webhooks',
      injection: { kind: 'path' },
      forward_headers: [],
    });
    const before = await auditCount();
    const refused = await duplicateCredentialAccessRule(deps, ACTOR, rule.id, {
      credentialId: webhookId,
    });
    expect(refused).toMatchObject({ ok: false, reason: 'acknowledgement_required' });
    expect(await auditCount()).toBe(before);
    const copied = await duplicateCredentialAccessRule(deps, ACTOR, rule.id, {
      credentialId: webhookId,
      acknowledge_warnings: true,
    });
    expect(copied.ok && copied.rule).toMatchObject({ name: 'deploy', credential_id: webhookId });
    expect((await auditRows()).at(-1)?.summary).toBe(
      'Copied credential access rule deploy from GitHub to Discord webhook',
    );
  });
});

describe('deleteCredentialAccessRule', () => {
  it('deletes the rule and its labels with the full rule in the audit row', async () => {
    const rule = await seedCredentialRule(deps, {
      labels: [{ claim: 'repository_id', value: REPOSITORY_ID, label: 'acme/api' }],
    });
    expect(await deleteCredentialAccessRule(deps, ACTOR, rule.id)).toEqual({ ok: true });
    expect(await getCredentialAccessRule(env.DB, rule.id)).toBeNull();
    const labels = await env.DB.prepare('SELECT count(*) AS n FROM claim_labels').first<{
      n: number;
    }>();
    expect(labels?.n).toBe(0);
    const audit = (await auditRows(rule.id)).at(-1);
    expect(audit).toMatchObject({
      action: 'credential_access_rule.delete',
      summary: 'Deleted credential access rule read repo of GitHub',
    });
    expect(audit?.diff?.before).toMatchObject({ id: rule.id, issuer: GITHUB_ISSUER });
    expect(await deleteCredentialAccessRule(deps, ACTOR, rule.id)).toMatchObject({
      reason: 'not_found',
    });
  });

  it('never deletes a global access rule by its id', async () => {
    const global = await seedGlobalRule(deps);
    expect(await deleteCredentialAccessRule(deps, ACTOR, global.id)).toMatchObject({
      reason: 'not_found',
    });
  });
});

describe('addTenantValue, removeTenantValue', () => {
  it('adds organizations with their labels and keeps a typed name', async () => {
    const rule = await seedCredentialRule(deps);
    const added = await addTenantValue(deps, ACTOR, rule.id, {
      claim: 'repository_owner_id',
      entries: [{ value: '5', label: 'other' }],
    });
    expect(added.ok && added.rule).toMatchObject({
      name: 'read repo',
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID, '5'] }],
    });
    const again = await addTenantValue(deps, ACTOR, rule.id, {
      claim: 'repository_owner_id',
      entries: [{ value: '5', label: 'other' }],
    });
    expect(again).toMatchObject({ ok: false, errors: ['other (5) is already allowed.'] });
  });

  it('refuses a non-numeric organization ID (UI rule on top of the validator)', async () => {
    const rule = await seedCredentialRule(deps);
    const result = await addTenantValue(deps, ACTOR, rule.id, {
      claim: 'repository_owner_id',
      entries: [{ value: 'acme', label: 'acme' }],
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('refuses removing a value its own jobs use, and removes an unused one', async () => {
    const rule = await seedCredentialRule(deps);
    await addTenantValue(deps, ACTOR, rule.id, {
      claim: 'repository_owner_id',
      entries: [{ value: '5', label: 'other' }],
    });
    expect(
      await removeTenantValue(deps, ACTOR, rule.id, {
        claim: 'repository_owner_id',
        value: OWNER_ID,
        label: 'acme',
      }),
    ).toMatchObject({
      ok: false,
      errors: ['Remove the workload conditions that use organization acme first.'],
    });
    expect(
      await removeTenantValue(deps, ACTOR, rule.id, { claim: 'repository_owner_id', value: '5' }),
    ).toMatchObject({ ok: true });
    expect((await getCredentialAccessRule(env.DB, rule.id))?.tenant_pin).toEqual(OWNER_PIN);
  });

  it('reads a pin with two conditions on the claim as their intersection (I-TEN-1)', async () => {
    const rule = await seedCredentialRule(deps, {
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: ['2'] }],
      conditions: [
        { claim: 'repository_owner_id', match: 'exact', values: ['2'] },
        { claim: 'repository_id', match: 'exact', values: [REPOSITORY_ID] },
      ],
    });
    // A pin stored with two rows on one claim: effective organizations {2}.
    await env.DB.prepare('UPDATE access_rules SET tenant_pin = ? WHERE id = ?')
      .bind(
        JSON.stringify([
          { claim: 'repository_owner_id', match: 'exact', values: ['1', '2'] },
          { claim: 'repository_owner_id', match: 'exact', values: ['2', '3'] },
        ]),
        rule.id,
      )
      .run();
    expect(
      await removeTenantValue(deps, ACTOR, rule.id, { claim: 'repository_owner_id', value: '1' }),
    ).toMatchObject({ ok: false, reason: 'invalid' });
    const added = await addTenantValue(deps, ACTOR, rule.id, {
      claim: 'repository_owner_id',
      entries: [{ value: '4', label: 'other' }],
    });
    expect(added.ok).toBe(true);
    // Organizations 1 and 3 stay out: only the admitted value plus the added one.
    expect((await getCredentialAccessRule(env.DB, rule.id))?.tenant_pin).toEqual([
      { claim: 'repository_owner_id', match: 'exact', values: ['2', '4'] },
    ]);
  });
});

describe('guarded insert', () => {
  it('writes nothing when the guard does not hold', async () => {
    const rule = await seedCredentialRule(deps);
    const statement = insertAccessRuleStatement(
      env.DB,
      { ...rule, id: 'acr_GUARDED00000000000000000', name: 'guarded' },
      {
        sql: 'EXISTS (SELECT 1 FROM access_rules WHERE id = ? AND updated_at = ?)',
        binds: [rule.id, -1],
      },
    );
    const result = await statement.run();
    expect(result.meta.changes).toBe(0);
    expect(await getCredentialAccessRule(env.DB, 'acr_GUARDED00000000000000000')).toBeNull();
  });
});
