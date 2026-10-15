// A7.7: a risky consumer access is saved only with the risk explicitly accepted, either by the
// structured choice that causes it or by ticking a box bound to a digest of exactly the risks
// shown. A tick or choice for one risk never covers another, and nothing is written on refusal.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getGrant, listGrants } from '../../src/db/grants';
import type { CallerProvider } from '../../src/db/types';
import { adminGet, adminPost } from '../helpers/admin-auth';
import {
  type ConsumersWorld,
  consumersWorld,
  idFromLocation,
  inputValue,
  lastAudit,
  locationOf,
} from '../helpers/consumers';
import {
  OWNER_ID,
  REPOSITORY_ID,
  seedGithubProvider,
  seedService,
} from '../unit/admin/ops/helpers';

let world: ConsumersWorld;
let provider: CallerProvider;
let serviceId: string;

beforeEach(async () => {
  world = await consumersWorld();
  provider = await seedGithubProvider(world.app.deps);
  serviceId = await seedService(world.app.deps);
});

const session = () => world.sessions.access_manager;

function fields(overrides: Record<string, string | string[]> = {}) {
  return {
    consumer_id: provider.id,
    token_id: serviceId,
    repository: `acme/api (${REPOSITORY_ID})`,
    context: 'branch',
    branch: 'main',
    ref_protection: 'protected',
    op: 'read-repo',
    expires: 'never',
    ...overrides,
  };
}

function rows(extra: Record<string, string> = {}) {
  return {
    consumer_id: provider.id,
    token_id: serviceId,
    editor: 'rows',
    'cond.0.claim': 'repository_owner_id',
    'cond.0.values': OWNER_ID,
    'cond.1.claim': 'repository_id',
    'cond.1.values': REPOSITORY_ID,
    'cond.2.claim': 'ref',
    'cond.2.match': 'glob',
    'cond.2.values': 'refs/heads/main',
    'rule.0.m': 'GET',
    'rule.0.path': '/repos/acme/api',
    expires: 'never',
    ...extra,
  };
}

