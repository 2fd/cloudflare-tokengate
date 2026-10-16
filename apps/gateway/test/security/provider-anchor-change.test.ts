import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCallerProvider, updateCallerProvider } from '../../src/admin/ops/caller-providers';
import { createGrant, setGrantEnabled } from '../../src/admin/ops/grants';
import { getCallerProvider } from '../../src/db/caller-providers';
import { getGrant } from '../../src/db/grants';
import type { Deps } from '../../src/deps';
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
  const provider = await createCallerProvider(deps, ACTOR, {
    name: 'IdP',
    profile: 'generic',
    issuer: ISSUER,
    jwks_uri: `${ISSUER}/keys`,
    audience: 'tokengate:anchor-test',
    anchor_claims: ['email'],
  });
  if (!provider.ok) throw new Error(provider.errors.join('; '));
  const grant = await createGrant(deps, ACTOR, {
    name: 'by email',
    caller_provider_id: provider.callerProvider.id,
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
  return { providerId: provider.callerProvider.id, grantId: grant.grant.id };
}

beforeEach(resetControlPlane);

describe('I-AUTHZ-2: changing anchor claims cannot leave enabled grants unanchored', () => {
  it('refuses the change and names the enabled grants that would no longer validate', async () => {
    const deps = opsDeps();
    const { providerId, grantId } = await seed(deps, true);
    const audits = await auditCount();

    const result = await updateCallerProvider(deps, ACTOR, providerId, { anchor_claims: ['oid'] });

    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (result.ok) return;
    expect(result.errors.join()).toMatch(/"by email".*oid/);
    expect((await getCallerProvider(env.DB, providerId))?.anchor_claims).toEqual(['email']);
    expect((await getGrant(env.DB, grantId))?.enabled).toBe(true);
    expect(await auditCount()).toBe(audits);
  });

  it('allows the change once the grant is disabled; re-enabling it is then refused', async () => {
    const deps = opsDeps();
    const { providerId, grantId } = await seed(deps, false);
    const result = await updateCallerProvider(deps, ACTOR, providerId, { anchor_claims: ['oid'] });
    expect(result.ok).toBe(true);
    expect(await setGrantEnabled(deps, ACTOR, grantId, true)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('allows the change when every enabled grant satisfies the new anchor', async () => {
    const deps = opsDeps();
    const { providerId } = await seed(deps, true);
    const result = await updateCallerProvider(deps, ACTOR, providerId, {
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
      const enabled = await setGrantEnabled(deps, ACTOR, grantId, true);
      if (!enabled.ok) throw new Error(enabled.errors.join('; '));
    });

    const result = await updateCallerProvider(racing, ACTOR, providerId, {
      anchor_claims: ['oid'],
    });

    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect((await getCallerProvider(env.DB, providerId))?.anchor_claims).toEqual(['email']);
    expect((await getGrant(env.DB, grantId))?.enabled).toBe(true);
    // Only the concurrent enable was recorded.
    expect(await auditCount()).toBe(audits + 1);
  });
});
