// Credential access rule pages through the real app: RBAC, the derived add form, tenants, trust
// settings with the confirm-up-front checkbox, toggle with Undo, the cascade delete, escaping.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCredentialAccessRule } from '../../src/admin/ops/credential-access-rules';
import { getCredentialAccessRule } from '../../src/db/credential-access-rules';
import { listIssuerAccessRules } from '../../src/db/issuer_access_rules';
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
import { testCredentialId } from '../unit/admin/ops/helpers';
import {
  ACTOR,
  GITHUB_ISSUER,
  OWNER_ID,
  seedGithubProvider,
  seedIssuerAccessRule,
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

describe('credential access rules: viewer and access manager', () => {
  it('can read the list and the page but not add, change, toggle or delete', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const before = await auditActions();
    for (const session of [viewer(), world.sessions.access_manager]) {
      const list = await (
        await adminGet(world.app, session, '/admin/credential-access-rules')
      ).text();
      expect(list).toContain(provider.name);
      expect(list).not.toContain('Add a credential access rule');
      const page = await (
        await adminGet(world.app, session, `/admin/credential-access-rules/${provider.id}`)
      ).text();
      expect(page).toContain(provider.audience);
      expect(page).not.toContain('Save trust settings');
      if (session === world.sessions.viewer) expect(page).not.toContain('Add issuer access rule');
      else expect(page).toContain('Add issuer access rule');
      expect(
        (await adminGet(world.app, session, '/admin/credential-access-rules/new')).status,
      ).toBe(403);
      for (const path of [
        '/admin/credential-access-rules',
        `/admin/credential-access-rules/${provider.id}`,
        `/admin/credential-access-rules/${provider.id}/tenants`,
        `/admin/credential-access-rules/${provider.id}/toggle`,
        `/admin/credential-access-rules/${provider.id}/delete`,
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
    const html = await (
      await adminGet(world.app, viewer(), '/admin/credential-access-rules')
    ).text();
    expect(html).toContain('No credential access rules yet.');
    expect(html).toContain('Only credential managers can');
  });
});

describe('consumers: add', () => {
  it('renders the type cards and only the inputs that cannot be derived', async () => {
    const html = await (
      await adminGet(world.app, admin(), '/admin/credential-access-rules/new?type=gitlab-ci')
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
    const res = await adminPost(world.app, admin(), '/admin/credential-access-rules', {
      credential_id: await testCredentialId(world.app.deps),
      type: 'github-actions',
      github_org: `acme (${OWNER_ID}), acme-labs (7654321)`,
    });
    expect(res.status).toBe(303);
    expect(locationOf(res)).toMatch(
      /^\/admin\/credential-access-rules\/cpr_[0-9A-Z]{26}\?notice=created$/,
    );
    expect((await auditActions()).filter((action) => action !== 'service.create')).toEqual([
      'credential_access_rule.create',
    ]);
    const id = idFromLocation(locationOf(res));
    const stored = await getCredentialAccessRule(env.DB, id);
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
    expect(html).toContain('Credential access rule created. Add the snippet below');
    expect(html).toContain('uses: 2fd/cloudflare-tokengate/actions/get-token@main');
    expect(html).toContain(`with: { audience: ${stored?.audience}, url: https://gw.test }`);
    expect(html).toContain('outputs.proxy-base }}/&lt;token-slug&gt;/&lt;path&gt;');
    expect(html).toContain('acme (4242)');
  });

  it('shows the saved boundary without requiring access-management permission', async () => {
    await seedService(world.app.deps);
    const res = await adminPost(world.app, admin(), '/admin/credential-access-rules', {
      credential_id: await testCredentialId(world.app.deps),
      type: 'github-actions',
      github_org: `acme (${OWNER_ID})`,
    });
    expect(locationOf(res)).toMatch(
      /^\/admin\/credential-access-rules\/cpr_[0-9A-Z]{26}\?notice=created$/,
    );
    const html = await (await adminGet(world.app, admin(), locationOf(res))).text();
    expect(html).toContain('Credential access rule created.');
  });

  it('re-renders with field errors and the typed values, writing nothing and calling nothing', async () => {
    const res = await adminPost(world.app, admin(), '/admin/credential-access-rules', {
      credential_id: await testCredentialId(world.app.deps),
      type: 'github-actions',
      github_org: 'acme',
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('<title>Error: Add a credential access rule');
    expect(html).toContain('href="#f-github_org"');
    expect(html).toContain('id="f-github_org-error"');
    expect(html).toContain('Enter each organization as name (ID), for example acme (1234567).');
    expect(html).toContain('value="acme"');
    expect((await auditActions()).filter((action) => action !== 'service.create')).toEqual([]);
    expect(world.calls).toEqual([]);
  });

  it('creates a GitLab consumer for gitlab.com and a self-managed one', async () => {
    const com = await adminPost(world.app, admin(), '/admin/credential-access-rules', {
      credential_id: await testCredentialId(world.app.deps),
      type: 'gitlab-ci',
      gitlab_group: 'acme-group (5678901)',
    });
    expect(com.status).toBe(303);
    const stored = await getCredentialAccessRule(env.DB, idFromLocation(locationOf(com)));
    expect(stored).toMatchObject({
      name: 'GitLab (acme-group)',
      issuer: 'https://gitlab.com',
      tenant_pin: [{ claim: 'namespace_id', match: 'exact', values: ['5678901'] }],
    });
    const selfManaged = await adminPost(world.app, admin(), '/admin/credential-access-rules', {
      credential_id: await testCredentialId(world.app.deps),
      type: 'gitlab-ci',
      gitlab_group: 'platform (11)',
      gitlab_url: 'https://gitlab.example.com/',
    });
    // Discovery for the self-managed instance fails on the fake network: nothing is written.
    expect(selfManaged.status).toBe(422);
    const html = await selfManaged.text();
    expect(html).toContain('href="#f-gitlab_url"');
    expect((await auditActions()).filter((action) => action !== 'service.create')).toEqual([
      'credential_access_rule.create',
    ]);
  });

  it('creates a generic consumer: the issuer preset gives the anchor, discovery the algorithms', async () => {
    const res = await adminPost(world.app, admin(), '/admin/credential-access-rules', {
      credential_id: await testCredentialId(world.app.deps),
      type: 'generic',
      generic_issuer: BUILDKITE_ISSUER,
      generic_pin_value: 'org-uuid',
    });
    expect(res.status).toBe(303);
    const stored = await getCredentialAccessRule(env.DB, idFromLocation(locationOf(res)));
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
    const res = await adminPost(world.app, admin(), '/admin/credential-access-rules', {
      credential_id: await testCredentialId(world.app.deps),
      type: 'generic',
      generic_issuer: BUILDKITE_ISSUER,
      generic_pin_claim: 'organization_id',
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('id="f-generic_pin_value-error"');
    expect(html).toContain('Enter the value of organization_id.');
  });

  it('names another credential access rule of the same generic issuer', async () => {
    await createCredentialAccessRule(world.app.deps, ACTOR, {
      credential_id: await testCredentialId(world.app.deps),
      profile: 'generic',
      issuer: BUILDKITE_ISSUER,
      jwks_uri: `${BUILDKITE_ISSUER}/keys`,
      anchor_claims: ['pipeline_id'],
    });
    const res = await adminPost(world.app, admin(), '/admin/credential-access-rules', {
      credential_id: await testCredentialId(world.app.deps),
      type: 'generic',
      generic_issuer: BUILDKITE_ISSUER,
    });
    expect(res.status).toBe(303);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS n FROM credential_access_rules').first('n'),
    ).toBe(2);
  });
});

describe('consumers: page', () => {
  it('renames, escaping the name everywhere', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    await seedService(world.app.deps);
    const res = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${provider.id}`,
      {
        intent: 'rename',
        name: '<script>alert(1)</script>',
        expected_updated_at: String(provider.updated_at),
      },
    );
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe(`/admin/credential-access-rules/${provider.id}?notice=renamed`);
    for (const path of [
      '/admin/credential-access-rules',
      `/admin/credential-access-rules/${provider.id}`,
      '/admin/issuer-access-rules',
    ]) {
      const html = await (await adminGet(world.app, admin(), path)).text();
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
  });

  it('refuses a rename from a page opened before another change', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const res = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${provider.id}`,
      {
        intent: 'rename',
        name: 'Other',
        expected_updated_at: String(provider.updated_at - 1),
      },
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('changed by someone else');
  });

  it('adds organizations as a list and re-derives the name', async () => {
    const created = await adminPost(world.app, admin(), '/admin/credential-access-rules', {
      credential_id: await testCredentialId(world.app.deps),
      type: 'github-actions',
      github_org: `acme (${OWNER_ID})`,
    });
    const id = idFromLocation(locationOf(created));
    const res = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${id}/tenants`,
      {
        intent: 'add',
        tenant: 'acme-labs (7654321), acme-ops (7654322)',
      },
    );
    expect(res.status).toBe(303);
    expect(locationOf(res)).toBe(
      `/admin/credential-access-rules/${id}?notice=tenant_added#tenants`,
    );
    expect(await getCredentialAccessRule(env.DB, id)).toMatchObject({
      name: 'GitHub Actions (acme, acme-labs, acme-ops)',
      tenant_pin: [
        { claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID, '7654321', '7654322'] },
      ],
    });
    expect((await auditActions()).filter((action) => action !== 'service.create')).toEqual([
      'credential_access_rule.create',
      'credential_access_rule.update',
    ]);
    const again = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${id}/tenants`,
      {
        intent: 'add',
        tenant: 'acme-labs (7654321)',
      },
    );
    expect(again.status).toBe(422);
    expect(await again.text()).toContain('acme-labs (7654321) is already allowed.');
  });

  it('allows immediate organization revocation while keeping at least one organization', async () => {
    const created = await adminPost(world.app, admin(), '/admin/credential-access-rules', {
      credential_id: await testCredentialId(world.app.deps),
      type: 'github-actions',
      github_org: `acme (${OWNER_ID}), other (99)`,
    });
    const id = idFromLocation(locationOf(created));
    const provider = await getCredentialAccessRule(env.DB, id);
    if (!provider) throw new Error('missing');
    const serviceId = await seedService(world.app.deps);
    await seedIssuerAccessRule(world.app.deps, id, serviceId, 'deploy <b>x</b>');
    const html = await (
      await adminGet(world.app, admin(), `/admin/credential-access-rules/${id}`)
    ).text();
    expect(html).not.toMatch(/name="remove" value="4242"[^>]*disabled/);
    expect(html).toContain('Used by 1 enabled access');
    expect(html).toContain('deploy &lt;b&gt;x&lt;/b&gt;');
    const blocked = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${id}/tenants`,
      {
        intent: 'remove',
        remove: OWNER_ID,
      },
    );
    expect(blocked.status).toBe(303);
    const removed = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${id}/tenants`,
      {
        intent: 'remove',
        remove: '99',
      },
    );
    expect(removed.status).toBe(422);
    expect((await getCredentialAccessRule(env.DB, id))?.name).toBe('GitHub Actions (other)');
    const last = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${id}/tenants`,
      {
        intent: 'remove',
        remove: OWNER_ID,
      },
    );
    expect(last.status).toBe(422);
  });

  it('shows the trust confirmation up front and needs it only for an issuer change', async () => {
    const created = await createCredentialAccessRule(world.app.deps, ACTOR, {
      credential_id: await testCredentialId(world.app.deps),
      profile: 'github-actions',
      issuer: GITHUB_ISSUER,
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
    });
    if (!created.ok) throw new Error(created.errors.join('; '));
    const provider = created.credentialAccessRule;
    await env.DB.prepare('UPDATE credential_access_rules SET issuer = ? WHERE id = ?')
      .bind(`${GITHUB_ISSUER}/old-slug`, provider.id)
      .run();
    const fresh = await getCredentialAccessRule(env.DB, provider.id);
    if (!fresh) throw new Error('missing');
    const serviceId = await seedService(world.app.deps);
    await seedIssuerAccessRule(world.app.deps, provider.id, serviceId, 'deploy <b>grant</b>');
    const page = await (
      await adminGet(world.app, admin(), `/admin/credential-access-rules/${provider.id}?open=trust`)
    ).text();
    expect(page).toContain('name="confirm_trust_change"');
    expect(page).toContain('deploy &lt;b&gt;grant&lt;/b&gt;');
    expect(page).toMatch(/<details class="disc" id="trust" open/);
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
    const first = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${provider.id}`,
      fields,
    );
    expect(first.status).toBe(422);
    expect(await first.text()).toContain('href="#f-confirm_trust_change"');
    expect(await auditActions()).toEqual(before);
    const second = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${provider.id}`,
      {
        ...fields,
        confirm_trust_change: '1',
      },
    );
    expect(second.status).toBe(303);
    expect((await getCredentialAccessRule(env.DB, provider.id))?.issuer).toBe(ENTERPRISE_ISSUER);
    // A change that does not touch the issuer needs no tick.
    const age = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${provider.id}`,
      {
        ...fields,
        issuer: ENTERPRISE_ISSUER,
        max_token_age_seconds: '300',
        expected_updated_at: String(
          (await getCredentialAccessRule(env.DB, provider.id))?.updated_at,
        ),
      },
    );
    expect(age.status).toBe(303);
  });

  it('saves the pin rows of a generic consumer', async () => {
    const created = await createCredentialAccessRule(world.app.deps, ACTOR, {
      credential_id: await testCredentialId(world.app.deps),
      profile: 'generic',
      issuer: 'https://idp.acme.example',
      jwks_uri: 'https://idp.acme.example/keys',
      anchor_claims: ['sub'],
    });
    if (!created.ok) throw new Error(created.errors.join('; '));
    const provider = created.credentialAccessRule;
    const page = await (
      await adminGet(world.app, admin(), `/admin/credential-access-rules/${provider.id}`)
    ).text();
    expect(page).toContain('<b>Risk:</b> no tenant pin');
    const res = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${provider.id}`,
      {
        intent: 'trust',
        pin_rows: '1',
        'pin.0.claim': 'org_id',
        'pin.0.value': '77, "a,b"',
        expected_updated_at: String(provider.updated_at),
      },
    );
    expect(res.status).toBe(303);
    expect((await getCredentialAccessRule(env.DB, provider.id))?.tenant_pin).toEqual([
      { claim: 'org_id', match: 'exact', values: ['77', 'a,b'] },
    ]);
    const bad = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${provider.id}`,
      {
        intent: 'trust',
        pin_rows: '1',
        'pin.0.claim': 'org_id',
        'pin.0.value': '"open',
      },
    );
    expect(bad.status).toBe(422);
    expect(await bad.text()).toContain('id="f-pin-0-value-error"');
    // Rows are ANDed: a second row on the same claim is refused, not saved as an intersection.
    const twice = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${provider.id}`,
      {
        intent: 'trust',
        pin_rows: '1',
        'pin.0.claim': 'org_id',
        'pin.0.value': '77',
        'pin.1.claim': 'org_id',
        'pin.1.value': '78',
      },
    );
    expect(twice.status).toBe(422);
    expect(await twice.text()).toContain('Put every value of org_id in one row');
    // The trust fields suggest the anchor and pin claims of the presets.
    expect(page).toMatch(/<option value="pipeline_id">/);
    expect(page).toMatch(/<option value="organization_id">/);
  });

  it('shows no trust confirmation where neither the issuer nor the keys can change', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const serviceId = await seedService(world.app.deps);
    await seedIssuerAccessRule(world.app.deps, provider.id, serviceId);
    const page = await (
      await adminGet(world.app, admin(), `/admin/credential-access-rules/${provider.id}?open=trust`)
    ).text();
    expect(page).toMatch(/<details class="disc" id="trust" open/);
    expect(page).not.toContain('name="confirm_trust_change"');
  });

  it('disables with an Undo, then enables again', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const off = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${provider.id}/toggle`,
      {
        enabled: '0',
        _return: 'detail',
      },
    );
    expect(off.status).toBe(303);
    expect(locationOf(off)).toBe(`/admin/credential-access-rules/${provider.id}?notice=disabled`);
    const html = await (await adminGet(world.app, admin(), locationOf(off))).text();
    expect(html).toContain('Enable again');
    const on = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${provider.id}/toggle`,
      {
        enabled: '1',
        _return: 'detail',
      },
    );
    expect(on.status).toBe(303);
    expect((await getCredentialAccessRule(env.DB, provider.id))?.enabled).toBe(true);
    expect((await auditActions()).slice(-2)).toEqual([
      'credential_access_rule.disable',
      'credential_access_rule.enable',
    ]);
    const after = await (
      await adminGet(
        world.app,
        admin(),
        `/admin/credential-access-rules/${provider.id}?notice=disabled`,
      )
    ).text();
    expect(after).not.toContain('Enable again');
  });

  it('lists accesses per repository with chips and a "+" to give the repository another token', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    await seedLabel(provider.id, 'repository_id', '987654321', 'acme/api');
    const serviceId = await seedService(world.app.deps);
    const grant = await seedIssuerAccessRule(world.app.deps, provider.id, serviceId);
    const html = await (
      await adminGet(world.app, admin(), `/admin/credential-access-rules/${provider.id}`)
    ).text();
    expect(html).toContain('Accesses by repository<span class="count">1</span>');
    expect(html).toContain(
      '<span class="mono">acme/api</span> <span class="meta">(987654321)</span>',
    );
    expect(html).toContain(`href="/admin/issuer-access-rules/${grant.id}"`);
    expect(html).toContain(
      `/admin/issuer-access-rules/new?consumer=${provider.id}&amp;repository=987654321&amp;copy=${grant.id}`,
    );
    expect(html).toContain('outputs.proxy-base }}/github/&lt;path&gt;');
  });
});

