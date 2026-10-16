// Service consumer pages through the real app: RBAC, the derived add form, tenants, trust
// settings with the confirm-up-front checkbox, toggle with Undo, the cascade delete, escaping.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCallerProvider } from '../../src/admin/ops/caller-providers';
import { getCallerProvider } from '../../src/db/caller-providers';
import { listGrants } from '../../src/db/grants';
import { adminGet, adminPost } from '../helpers/admin-auth';
import {
  auditActions,
  BUILDKITE_ISSUER,
  type ConsumersWorld,
  consumersWorld,
  idFromLocation,
  labels,
  lastAudit,
  locationOf,
  seedLabel,
} from '../helpers/consumers';
import {
  ACTOR,
  GITHUB_ISSUER,
  OWNER_ID,
  seedGithubProvider,
  seedGrant,
  seedService,
} from '../unit/admin/ops/helpers';

const ENTERPRISE_ISSUER = `${GITHUB_ISSUER}/acme-corp`;

let world: ConsumersWorld;

beforeEach(async () => {
  world = await consumersWorld(
    { [ENTERPRISE_ISSUER]: `${ENTERPRISE_ISSUER}/.well-known/jwks` },
    { id_token_signing_alg_values_supported: ['ES256', 'none', 'RS256', 'HS256'] },
  );
});

const admin = () => world.sessions.admin;
const viewer = () => world.sessions.viewer;

describe('consumers: viewer and token manager', () => {
  it('can read the list and the page but not add, change, toggle or delete', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const before = await auditActions();
    for (const session of [viewer(), world.sessions.token_manager]) {
      const list = await (await adminGet(world.app, session, '/admin/consumers')).text();
      expect(list).toContain(provider.name);
      expect(list).not.toContain('Add a consumer');
      const page = await (
        await adminGet(world.app, session, `/admin/consumers/${provider.id}`)
      ).text();
      expect(page).toContain(provider.audience);
      expect(page).not.toContain('Save trust settings');
      expect(page).not.toContain('Give access to a token');
      expect((await adminGet(world.app, session, '/admin/consumers/new')).status).toBe(403);
      for (const path of [
        '/admin/consumers',
        `/admin/consumers/${provider.id}`,
        `/admin/consumers/${provider.id}/tenants`,
        `/admin/consumers/${provider.id}/toggle`,
        `/admin/consumers/${provider.id}/delete`,
      ]) {
        const res = await adminPost(world.app, session, path, {
          type: 'github-actions',
          github_org: 'acme (4242)',
          intent: 'add',
          tenant: 'x (1)',
          enabled: '0',
          confirm: '1',
        });
        expect(res.status, path).toBe(403);
      }
    }
    expect(await auditActions()).toEqual(before);
  });

  it('shows the empty state with who to ask', async () => {
    const html = await (await adminGet(world.app, viewer(), '/admin/consumers')).text();
    expect(html).toContain('No consumers yet.');
    expect(html).toContain('Ask an access manager');
  });
});

