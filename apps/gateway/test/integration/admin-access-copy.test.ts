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
  formFields,
  idFromLocation,
  labels,
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
    expect(page).toContain('Slack<span class="meta">(review operations)</span>');
    const before = await auditActions();
    const res = await adminPost(world.app, session(), `/admin/access/${sourceId}/copy`, {
      repository: 'acme/api (987654321)',
      token_id: slack,
    });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe(
      `/admin/access/new?copy=${sourceId}&token=${slack}&repository=acme%2Fapi+%28987654321%29&notice=copy_review`,
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
    expect(locationOf(res)).toContain('notice=copy_review_rows');
    expect(await listGrants(env.DB)).toHaveLength(2);
    const form = await (await adminGet(world.app, session(), locationOf(res))).text();
    expect(form).toContain('name="editor" value="rows"');
    expect(form).toMatch(/name="acknowledge_warnings"[^>]*required/);
    expect(form).toContain('These constraints need the conditions editor');
    // The repository condition of the rows is the one the admin typed, not the source's.
    expect(form).toContain('for acme/web (987654322)');
    expect(form).toMatch(/name="cond\.\d+\.values" type="text" value="987654322"/);
    expect(form).not.toMatch(/name="cond\.\d+\.values" type="text" value="987654321"/);
    const saved = await adminPost(world.app, session(), '/admin/access', {
      ...(await formFields(form, 'access-form')),
      acknowledge_warnings: '1',
    });
    expect(saved.status).toBe(303);
    const copy = await getGrant(env.DB, idFromLocation(locationOf(saved)));
    expect(copy?.conditions).toContainEqual({
      claim: 'repository_id',
      match: 'exact',
      values: ['987654322'],
    });
  });

  it('copies to a repository with no stored name on a token with other operations: one more submit', async () => {
    const slack = await seedService(world.app.deps, {
      slug: 'slack',
      name: 'Slack',
      base_url: 'https://slack.com/api',
    });
    const res = await adminPost(world.app, session(), `/admin/access/${sourceId}/copy`, {
      repository: 'acme/web (987654322)',
      token_id: slack,
    });
    expect(locationOf(res)).toContain('repository=acme%2Fweb+%28987654322%29');
    const form = await (await adminGet(world.app, session(), locationOf(res))).text();
    expect(form).toContain('for acme/web (987654322)');
    // "Change token" keeps the copy and the repository, and drops only the token.
    expect(form).toContain(
      `href="/admin/access/new?consumer=${provider.id}&amp;copy=${sourceId}&amp;repository=acme%2Fweb+%28987654322%29">Change<span class="vh"> token</span>`,
    );
    const saved = await adminPost(
      world.app,
      session(),
      '/admin/access',
      await formFields(form, 'access-form'),
    );
    expect(saved.status).toBe(303);
    const copy = await getGrant(env.DB, idFromLocation(locationOf(saved)));
    expect(copy).toMatchObject({
      service_id: slack,
      name: 'Slack for acme/web (environment production)',
    });
    expect(await labels(provider.id)).toContainEqual({
      claim: 'repository_id',
      value: '987654322',
      label: 'acme/web',
    });
  });

  it('preselects the source token among the choices when the copy names no token', async () => {
    await seedService(world.app.deps, {
      slug: 'slack',
      name: 'Slack',
      base_url: 'https://slack.com/api',
    });
    const form = await (
      await adminGet(world.app, session(), `/admin/access/new?copy=${sourceId}`)
    ).text();
    expect(form).toMatch(new RegExp(`name="token_id" value="${github}" checked`));
    expect(form).toMatch(new RegExp(`name="${github}\\.op" value="read-repo" checked`));
  });

  it('reviews literal operations that name the source repository before copying to another one', async () => {
    const created = await adminPost(world.app, session(), '/admin/access', {
      consumer_id: provider.id,
      token_id: github,
      repository: 'acme/api (987654321)',
      context: 'environment',
      environment: 'staging',
      ref_protection: 'protected',
      op: 'read-repo',
      'rule.0.m': 'POST',
      'rule.0.path': '/repos/acme/api/dispatches',
      expires: 'never',
    });
    const withDispatch = idFromLocation(locationOf(created));
    // The snippet calls the access's own literal operation instead of <path>.
    const detail = await (
      await adminGet(world.app, session(), `/admin/access/${withDispatch}`)
    ).text();
    expect(detail).toContain('curl -sS --fail-with-body -X POST');
    expect(detail).not.toContain('&lt;path&gt;');
    const before = await auditActions();
    const res = await adminPost(world.app, session(), `/admin/access/${withDispatch}/copy`, {
      repository: 'acme/web (987654322)',
      token_id: github,
    });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toContain('notice=copy_review_paths');
    expect(await auditActions()).toEqual(before);
    const form = await (await adminGet(world.app, session(), locationOf(res))).text();
    expect(form).toContain('Some operations name the source repository');
    expect(form).toContain('value="/repos/acme/api/dispatches"');
    // The preset follows the new repository; the literal path is shown for review.
    expect(form).toContain('Read repository contents');
    expect(form).toContain('<code>GET /repos/acme/web/**</code>');
  });

  it('sends the copy of an expired access to the form to choose its expiry', async () => {
    await env.DB.prepare('UPDATE grants SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1000, sourceId)
      .run();
    const page = await (await adminGet(world.app, session(), `/admin/access/${sourceId}`)).text();
    expect(page).toContain('This access has expired: Create copy opens the form');
    const res = await adminPost(world.app, session(), `/admin/access/${sourceId}/copy`, {
      repository: 'acme/web (987654322)',
      token_id: github,
    });
    expect(locationOf(res)).toContain('notice=copy_review_expired');
    expect(await listGrants(env.DB)).toHaveLength(1);
  });
});