describe('I-AUTHZ-3: risky access needs explicit acceptance', () => {
  it('choosing unprotected refs accepts that risk in one submit, recorded in the audit row', async () => {
    const res = await adminPost(
      world.app,
      session(),
      '/admin/access',
      fields({ ref_protection: 'unprotected' }),
    );
    expect(res.status).toBe(303);
    const audit = await lastAudit('grant.create');
    expect(audit?.accepted_risks).toEqual(['unprotected_ref']);
    expect(audit?.warnings).toEqual([expect.stringContaining('ref_protected')]);
  });

  it('the pull request and any contexts carry their own risk in their choice', async () => {
    for (const context of ['pull_request', 'any']) {
      const res = await adminPost(
        world.app,
        session(),
        '/admin/access',
        fields({ context, pr_base: 'main' }),
      );
      expect(res.status, context).toBe(303);
    }
    expect((await lastAudit('grant.create'))?.accepted_risks).toEqual(['any_ref']);
  });

  it('rows with an uncovered warning need the digest and the box: 422 first, then one submit', async () => {
    const first = await adminPost(world.app, session(), '/admin/access', rows());
    expect(first.status).toBe(422);
    const html = await first.text();
    expect(html).toContain('href="#f-acknowledge_warnings"');
    expect(html).toMatch(/name="acknowledge_warnings"[^>]*required/);
    const digest = inputValue(html, 'warnings_digest');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await listGrants(env.DB)).toEqual([]);
    const unticked = await adminPost(world.app, session(), '/admin/access', {
      ...rows(),
      warnings_digest: digest ?? '',
    });
    expect(unticked.status).toBe(422);
    const second = await adminPost(world.app, session(), '/admin/access', {
      ...rows(),
      warnings_digest: digest ?? '',
      acknowledge_warnings: '1',
    });
    expect(second.status).toBe(303);
    expect((await lastAudit('grant.create'))?.accepted_risks).toEqual(['unprotected_ref']);
  });

  it('rows that constrain no ref, environment or event carry the any-ref risk too', async () => {
    const anyRef = rows({ 'cond.2.claim': '', 'cond.2.match': '', 'cond.2.values': '' });
    const first = await adminPost(world.app, session(), '/admin/access', anyRef);
    expect(first.status).toBe(422);
    const html = await first.text();
    expect(html).toContain('anyone with write access to the repository');
    expect(await listGrants(env.DB)).toEqual([]);
    const second = await adminPost(world.app, session(), '/admin/access', {
      ...anyRef,
      warnings_digest: inputValue(html, 'warnings_digest') ?? '',
      acknowledge_warnings: '1',
    });
    expect(second.status).toBe(303);
    expect((await lastAudit('grant.create'))?.accepted_risks).toEqual(['any_ref']);
    // The access page and the Risk accepted filter agree with the acceptance.
    const id = idFromLocation(locationOf(second));
    const page = await (await adminGet(world.app, session(), `/admin/access/${id}`)).text();
    expect(page).toContain('anyone with write access to the repository');
    const risky = await (
      await adminGet(world.app, session(), '/admin/access?view=list&status=risk')
    ).text();
    expect(risky).toContain(`/admin/access/${id}"`);
  });

  it('a digest of other risks does not count', async () => {
    const first = await adminPost(world.app, session(), '/admin/access', rows());
    const digest = inputValue(await first.text(), 'warnings_digest') ?? '';
    const broader = await adminPost(world.app, session(), '/admin/access', {
      ...rows({ 'cond.2.values': 'refs/heads/**' }),
      warnings_digest: digest,
      acknowledge_warnings: '1',
    });
    expect(broader.status).toBe(422);
    expect(await broader.text()).toContain('The risks changed');
    expect(await listGrants(env.DB)).toEqual([]);
  });

  it('a copy of a risk-accepted access asks for the acknowledgement on its first render', async () => {
    const created = await adminPost(
      world.app,
      session(),
      '/admin/access',
      fields({ ref_protection: 'unprotected' }),
    );
    const sourceId = idFromLocation(locationOf(created));
    const page = await adminGet(world.app, session(), `/admin/access/new?copy=${sourceId}`);
    const html = await page.text();
    expect(html).toContain('Copied the constraints of');
    expect(html).toMatch(/name="ref_protection" value="unprotected" checked/);
    expect(html).toMatch(/name="acknowledge_warnings"[^>]*required/);
    expect(html).not.toMatch(/name="acknowledge_warnings"[^>]*checked/);
    const digest = inputValue(html, 'warnings_digest') ?? '';
    const without = await adminPost(world.app, session(), '/admin/access', {
      ...fields({ ref_protection: 'unprotected', repository: 'acme/web (5)' }),
      warnings_digest: digest,
    });
    expect(without.status).toBe(422);
    expect(await listGrants(env.DB)).toHaveLength(1);
  });

  it('a decoy choice in another branch covers nothing', async () => {
    const other = await seedService(world.app.deps, { slug: 'other', name: 'Other' });
    // Two tokens: the token branches are prefixed. The chosen one is rows mode for the consumer
    // (one consumer, so its fields are unprefixed); a decoy "unprotected" sits in an unrelated
    // prefix and must not be read.
    const res = await adminPost(world.app, session(), '/admin/access', {
      ...rows(),
      token_id: serviceId,
      [`${serviceId}.ops`]: '1',
      [`${serviceId}.rule.0.m`]: 'GET',
      [`${serviceId}.rule.0.path`]: '/repos/acme/api',
      [`${other}.ops`]: '1',
      'new.github-actions.context': 'branch',
      'new.github-actions.ref_protection': 'unprotected',
      context: 'branch',
      ref_protection: 'unprotected',
    });
    expect(res.status).toBe(422);
    expect(await listGrants(env.DB)).toEqual([]);
  });

  it('an edit that adds a risk asks again', async () => {
    const created = await adminPost(world.app, session(), '/admin/access', fields());
    const id = idFromLocation(locationOf(created));
    const res = await adminPost(world.app, session(), `/admin/access/${id}`, {
      ...rows(),
      intent: 'save',
      expires: 'keep',
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/<details id="edit" open/);
    expect((await getGrant(env.DB, id))?.conditions).toHaveLength(6);
  });
});
