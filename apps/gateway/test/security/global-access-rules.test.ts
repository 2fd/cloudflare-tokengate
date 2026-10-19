// Global access rules on the real proxy (ADR 0026). A request needs a credential access rule of the
// credential and a global access rule of the caller's issuer; an issuer with no global row is not
// limited (I-AUTHZ-1). A global access rule never lets a request in by itself, a disabled or expired
// one still caps its issuer (AR-4), and a malformed or empty limit is never "no limit" (I-AUTHZ-5).
// Every change that can widen a ceiling needs a confirmation (AR-21).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  createGlobalAccessRule,
  deleteGlobalAccessRule,
  setGlobalAccessRuleEnabled,
  updateGlobalAccessRule,
} from '../../src/admin/ops/global-access-rules';
import type { Condition, Rule } from '../../src/policy/types';
import type { RequestRecord } from '../../src/telemetry/types';
import {
  createTestIssuer,
  GITHUB_ISSUER,
  githubClaims,
  gitlabClaims,
  TEST_AUDIENCE,
  TEST_GITHUB_OWNER_ID,
  TEST_GITHUB_REPOSITORY_ID,
  TEST_GITLAB_NAMESPACE_ID,
  TEST_GITLAB_PROJECT_ID,
} from '../helpers/jwt';
import { type ProxyFixture, setupProxy } from '../helpers/proxy-fixtures';
import { ACTOR } from '../unit/admin/ops/helpers';

const errorOf = (response: Response) => response.headers.get('x-tokengate-error');

const thisRepository: Condition = {
  claim: 'repository_id',
  match: 'exact',
  values: [TEST_GITHUB_REPOSITORY_ID],
};
const otherRepository: Condition = { claim: 'repository_id', match: 'exact', values: ['1'] };
const ownerPin: Condition = {
  claim: 'repository_owner_id',
  match: 'exact',
  values: [TEST_GITHUB_OWNER_ID],
};

/** Asserts a 403 `no_matching_rule` whose record says that the global access rules refused it. */
async function expectOutsideGlobal(
  fx: ProxyFixture,
  response: Response,
): Promise<RequestRecord | undefined> {
  expect(response.status).toBe(403);
  expect(errorOf(response)).toBe('no_matching_rule');
  const id = response.headers.get('x-tokengate-request-id');
  const record = (await fx.records()).find((candidate) => candidate.id === id);
  expect(record?.reason).toBe('outside_global_rules');
  expect(record?.global_access_rule_id).toBeNull();
  return record;
}

async function globalRows(): Promise<string> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM access_rules WHERE credential_id IS NULL ORDER BY id',
  ).all();
  return JSON.stringify(results);
}

/** Creates a global access rule of the test issuer through the op, with every confirmation. */
async function createGlobal(
  fx: ProxyFixture,
  input: Partial<Parameters<typeof createGlobalAccessRule>[2]> = {},
): Promise<string> {
  const result = await createGlobalAccessRule(fx.app.deps, ACTOR, {
    name: `ceiling ${crypto.randomUUID().slice(0, 8)}`,
    profile: 'github-actions',
    ...input,
    confirm_new_ceiling: true,
    confirm_widening: true,
  });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.rule.id;
}

