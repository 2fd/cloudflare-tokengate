// Autocomplete in the credential access rule form reads control-plane data only: labels and values
// that saved access rules of the same credential typed. A value seen only in the request log (data
// any caller can put there) is never suggested, the labels of another credential's access rules
// never are, and no admin page makes an outbound lookup.
import { beforeEach, describe, expect, it } from 'vitest';
import type { CredentialAccessRule } from '../../src/db/types';
import {
  type RulesWorld,
  rulesWorld,
  requestRecord,
  seedLabel,
  seedRequests,
} from '../helpers/access-rules';
import { adminGet, adminPost } from '../helpers/admin-auth';
import { OWNER_ID, seedCredentialRule, seedService } from '../unit/admin/ops/helpers';

let world: RulesWorld;
let rule: CredentialAccessRule;
let serviceId: string;

beforeEach(async () => {
  world = await rulesWorld();
  serviceId = await seedService(world.app.deps);
  rule = await seedCredentialRule(world.app.deps, { credential_id: serviceId });
});

const session = () => world.sessions.admin;
const newPath = () =>
  `/admin/credential-access-rules/new?credential=${serviceId}&type=github-actions`;

function datalists(html: string): string {
  return [...html.matchAll(/<datalist[^>]*>[\s\S]*?<\/datalist>/g)]
    .map((match) => match[0])
    .join('\n');
}

/** The credential access rule form for a GitHub repository with protected refs, read only. */
function ruleFields(repository: string, context: Record<string, string>) {
  const jobs = 'new.github-actions.';
  return {
    token_id: serviceId,
    token_view: 'fixed',
    'new.type': 'github-actions',
    'new.github_org': `acme (${OWNER_ID})`,
    [`${jobs}editor`]: 'structured',
    [`${jobs}repository`]: repository,
    [`${jobs}ref_protection`]: 'protected',
    ...Object.fromEntries(Object.entries(context).map(([key, value]) => [`${jobs}${key}`, value])),
    ops: '1',
    op: 'read-repo',
    expires: 'never',
  };
}

describe('I-LOG-2: suggestions come from the control plane only', () => {
  it('never suggests a repository that only the request log knows, and suggests one once saved', async () => {
    await seedRequests([
      requestRecord({
        id: 'req_01JTESTREQUEST0000000000SA',
        service_id: serviceId,
        credential_access_rule_id: rule.id,
        caller_repository: 'evil/repo',
        caller_claims: JSON.stringify({
          repository: 'evil/repo',
          repository_id: '111',
          repository_owner_id: OWNER_ID,
          environment: 'evil-env',
          ref: 'refs/heads/evil-branch',
        }),
      }),
    ]);
    const before = datalists(await (await adminGet(world.app, session(), newPath())).text());
    expect(before).not.toContain('evil');
    expect(before).not.toContain('111');

    const saved = await adminPost(
      world.app,
      session(),
      '/admin/credential-access-rules',
      ruleFields('acme/api (222)', { context: 'environment', environment: 'staging' }),
    );
    expect(saved.status).toBe(303);
    const after = datalists(await (await adminGet(world.app, session(), newPath())).text());
    expect(after).toContain('<option value="acme/api (222)">');
    expect(after).toContain('<option value="staging">');
    expect(after).not.toContain('evil');
  });

  it("never suggests the labels of another credential's access rules", async () => {
    const otherCredential = await seedService(world.app.deps, { slug: 'other', name: 'Other' });
    const other = await seedCredentialRule(world.app.deps, { credential_id: otherCredential });
    await seedLabel(other.id, 'repository_id', '333', 'secret-group/app');
    await seedLabel(rule.id, 'repository_id', '444', 'acme/web');
    const html = datalists(await (await adminGet(world.app, session(), newPath())).text());
    expect(html).toContain('acme/web (444)');
    expect(html).not.toContain('secret-group');
  });

  it('makes no outbound call while rendering admin pages', async () => {
    await seedLabel(rule.id, 'repository_id', '444', 'acme/web');
    const before = world.calls.length;
    for (const path of [
      '/admin/credential-access-rules',
      `/admin/credential-access-rules/${rule.id}`,
      `/admin/credential-access-rules/${rule.id}?open=edit`,
      '/admin/credential-access-rules/new',
      newPath(),
      `/admin/credential-access-rules/new?copy=${rule.id}`,
      '/admin/global-access-rules',
      '/admin/global-access-rules/new',
    ]) {
      expect((await adminGet(world.app, session(), path)).status, path).toBe(200);
    }
    // A POST for an issuer that a rule of the credential already trusts saves without any lookup.
    const saved = await adminPost(
      world.app,
      session(),
      '/admin/credential-access-rules',
      ruleFields('acme/web (444)', { context: 'branch', branch: 'main' }),
    );
    expect(saved.status).toBe(303);
    expect(world.calls.slice(before)).toEqual([]);
  });
});
