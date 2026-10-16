// "Add consumer" for an issuer that already has a consumer (github.com, gitlab.com) adds the
// organizations or groups to it: one caller_provider.update, the name re-derived, no UNIQUE error.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getCallerProvider } from '../../src/db/caller-providers';
import { adminGet, adminPost } from '../helpers/admin-auth';
import {
  auditActions,
  type ConsumersWorld,
  consumersWorld,
  idFromLocation,
  locationOf,
} from '../helpers/consumers';
import { OWNER_ID } from '../unit/admin/ops/helpers';

let world: ConsumersWorld;

beforeEach(async () => {
  world = await consumersWorld();
});

const session = () => world.sessions.access_manager;

describe('adding a consumer of an issuer that already has one', () => {
  it('merges the organizations with one audit row and a re-derived name', async () => {
    const first = await adminPost(world.app, session(), '/admin/consumers', {
      type: 'github-actions',
      github_org: `acme (${OWNER_ID})`,
    });
    const id = idFromLocation(locationOf(first));
    const second = await adminPost(world.app, session(), '/admin/consumers', {
      type: 'github-actions',
      github_org: 'acme-labs (7654321), acme-ops (7654322)',
    });
    expect(second.status).toBe(303);
    expect(locationOf(second)).toBe(`/admin/consumers/${id}?notice=tenant_added`);
    const stored = await getCallerProvider(env.DB, id);
    expect(stored?.name).toBe('GitHub Actions (acme, acme-labs, acme-ops)');
    expect(stored?.tenant_pin).toEqual([
      { claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID, '7654321', '7654322'] },
    ]);
    expect(await auditActions()).toEqual(['caller_provider.create', 'caller_provider.update']);
    const count = await env.DB.prepare('SELECT count(*) AS n FROM caller_providers').first<{
      n: number;
    }>();
    expect(count?.n).toBe(1);
  });

  it('says so when every organization is already there, writing nothing', async () => {
    await adminPost(world.app, session(), '/admin/consumers', {
      type: 'gitlab-ci',
      gitlab_group: 'acme-group (5678901)',
    });
    const again = await adminPost(world.app, session(), '/admin/consumers', {
      type: 'gitlab-ci',
      gitlab_group: 'acme-group (5678901)',
    });
    expect(again.status).toBe(422);
    expect(await again.text()).toContain(
      'acme-group (5678901) is already allowed for GitLab (acme-group).',
    );
    expect(await auditActions()).toEqual(['caller_provider.create']);
  });

  it('lists what is already added and never drops an enterprise ID in a merge', async () => {
    await adminPost(world.app, session(), '/admin/consumers', {
      type: 'github-actions',
      github_org: `acme (${OWNER_ID})`,
    });
    const form = await (await adminGet(world.app, session(), '/admin/consumers/new')).text();
    expect(form).toContain(`Already added: acme (${OWNER_ID}).`);
    const merged = await adminPost(world.app, session(), '/admin/consumers', {
      type: 'github-actions',
      github_org: 'acme-labs (7654321)',
      github_enterprise_id: '12345',
    });
    expect(merged.status).toBe(422);
    const html = await merged.text();
    expect(html).toContain('without an enterprise ID');
    expect(html).toContain('href="#f-github_enterprise_id"');
    expect(await auditActions()).toEqual(['caller_provider.create']);
  });
});
