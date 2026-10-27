// Save-time enforcement of threat-model invariants by the admin ops (docs/threat-model.md): invalid trust
// configuration is refused before any write, any network call and any use of the credential.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import {
  type CredentialRuleInput,
  createCredentialAccessRule,
  setCredentialAccessRuleEnabled,
  updateCredentialAccessRule,
} from '../../../../src/admin/ops/credential-access-rules';
import {
  checkServiceCredential,
  createService,
  rotateServiceSecret,
  setServiceCredential,
} from '../../../../src/admin/ops/credentials';
import {
  createGlobalAccessRule,
  type GlobalRuleInput,
} from '../../../../src/admin/ops/global-access-rules';
import type { Condition } from '../../../../src/policy/types';
import { setUpstreamHosts } from '../../../helpers/app';
import { testCredentialId } from './helpers';
import {
  ACTOR,
  anchoredConditions,
  CONTEXT,
  dumpControlPlane,
  fakeNetwork,
  GITHUB_ISSUER,
  OWNER_ID,
  opsDeps,
  resetControlPlane,
  seedCredentialRule,
  seedService,
  serviceInput,
} from './helpers';

const SECRET = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
const VERIFY = { method: 'GET' as const, path: '/rate_limit', expect_status: 200 };
const PIN: Condition[] = [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }];
const RULES = [{ methods: ['GET' as const], path: '/**' }];

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

type RulePatch = Omit<CredentialRuleInput, 'credential_id' | 'conditions' | 'rules'> &
  Partial<Pick<CredentialRuleInput, 'conditions' | 'rules'>>;

/** Creates a credential access rule on the test credential, with anchored jobs unless given. */
async function createRule(network: ReturnType<typeof fakeNetwork>, input: RulePatch) {
  return createCredentialAccessRule(opsDeps({ fetch: network.fetch }), ACTOR, {
    credential_id: await testCredentialId(opsDeps()),
    conditions: anchoredConditions(),
    rules: RULES,
    ...input,
  });
}

