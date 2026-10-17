// The access form asks only for what cannot be preselected: a single consumer or token is fixed,
// several are radio cards whose reveals hold their own prefixed fields, many are a select, and no
// consumer at all means the consumer is added in the same submit.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCallerProvider } from '../../src/admin/ops/caller-providers';
import { getGrant, listGrants } from '../../src/db/grants';
import { WORLD_SECRET } from '../fixtures/admin-forms';
import { adminGet, adminPost } from '../helpers/admin-auth';
import {
  auditActions,
  type ConsumersWorld,
  consumersWorld,
  idFromLocation,
  inputValue,
  locationOf,
} from '../helpers/consumers';
import { ACTOR, OWNER_ID, seedGithubProvider, seedService } from '../unit/admin/ops/helpers';

let world: ConsumersWorld;

beforeEach(async () => {
  world = await consumersWorld();
});

const session = () => world.sessions.access_manager;

async function githubConsumer(org: string, id: string) {
  const created = await createCallerProvider(world.app.deps, ACTOR, {
    profile: 'github-actions',
    issuer: `https://token.actions.githubusercontent.com`,
    tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [id] }],
    tenant_labels: [{ claim: 'repository_owner_id', value: id, label: org }],
  });
  if (!created.ok) throw new Error(created.errors.join('; '));
  return created.callerProvider;
}

describe('consumer access form: preselection', () => {
  it('fixes a preselected consumer and token and links to change them', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const a = await seedService(world.app.deps, { slug: 'a', name: 'A' });
    await seedService(world.app.deps, { slug: 'b', name: 'B' });
    const html = await (
      await adminGet(world.app, session(), `/admin/access/new?consumer=${provider.id}&token=${a}`)
    ).text();
    expect(inputValue(html, 'consumer_id')).toBe(provider.id);
    expect(inputValue(html, 'token_id')).toBe(a);
    expect(html).toContain('Change<span class="vh"> token</span>');
    expect(html).toContain('Add a new consumer');
    expect(inputValue(html, 'token_view')).toBe('fixed');
  });

  it('shows a token card with its credential state but never the credential hint', async () => {
    await seedGithubProvider(world.app.deps);
    const withSecret = await seedService(world.app.deps, {
      slug: 'a',
      name: 'A',
      secret: WORLD_SECRET,
    });
    await seedService(world.app.deps, { slug: 'b', name: 'B' });
    const html = await (await adminGet(world.app, session(), '/admin/access/new')).text();
    const hint = await env.DB.prepare('SELECT credential_hint FROM services WHERE id = ?')
      .bind(withSecret)
      .first<{ credential_hint: string }>();
    expect(hint?.credential_hint).toBeTruthy();
    expect(html).toContain('Secret set');
    expect(html).toContain('No secret yet: calls fail until a token manager sets it');
    expect(html).not.toContain(hint?.credential_hint ?? 'x');
  });

  it('nests each consumer and token branch, and reads only the chosen ones', async () => {
    const acme = await githubConsumer('acme', OWNER_ID);
    await env.DB.prepare("UPDATE caller_providers SET issuer = issuer || '/acme-corp' WHERE id = ?")
      .bind(acme.id)
      .run();
    const other = await githubConsumer('other', '777');
    const a = await seedService(world.app.deps, { slug: 'a', name: 'A' });
    const b = await seedService(world.app.deps, { slug: 'b', name: 'B' });
    const html = await (await adminGet(world.app, session(), '/admin/access/new')).text();
    expect(html).toContain(`name="consumer_id" value="${acme.id}"`);
    expect(html).toContain(`name="consumer_id" value="new"`);
    expect(html).toContain(`name="${acme.id}.repository"`);
    expect(html).toContain(`name="${other.id}.repository"`);
    expect(html).toContain(`name="${a}.op"`);
    expect(html).toContain(`name="new.github-actions.repository"`);
    const res = await adminPost(world.app, session(), '/admin/access', {
      consumer_id: acme.id,
      token_id: a,
      [`${acme.id}.repository`]: 'acme/api (5)',
      [`${acme.id}.context`]: 'environment',
      [`${acme.id}.environment`]: 'production',
      [`${acme.id}.ref_protection`]: 'protected',
      [`${other.id}.repository`]: 'other/decoy (6)',
      [`${other.id}.context`]: 'any',
      [`${a}.rule.0.m`]: 'POST',
      [`${a}.rule.0.path`]: '/a',
      [`${b}.rule.0.m`]: 'DELETE',
      [`${b}.rule.0.path`]: '/decoy',
      expires: 'never',
    });
    expect(res.status).toBe(303);
    const grant = await getGrant(env.DB, idFromLocation(locationOf(res)));
    expect(grant?.caller_provider_id).toBe(acme.id);
    expect(grant?.service_id).toBe(a);
    expect(grant?.rules).toEqual([{ methods: ['POST'], path: '/a' }]);
    expect(JSON.stringify(grant)).not.toContain('decoy');
    expect(grant?.conditions).toContainEqual({
      claim: 'environment',
      match: 'exact',
      values: ['production'],
    });
  });

  it('uses a select for seven or more consumers and shows the fields after refresh', async () => {
    const consumers = [];
    for (let i = 0; i < 7; i++) {
      const created = await createCallerProvider(world.app.deps, ACTOR, {
        profile: 'generic',
        issuer: `https://idp${i}.example.org`,
        jwks_uri: `https://idp${i}.example.org/keys`,
        anchor_claims: ['sub'],
      });
      if (!created.ok) throw new Error(created.errors.join('; '));
      consumers.push(created.callerProvider);
    }
    const token = await seedService(world.app.deps);
    const chosen = consumers[3]?.id ?? '';
    const html = await (await adminGet(world.app, session(), '/admin/access/new')).text();
    expect(html).toContain('<select class="select" id="f-consumer_id" name="consumer_id"');
    expect(html).not.toContain(`name="${chosen}.cond.0.claim"`);
    const refresh = await adminPost(world.app, session(), '/admin/access', {
      consumer_id: chosen,
      token_id: token,
      expires: 'never',
    });
    expect(refresh.status).toBe(200);
    const shown = await refresh.text();
    expect(shown).toContain(`name="${chosen}.cond.0.claim"`);
    expect(await listGrants(env.DB)).toEqual([]);
    const saved = await adminPost(world.app, session(), '/admin/access', {
      consumer_id: chosen,
      token_id: token,
      [`${chosen}.editor`]: 'rows',
      [`${chosen}.cond.0.claim`]: 'sub',
      [`${chosen}.cond.0.values`]: 'job-1',
      'rule.0.m': 'GET',
      'rule.0.path': '/x',
      expires: 'never',
    });
    expect(saved.status).toBe(303);
  });
});