describe('I-AUTHZ-1: a request needs a credential and a global access rule', () => {
  it('an issuer with no global access rule is not limited', async () => {
    const fx = await setupProxy();
    expect((await fx.call('/a')).status).toBe(200);
    const [record] = await fx.records();
    expect(record).toMatchObject({
      credential_access_rule_id: fx.ruleId,
      global_access_rule_id: null,
    });
  });

  it('a global access rule that excludes the repository refuses the very next request', async () => {
    const fx = await setupProxy();
    expect((await fx.call('/a')).status).toBe(200);
    const globalId = await createGlobal(fx, { conditions: [otherRepository] });
    const record = await expectOutsideGlobal(fx, await fx.call('/a'));
    expect(record?.credential_access_rule_id).toBe(fx.ruleId);
    expect(JSON.parse(record?.eval_trace ?? '[]')).toEqual([
      expect.objectContaining({
        rule_id: fx.ruleId,
        global_rule_id: globalId,
        result: 'global_blocked',
      }),
    ]);
    expect(fx.upstreamCalls).toHaveLength(1);
  });

  it('records the global access rule that held on an allowed request', async () => {
    const fx = await setupProxy();
    const globalId = await createGlobal(fx, { conditions: [thisRepository] });
    expect((await fx.call('/a')).status).toBe(200);
    const [record] = await fx.records();
    expect(record).toMatchObject({
      outcome: 'allowed',
      credential_access_rule_id: fx.ruleId,
      global_access_rule_id: globalId,
    });
  });

  it('a global access rule never lets a request in by itself', async () => {
    const fx = await setupProxy({ rule: false });
    await createGlobal(fx);
    const response = await fx.call('/a');
    expect(response.status).toBe(401);
    expect(errorOf(response)).toBe('issuer_unknown');
    expect(fx.upstreamCalls).toHaveLength(0);
  });

  it('any one global access rule of the issuer suffices', async () => {
    const fx = await setupProxy();
    await fx.addGlobalRule({ conditions: [otherRepository] });
    const second = await fx.addGlobalRule({ conditions: [thisRepository] });
    expect((await fx.call('/a')).status).toBe(200);
    expect((await fx.records())[0]?.global_access_rule_id).toBe(second);
  });

  it('disabling the only global access rule refuses every request of the issuer with 403', async () => {
    const fx = await setupProxy();
    const globalId = await createGlobal(fx, { conditions: [thisRepository] });
    expect((await fx.call('/a')).status).toBe(200);
    const unconfirmed = await setGlobalAccessRuleEnabled(fx.app.deps, ACTOR, globalId, false, {});
    expect(unconfirmed).toMatchObject({ ok: false, confirm: 'last_disable' });
    expect((await fx.call('/a')).status).toBe(200);
    const disabled = await setGlobalAccessRuleEnabled(fx.app.deps, ACTOR, globalId, false, {
      confirm_last_disable: true,
    });
    expect(disabled.ok).toBe(true);
    await expectOutsideGlobal(fx, await fx.call('/a'));
    await expectOutsideGlobal(fx, await fx.call('/b', { method: 'POST', body: '{}' }));
  });

  it('an expired global access rule still caps its issuer (AR-4)', async () => {
    const fx = await setupProxy();
    await fx.addGlobalRule({ expiresAt: fx.clock.now() + 1000 });
    expect((await fx.call('/a')).status).toBe(200);
    fx.clock.advance(1000);
    await expectOutsideGlobal(fx, await fx.call('/a'));
  });

  it('deleting the last global access rule needs a confirmation, then lifts the ceiling', async () => {
    const fx = await setupProxy();
    const globalId = await createGlobal(fx, { conditions: [otherRepository] });
    await expectOutsideGlobal(fx, await fx.call('/a'));
    const before = await globalRows();
    const unconfirmed = await deleteGlobalAccessRule(fx.app.deps, ACTOR, globalId, {});
    expect(unconfirmed).toMatchObject({ ok: false, confirm: 'last_delete' });
    expect(await globalRows()).toBe(before);
    await expectOutsideGlobal(fx, await fx.call('/a'));
    const deleted = await deleteGlobalAccessRule(fx.app.deps, ACTOR, globalId, {
      confirm_widening: true,
    });
    expect(deleted).toMatchObject({ ok: true, last: true });
    expect((await fx.call('/a')).status).toBe(200);
  });

  it('tightening a global access rule by a direct database write is effective immediately', async () => {
    const fx = await setupProxy();
    const globalId = await fx.addGlobalRule({ conditions: [thisRepository] });
    expect((await fx.call('/a')).status).toBe(200);
    await env.DB.prepare('UPDATE access_rules SET conditions = ? WHERE id = ?')
      .bind(JSON.stringify([otherRepository]), globalId)
      .run();
    await expectOutsideGlobal(fx, await fx.call('/a'));
  });
});

describe('I-AUTHZ-5: a global limit that is empty is refused, never "no limit"', () => {
  it.each(['tenant_pin', 'anchor_claims', 'conditions', 'rules', 'allowed_algs'])(
    'the database refuses %s = [] on a global access rule',
    async (column) => {
      const fx = await setupProxy();
      const globalId = await fx.addGlobalRule({ conditions: [otherRepository] });
      await expect(
        env.DB.prepare(`UPDATE access_rules SET ${column} = '[]' WHERE id = ?`)
          .bind(globalId)
          .run(),
      ).rejects.toThrow(/CHECK constraint failed/);
      await expectOutsideGlobal(fx, await fx.call('/a'));
    },
  );
});

