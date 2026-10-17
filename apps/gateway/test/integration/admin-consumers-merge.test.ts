import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getCredentialAccessRule } from '../../src/db/credential-access-rules';
import { adminGet, adminPost } from '../helpers/admin-auth';
import {
  type ConsumersWorld,
  consumersWorld,
  idFromLocation,
  locationOf,
} from '../helpers/consumers';
import { OWNER_ID, seedService } from '../unit/admin/ops/helpers';

let world: ConsumersWorld;
let credentialId: string;
beforeEach(async () => {
  world = await consumersWorld();
  credentialId = await seedService(world.app.deps);
});

const add = (org: string, filters = '') =>
  adminPost(world.app, world.sessions.token_manager, '/admin/credential-access-rules', {
    credential_id: credentialId,
    type: 'github-actions',
    github_org: org,
    boundary_filters: filters,
  });

describe('credential boundaries with a shared issuer', () => {
  it('keeps organizations and mandatory filters independent instead of merging by issuer', async () => {
    const first = await add(`acme (${OWNER_ID})`, 'environment exact production');
    const second = await add('other (7654321)', 'environment exact staging');
    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    const firstId = idFromLocation(locationOf(first));
    const secondId = idFromLocation(locationOf(second));
    expect(firstId).not.toBe(secondId);
    const a = await getCredentialAccessRule(env.DB, firstId);
    const b = await getCredentialAccessRule(env.DB, secondId);
    expect(a?.issuer).toBe(b?.issuer);
    expect(a?.conditions).toEqual([
      { claim: 'environment', match: 'exact', values: ['production'] },
    ]);
    expect(a?.tenant_pin).toEqual([
      { claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] },
    ]);
    expect(b?.conditions).toEqual([{ claim: 'environment', match: 'exact', values: ['staging'] }]);
  });

  it('preselects the credential and lets its manager edit the boundary filters', async () => {
    const html = await (
      await adminGet(
        world.app,
        world.sessions.token_manager,
        `/admin/credential-access-rules/new?credential=${credentialId}`,
      )
    ).text();
    expect(html).toContain(`value="${credentialId}" selected`);
    expect(html).toContain('name="boundary_filters"');
    const created = await add(`acme (${OWNER_ID})`, 'environment exact production');
    const id = idFromLocation(locationOf(created));
    const boundary = await getCredentialAccessRule(env.DB, id);
    const changed = await adminPost(
      world.app,
      world.sessions.token_manager,
      `/admin/credential-access-rules/${id}`,
      {
        intent: 'boundary',
        expected_updated_at: String(boundary?.updated_at),
        boundary_filters: 'environment exact production\nref exact refs/heads/main',
      },
    );
    expect(changed.status).toBe(303);
    expect((await getCredentialAccessRule(env.DB, id))?.conditions).toHaveLength(2);
  });

  it('does not let an access manager create or widen a credential boundary', async () => {
    const created = await add(`acme (${OWNER_ID})`, 'environment exact production');
    const id = idFromLocation(locationOf(created));
    for (const [path, fields] of [
      [
        '/admin/credential-access-rules',
        { credential_id: credentialId, type: 'github-actions', github_org: `acme (${OWNER_ID})` },
      ],
      [`/admin/credential-access-rules/${id}`, { intent: 'boundary', boundary_filters: '' }],
    ] as const) {
      expect((await adminPost(world.app, world.sessions.access_manager, path, fields)).status).toBe(
        403,
      );
    }
    expect((await getCredentialAccessRule(env.DB, id))?.conditions).toEqual([
      { claim: 'environment', match: 'exact', values: ['production'] },
    ]);
  });
});