describe('I-TEN-1: shared issuers need a tenant pin', () => {
  beforeEach(async () => {
    await testCredentialId(opsDeps());
  });
  const cases: Array<[string, RulePatch]> = [
    ['github-actions without a pin', { name: 'gh', profile: 'github-actions' }],
    [
      'gitlab-ci without a pin',
      {
        name: 'gl',
        profile: 'gitlab-ci',
        conditions: [
          { claim: 'namespace_id', match: 'exact', values: ['1'] },
          { claim: 'project_id', match: 'exact', values: ['2'] },
        ],
      },
    ],
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
        conditions: [
          { claim: 'sub', match: 'exact', values: ['repo:acme/app:ref:refs/heads/main'] },
        ],
      },
    ],
  ];
  it.each(cases)('refuses %s before discovery', async (_, input) => {
    const network = fakeNetwork();
    await expectRefusedQuietly(network, () => createRule(network, input));
  });

  it('refuses removing the pin later', async () => {
    const network = fakeNetwork();
    const deps = opsDeps({ fetch: network.fetch });
    const rule = await seedCredentialRule(deps);
    await expectRefusedQuietly(network, async () =>
      updateCredentialAccessRule(deps, ACTOR, rule.id, { tenant_pin: [] }),
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
    await expectRefusedQuietly(network, () => createRule(network, { ...base, ...patch }));
  });

  it('never stores an empty audience', async () => {
    const result = await createRule(fakeNetwork(), { ...base, audience: '  ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rule.audience).toMatch(/^tokengate:[a-z2-7]{26}$/);
  });

  it('refuses a fifth JWKS URI and audience pair for one credential and issuer (AR-10)', async () => {
    const deps = opsDeps();
    for (const n of [1, 2, 3, 4]) {
      await seedCredentialRule(deps, { name: `r${n}`, audience: `tokengate:audience-0000${n}` });
    }
    const network = fakeNetwork();
    await expectRefusedQuietly(network, () =>
      createRule(network, { ...base, name: 'r5', audience: 'tokengate:audience-00005' }),
    );
    // A pair already in use is accepted.
    expect(
      (await createRule(network, { ...base, name: 'r6', audience: 'tokengate:audience-00001' })).ok,
    ).toBe(true);
  });
});

describe('I-AUTHZ-2: a credential access rule must pin an anchor rule exactly', () => {
  const owner = anchoredConditions()[0] as Condition;
  const repo = anchoredConditions()[1] as Condition;

  beforeEach(async () => {
    await testCredentialId(opsDeps());
  });

  it.each([
    ['only the owner', [owner]],
    ['the repository as a glob', [owner, { ...repo, match: 'glob' as const }]],
    ['the repository negated', [owner, { ...repo, negate: true }]],
    ['a repository outside the tenant pin', [{ ...owner, values: ['1'] }, repo]],
  ])('refuses %s', async (_, conditions) => {
    const network = fakeNetwork();
    await expectRefusedQuietly(network, () =>
      createRule(network, {
        name: 'g',
        profile: 'github-actions',
        tenant_pin: PIN,
        conditions,
        acknowledge_warnings: true,
      }),
    );
  });

  it('refuses an update that drops the anchor', async () => {
    const deps = opsDeps();
    const rule = await seedCredentialRule(deps);
    const result = await updateCredentialAccessRule(deps, ACTOR, rule.id, { conditions: [owner] });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('refuses an anchor change that leaves its own jobs unanchored', async () => {
    const deps = opsDeps({
      fetch: fakeNetwork(undefined, { 'https://idp.acme.example': 'https://idp.acme.example/keys' })
        .fetch,
    });
    const rule = await seedCredentialRule(deps, {
      profile: 'generic',
      issuer: 'https://idp.acme.example',
      audience: 'tokengate:acme-gateway-01',
      anchor_claims: ['sub'],
      tenant_pin: [{ claim: 'tenant', match: 'exact', values: ['acme'] }],
      conditions: [{ claim: 'sub', match: 'exact', values: ['ci-bot'] }],
      rules: RULES,
    });
    const result = await updateCredentialAccessRule(deps, ACTOR, rule.id, {
      anchor_claims: ['project'],
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (!result.ok) expect(result.errors.join()).toMatch(/I-AUTHZ-2/);
  });

  it('refuses to enable a rule whose stored conditions were edited in D1', async () => {
    const deps = opsDeps();
    const rule = await seedCredentialRule(deps);
    expect((await setCredentialAccessRuleEnabled(deps, ACTOR, rule.id, false)).ok).toBe(true);
    await env.DB.prepare('UPDATE access_rules SET conditions = ? WHERE id = ?')
      .bind(JSON.stringify([owner]), rule.id)
      .run();
    expect(await setCredentialAccessRuleEnabled(deps, ACTOR, rule.id, true)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('I-AUTHZ-5: a global access rule never stores an empty limit', () => {
  it.each<[string, Partial<GlobalRuleInput>]>([
    ['an empty tenant pin', { tenant_pin: [] }],
    ['no algorithms', { allowed_algs: [] }],
    ['no anchor claims', { anchor_claims: [] }],
    ['no jobs', { conditions: [] }],
    ['no operations', { rules: [] }],
    ['alg none', { allowed_algs: ['none'] }],
    ['a negated tenant pin', { tenant_pin: [{ ...PIN[0], negate: true } as Condition] }],
    ['a token age above the profile limit', { max_token_age_seconds: 3600 }],
    ['an http JWKS URI', { jwks_uri: 'http://token.actions.githubusercontent.com/jwks' }],
  ])('refuses %s', async (_, patch) => {
    const network = fakeNetwork();
    await expectRefusedQuietly(network, () =>
      createGlobalAccessRule(opsDeps({ fetch: network.fetch }), ACTOR, {
        name: 'ceiling',
        profile: 'github-actions',
        ...patch,
        confirm_new_ceiling: true,
      }),
    );
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
    // A custom credential: a template credential refuses any other destination.
    const id = await seedService(deps, {
      slug: 'custom',
      base_url: 'https://api.example.com',
      secret: SECRET,
      verify: VERIFY,
    });
    await setUpstreamHosts(['*.example.com']);
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
