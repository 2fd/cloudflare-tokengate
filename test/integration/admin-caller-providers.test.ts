// Caller provider admin pages through the real app: RBAC, create/edit/toggle/delete via ops,
// validation re-render, trust-change confirmation, escaping.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCallerProvider } from '../../src/admin/ops/caller-providers';
import { getCallerProvider } from '../../src/db/caller-providers';
import type { User } from '../../src/db/types';
import {
  type AdminSession,
  adminGet,
  adminPost,
  createUser,
  loginAs,
  resetControlPlane,
} from '../helpers/admin-auth';
import { createTestApp, type TestApp } from '../helpers/app';
import {
  ACTOR,
  fakeNetwork,
  GITHUB_ISSUER,
  GITHUB_JWKS,
  KEK_1,
  OWNER_ID,
  seedGithubProvider,
  seedGrant,
  seedService,
} from '../unit/admin/ops/helpers';

const ENTERPRISE_ISSUER = `${GITHUB_ISSUER}/acme`;
const ACME_ISSUER = 'https://idp.acme.example';

let app: TestApp;
let admin: AdminSession;
let viewer: AdminSession;

beforeEach(async () => {
  await resetControlPlane();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM grants'),
    env.DB.prepare('DELETE FROM services'),
    env.DB.prepare('DELETE FROM caller_providers'),
  ]);
  const net = fakeNetwork(undefined, {
    [GITHUB_ISSUER]: GITHUB_JWKS,
    [ENTERPRISE_ISSUER]: `${ENTERPRISE_ISSUER}/.well-known/jwks`,
    [ACME_ISSUER]: `${ACME_ISSUER}/discovered-keys`,
  });
  app = createTestApp({ fetch: net.fetch, env: { TOKENGATE_KEK: KEK_1 } });
  const adminUser: User = await createUser({ email: 'admin@example.com', role: 'admin' });
  const viewerUser: User = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  admin = await loginAs(app, adminUser);
  viewer = await loginAs(app, viewerUser);
});

/** Audit actions of config changes (sign-ins also write audit rows). */
async function auditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT action FROM audit_log WHERE action NOT LIKE 'user.%' ORDER BY rowid",
  ).all<{ action: string }>();
  return results.map((row) => row.action);
}

function githubFields(overrides: Record<string, string | string[]> = {}) {
  return {
    profile: 'github-actions',
    name: 'GitHub Actions',
    issuer: GITHUB_ISSUER,
    audience: 'tokengate:abcdefghijklmnopqrstuvwxyz',
    allowed_algs: 'RS256',
    max_token_age_seconds: '600',
    pin_mode: 'fields',
    owner_ids: OWNER_ID,
    enterprise_id: '',
    ...overrides,
  };
}

describe('caller providers: viewer', () => {
  it('can read the list and detail but not create, edit, toggle or delete', async () => {
    const provider = await seedGithubProvider(app.deps);
    const before = await auditActions();

    const list = await adminGet(app, viewer, '/admin/caller-providers');
    expect(list.status).toBe(200);
    const listHtml = await list.text();
    expect(listHtml).toContain(provider.name);
    expect(listHtml).not.toContain('Add a caller provider');

    const detail = await adminGet(app, viewer, `/admin/caller-providers/${provider.id}`);
    expect(detail.status).toBe(200);
    const detailHtml = await detail.text();
    expect(detailHtml).toContain(provider.audience);
    expect(detailHtml).not.toContain('Save changes');

    expect((await adminGet(app, viewer, '/admin/caller-providers/new')).status).toBe(403);
    for (const path of [
      '/admin/caller-providers',
      `/admin/caller-providers/${provider.id}`,
      `/admin/caller-providers/${provider.id}/toggle`,
      `/admin/caller-providers/${provider.id}/delete`,
    ]) {
      const res = await adminPost(app, viewer, path, { ...githubFields(), enabled: '0' });
      expect(res.status, path).toBe(403);
    }
    expect(await auditActions()).toEqual(before);
    expect((await getCallerProvider(env.DB, provider.id))?.enabled).toBe(true);
  });
});

