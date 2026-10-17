// Save-time enforcement of threat-model invariants by the admin ops (docs/threat-model.md): invalid trust
// configuration is refused before any write, any network call and any use of the credential.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import {
  type CredentialAccessRuleCreateInput,
  createCredentialAccessRule,
  updateCredentialAccessRule,
} from '../../../../src/admin/ops/credential-access-rules';
import {
  checkServiceCredential,
  createService,
  rotateServiceSecret,
  setServiceCredential,
} from '../../../../src/admin/ops/credentials';
import {
  createIssuerAccessRule,
  setIssuerAccessRuleEnabled,
  updateIssuerAccessRule,
} from '../../../../src/admin/ops/issuer_access_rules';
import { getIssuerAccessRule } from '../../../../src/db/issuer_access_rules';
import type { Condition } from '../../../../src/policy/types';
import { setUpstreamHosts } from '../../../helpers/app';
import { testCredentialId } from './helpers';
import {
  ACTOR,
  anchoredConditions,
  auditCount,
  CONTEXT,
  dumpControlPlane,
  fakeNetwork,
  GITHUB_ISSUER,
  OWNER_ID,
  opsDeps,
  racingDeps,
  resetControlPlane,
  seedGithubProvider,
  seedIssuerAccessRule,
  seedService,
  serviceInput,
} from './helpers';

const SECRET = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
const VERIFY = { method: 'GET' as const, path: '/rate_limit', expect_status: 200 };
const PIN: Condition[] = [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }];

beforeEach(resetControlPlane);

/** Runs `op` and asserts it was refused as invalid with no write and no network call. */
async function expectRefusedQuietly(
  network: ReturnType<typeof fakeNetwork>,
  op: () => Promise<{ ok: boolean }>,
): Promise<void> {
  const before = await dumpControlPlane();
  const calls = network.calls.length;
  expect(await op()).toMatchObject({ ok: false, reason: 'invalid' });
  expect(await dumpControlPlane()).toBe(before);
  expect(network.calls.length).toBe(calls);
}

describe('I-TEN-1: shared issuers need a tenant pin', () => {
  beforeEach(async () => {
    await testCredentialId(opsDeps());
  });
  const cases: Array<[string, CredentialAccessRuleCreateInput]> = [
    ['github-actions without a pin', { name: 'gh', profile: 'github-actions' }],
    ['gitlab-ci without a pin', { name: 'gl', profile: 'gitlab-ci' }],
    [
      'a glob pin',
      {
        name: 'gh',
        profile: 'github-actions',
        tenant_pin: [{ claim: 'repository_owner_id', match: 'glob', values: ['*'] }],
      },
    ],
    [
      'a negated pin',
      {
        name: 'gh',
        profile: 'github-actions',
        tenant_pin: [{ ...PIN[0], negate: true } as Condition],
      },
    ],
    [
      'a pin on a non-tenant claim',
      {
        name: 'gh',
        profile: 'github-actions',
        tenant_pin: [{ claim: 'repository', match: 'exact', values: ['acme/app'] }],
      },
    ],
    [
      'the GitHub issuer under the generic profile',
      {
        name: 'gh',
        profile: 'generic',
        issuer: GITHUB_ISSUER,
        jwks_uri: `${GITHUB_ISSUER}/.well-known/jwks`,
        anchor_claims: ['sub'],
      },
    ],
  ];
  it.each(cases)('refuses %s before discovery', async (_, input) => {
    const network = fakeNetwork();
    await expectRefusedQuietly(network, async () =>
      createCredentialAccessRule(opsDeps({ fetch: network.fetch }), ACTOR, {
        ...input,
        credential_id: await testCredentialId(opsDeps()),
      }),
    );
  });

  it('refuses removing the pin later', async () => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    const provider = await seedGithubProvider(deps);
    await expectRefusedQuietly(network, async () =>
      updateCredentialAccessRule(deps, ACTOR, provider.id, { tenant_pin: [] }),
    );
  });
});

