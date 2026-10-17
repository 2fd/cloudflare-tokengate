import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCredentialAccessRule,
  updateCredentialAccessRule,
} from '../../src/admin/ops/credential-access-rules';
import {
  createIssuerAccessRule,
  setIssuerAccessRuleEnabled,
} from '../../src/admin/ops/issuer_access_rules';
import { getCredentialAccessRule } from '../../src/db/credential-access-rules';
import { getIssuerAccessRule } from '../../src/db/issuer_access_rules';
import type { Deps } from '../../src/deps';
import { testCredentialId } from '../unit/admin/ops/helpers';
import {
  ACTOR,
  auditCount,
  opsDeps,
  racingDeps,
  resetControlPlane,
  seedService,
} from '../unit/admin/ops/helpers';

const ISSUER = 'https://idp.example.com';

async function seed(deps: Deps, enabled: boolean) {
  const provider = await createCredentialAccessRule(deps, ACTOR, {
    credential_id: await testCredentialId(deps),
    name: 'IdP',
    profile: 'generic',
    issuer: ISSUER,
    jwks_uri: `${ISSUER}/keys`,
    audience: 'tokengate:anchor-test',
    anchor_claims: ['email'],
  });
  if (!provider.ok) throw new Error(provider.errors.join('; '));
  const grant = await createIssuerAccessRule(deps, ACTOR, {
    name: 'by email',
    credential_access_rule_id: provider.credentialAccessRule.id,
    service_id: await seedService(deps),
    conditions: [
      { claim: 'email', match: 'exact', values: ['a@x.com'] },
      { claim: 'oid', match: 'glob', values: ['*'] },
    ],
    rules: [{ methods: ['GET'], path: '/repos/**' }],
    enabled,
    acknowledge_warnings: true,
  });
  if (!grant.ok) throw new Error(grant.errors.join('; '));
  return { providerId: provider.credentialAccessRule.id, grantId: grant.grant.id };
}

beforeEach(resetControlPlane);

describe('I-AUTHZ-2: changing anchor claims cannot leave enabled issuer_access_rules unanchored', () => {
  it('refuses the change and names the enabled issuer_access_rules that would no longer validate', async () => {
    const deps = opsDeps();
    const { providerId, grantId } = await seed(deps, true);
    const audits = await auditCount();

    const result = await updateCredentialAccessRule(deps, ACTOR, providerId, {
      anchor_claims: ['oid'],
    });

    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (result.ok) return;
    expect(result.errors.join()).toMatch(/"by email".*oid/);
    expect((await getCredentialAccessRule(env.DB, providerId))?.anchor_claims).toEqual(['email']);
    expect((await getIssuerAccessRule(env.DB, grantId))?.enabled).toBe(true);
    expect(await auditCount()).toBe(audits);
  });

  it('allows the change once the grant is disabled; re-enabling it is then refused', async () => {
    const deps = opsDeps();
    const { providerId, grantId } = await seed(deps, false);
    const result = await updateCredentialAccessRule(deps, ACTOR, providerId, {
      anchor_claims: ['oid'],
    });
    expect(result.ok).toBe(true);
    expect(await setIssuerAccessRuleEnabled(deps, ACTOR, grantId, true)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('allows the change when every enabled grant satisfies the new anchor', async () => {
    const deps = opsDeps();
    const { providerId } = await seed(deps, true);
    const result = await updateCredentialAccessRule(deps, ACTOR, providerId, {
      anchor_claims: ['email', 'tid'],
    });
    // email is still one of the accepted anchors.
    expect(result.ok).toBe(true);
  });

  it('a grant enabled while the change is being saved makes the change fail (SQL guard)', async () => {
    const deps = opsDeps();
    const { providerId, grantId } = await seed(deps, false);
    const audits = await auditCount();
    const racing = racingDeps(deps, async () => {
      const enabled = await setIssuerAccessRuleEnabled(deps, ACTOR, grantId, true);
      if (!enabled.ok) throw new Error(enabled.errors.join('; '));
    });

    const result = await updateCredentialAccessRule(racing, ACTOR, providerId, {
      anchor_claims: ['oid'],
    });

    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect((await getCredentialAccessRule(env.DB, providerId))?.anchor_claims).toEqual(['email']);
    expect((await getIssuerAccessRule(env.DB, grantId))?.enabled).toBe(true);
    // Only the concurrent enable was recorded.
    expect(await auditCount()).toBe(audits + 1);
  });
});