describe('consumers: design D pages', () => {
  it('lists consumers with their token chips, the row action for writers only, and one primary', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const serviceId = await seedService(world.app.deps);
    await seedIssuerAccessRule(world.app.deps, provider.id, serviceId);
    const html = await (
      await adminGet(world.app, admin(), '/admin/credential-access-rules')
    ).text();
    expect(html).toContain('<h1>Credential access rules<span class="count">1</span></h1>');
    expect(html).toContain('<table class="tbl stackable" id="consumers">');
    expect(html).toContain(
      `href="/admin/issuer-access-rules?consumer=${provider.id}&amp;token=${serviceId}"`,
    );
    expect(html).toMatch(/<span class="vh">: 1 access(, [a-z ]+)*\. Open\.<\/span>/);
    expect(html).toContain(
      `href="/admin/issuer-access-rules/new?consumer=${provider.id}">Give access<span class="vh"> to ${provider.name}</span>`,
    );
    expect(html.match(/class="btn primary/g)).toHaveLength(1);
    const viewerHtml = await (
      await adminGet(world.app, viewer(), '/admin/credential-access-rules')
    ).text();
    expect(viewerHtml).not.toContain('Give access<span class="vh">');
    expect(viewerHtml).not.toContain('class="btn primary');
  });

  it('puts the primary in the empty state when there is no consumer yet', async () => {
    await seedService(world.app.deps);
    const html = await (
      await adminGet(world.app, admin(), '/admin/credential-access-rules')
    ).text();
    expect(html).toContain('No credential access rules yet.');
    expect(html.match(/class="btn primary/g)).toHaveLength(1);
    expect(html).toContain('href="/admin/credential-access-rules/new"');
  });

  it('shows the credential access rule header: identity, relation line and the rail facts', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    await seedLabel(provider.id, 'repository_id', '987654321', 'acme/api');
    const serviceId = await seedService(world.app.deps);
    await seedIssuerAccessRule(world.app.deps, provider.id, serviceId);
    const html = await (
      await adminGet(world.app, admin(), `/admin/credential-access-rules/${provider.id}`)
    ).text();
    expect(html).toContain('<nav class="crumbs" aria-label="Breadcrumb">');
    expect(html).toMatch(/<h1>GitHub Actions <span class="badge ok">/);
    expect(html).toContain(
      '<p class="relline">Can use <a href="/admin/issuer-access-rules?consumer=',
    );
    expect(html).toContain('through <b>1 access</b> from <b>1 repository</b>');
    expect(html).toContain('<aside class="rail" aria-label="Credential access rule">');
    expect(html).toContain('<dialog class="dlg" id="dlg-rename-consumer"');
    expect(html).toContain('command="show-modal" commandfor="dlg-rename-consumer"');
    // Viewers get the read-only trust settings and no dialogs.
    const viewerHtml = await (
      await adminGet(world.app, viewer(), `/admin/credential-access-rules/${provider.id}`)
    ).text();
    expect(viewerHtml).toContain('<section class="tray" id="trust" aria-labelledby="trust-h">');
    expect(viewerHtml).not.toContain('<dialog');
  });

  it('opens the rename dialog on a rename error and keeps the typed name', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const res = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${provider.id}`,
      {
        intent: 'rename',
        name: '',
        expected_updated_at: String(provider.updated_at),
      },
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toMatch(/<dialog class="dlg" id="dlg-rename-consumer"[^>]*open/);
  });

  it('derives the rest of the credential access rule: the add page rail lists what is set for you', async () => {
    const html = await (
      await adminGet(world.app, admin(), '/admin/credential-access-rules/new')
    ).text();
    expect(html).toContain(
      '<form class="lform form-layout" method="post" action="/admin/credential-access-rules" id="f-add">',
    );
    expect(html).toContain('<fieldset class="field sf1 con-types" id="f-type"');
    expect(html).toContain('id="ad-set-h">Set for you</h2>');
    expect(html).toContain('<div class="rv1 con-fields" data-o="1">');
    expect(html).toContain('Presets: Buildkite, CircleCI');
  });
});

describe('consumers: delete', () => {
  it('needs the confirmation, then deletes a credential access rule without accesses', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const page = await (
      await adminGet(world.app, admin(), `/admin/credential-access-rules/${provider.id}`)
    ).text();
    expect(page).toContain(`action="/admin/credential-access-rules/${provider.id}/delete"`);
    expect(page).toContain('command="show-modal"');
    const unconfirmed = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${provider.id}/delete`,
    );
    expect(unconfirmed.status).toBe(400);
    expect(await getCredentialAccessRule(env.DB, provider.id)).not.toBeNull();
    const deleted = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${provider.id}/delete`,
      {
        confirm: '1',
      },
    );
    expect(deleted.status).toBe(303);
    expect(locationOf(deleted)).toBe('/admin/credential-access-rules?notice=deleted');
    expect(await getCredentialAccessRule(env.DB, provider.id)).toBeNull();
  });

  it('refuses to delete accesses that the confirmation did not list', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const serviceId = await seedService(world.app.deps);
    await seedIssuerAccessRule(world.app.deps, provider.id, serviceId);
    const plain = await adminPost(
      world.app,
      admin(),
      `/admin/credential-access-rules/${provider.id}/delete`,
      {
        confirm: '1',
      },
    );
    expect(plain.status).toBe(409);
    expect(await plain.text()).toContain('Delete dialog');
    expect(await getCredentialAccessRule(env.DB, provider.id)).not.toBeNull();
    expect(
      await listIssuerAccessRules(env.DB, { credential_access_rule_id: provider.id }),
    ).toHaveLength(1);
    expect(await lastAudit('credential_access_rule.delete')).toBeNull();
  });

  it('answers 404 for unknown ids', async () => {
    expect(
      (await adminGet(world.app, admin(), '/admin/credential-access-rules/cpr_missing')).status,
    ).toBe(404);
    const res = await adminPost(world.app, admin(), '/admin/credential-access-rules/cpr_missing', {
      intent: 'rename',
      name: 'x',
    });
    expect(res.status).toBe(404);
  });
});

describe('consumers: review findings', () => {
  it('quotes an audience that YAML would misread in the copy-ready snippet', async () => {
    const created = await createCredentialAccessRule(world.app.deps, ACTOR, {
      credential_id: await testCredentialId(world.app.deps),
      name: 'Odd audience',
      profile: 'github-actions',
      audience: 'tokengate,odd}#audience',
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
    });
    if (!created.ok) throw new Error(created.errors.join('; '));
    const html = await (
      await adminGet(
        world.app,
        admin(),
        `/admin/credential-access-rules/${created.credentialAccessRule.id}`,
      )
    ).text();
    expect(html).toContain(
      'with: { audience: &quot;tokengate,odd}#audience&quot;, url: https://gw.test }',
    );
  });

  it('refuses mutations without the CSRF token (I-CSRF-1)', async () => {
    const provider = await seedGithubProvider(world.app.deps);
    const before = await auditActions();
    for (const path of [
      '/admin/credential-access-rules',
      `/admin/credential-access-rules/${provider.id}`,
      `/admin/credential-access-rules/${provider.id}/tenants`,
      `/admin/credential-access-rules/${provider.id}/toggle`,
      `/admin/credential-access-rules/${provider.id}/delete`,
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
    expect(await getCredentialAccessRule(env.DB, provider.id)).not.toBeNull();
  });
});
