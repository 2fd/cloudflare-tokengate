// "Copy to another repository or token" (D13): one submit when the target token has the same
// operations, otherwise the prefilled form with nothing written; never a copy with an unaccepted
// risk, and never an identical copy.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getGrant, listGrants } from '../../src/db/grants';
import type { CallerProvider } from '../../src/db/types';
import { adminGet, adminPost } from '../helpers/admin-auth';
import {
  auditActions,
  type ConsumersWorld,
  consumersWorld,
  idFromLocation,
  lastAudit,
  locationOf,
  seedLabel,
} from '../helpers/consumers';
import { OWNER_ID, seedGithubProvider, seedService } from '../unit/admin/ops/helpers';

let world: ConsumersWorld;
let provider: CallerProvider;
let github: string;
let sourceId: string;

beforeEach(async () => {
  world = await consumersWorld();
  provider = await seedGithubProvider(world.app.deps);
  github = await seedService(world.app.deps);
  await seedLabel(provider.id, 'repository_owner_id', OWNER_ID, 'acme');
  const created = await adminPost(world.app, world.sessions.access_manager, '/admin/access', {
    consumer_id: provider.id,
    token_id: github,
    repository: 'acme/api (987654321)',
    context: 'environment',
    environment: 'production',
    ref_protection: 'protected',
    op: 'read-repo',
    expires: 'never',
  });
  sourceId = idFromLocation(locationOf(created));
});

const session = () => world.sessions.access_manager;

describe('copy an access', () => {
  it('copies to another repository in one submit: enabled, re-labelled, operations re-targeted', async () => {
    const page = await (await adminGet(world.app, session(), `/admin/access/${sourceId}`)).text();
    expect(page).toContain(`action="/admin/access/${sourceId}/copy"`);
    expect(page).toContain('The copy has no accepted risks.');
    const res = await adminPost(world.app, session(), `/admin/access/${sourceId}/copy`, {
      repository: 'acme/web (987654322)',
      token_id: github,
    });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toMatch(/\?notice=copied$/);
    const copy = await getGrant(env.DB, idFromLocation(locationOf(res)));
    expect(copy).toMatchObject({
      enabled: true,
      name: 'GitHub for acme/web (environment production)',
      rules: [{ methods: ['GET'], path: '/repos/acme/web/**' }],
    });
    expect(copy?.conditions).toContainEqual({
      claim: 'repository_id',
      match: 'exact',
      values: ['987654322'],
    });
    expect((await lastAudit('grant.duplicate'))?.source_id).toBe(sourceId);
  });

  it('sends a token with other operations to the prefilled form, writing nothing', async () => {
    const slack = await seedService(world.app.deps, {
      slug: 'slack',
      name: 'Slack',
      base_url: 'https://slack.com/api',
    });
    const page = await (await adminGet(world.app, session(), `/admin/access/${sourceId}`)).text();
    expect(page).toContain('Slack (review operations)');
    const before = await auditActions();
    const res = await adminPost(world.app, session(), `/admin/access/${sourceId}/copy`, {
      repository: 'acme/api (987654321)',
      token_id: slack,
    });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe(
      `/admin/access/new?copy=${sourceId}&token=${slack}&repository=987654321&notice=copy_review`,
    );
    expect(await auditActions()).toEqual(before);
    const form = await (await adminGet(world.app, session(), locationOf(res))).text();
    expect(form).toContain('Copied the constraints of');
    expect(form).toContain('review them, then save the copy');
    expect(form).toMatch(/name="op" value="post-message" checked/);
  });

  it('refuses an identical copy and an unknown organization without the new organization', async () => {
    const same = await adminPost(world.app, session(), `/admin/access/${sourceId}/copy`, {
      repository: 'acme/api (987654321)',
      token_id: github,
    });
    expect(same.status).toBe(422);
    expect(await same.text()).toContain('Choose another repository or token.');
    const unknown = await adminPost(world.app, session(), `/admin/access/${sourceId}/copy`, {
      repository: 'other-org/api (5)',
      token_id: github,
    });
    expect(unknown.status).toBe(422);
    const html = await unknown.text();
    expect(html).toContain('Add organization other-org to this consumer');
    expect(html).toContain('<title>Error: Give a consumer access');
    expect(await listGrants(env.DB)).toHaveLength(1);
  });

  it('a copy of constraints only the rows editor shows goes through the form, risks and all', async () => {
    const rows = {
      consumer_id: provider.id,
      token_id: github,
      editor: 'rows',
      'cond.0.claim': 'repository_owner_id',
      'cond.0.values': OWNER_ID,
      'cond.1.claim': 'repository_id',
      'cond.1.values': '987654321',
      'cond.2.claim': 'ref',
      'cond.2.match': 'glob',
      'cond.2.values': 'refs/heads/main',
      'rule.0.m': 'GET',
      'rule.0.path': '/x',
      expires: 'never',
    };
    const first = await adminPost(world.app, session(), '/admin/access', rows);
    const digest = /name="warnings_digest" value="([0-9a-f]+)"/.exec(await first.text())?.[1] ?? '';
    const risky = await adminPost(world.app, session(), '/admin/access', {
      ...rows,
      warnings_digest: digest,
      acknowledge_warnings: '1',
    });
    const riskyId = idFromLocation(locationOf(risky));
    const res = await adminPost(world.app, session(), `/admin/access/${riskyId}/copy`, {
      repository: 'acme/web (987654322)',
      token_id: github,
    });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toContain(`/admin/access/new?copy=${riskyId}`);
    expect(await listGrants(env.DB)).toHaveLength(2);
    const form = await (await adminGet(world.app, session(), locationOf(res))).text();
    expect(form).toContain('name="editor" value="rows"');
    expect(form).toMatch(/name="acknowledge_warnings"[^>]*required/);
  });
});
