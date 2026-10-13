import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCallerProvider,
  defaultAudience,
  deleteCallerProvider,
  setCallerProviderEnabled,
  updateCallerProvider,
} from '../../../../src/admin/ops/caller-providers';
import { createGrant, setGrantEnabled } from '../../../../src/admin/ops/grants';
import { getCallerProvider } from '../../../../src/db/caller-providers';
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
  seedGrant,
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

describe('createCallerProvider', () => {
  it('applies profile defaults, generates an audience and discovers the JWKS URI', async () => {
    const net = network();
    const result = await createCallerProvider(opsDeps({ fetch: net.fetch }), ACTOR, {
      name: ' GitHub Actions ',
      profile: 'github-actions',
      jwks_uri: 'https://attacker.example/jwks',
      tenant_pin: [
        { claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID], negate: false },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.callerProvider).toMatchObject({
      name: 'GitHub Actions',
      profile: 'github-actions',
      issuer: GITHUB_ISSUER,
      jwks_uri: GITHUB_JWKS,
      allowed_algs: ['RS256'],
      max_token_age_seconds: 600,
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
      enabled: true,
    });
    expect(result.callerProvider.audience).toMatch(/^tokengate:[a-z2-7]{26}$/);
    expect(net.calls.map((call) => call.url)).toEqual([
      `${GITHUB_ISSUER}/.well-known/openid-configuration`,
    ]);
    const stored = await getCallerProvider(env.DB, result.callerProvider.id);
    expect(stored).toEqual(result.callerProvider);
    const [audit] = await auditRows(result.callerProvider.id);
    expect(audit?.action).toBe('caller_provider.create');
  });

  it('requires a tenant pin on the shared GitHub issuer (I-TEN-1)', async () => {
    const result = await createCallerProvider(opsDeps({ fetch: network().fetch }), ACTOR, {
      name: 'GitHub',
      profile: 'github-actions',
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (result.ok) return;
    expect(result.errors.join()).toMatch(/tenant pin is required/);
    expect(await auditCount()).toBe(0);
  });

  it('lets a generic provider name its JWKS URI without discovery', async () => {
    const net = network();
    const result = await createCallerProvider(opsDeps({ fetch: net.fetch }), ACTOR, {
      name: 'Acme',
      profile: 'generic',
      issuer: 'https://idp.other.example',
      jwks_uri: 'https://idp.other.example/jwks.json',
      audience: 'tokengate:acme-gateway-01',
      anchor_claims: ['sub'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.callerProvider.jwks_uri).toBe('https://idp.other.example/jwks.json');
    expect(result.warnings.join()).toMatch(/no tenant pin/);
    expect(net.calls).toHaveLength(0);
  });

  it('reports discovery failures', async () => {
    const result = await createCallerProvider(opsDeps({ fetch: network().fetch }), ACTOR, {
      name: 'Unknown',
      profile: 'generic',
      issuer: 'https://unknown.example',
      anchor_claims: ['sub'],
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/^JWKS discovery failed/);
  });

  it('rejects unknown profiles and duplicate issuers', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    expect(
      await createCallerProvider(deps, ACTOR, { name: 'x', profile: 'constructor' }),
    ).toMatchObject({ ok: false, reason: 'invalid' });
    await seedGithubProvider(deps);
    const duplicate = await createCallerProvider(deps, ACTOR, {
      name: 'GitHub again',
      profile: 'github-actions',
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: ['1'] }],
    });
    expect(duplicate).toMatchObject({
      ok: false,
      reason: 'conflict',
      errors: [
        'another caller provider already has this issuer; edit that caller provider instead',
      ],
    });
  });
});

describe('updateCallerProvider', () => {
  async function seedGeneric(deps: ReturnType<typeof opsDeps>) {
    const result = await createCallerProvider(deps, ACTOR, {
      name: 'Acme',
      profile: 'generic',
      issuer: ACME_ISSUER,
      audience: 'tokengate:acme-gateway-01',
      anchor_claims: ['sub'],
      tenant_pin: [{ claim: 'tenant', match: 'exact', values: ['acme'] }],
    });
    if (!result.ok) throw new Error(result.errors.join());
    return result.callerProvider;
  }

  it('keeps the profile immutable', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGithubProvider(deps);
    const result = await updateCallerProvider(deps, ACTOR, provider.id, { profile: 'generic' });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('audits only changed fields', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGithubProvider(deps);
    const result = await updateCallerProvider(deps, ACTOR, provider.id, {
      max_token_age_seconds: 300,
    });
    expect(result.ok).toBe(true);
    const audit = (await auditRows(provider.id)).at(-1);
    expect(audit?.action).toBe('caller_provider.update');
    expect(audit?.diff).toMatchObject({
      before: { max_token_age_seconds: 600 },
      after: { max_token_age_seconds: 300 },
    });
  });

  it('refuses a save from a form opened at an older version', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGithubProvider(deps);
    const first = await updateCallerProvider(deps, ACTOR, provider.id, {
      max_token_age_seconds: 300,
      expected_updated_at: provider.updated_at,
    });
    expect(first.ok).toBe(true);
    const stale = await updateCallerProvider(deps, ACTOR, provider.id, {
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

  it('requires confirmation to change the issuer under enabled grants', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGeneric(deps);
    const serviceId = await seedService(deps);
    const created = await createGrant(deps, ACTOR, {
      name: 'acme ci',
      caller_provider_id: provider.id,
      service_id: serviceId,
      conditions: [{ claim: 'sub', match: 'exact', values: ['ci-bot'] }],
      rules: [{ methods: ['GET'], path: '/**' }],
    });
    if (!created.ok) throw new Error(created.errors.join());
    const grant = created.grant;

    const refused = await updateCallerProvider(deps, ACTOR, provider.id, {
      issuer: 'https://idp2.acme.example',
    });
    expect(refused).toMatchObject({ ok: false, reason: 'confirmation_required' });
    if (refused.ok) return;
    expect(refused.errors.join()).toContain('"acme ci"');
    expect((await getCallerProvider(env.DB, provider.id))?.issuer).toBe(ACME_ISSUER);

    const confirmed = await updateCallerProvider(deps, ACTOR, provider.id, {
      issuer: 'https://idp2.acme.example',
      confirm_trust_change: true,
    });
    expect(confirmed.ok).toBe(true);
    expect(await getCallerProvider(env.DB, provider.id)).toMatchObject({
      issuer: 'https://idp2.acme.example',
      jwks_uri: 'https://idp2.acme.example/keys',
    });
    expect((await auditRows(provider.id)).at(-1)?.diff).toMatchObject({
      trust_change_confirmed: true,
    });

    // Without enabled grants no confirmation is needed.
    await setGrantEnabled(deps, ACTOR, grant.id, false);
    const unconfirmed = await updateCallerProvider(deps, ACTOR, provider.id, {
      issuer: ACME_ISSUER,
    });
    expect(unconfirmed.ok).toBe(true);
  });

  it('enables and disables', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGithubProvider(deps);
    await setCallerProviderEnabled(deps, ACTOR, provider.id, false);
    expect((await getCallerProvider(env.DB, provider.id))?.enabled).toBe(false);
    expect((await auditRows(provider.id)).at(-1)?.action).toBe('caller_provider.disable');
  });
});

describe('deleteCallerProvider', () => {
  it('refuses while grants reference it, then deletes', async () => {
    const deps = opsDeps({ fetch: network().fetch });
    const provider = await seedGithubProvider(deps);
    const serviceId = await seedService(deps);
    const grant = await seedGrant(deps, provider.id, serviceId);
    expect(await deleteCallerProvider(deps, ACTOR, provider.id)).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    await env.DB.prepare('DELETE FROM grants WHERE id = ?').bind(grant.id).run();
    expect(await deleteCallerProvider(deps, ACTOR, provider.id)).toEqual({ ok: true });
    expect(await getCallerProvider(env.DB, provider.id)).toBeNull();
    expect((await auditRows(provider.id)).at(-1)?.action).toBe('caller_provider.delete');
  });
});