describe('I-AUTHZ-1: global limits on the identity side', () => {
  it('a global JWKS pin refuses a generic credential access rule with an attacker JWKS', async () => {
    let fx: ProxyFixture | null = null;
    const attacker = await createTestIssuer({
      issuer: 'https://attacker.example',
      now: () => fx?.clock.now() ?? Date.now(),
    });
    fx = await setupProxy({ rule: false, issuers: [attacker] });
    // A credential manager's rule: the GitHub issuer's name, but keys that the attacker holds.
    await fx.addRule({
      profile: 'generic',
      jwksUri: attacker.jwksUri,
      allowedAlgs: [attacker.alg],
      tenantPin: [ownerPin],
      anchorClaims: ['sub'],
      conditions: [{ claim: 'sub', match: 'exact', values: ['repo:acme/app:ref:refs/heads/main'] }],
    });
    const forged = () =>
      attacker.sign({
        iss: GITHUB_ISSUER,
        sub: 'repo:acme/app:ref:refs/heads/main',
        aud: TEST_AUDIENCE,
        repository_owner_id: TEST_GITHUB_OWNER_ID,
      });
    expect((await fx.call('/a', { token: await forged() })).status).toBe(200);
    await fx.addGlobalRule({ profile: 'generic', jwksUri: fx.issuer.jwksUri });
    await expectOutsideGlobal(fx, await fx.call('/a', { token: await forged() }));
  });

  it('a credential access rule with another profile for the same issuer is refused (AR-6)', async () => {
    const fx = await setupProxy({
      rule: {
        profile: 'generic',
        anchorClaims: ['sub'],
        conditions: [
          { claim: 'sub', match: 'exact', values: ['repo:acme/app:ref:refs/heads/main'] },
        ],
      },
    });
    expect((await fx.call('/a')).status).toBe(200);
    await fx.addGlobalRule({ profile: 'github-actions' });
    await expectOutsideGlobal(fx, await fx.call('/a'));
  });

  it('when every global access rule of the issuer has another profile, the result is 403, not 401', async () => {
    const fx = await setupProxy();
    await fx.addGlobalRule({ profile: 'generic' });
    await fx.addGlobalRule({ profile: 'generic', conditions: [thisRepository] });
    await expectOutsideGlobal(fx, await fx.call('/a'));
  });

  it('a global access rule spelled https://GitLab.com/ caps https://gitlab.com rules (AR-3)', async () => {
    let fx: ProxyFixture | null = null;
    const gitlab = await createTestIssuer({
      issuer: 'https://gitlab.com',
      now: () => fx?.clock.now() ?? Date.now(),
    });
    fx = await setupProxy({ rule: false, issuers: [gitlab] });
    await fx.addRule({
      profile: 'gitlab-ci',
      issuer: gitlab.issuer,
      jwksUri: gitlab.jwksUri,
      tenantPin: [{ claim: 'namespace_id', match: 'exact', values: [TEST_GITLAB_NAMESPACE_ID] }],
      conditions: [
        { claim: 'namespace_id', match: 'exact', values: [TEST_GITLAB_NAMESPACE_ID] },
        { claim: 'project_id', match: 'exact', values: [TEST_GITLAB_PROJECT_ID] },
      ],
    });
    const token = () => gitlab.sign(gitlabClaims());
    expect((await fx.call('/a', { token: await token() })).status).toBe(200);
    // A direct write: the ops refuse an issuer URL that is not in canonical form.
    const globalId = await fx.addGlobalRule({
      profile: 'gitlab-ci',
      issuer: 'https://GitLab.com/',
      conditions: [{ claim: 'project_id', match: 'exact', values: ['1'] }],
    });
    const stored = await env.DB.prepare('SELECT issuer, issuer_key FROM access_rules WHERE id = ?')
      .bind(globalId)
      .first();
    expect(stored).toEqual({ issuer: 'https://GitLab.com/', issuer_key: 'https://gitlab.com' });
    await expectOutsideGlobal(fx, await fx.call('/a', { token: await token() }));
  });

  it('a global tenant pin that excludes the caller is a 403 after the tenant gate, never a 401 (AR-9)', async () => {
    const fx = await setupProxy();
    await fx.addGlobalRule({
      tenantPin: [{ claim: 'repository_owner_id', match: 'exact', values: ['1'] }],
    });
    await expectOutsideGlobal(fx, await fx.call('/a'));
    // I-TEN-1: the caller that a credential access rule's own pin admits still learns only
    // that the slug does not exist.
    const unknown = await fx.call('/a', { slug: 'does-not-exist' });
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown)).toBe('service_not_found');
    // An outsider of the rule's own pin is refused at the tenant gate, as without global rules.
    const outsider = await fx.call('/a', {
      token: await fx.token({ repository_owner_id: '999' }),
    });
    expect(outsider.status).toBe(401);
    expect(errorOf(outsider)).toBe('tenant_mismatch');
  });

  it('a global algorithm ceiling refuses a token signed with another algorithm', async () => {
    const fx = await setupProxy();
    const globalId = await fx.addGlobalRule({ allowedAlgs: ['ES256'] });
    await expectOutsideGlobal(fx, await fx.call('/a'));
    await env.DB.prepare('UPDATE access_rules SET allowed_algs = ? WHERE id = ?')
      .bind(JSON.stringify([fx.issuer.alg]), globalId)
      .run();
    expect((await fx.call('/a')).status).toBe(200);
  });

  it('a global token age ceiling holds to the second and refuses one second more', async () => {
    const fx = await setupProxy();
    await fx.addGlobalRule({ maxTokenAgeSeconds: 120 });
    const now = Math.floor(fx.clock.now() / 1000);
    // The clock tolerance (30 s) applies to the ceiling as it does to the rule's own limit.
    const aged = (iat: number) => fx.issuer.sign(githubClaims(), { iat, exp: now + 300 });
    expect((await fx.call('/a', { token: await aged(now - 150) })).status).toBe(200);
    await expectOutsideGlobal(fx, await fx.call('/a', { token: await aged(now - 151) }));
  });
});