describe('consumers: add', () => {
  it('renders the type cards and only the inputs that cannot be derived', async () => {
    const html = await (
      await adminGet(world.app, admin(), '/admin/consumers/new?type=gitlab-ci')
    ).text();
    for (const type of ['github-actions', 'gitlab-ci', 'generic']) {
      expect(html).toContain(`name="type" value="${type}"`);
    }
    expect(html).toMatch(/name="type" value="gitlab-ci" checked/);
    expect(html).not.toContain('name="audience"');
    expect(html).not.toContain('name="name"');
    expect(html).toContain('placeholder="acme (1234567), acme-labs (7654321)"');
    expect(html).toContain(`gh api orgs/acme --jq &#39;&quot;\\(.login) (\\(.id))&quot;&#39;`);
  });

  it('creates a GitHub consumer with a derived name and labels, one audit row, and shows the snippet', async () => {
    const res = await adminPost(world.app, admin(), '/admin/consumers', {
      type: 'github-actions',
      github_org: `acme (${OWNER_ID}), acme-labs (7654321)`,
    });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toMatch(/^\/admin\/consumers\/cpr_[0-9A-Z]{26}\?notice=created$/);
    expect(await auditActions()).toEqual(['caller_provider.create']);
    const id = idFromLocation(locationOf(res));
    const stored = await getCallerProvider(env.DB, id);
    expect(stored).toMatchObject({
      name: 'GitHub Actions (acme, acme-labs)',
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID, '7654321'] }],
      allowed_algs: ['RS256'],
    });
    expect(await labels(id)).toEqual([
      { claim: 'repository_owner_id', value: OWNER_ID, label: 'acme' },
      { claim: 'repository_owner_id', value: '7654321', label: 'acme-labs' },
    ]);
    const html = await (await adminGet(world.app, admin(), locationOf(res))).text();
    expect(html).toContain('Consumer created. Add the snippet below');
    expect(html).toContain('uses: 2fd/cloudflare-tokengate/actions/get-token@main');
    expect(html).toContain(`with: { audience: ${stored?.audience}, url: https://gw.test }`);
    expect(html).toContain('outputs.proxy-base }}/&lt;token-slug&gt;/&lt;path&gt;');
    expect(html).toContain('acme (4242)');
  });

  it('goes straight to the access form when a token exists', async () => {
    await seedService(world.app.deps);
    const res = await adminPost(world.app, admin(), '/admin/consumers', {
      type: 'github-actions',
      github_org: `acme (${OWNER_ID})`,
    });
    expect(locationOf(res)).toMatch(
      /^\/admin\/access\/new\?consumer=cpr_[0-9A-Z]{26}&notice=consumer_created$/,
    );
    const html = await (await adminGet(world.app, admin(), locationOf(res))).text();
    expect(html).toContain('Consumer GitHub Actions (acme) created.');
  });

  it('re-renders with field errors and the typed values, writing nothing and calling nothing', async () => {
    const res = await adminPost(world.app, admin(), '/admin/consumers', {
      type: 'github-actions',
      github_org: 'acme',
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('<title>Error: Add a service consumer');
    expect(html).toContain('href="#f-github_org"');
    expect(html).toContain('id="f-github_org-error"');
    expect(html).toContain('Enter each organization as name (ID), for example acme (1234567).');
    expect(html).toContain('value="acme"');
    expect(await auditActions()).toEqual([]);
    expect(world.calls).toEqual([]);
  });

  it('creates a GitLab consumer for gitlab.com and a self-managed one', async () => {
    const com = await adminPost(world.app, admin(), '/admin/consumers', {
      type: 'gitlab-ci',
      gitlab_group: 'acme-group (5678901)',
    });
    expect(com.status).toBe(303);
    const stored = await getCallerProvider(env.DB, idFromLocation(locationOf(com)));
    expect(stored).toMatchObject({
      name: 'GitLab (acme-group)',
      issuer: 'https://gitlab.com',
      tenant_pin: [{ claim: 'namespace_id', match: 'exact', values: ['5678901'] }],
    });
    const selfManaged = await adminPost(world.app, admin(), '/admin/consumers', {
      type: 'gitlab-ci',
      gitlab_group: 'platform (11)',
      gitlab_url: 'https://gitlab.example.com/',
    });
    // Discovery for the self-managed instance fails on the fake network: nothing is written.
    expect(selfManaged.status).toBe(422);
    const html = await selfManaged.text();
    expect(html).toContain('href="#f-gitlab_url"');
    expect(await auditActions()).toEqual(['caller_provider.create']);
  });

  it('creates a generic consumer: the issuer preset gives the anchor, discovery the algorithms', async () => {
    const res = await adminPost(world.app, admin(), '/admin/consumers', {
      type: 'generic',
      generic_issuer: BUILDKITE_ISSUER,
      generic_pin_value: 'org-uuid',
    });
    expect(res.status).toBe(303);
    const stored = await getCallerProvider(env.DB, idFromLocation(locationOf(res)));
    expect(stored).toMatchObject({
      name: 'agent.buildkite.com',
      anchor_claims: ['pipeline_id'],
      tenant_pin: [{ claim: 'organization_id', match: 'exact', values: ['org-uuid'] }],
      // Discovery listed ES256, none, RS256 and HS256: only the I-JWT-1 algorithms are kept.
      allowed_algs: ['RS256', 'ES256'],
      jwks_uri: `${BUILDKITE_ISSUER}/.well-known/jwks`,
    });
  });

  it('asks for the pin value next to its field when only the claim is given', async () => {
    const res = await adminPost(world.app, admin(), '/admin/consumers', {
      type: 'generic',
      generic_issuer: BUILDKITE_ISSUER,
      generic_pin_claim: 'organization_id',
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('id="f-generic_pin_value-error"');
    expect(html).toContain('Enter the value of organization_id.');
  });

  it('names another consumer of the same generic issuer', async () => {
    await createCallerProvider(world.app.deps, ACTOR, {
      profile: 'generic',
      issuer: BUILDKITE_ISSUER,
      jwks_uri: `${BUILDKITE_ISSUER}/keys`,
      anchor_claims: ['pipeline_id'],
    });
    const res = await adminPost(world.app, admin(), '/admin/consumers', {
      type: 'generic',
      generic_issuer: BUILDKITE_ISSUER,
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Another consumer already uses this issuer');
  });
});

describe('consumers: page', () => {
  it('renames, escaping the name everywhere', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    await seedService(world.app.deps);
    const res = await adminPost(world.app, admin(), `/admin/consumers/${provider.id}`, {
      intent: 'rename',
      name: '<script>alert(1)</script>',
      expected_updated_at: String(provider.updated_at),
    });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe(`/admin/consumers/${provider.id}?notice=renamed`);
    for (const path of ['/admin/consumers', `/admin/consumers/${provider.id}`, '/admin/access']) {
      const html = await (await adminGet(world.app, admin(), path)).text();
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
  });

  it('refuses a rename from a page opened before another change', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const res = await adminPost(world.app, admin(), `/admin/consumers/${provider.id}`, {
      intent: 'rename',
      name: 'Other',
      expected_updated_at: String(provider.updated_at - 1),
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('changed by someone else');
  });

  it('adds organizations as a list and re-derives the name', async () => {
    const created = await adminPost(world.app, admin(), '/admin/consumers', {
      type: 'github-actions',
      github_org: `acme (${OWNER_ID})`,
    });
    const id = idFromLocation(locationOf(created));
    const res = await adminPost(world.app, admin(), `/admin/consumers/${id}/tenants`, {
      intent: 'add',
      tenant: 'acme-labs (7654321), acme-ops (7654322)',
    });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe(`/admin/consumers/${id}?notice=tenant_added#tenants`);
    expect(await getCallerProvider(env.DB, id)).toMatchObject({
      name: 'GitHub Actions (acme, acme-labs, acme-ops)',
      tenant_pin: [
        { claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID, '7654321', '7654322'] },
      ],
    });
    expect(await auditActions()).toEqual(['caller_provider.create', 'caller_provider.update']);
    const again = await adminPost(world.app, admin(), `/admin/consumers/${id}/tenants`, {
      intent: 'add',
      tenant: 'acme-labs (7654321)',
    });
    expect(again.status).toBe(422);
    expect(await again.text()).toContain('acme-labs (7654321) is already allowed.');
  });

  it('blocks removing an organization that enabled accesses use, and lists disabled ones', async () => {
    const created = await adminPost(world.app, admin(), '/admin/consumers', {
      type: 'github-actions',
      github_org: `acme (${OWNER_ID}), other (99)`,
    });
    const id = idFromLocation(locationOf(created));
    const provider = await getCallerProvider(env.DB, id);
    if (!provider) throw new Error('missing');
    const serviceId = await seedService(world.app.deps);
    await seedGrant(world.app.deps, id, serviceId, 'deploy <b>x</b>');
    const html = await (await adminGet(world.app, admin(), `/admin/consumers/${id}`)).text();
    expect(html).toMatch(/name="remove" value="4242" class="secondary" disabled/);
    expect(html).toContain('Used by 1 enabled access');
    expect(html).toContain('deploy &lt;b&gt;x&lt;/b&gt;');
    const blocked = await adminPost(world.app, admin(), `/admin/consumers/${id}/tenants`, {
      intent: 'remove',
      remove: OWNER_ID,
    });
    expect(blocked.status).toBe(422);
    const removed = await adminPost(world.app, admin(), `/admin/consumers/${id}/tenants`, {
      intent: 'remove',
      remove: '99',
    });
    expect(removed.status).toBe(303);
    expect((await getCallerProvider(env.DB, id))?.name).toBe('GitHub Actions (acme)');
    const last = await adminPost(world.app, admin(), `/admin/consumers/${id}/tenants`, {
      intent: 'remove',
      remove: OWNER_ID,
    });
    expect(last.status).toBe(422);
  });

  it('shows the trust confirmation up front and needs it only for an issuer change', async () => {
    const created = await createCallerProvider(world.app.deps, ACTOR, {
      profile: 'github-actions',
      issuer: GITHUB_ISSUER,
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
    });
    if (!created.ok) throw new Error(created.errors.join('; '));
    const provider = created.callerProvider;
    await env.DB.prepare('UPDATE caller_providers SET issuer = ? WHERE id = ?')
      .bind(`${GITHUB_ISSUER}/old-slug`, provider.id)
      .run();
    const fresh = await getCallerProvider(env.DB, provider.id);
    if (!fresh) throw new Error('missing');
    const serviceId = await seedService(world.app.deps);
    await seedGrant(world.app.deps, provider.id, serviceId, 'deploy <b>grant</b>');
    const page = await (
      await adminGet(world.app, admin(), `/admin/consumers/${provider.id}?open=trust`)
    ).text();
    expect(page).toContain('name="confirm_trust_change"');
    expect(page).toContain('deploy &lt;b&gt;grant&lt;/b&gt;');
    expect(page).toMatch(/<details id="trust" open/);
    const fields = {
      intent: 'trust',
      issuer: ENTERPRISE_ISSUER,
      audience: fresh.audience,
      allowed_algs: 'RS256',
      max_token_age_seconds: '600',
      enterprise_id: '',
      expected_updated_at: String(fresh.updated_at),
    };
    const before = await auditActions();
    const first = await adminPost(world.app, admin(), `/admin/consumers/${provider.id}`, fields);
    expect(first.status).toBe(422);
    expect(await first.text()).toContain('href="#f-confirm_trust_change"');
    expect(await auditActions()).toEqual(before);
    const second = await adminPost(world.app, admin(), `/admin/consumers/${provider.id}`, {
      ...fields,
      confirm_trust_change: '1',
    });
    expect(second.status).toBe(303);
    expect((await getCallerProvider(env.DB, provider.id))?.issuer).toBe(ENTERPRISE_ISSUER);
    // A change that does not touch the issuer needs no tick.
    const age = await adminPost(world.app, admin(), `/admin/consumers/${provider.id}`, {
      ...fields,
      issuer: ENTERPRISE_ISSUER,
      max_token_age_seconds: '300',
      expected_updated_at: String((await getCallerProvider(env.DB, provider.id))?.updated_at),
    });
    expect(age.status).toBe(303);
  });

  it('saves the pin rows of a generic consumer', async () => {
    const created = await createCallerProvider(world.app.deps, ACTOR, {
      profile: 'generic',
      issuer: 'https://idp.acme.example',
      jwks_uri: 'https://idp.acme.example/keys',
      anchor_claims: ['sub'],
    });
    if (!created.ok) throw new Error(created.errors.join('; '));
    const provider = created.callerProvider;
    const page = await (
      await adminGet(world.app, admin(), `/admin/consumers/${provider.id}`)
    ).text();
    expect(page).toContain('<strong>Risk:</strong> no tenant pin');
    const res = await adminPost(world.app, admin(), `/admin/consumers/${provider.id}`, {
      intent: 'trust',
      pin_rows: '1',
      'pin.0.claim': 'org_id',
      'pin.0.value': '77, "a,b"',
      expected_updated_at: String(provider.updated_at),
    });
    expect(res.status).toBe(303);
    expect((await getCallerProvider(env.DB, provider.id))?.tenant_pin).toEqual([
      { claim: 'org_id', match: 'exact', values: ['77', 'a,b'] },
    ]);
    const bad = await adminPost(world.app, admin(), `/admin/consumers/${provider.id}`, {
      intent: 'trust',
      pin_rows: '1',
      'pin.0.claim': 'org_id',
      'pin.0.value': '"open',
    });
    expect(bad.status).toBe(422);
    expect(await bad.text()).toContain('id="f-pin-0-value-error"');
    // Rows are ANDed: a second row on the same claim is refused, not saved as an intersection.
    const twice = await adminPost(world.app, admin(), `/admin/consumers/${provider.id}`, {
      intent: 'trust',
      pin_rows: '1',
      'pin.0.claim': 'org_id',
      'pin.0.value': '77',
      'pin.1.claim': 'org_id',
      'pin.1.value': '78',
    });
    expect(twice.status).toBe(422);
    expect(await twice.text()).toContain('Put every value of org_id in one row');
    // The trust fields suggest the anchor and pin claims of the presets.
    expect(page).toMatch(/<option value="pipeline_id">/);
    expect(page).toMatch(/<option value="organization_id">/);
  });

  it('shows no trust confirmation where neither the issuer nor the keys can change', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const serviceId = await seedService(world.app.deps);
    await seedGrant(world.app.deps, provider.id, serviceId);
    const page = await (
      await adminGet(world.app, admin(), `/admin/consumers/${provider.id}?open=trust`)
    ).text();
    expect(page).toMatch(/<details id="trust" open/);
    expect(page).not.toContain('name="confirm_trust_change"');
  });

  it('disables with an Undo, then enables again', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const off = await adminPost(world.app, admin(), `/admin/consumers/${provider.id}/toggle`, {
      enabled: '0',
      _return: 'detail',
    });
    expect(off.status).toBe(303);
    expect(locationOf(off)).toBe(`/admin/consumers/${provider.id}?notice=disabled`);
    const html = await (await adminGet(world.app, admin(), locationOf(off))).text();
    expect(html).toContain('Enable again');
    const on = await adminPost(world.app, admin(), `/admin/consumers/${provider.id}/toggle`, {
      enabled: '1',
      _return: 'detail',
    });
    expect(on.status).toBe(303);
    expect((await getCallerProvider(env.DB, provider.id))?.enabled).toBe(true);
    expect((await auditActions()).slice(-2)).toEqual([
      'caller_provider.disable',
      'caller_provider.enable',
    ]);
    const after = await (
      await adminGet(world.app, admin(), `/admin/consumers/${provider.id}?notice=disabled`)
    ).text();
    expect(after).not.toContain('Enable again');
  });

  it('lists accesses per repository with chips and a "+" to give the repository another token', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    await seedLabel(provider.id, 'repository_id', '987654321', 'acme/api');
    const serviceId = await seedService(world.app.deps);
    const grant = await seedGrant(world.app.deps, provider.id, serviceId);
    const html = await (
      await adminGet(world.app, admin(), `/admin/consumers/${provider.id}`)
    ).text();
    expect(html).toContain('Tokens this consumer can use (1)');
    expect(html).toContain('acme/api<span class="secondary-text"> (987654321)</span>');
    expect(html).toContain(`href="/admin/access/${grant.id}"`);
    expect(html).toContain(
      `/admin/access/new?consumer=${provider.id}&amp;repository=987654321&amp;copy=${grant.id}`,
    );
    expect(html).toContain('outputs.proxy-base }}/github/&lt;path&gt;');
  });
});

describe('consumers: delete', () => {
  it('needs the confirmation, then deletes a consumer without accesses', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const page = await (
      await adminGet(world.app, admin(), `/admin/consumers/${provider.id}`)
    ).text();
    expect(page).toContain(`action="/admin/consumers/${provider.id}/delete"`);
    expect(page).toContain('command="show-modal"');
    const unconfirmed = await adminPost(
      world.app,
      admin(),
      `/admin/consumers/${provider.id}/delete`,
    );
    expect(unconfirmed.status).toBe(400);
    expect(await getCallerProvider(env.DB, provider.id)).not.toBeNull();
    const deleted = await adminPost(world.app, admin(), `/admin/consumers/${provider.id}/delete`, {
      confirm: '1',
    });
    expect(deleted.status).toBe(303);
    expect(locationOf(deleted)).toBe('/admin/consumers?notice=deleted');
    expect(await getCallerProvider(env.DB, provider.id)).toBeNull();
  });

  it('refuses to delete accesses that the confirmation did not list', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const serviceId = await seedService(world.app.deps);
    await seedGrant(world.app.deps, provider.id, serviceId);
    const plain = await adminPost(world.app, admin(), `/admin/consumers/${provider.id}/delete`, {
      confirm: '1',
    });
    expect(plain.status).toBe(409);
    expect(await plain.text()).toContain('Delete dialog');
    expect(await getCallerProvider(env.DB, provider.id)).not.toBeNull();
    expect(await listGrants(env.DB, { caller_provider_id: provider.id })).toHaveLength(1);
    expect(await lastAudit('caller_provider.delete')).toBeNull();
  });

  it('answers 404 for unknown ids', async () => {
    expect((await adminGet(world.app, admin(), '/admin/consumers/cpr_missing')).status).toBe(404);
    const res = await adminPost(world.app, admin(), '/admin/consumers/cpr_missing', {
      intent: 'rename',
      name: 'x',
    });
    expect(res.status).toBe(404);
  });
});

