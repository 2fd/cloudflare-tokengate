// I-AUTHZ-2: an access rule's anchor claims and its conditions live in the same row, so an anchor
// change is validated against the rule's own conditions. A change that leaves them unanchored is
// refused and writes nothing.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCredentialAccessRule,
  updateCredentialAccessRule,
} from '../../src/admin/ops/credential-access-rules';
import { getCredentialAccessRule } from '../../src/db/access-rules';
import {
  ACTOR,
  auditCount,
  opsDeps,
  resetControlPlane,
  testCredentialId,
} from '../unit/admin/ops/helpers';

const ISSUER = 'https://idp.example.com';

beforeEach(resetControlPlane);

describe('I-AUTHZ-2: changing anchor claims cannot leave the rule unanchored', () => {
  it("refuses an anchor change that the rule's own conditions do not satisfy", async () => {
    const deps = opsDeps();
    const created = await createCredentialAccessRule(deps, ACTOR, {
      credential_id: await testCredentialId(deps),
      name: 'by email',
      profile: 'generic',
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/keys`,
      audience: 'tokengate:anchor-test',
      anchor_claims: ['email'],
      conditions: [
        { claim: 'email', match: 'exact', values: ['a@x.com'] },
        { claim: 'oid', match: 'glob', values: ['*'] },
      ],
      rules: [{ methods: ['GET'], path: '/repos/**' }],
      acknowledge_warnings: true,
    });
    if (!created.ok) throw new Error(created.errors.join('; '));
    const id = created.rule.id;
    const audits = await auditCount();

    const refused = await updateCredentialAccessRule(deps, ACTOR, id, { anchor_claims: ['oid'] });
    expect(refused).toMatchObject({ ok: false, reason: 'invalid' });
    expect((await getCredentialAccessRule(env.DB, id))?.anchor_claims).toEqual(['email']);
    expect(await auditCount()).toBe(audits);

    // email is still one of the accepted anchors.
    const kept = await updateCredentialAccessRule(deps, ACTOR, id, {
      anchor_claims: ['email', 'tid'],
      acknowledge_warnings: true,
    });
    expect(kept.ok).toBe(true);
  });
});