describe('I-AUTHZ-1: global limits on the target side', () => {
  it('a global operations ceiling refuses POST while allowing GET', async () => {
    const fx = await setupProxy();
    await fx.addGlobalRule({ rules: [{ methods: ['GET'], path: '/**' }] });
    expect((await fx.call('/a')).status).toBe(200);
    const record = await expectOutsideGlobal(
      fx,
      await fx.call('/a', { method: 'POST', body: '{}' }),
    );
    expect(record?.eval_trace).toContain('POST /a');
    expect(fx.upstreamCalls).toHaveLength(1);
  });
});

describe('AR-21: a change that widens a ceiling needs a confirmation', () => {
  it('a sibling global access rule with no limits', async () => {
    const fx = await setupProxy();
    await createGlobal(fx, { conditions: [otherRepository] });
    const before = await globalRows();
    const unconfirmed = await createGlobalAccessRule(fx.app.deps, ACTOR, {
      name: 'everything',
      profile: 'github-actions',
      confirm_new_ceiling: true,
    });
    expect(unconfirmed).toMatchObject({
      ok: false,
      reason: 'confirmation_required',
      confirm: 'widening',
    });
    expect(await globalRows()).toBe(before);
    await expectOutsideGlobal(fx, await fx.call('/a'));
    await createGlobal(fx, { name: 'everything' });
    expect((await fx.call('/a')).status).toBe(200);
  });

  it('enabling a disabled global access rule', async () => {
    const fx = await setupProxy();
    const globalId = await fx.addGlobalRule({ enabled: false });
    await expectOutsideGlobal(fx, await fx.call('/a'));
    const before = await globalRows();
    const unconfirmed = await setGlobalAccessRuleEnabled(fx.app.deps, ACTOR, globalId, true, {});
    expect(unconfirmed).toMatchObject({ ok: false, confirm: 'widening' });
    expect(await globalRows()).toBe(before);
    await expectOutsideGlobal(fx, await fx.call('/a'));
    const enabled = await setGlobalAccessRuleEnabled(fx.app.deps, ACTOR, globalId, true, {
      confirm_widening: true,
    });
    expect(enabled.ok).toBe(true);
    expect((await fx.call('/a')).status).toBe(200);
  });

  it('clearing the expiry of an expired global access rule', async () => {
    const fx = await setupProxy();
    const globalId = await fx.addGlobalRule({ expiresAt: fx.clock.now() - 1 });
    await expectOutsideGlobal(fx, await fx.call('/a'));
    const before = await globalRows();
    const unconfirmed = await updateGlobalAccessRule(fx.app.deps, ACTOR, globalId, {
      expires_at: null,
    });
    expect(unconfirmed).toMatchObject({ ok: false, confirm: 'widening' });
    expect(await globalRows()).toBe(before);
    const cleared = await updateGlobalAccessRule(fx.app.deps, ACTOR, globalId, {
      expires_at: null,
      confirm_widening: true,
    });
    expect(cleared.ok).toBe(true);
    expect((await fx.call('/a')).status).toBe(200);
  });

  it('relaxing the operations of a global access rule', async () => {
    const fx = await setupProxy();
    const globalId = await createGlobal(fx, { rules: [{ methods: ['GET'], path: '/**' }] });
    await expectOutsideGlobal(fx, await fx.call('/a', { method: 'POST', body: '{}' }));
    const before = await globalRows();
    const relaxed = { rules: [{ methods: ['*'], path: '/**' }] satisfies Rule[] };
    const unconfirmed = await updateGlobalAccessRule(fx.app.deps, ACTOR, globalId, relaxed);
    expect(unconfirmed).toMatchObject({ ok: false, confirm: 'widening' });
    expect(await globalRows()).toBe(before);
    await expectOutsideGlobal(fx, await fx.call('/a', { method: 'POST', body: '{}' }));
    const updated = await updateGlobalAccessRule(fx.app.deps, ACTOR, globalId, {
      ...relaxed,
      confirm_widening: true,
    });
    expect(updated.ok).toBe(true);
    expect((await fx.call('/a', { method: 'POST', body: '{}' })).status).toBe(200);
  });
});