describe('consumers: review findings', () => {
  it('quotes an audience that YAML would misread in the copy-ready snippet', async () => {
    const created = await createCallerProvider(world.app.deps, ACTOR, {
      name: 'Odd audience',
      profile: 'github-actions',
      audience: 'tokengate,odd}#audience',
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
    });
    if (!created.ok) throw new Error(created.errors.join('; '));
    const html = await (
      await adminGet(world.app, admin(), `/admin/consumers/${created.callerProvider.id}`)
    ).text();
    expect(html).toContain(
      'with: { audience: &quot;tokengate,odd}#audience&quot;, url: https://gw.test }',
    );
  });

  it('refuses mutations without the CSRF token (I-CSRF-1)', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const before = await auditActions();
    for (const path of [
      '/admin/consumers',
      `/admin/consumers/${provider.id}`,
      `/admin/consumers/${provider.id}/tenants`,
      `/admin/consumers/${provider.id}/toggle`,
      `/admin/consumers/${provider.id}/delete`,
    ]) {
      const res = await adminPost(
        world.app,
        admin(),
        path,
        {
          type: 'github-actions',
          github_org: 'x (1)',
          intent: 'add',
          tenant: 'x (1)',
          enabled: '0',
          confirm: '1',
        },
        { csrf: null },
      );
      expect(res.status, path).toBe(403);
    }
    expect(await auditActions()).toEqual(before);
    expect(await getCallerProvider(env.DB, provider.id)).not.toBeNull();
  });
});