describe('I-JWT-1: algorithm allowlist, audience and token age are checked at save', () => {
  beforeEach(async () => {
    await testCredentialId(opsDeps());
  });
  const base = { name: 'gh', profile: 'github-actions', tenant_pin: PIN };
  it.each([
    ['alg none', { allowed_algs: ['none'] }],
    ['alg HS256', { allowed_algs: ['HS256'] }],
    ['no algorithms', { allowed_algs: [] }],
    ['a short audience', { audience: 'tokengate' }],
    ['the GitHub owner URL audience', { audience: 'https://github.com/acme-corp' }],
    ['the AWS audience', { audience: 'sts.amazonaws.com' }],
    ['a token age above the profile limit', { max_token_age_seconds: 3600 }],
  ])('refuses %s', async (_, patch) => {
    const network = fakeNetwork();
    await expectRefusedQuietly(network, async () =>
      createCredentialAccessRule(opsDeps({ fetch: network.fetch }), ACTOR, {
        credential_id: await testCredentialId(opsDeps({ fetch: network.fetch })),
        ...base,
        ...patch,
      }),
    );
  });

  it('never stores an empty audience', async () => {
    const result = await createCredentialAccessRule(opsDeps(), ACTOR, {
      credential_id: await testCredentialId(opsDeps()),
      ...base,
      audience: '  ',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.credentialAccessRule.audience).toMatch(/^tokengate:[a-z2-7]{26}$/);
  });
});

describe('I-AUTHZ-2: issuer_access_rules must pin an anchor rule exactly', () => {
  let deps: ReturnType<typeof opsDeps>;
  let providerId: string;
  let serviceId: string;
  const rules = [{ methods: ['GET' as const], path: '/**' }];
  const owner = anchoredConditions()[0] as Condition;
  const repo = anchoredConditions()[1] as Condition;

  beforeEach(async () => {
    deps = opsDeps();
    providerId = (await seedGithubProvider(deps)).id;
    serviceId = await seedService(deps);
  });

  it.each([
    ['only the owner', [owner]],
    ['the repository as a glob', [owner, { ...repo, match: 'glob' as const }]],
    ['the repository negated', [owner, { ...repo, negate: true }]],
    ['a repository outside the tenant pin', [{ ...owner, values: ['1'] }, repo]],
  ])('refuses %s', async (_, conditions) => {
    const audits = await auditCount();
    const result = await createIssuerAccessRule(deps, ACTOR, {
      name: 'g',
      credential_access_rule_id: providerId,
      service_id: serviceId,
      conditions,
      rules,
      acknowledge_warnings: true,
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await auditCount()).toBe(audits);
  });

  it('refuses an update that drops the anchor', async () => {
    const grant = await seedIssuerAccessRule(deps, providerId, serviceId);
    const result = await updateIssuerAccessRule(deps, ACTOR, grant.id, { conditions: [owner] });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('refuses to enable a grant whose stored conditions were edited in D1', async () => {
    const grant = await seedIssuerAccessRule(deps, providerId, serviceId);
    expect((await setIssuerAccessRuleEnabled(deps, ACTOR, grant.id, false)).ok).toBe(true);
    await env.DB.prepare('UPDATE issuer_access_rules SET conditions = ? WHERE id = ?')
      .bind(JSON.stringify([owner]), grant.id)
      .run();
    expect(await setIssuerAccessRuleEnabled(deps, ACTOR, grant.id, true)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('a caller provider change between validation and write discards the grant write', async () => {
    const grant = await seedIssuerAccessRule(deps, providerId, serviceId);
    // Concurrently the caller provider changes, so the grant was validated against a stale version.
    const racing = racingDeps(deps, () =>
      updateCredentialAccessRule(deps, ACTOR, providerId, { max_token_age_seconds: 120 }),
    );
    const result = await updateIssuerAccessRule(racing, ACTOR, grant.id, { name: 'renamed' });
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect((await getIssuerAccessRule(env.DB, grant.id))?.name).toBe(grant.name);
  });
});

describe('I-SSRF-1: base URLs are validated before the credential is used or stored', () => {
  const bad = [
    'http://api.github.com',
    'https://127.0.0.1',
    'https://[::1]',
    'https://localhost',
    'https://internal.localhost',
    'https://user:pw@api.github.com',
    'https://api.github.com/?x=1',
    'https://other.workers.dev',
    `https://${CONTEXT.requestHost}`,
    'https://api.github.com/a/../b',
  ];

  it.each(bad)('createService refuses %s without calling it', async (baseUrl) => {
    const network = fakeNetwork();
    await expectRefusedQuietly(network, async () =>
      createService(
        opsDeps({ fetch: network.fetch }),
        ACTOR,
        serviceInput({ base_url: baseUrl, secret: SECRET, verify: VERIFY }),
        CONTEXT,
      ),
    );
  });

  it.each(bad)('setServiceCredential refuses %s without calling it', async (baseUrl) => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    const id = await seedService(deps, { verify: VERIFY });
    await expectRefusedQuietly(network, async () =>
      setServiceCredential(
        deps,
        ACTOR,
        id,
        { base_url: baseUrl, injection: { kind: 'bearer' }, secret: SECRET },
        CONTEXT,
      ),
    );
  });

  it('enforces the upstream host allowlist on credential changes', async () => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    const id = await seedService(deps, { verify: VERIFY });
    await setUpstreamHosts(['*.github.com']);
    onTestFinished(() => setUpstreamHosts(null));
    await expectRefusedQuietly(network, async () =>
      setServiceCredential(
        deps,
        ACTOR,
        id,
        { base_url: 'https://api.openai.com/v1', injection: { kind: 'bearer' }, secret: SECRET },
        CONTEXT,
      ),
    );
  });
});

describe('I-SSRF-1 and I-CRED-2: rotation and the destination pre-check send nothing first', () => {
  afterEach(() => setUpstreamHosts(null));

  it('rotateServiceSecret re-validates the stored base URL against the allowlist without calling it', async () => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    const id = await seedService(deps, { secret: SECRET, verify: VERIFY });
    await setUpstreamHosts(['*.openai.com']);
    await expectRefusedQuietly(network, async () =>
      rotateServiceSecret(deps, ACTOR, id, { secret: `${SECRET}x` }, CONTEXT),
    );
  });

  it('rotateServiceSecret refuses a malformed secret before the keyring and the network', async () => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    const id = await seedService(deps, { secret: SECRET, verify: VERIFY });
    const broken = opsDeps({ fetch: network.fetch, env: { TOKENGATE_KEK: '' } });
    await expectRefusedQuietly(network, async () =>
      rotateServiceSecret(broken, ACTOR, id, { secret: 'two\nlines' }, CONTEXT),
    );
  });

  it('checkServiceCredential writes and sends nothing; hostAllowed skips only the allowlist', async () => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    const id = await seedService(deps, { secret: SECRET, verify: VERIFY });
    await setUpstreamHosts(['*.github.com']);
    const openai = {
      base_url: 'https://api.openai.com/v1',
      injection: { kind: 'bearer' },
      secret: SECRET,
    };
    await expectRefusedQuietly(network, async () =>
      checkServiceCredential(deps, id, openai, CONTEXT),
    );
    const before = await dumpControlPlane();
    const calls = network.calls.length;
    expect(await checkServiceCredential(deps, id, openai, CONTEXT, { hostAllowed: true })).toEqual({
      ok: true,
      warnings: [],
    });
    await expectRefusedQuietly(network, async () =>
      checkServiceCredential(
        deps,
        id,
        { ...openai, base_url: `https://${CONTEXT.requestHost}` },
        CONTEXT,
        { hostAllowed: true },
      ),
    );
    expect(await dumpControlPlane()).toBe(before);
    expect(network.calls.length).toBe(calls);
  });

  it('checkServiceCredential asks for the host of a token without a stored secret', async () => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    const id = await seedService(deps, { verify: VERIFY });
    const input = {
      base_url: 'https://api.github.com',
      injection: { kind: 'bearer' },
      secret: SECRET,
    };
    const calls = network.calls.length;
    expect(await checkServiceCredential(deps, id, input, CONTEXT)).toMatchObject({
      ok: false,
      reason: 'confirmation_required',
    });
    expect(
      await checkServiceCredential(
        deps,
        id,
        { ...input, confirm_destination: 'api.github.com' },
        CONTEXT,
      ),
    ).toMatchObject({ ok: true });
    expect(network.calls.length).toBe(calls);
  });
});
