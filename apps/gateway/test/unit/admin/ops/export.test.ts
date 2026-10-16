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
  auditRows,
  OWNER_ID,
  opsDeps,
  resetControlPlane,
  seedGithubProvider,
  seedGrant,
  seedService,
} from './helpers';

const SECRET = 'export-canary-0123456789abcdef';

beforeEach(resetControlPlane);

async function seed() {
  const deps = opsDeps();
  const provider = await seedGithubProvider(deps);
  const github = await seedService(deps, { secret: SECRET });
  const slack = await seedService(deps, {
    slug: 'slack',
    name: 'Slack',
    base_url: 'https://slack.com/api',
    forward_headers: [],
  });
  await seedGrant(deps, provider.id, slack, 'zeta');
  await seedGrant(deps, provider.id, github, 'beta');
  await seedGrant(deps, provider.id, github, 'alpha');
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, email, role, status, created_at, updated_at) VALUES ('usr_b', 'B@example.com', 'admin', 'active', 1, 1), ('usr_a', 'a@example.com', 'owner', 'active', 1, 1), ('usr_c', 'c@example.com', 'token_manager', 'active', 1, 1), ('usr_d', 'd@example.com', 'access_manager', 'pending', 1, 1)",
  ).run();
  await env.DB.prepare(
    `INSERT INTO claim_labels (caller_provider_id, claim, value, label, updated_at, updated_by)
     VALUES (?1, 'repository_id', '987654321', 'acme/api', 1, 'usr_a'),
            (?1, 'repository_id', '12345', 'acme/web', 1, NULL),
            (?1, 'repository_owner_id', ?2, 'acme', 1, 'usr_a')`,
  )
    .bind(provider.id, OWNER_ID)
    .run();
  return { deps, provider };
}

describe('buildExport', () => {
  it('exports configuration keyed by name/slug, sorted, without ids or secrets', async () => {
    const { provider } = await seed();
    const document = await buildExport(env.DB);
    expect(document.schema_version).toBe(EXPORT_SCHEMA_VERSION);
    expect(EXPORT_SCHEMA_VERSION).toBe(2);
    expect(document.caller_providers).toEqual([
      {
        name: 'GitHub Actions',
        profile: 'github-actions',
        issuer: provider.issuer,
        jwks_uri: provider.jwks_uri,
        audience: provider.audience,
        allowed_algs: ['RS256'],
        max_token_age_seconds: 600,
        tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
        anchor_claims: [],
        enabled: true,
      },
    ]);
    expect(document.services.map((s) => s.slug)).toEqual(['github', 'slack']);
    expect(document.services[0]?.credential).toMatchObject({ hint: '…cdef (30 chars)' });
    expect(document.services[1]?.credential).toBeNull();
    // createService derives template_id from the destination.
    expect(document.services.map((s) => s.template_id)).toEqual(['github', 'slack']);
    expect(document.claim_labels).toEqual([
      {
        caller_provider: 'GitHub Actions',
        claim: 'repository_id',
        value: '12345',
        label: 'acme/web',
      },
      {
        caller_provider: 'GitHub Actions',
        claim: 'repository_id',
        value: '987654321',
        label: 'acme/api',
      },
      {
        caller_provider: 'GitHub Actions',
        claim: 'repository_owner_id',
        value: OWNER_ID,
        label: 'acme',
      },
    ]);
    expect(document.grants.map((g) => [g.service, g.name])).toEqual([
      ['github', 'alpha'],
      ['github', 'beta'],
      ['slack', 'zeta'],
    ]);
    expect(document.grants[0]?.caller_provider).toBe('GitHub Actions');
    expect(document.users).toEqual([
      { email: 'a@example.com', role: 'owner', status: 'active' },
      { email: 'b@example.com', role: 'admin', status: 'active' },
      { email: 'c@example.com', role: 'token_manager', status: 'active' },
      { email: 'd@example.com', role: 'access_manager', status: 'pending' },
    ]);

    const json = exportJson(document);
    expect(json).not.toContain(SECRET);
    expect(json).not.toMatch(/credential_sealed|"(svc|cpr|grt|usr)_/);
    expect(json).not.toMatch(/"(id|created_at|created_by|updated_by)":/);
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
      counts: { caller_providers: 1, services: 2, grants: 3, claim_labels: 3, users: 4 },
    });
  });
});