describe('caller providers: create', () => {
  it('offers a profile choice, then a form with profile defaults and a random audience', async () => {
    const chooser = await (await adminGet(app, admin, '/admin/caller-providers/new')).text();
    expect(chooser).toContain('/admin/caller-providers/new?profile=github-actions');
    expect(chooser).toContain('/admin/caller-providers/new?profile=gitlab-ci');
    expect(chooser).toContain('/admin/caller-providers/new?profile=generic');

    const res = await adminGet(app, admin, '/admin/caller-providers/new?profile=github-actions');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`value="${GITHUB_ISSUER}"`);
    expect(html).toMatch(/name="audience" value="tokengate:[a-z2-7]{26}"/);
    expect(html).toContain('Allowed organization IDs');
    expect(html).toContain('gh api repos/OWNER/REPO');
  });

  it('creates a GitHub caller provider, writes one audit row and shows the workflow snippet', async () => {
    const res = await adminPost(app, admin, '/admin/caller-providers', githubFields());
    expect(res.status).toBe(303);
    const location = res.headers.get('location') ?? '';
    expect(location).toMatch(/^\/admin\/caller-providers\/cpr_[0-9A-Z]{26}\?notice=created$/);
    expect(await auditActions()).toEqual(['caller_provider.create']);

    const id = location.split('/')[3]?.split('?')[0] ?? '';
    const stored = await getCallerProvider(env.DB, id);
    expect(stored?.tenant_pin).toEqual([
      { claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] },
    ]);
    expect(stored?.jwks_uri).toBe(GITHUB_JWKS);

    const html = await (await adminGet(app, admin, location)).text();
    expect(html).toContain('Caller provider created.');
    expect(html).toContain('uses: 2fd/cloudflare-tokengate/actions/get-token@main');
    expect(html).toContain(
      'with: { audience: tokengate:abcdefghijklmnopqrstuvwxyz, url: https://gw.test }',
    );
    expect(html).toContain('Create a grant');
  });

  it('re-renders with errors and the submitted values when validation fails, without an audit row', async () => {
    const res = await adminPost(
      app,
      admin,
      '/admin/caller-providers',
      githubFields({ owner_ids: '', name: 'Kept name' }),
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('a tenant pin is required');
    expect(html).toContain('value="Kept name"');
    expect(await auditActions()).toEqual([]);
  });

  it('creates a generic caller provider from pin lines, anchor claims and an explicit JWKS URI', async () => {
    const res = await adminPost(app, admin, '/admin/caller-providers', {
      profile: 'generic',
      name: 'Acme IdP',
      issuer: ACME_ISSUER,
      jwks_uri: `${ACME_ISSUER}/keys`,
      audience: 'tokengate:abcdefghijklmnopqrstuvwxyz',
      allowed_algs: ['RS256', 'ES256'],
      max_token_age_seconds: '300',
      pin_mode: 'text',
      tenant_pin_text: 'org_id exact 77',
      anchor_claims: 'sub\nproject_id\n',
    });
    expect(res.status).toBe(303);
    const id = (res.headers.get('location') ?? '').split('/')[3]?.split('?')[0] ?? '';
    const stored = await getCallerProvider(env.DB, id);
    expect(stored).toMatchObject({
      jwks_uri: `${ACME_ISSUER}/keys`,
      allowed_algs: ['RS256', 'ES256'],
      max_token_age_seconds: 300,
      tenant_pin: [{ claim: 'org_id', match: 'exact', values: ['77'] }],
      anchor_claims: ['sub', 'project_id'],
    });
  });

  it('reports unparseable pin lines without calling the op', async () => {
    const res = await adminPost(app, admin, '/admin/caller-providers', {
      profile: 'generic',
      name: 'Acme IdP',
      issuer: ACME_ISSUER,
      audience: 'tokengate:abcdefghijklmnopqrstuvwxyz',
      allowed_algs: 'RS256',
      max_token_age_seconds: '600',
      tenant_pin_text: 'org_id is 77',
      anchor_claims: 'sub',
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('condition line 1');
    expect(await auditActions()).toEqual([]);
  });

  it('escapes names in the list and detail pages', async () => {
    const res = await adminPost(
      app,
      admin,
      '/admin/caller-providers',
      githubFields({ name: '<script>alert(1)</script>' }),
    );
    expect(res.status).toBe(303);
    for (const path of ['/admin/caller-providers', res.headers.get('location') ?? '']) {
      const html = await (await adminGet(app, admin, path)).text();
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
  });
});

describe('caller providers: edit, toggle, delete', () => {
  it('asks to confirm an issuer change that affects enabled grants, then saves it', async () => {
    const provider = await seedGithubProvider(app.deps);
    const serviceId = await seedService(app.deps);
    await seedGrant(app.deps, provider.id, serviceId, 'deploy <b>grant</b>');
    const before = await auditActions();

    const fields = githubFields({
      name: provider.name,
      audience: provider.audience,
      issuer: ENTERPRISE_ISSUER,
    });
    const first = await adminPost(app, admin, `/admin/caller-providers/${provider.id}`, fields);
    expect(first.status).toBe(422);
    const html = await first.text();
    expect(html).toContain('name="confirm_trust_change"');
    expect(html).toContain('deploy &lt;b&gt;grant&lt;/b&gt;');
    expect(await auditActions()).toEqual(before);

    const second = await adminPost(app, admin, `/admin/caller-providers/${provider.id}`, {
      ...fields,
      confirm_trust_change: '1',
    });
    expect(second.status).toBe(303);
    expect(await auditActions()).toEqual([...before, 'caller_provider.update']);
    expect((await getCallerProvider(env.DB, provider.id))?.issuer).toBe(ENTERPRISE_ISSUER);
  });

  it('keeps a pin the ID inputs cannot show as editable condition lines', async () => {
    const created = await createCallerProvider(app.deps, ACTOR, {
      name: 'Two pins',
      profile: 'github-actions',
      tenant_pin: [
        { claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID, '5'] },
        { claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] },
      ],
    });
    if (!created.ok) throw new Error(created.errors.join('; '));
    const html = await (
      await adminGet(app, admin, `/admin/caller-providers/${created.callerProvider.id}`)
    ).text();
    expect(html).toContain('name="tenant_pin_text"');
    expect(html).not.toContain('name="owner_ids"');
  });

  it('disables and re-enables through the toggle route', async () => {
    const provider = await seedGithubProvider(app.deps);
    const off = await adminPost(app, admin, `/admin/caller-providers/${provider.id}/toggle`, {
      enabled: '0',
    });
    expect(off.status).toBe(303);
    expect(off.headers.get('location')).toBe(
      `/admin/caller-providers/${provider.id}?notice=disabled`,
    );
    expect((await getCallerProvider(env.DB, provider.id))?.enabled).toBe(false);

    const on = await adminPost(app, admin, `/admin/caller-providers/${provider.id}/toggle`, {
      enabled: '1',
    });
    expect(on.status).toBe(303);
    expect((await getCallerProvider(env.DB, provider.id))?.enabled).toBe(true);
    expect((await auditActions()).slice(-2)).toEqual([
      'caller_provider.disable',
      'caller_provider.enable',
    ]);
  });

  it('refuses to delete while grants exist, then deletes', async () => {
    const provider = await seedGithubProvider(app.deps);
    const serviceId = await seedService(app.deps);
    const grant = await seedGrant(app.deps, provider.id, serviceId);

    const blocked = await adminPost(app, admin, `/admin/caller-providers/${provider.id}/delete`, {
      confirm: '1',
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain('delete them first');

    await env.DB.prepare('DELETE FROM grants WHERE id = ?').bind(grant.id).run();
    const deleted = await adminPost(app, admin, `/admin/caller-providers/${provider.id}/delete`, {
      confirm: '1',
    });
    expect(deleted.status).toBe(303);
    expect(deleted.headers.get('location')).toBe('/admin/caller-providers?notice=deleted');
    expect(await getCallerProvider(env.DB, provider.id)).toBeNull();
    expect((await auditActions()).at(-1)).toBe('caller_provider.delete');
  });

  it('answers 404 for unknown ids', async () => {
    expect((await adminGet(app, admin, '/admin/caller-providers/cpr_missing')).status).toBe(404);
    const res = await adminPost(app, admin, '/admin/caller-providers/cpr_missing', githubFields());
    expect(res.status).toBe(404);
  });

  it('shows an empty state with next steps', async () => {
    const html = await (await adminGet(app, admin, '/admin/caller-providers')).text();
    expect(html).toContain('No caller providers yet.');
    expect(html).toContain('/admin/caller-providers/new?profile=github-actions');
  });
});

describe('caller providers: review findings', () => {
  it('deletes only with the confirmation box ticked', async () => {
    const provider = await seedGithubProvider(app.deps);
    const detail = await (
      await adminGet(app, admin, `/admin/caller-providers/${provider.id}`)
    ).text();
    expect(detail).toContain(`action="/admin/caller-providers/${provider.id}/delete"`);

    const unconfirmed = await adminPost(
      app,
      admin,
      `/admin/caller-providers/${provider.id}/delete`,
    );
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.text()).toContain('Tick the confirmation box');
    expect(await getCallerProvider(env.DB, provider.id)).not.toBeNull();
    expect(await auditActions()).toEqual(['caller_provider.create']);
  });

  it('hides the delete form while grants use the caller provider', async () => {
    const provider = await seedGithubProvider(app.deps);
    const serviceId = await seedService(app.deps);
    await seedGrant(app.deps, provider.id, serviceId);
    const html = await (
      await adminGet(app, admin, `/admin/caller-providers/${provider.id}`)
    ).text();
    expect(html).not.toContain(`action="/admin/caller-providers/${provider.id}/delete"`);
    expect(html).toContain('Delete those grants first');
  });

  it('quotes an audience that YAML would misread in the copy-ready snippets', async () => {
    const created = await createCallerProvider(app.deps, ACTOR, {
      name: 'Odd audience',
      profile: 'github-actions',
      audience: 'tokengate,odd}#audience',
      tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
    });
    if (!created.ok) throw new Error(created.errors.join('; '));
    const html = await (
      await adminGet(app, admin, `/admin/caller-providers/${created.callerProvider.id}`)
    ).text();
    expect(html).toContain(
      'with: { audience: &quot;tokengate,odd}#audience&quot;, url: https://gw.test }',
    );
  });

  it('refuses mutations without the CSRF token (I-CSRF-1)', async () => {
    const provider = await seedGithubProvider(app.deps);
    for (const path of [
      '/admin/caller-providers',
      `/admin/caller-providers/${provider.id}`,
      `/admin/caller-providers/${provider.id}/toggle`,
      `/admin/caller-providers/${provider.id}/delete`,
    ]) {
      const res = await adminPost(
        app,
        admin,
        path,
        { ...githubFields(), enabled: '0', confirm: '1' },
        { csrf: null },
      );
      expect(res.status, path).toBe(403);
    }
    expect(await auditActions()).toEqual(['caller_provider.create']);
    expect(await getCallerProvider(env.DB, provider.id)).not.toBeNull();
  });
});