describe('consumer access form: no consumer yet', () => {
  it('adds the consumer and the access in one submit, two audit rows', async () => {
    const token = await seedService(world.app.deps);
    const html = await (await adminGet(world.app, session(), '/admin/access/new')).text();
    expect(inputValue(html, 'consumer_id')).toBe('new');
    expect(html).toContain('name="new.type" value="github-actions"');
    expect(html).toContain('name="new.github-actions.repository"');
    const res = await adminPost(world.app, session(), '/admin/access', {
      consumer_id: 'new',
      token_id: token,
      'new.type': 'github-actions',
      'new.github_org': `acme (${OWNER_ID})`,
      'new.github-actions.repository': 'acme/api (89012345)',
      'new.github-actions.context': 'environment',
      'new.github-actions.environment': 'production',
      'new.github-actions.ref_protection': 'protected',
      op: 'read-repo',
      expires: 'never',
    });
    expect(res.status).toBe(303);
    expect(await auditActions()).toEqual([
      'service.create',
      'caller_provider.create',
      'grant.create',
    ]);
    const grant = await getGrant(env.DB, idFromLocation(locationOf(res)));
    expect(grant?.name).toBe('GitHub for acme/api (environment production)');
    expect(grant?.rules).toEqual([{ methods: ['GET'], path: '/repos/acme/api/**' }]);
  });

  it('writes nothing and calls nothing when the access is invalid', async () => {
    const token = await seedService(world.app.deps);
    const before = world.calls.length;
    const res = await adminPost(world.app, session(), '/admin/access', {
      consumer_id: 'new',
      token_id: token,
      'new.type': 'github-actions',
      'new.github_org': `acme (${OWNER_ID})`,
      'new.github-actions.repository': 'acme/api (89012345)',
      'new.github-actions.context': 'environment',
      'new.github-actions.environment': 'prod-*',
      op: 'read-repo',
      expires: 'never',
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('href="#f-new-github-actions-environment"');
    expect(html).toContain('value="acme (4242)"');
    expect(world.calls.length).toBe(before);
    expect(await auditActions()).toEqual(['service.create']);
  });
});
