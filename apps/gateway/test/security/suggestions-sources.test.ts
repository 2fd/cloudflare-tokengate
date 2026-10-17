// Autocomplete in the issuer access rules form reads control-plane data only: labels and values that
// saved consumers and accesses typed. A value seen only in the request log (data any caller can
// put there) is never suggested, another credential access rule's labels never are, and no admin page makes an
// outbound lookup.
import { beforeEach, describe, expect, it } from 'vitest';
import { createCredentialAccessRule } from '../../src/admin/ops/credential-access-rules';
import type { CredentialAccessRule } from '../../src/db/types';
import { adminGet, adminPost } from '../helpers/admin-auth';
import {
  type ConsumersWorld,
  consumersWorld,
  requestRecord,
  seedLabel,
  seedRequests,
} from '../helpers/consumers';
import { testCredentialId } from '../unit/admin/ops/helpers';
import { ACTOR, OWNER_ID, seedGithubProvider, seedService } from '../unit/admin/ops/helpers';

let world: ConsumersWorld;
let provider: CredentialAccessRule;
let serviceId: string;

beforeEach(async () => {
  world = await consumersWorld();
  serviceId = await seedService(world.app.deps);
  provider = await seedGithubProvider(world.app.deps);
});

const session = () => world.sessions.admin;

function datalists(html: string): string {
  return [...html.matchAll(/<datalist[^>]*>[\s\S]*?<\/datalist>/g)]
    .map((match) => match[0])
    .join('\n');
}

describe('I-LOG-2: suggestions come from the control plane only', () => {
  it('never suggests a repository that only the request log knows, and suggests one once saved', async () => {
    await seedRequests([
      requestRecord({
        id: 'req_01JTESTREQUEST0000000000SA',
        service_id: serviceId,
        credential_access_rule_id: provider.id,
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
    const before = datalists(
      await (await adminGet(world.app, session(), '/admin/issuer-access-rules/new')).text(),
    );
    expect(before).not.toContain('evil');
    expect(before).not.toContain('111');

    const saved = await adminPost(world.app, session(), '/admin/issuer-access-rules', {
      consumer_id: provider.id,
      token_id: serviceId,
      repository: 'acme/api (222)',
      context: 'environment',
      environment: 'staging',
      ref_protection: 'protected',
      op: 'read-repo',
      expires: 'never',
    });
    expect(saved.status).toBe(303);
    const after = datalists(
      await (await adminGet(world.app, session(), '/admin/issuer-access-rules/new')).text(),
    );
    expect(after).toContain('<option value="acme/api (222)">');
    expect(after).toContain('<option value="staging">');
    expect(after).not.toContain('evil');
  });

  it('never suggests another credential access rule’s labels', async () => {
    const other = await createCredentialAccessRule(world.app.deps, ACTOR, {
      credential_id: await testCredentialId(world.app.deps),
      profile: 'gitlab-ci',
      issuer: 'https://gitlab.com',
      tenant_pin: [{ claim: 'namespace_id', match: 'exact', values: ['9'] }],
    });
    if (!other.ok) throw new Error(other.errors.join('; '));
    await seedLabel(
      other.ok ? other.credentialAccessRule.id : '',
      'project_id',
      '333',
      'secret-group/app',
    );
    await seedLabel(provider.id, 'repository_id', '444', 'acme/web');
    const html = await (
      await adminGet(world.app, session(), `/admin/issuer-access-rules/new?consumer=${provider.id}`)
    ).text();
    expect(datalists(html)).toContain('acme/web (444)');
    expect(datalists(html)).not.toContain('secret-group');
  });

  it('makes no outbound call while rendering admin pages', async () => {
    await seedLabel(provider.id, 'repository_id', '444', 'acme/web');
    const before = world.calls.length;
    for (const path of [
      '/admin/credential-access-rules',
      `/admin/credential-access-rules/${provider.id}`,
      '/admin/credential-access-rules/new',
      '/admin/issuer-access-rules',
      '/admin/issuer-access-rules?view=list',
      '/admin/issuer-access-rules/new',
      `/admin/issuer-access-rules/new?consumer=${provider.id}&token=${serviceId}&repository=444`,
    ]) {
      expect((await adminGet(world.app, session(), path)).status, path).toBe(200);
    }
    // A POST for an existing consumer validates and saves without any lookup.
    await adminPost(world.app, session(), '/admin/issuer-access-rules', {
      consumer_id: provider.id,
      token_id: serviceId,
      repository: 'acme/web (444)',
      context: 'branch',
      branch: 'main',
      ref_protection: 'protected',
      op: 'read-repo',
      expires: 'never',
    });
    expect(world.calls.slice(before)).toEqual([]);
  });
});
