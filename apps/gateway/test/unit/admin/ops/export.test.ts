import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildExport,
  EXPORT_SCHEMA_VERSION,
  exportConfiguration,
  exportJson,
} from '../../../../src/admin/ops/export';
import {
  ACTOR,
  anchoredConditions,
  auditRows,
  GITHUB_ISSUER,
  OWNER_ID,
  opsDeps,
  REPOSITORY_ID,
  resetControlPlane,
  seedCredentialRule,
  seedGlobalRule,
  seedService,
} from './helpers';

const SECRET = 'export-canary-0123456789abcdef';
const PIN = [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }];

beforeEach(resetControlPlane);

async function seed() {
  const deps = opsDeps();
  const github = await seedService(deps, { secret: SECRET });
  const slack = await seedService(deps, {
    slug: 'slack',
    name: 'Slack',
    base_url: 'https://slack.com/api',
    forward_headers: [],
  });
  const zeta = await seedCredentialRule(deps, { credential_id: slack, name: 'zeta' });
  const beta = await seedCredentialRule(deps, { credential_id: github, name: 'beta' });
  const alpha = await seedCredentialRule(deps, {
    credential_id: github,
    name: 'alpha',
    labels: [
      { claim: 'repository_owner_id', value: OWNER_ID, label: 'acme' },
      { claim: 'repository_id', value: REPOSITORY_ID, label: 'acme/api' },
    ],
  });
  const global = await seedGlobalRule(deps, {
    name: 'acme only',
    tenant_pin: PIN as never,
    labels: [{ claim: 'repository_owner_id', value: OWNER_ID, label: 'acme' }],
  });
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, email, role, status, created_at, updated_at) VALUES ('usr_b', 'B@example.com', 'admin', 'active', 1, 1), ('usr_a', 'a@example.com', 'owner', 'active', 1, 1), ('usr_c', 'c@example.com', 'token_manager', 'active', 1, 1), ('usr_d', 'd@example.com', 'access_manager', 'pending', 1, 1)",
  ).run();
  return { deps, credentials: { github, slack }, rules: { zeta, beta, alpha }, global };
}

describe('buildExport', () => {
  it('exports schema 6: credentials and both kinds of access rule with their ids and labels', async () => {
    const { credentials, rules, global } = await seed();
    const document = await buildExport(env.DB);
    expect(document.schema_version).toBe(EXPORT_SCHEMA_VERSION);
    expect(EXPORT_SCHEMA_VERSION).toBe(6);
    expect(document.credentials.map((credential) => [credential.slug, credential.id])).toEqual([
      ['github', credentials.github],
      ['slack', credentials.slack],
    ]);
    // A slug names a credential type (ADR 0031), so a rule points at its credential's id.
    expect(document.credential_access_rules.map((rule) => [rule.credential, rule.name])).toEqual([
      [credentials.github, 'alpha'],
      [credentials.github, 'beta'],
      [credentials.slack, 'zeta'],
    ]);
    expect(document.credential_access_rules[0]).toEqual({
      id: rules.alpha.id,
      credential: credentials.github,
      name: 'alpha',
      description: '',
      profile: 'github-actions',
      issuer: GITHUB_ISSUER,
      jwks_uri: rules.alpha.jwks_uri,
      audience: rules.alpha.audience,
      allowed_algs: ['RS256'],
      max_token_age_seconds: 600,
      tenant_pin: PIN,
      anchor_claims: [],
      conditions: anchoredConditions(),
      rules: [{ methods: ['GET'], path: '/repos/**' }],
      enabled: true,
      expires_at: null,
      labels: [
        { claim: 'repository_id', value: REPOSITORY_ID, label: 'acme/api' },
        { claim: 'repository_owner_id', value: OWNER_ID, label: 'acme' },
      ],
    });
    expect(document.global_access_rules).toEqual([
      {
        id: global.id,
        name: 'acme only',
        description: '',
        profile: 'github-actions',
        issuer: GITHUB_ISSUER,
        jwks_uri: null,
        audience: null,
        allowed_algs: null,
        max_token_age_seconds: null,
        tenant_pin: PIN,
        anchor_claims: null,
        conditions: null,
        rules: null,
        enabled: true,
        expires_at: null,
        labels: [{ claim: 'repository_owner_id', value: OWNER_ID, label: 'acme' }],
      },
    ]);
    expect(document.credentials.map((s) => s.slug)).toEqual(['github', 'slack']);
    // Export version 5: a credential has no expiry.
    expect(document.credentials[0]?.credential).toEqual({
      hint: '…cdef (30 chars)',
      updated_at: expect.any(Number),
    });
    expect(document.credentials[1]?.credential).toBeNull();
    // createService derives template_id from the destination.
    expect(document.credentials.map((s) => s.template_id)).toEqual(['github', 'slack']);
    expect(document.users).toEqual([
      { email: 'a@example.com', role: 'owner', status: 'active' },
      { email: 'b@example.com', role: 'admin', status: 'active' },
      { email: 'c@example.com', role: 'token_manager', status: 'active' },
      { email: 'd@example.com', role: 'access_manager', status: 'pending' },
    ]);
    expect(Object.keys(document).sort()).toEqual([
      'credential_access_rules',
      'credentials',
      'global_access_rules',
      'schema_version',
      'users',
    ]);

    const json = exportJson(document);
    expect(json).not.toContain(SECRET);
    // Credentials and rules carry their ids (ADR 0031); users do not.
    expect(json).not.toMatch(/credential_sealed|issuer_key|"usr_/);
    expect(json).not.toMatch(/"(credential_id|created_at|created_by|updated_by)":/);
  });

  it('is deterministic', async () => {
    await seed();
    const first = exportJson(await buildExport(env.DB));
    const second = exportJson(await buildExport(env.DB));
    expect(second).toBe(first);
    expect(first.endsWith('}\n')).toBe(true);
  });
});

describe('exportConfiguration', () => {
  it('audits the download', async () => {
    const { deps } = await seed();
    const result = await exportConfiguration(deps, ACTOR);
    expect(result.ok).toBe(true);
    const audit = (await auditRows()).at(-1);
    expect(audit).toMatchObject({ action: 'config.export', actor_email: ACTOR.email });
    expect(audit?.diff).toEqual({
      counts: {
        credentials: 2,
        credential_access_rules: 3,
        global_access_rules: 1,
        users: 4,
      },
    });
  });
});
