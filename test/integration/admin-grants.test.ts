// Grant admin pages through the real app: RBAC, GitHub builder and text conditions, warning
// acknowledgement bound to the warnings shown, prefill from requests (verified only), escaping.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getGrant, listGrants } from '../../src/db/grants';
import { insertRequestRecordsStatements } from '../../src/db/requests';
import type { CallerProvider, User } from '../../src/db/types';
import type { RequestRecord } from '../../src/telemetry/types';
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
  fakeNetwork,
  KEK_1,
  OWNER_ID,
  REPOSITORY_ID,
  seedGithubProvider,
  seedGrant,
  seedService,
} from '../unit/admin/ops/helpers';

let app: TestApp;
let admin: AdminSession;
let viewer: AdminSession;
let provider: CallerProvider;
let serviceId: string;

beforeEach(async () => {
  await resetControlPlane();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM grants'),
    env.DB.prepare('DELETE FROM services'),
    env.DB.prepare('DELETE FROM caller_providers'),
  ]);
  await env.TELEMETRY_DB.prepare('DELETE FROM request_log').run();
  app = createTestApp({ fetch: fakeNetwork().fetch, env: { TOKENGATE_KEK: KEK_1 } });
  const adminUser: User = await createUser({ email: 'admin@example.com', role: 'admin' });
  const viewerUser: User = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  admin = await loginAs(app, adminUser);
  viewer = await loginAs(app, viewerUser);
  provider = await seedGithubProvider(app.deps);
  // Same base URL as the GitHub service template, whose starter rules prefill new grants.
  serviceId = await seedService(app.deps);
});

/** Audit actions of grant changes. */
async function grantAuditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT action FROM audit_log WHERE target_type = 'grant' ORDER BY rowid",
  ).all<{ action: string }>();
  return results.map((row) => row.action);
}

function presetFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    caller_provider_id: provider.id,
    service_id: serviceId,
    mode: 'preset',
    name: 'main deploys',
    owner_id: OWNER_ID,
    repository_ids: REPOSITORY_ID,
    context: 'branch',
    pattern: 'main',
    require_protected_ref: '1',
    rules_text: 'GET /repos/**',
    enabled: '1',
    ...overrides,
  };
}

function advancedFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    caller_provider_id: provider.id,
    service_id: serviceId,
    mode: 'advanced',
    name: 'text grant',
    conditions_text: `repository_owner_id exact ${OWNER_ID}\nrepository_id exact ${REPOSITORY_ID}`,
    rules_text: 'GET /repos/**',
    enabled: '1',
    ...overrides,
  };
}

function grantIdFrom(response: Response): string {
  return (response.headers.get('location') ?? '').split('/')[3]?.split('?')[0] ?? '';
}

describe('grants: viewer', () => {
  it('can read but not create, edit, toggle or delete', async () => {
    const grant = await seedGrant(app.deps, provider.id, serviceId);
    const list = await adminGet(app, viewer, '/admin/grants');
    expect(list.status).toBe(200);
    const listHtml = await list.text();
    expect(listHtml).toContain(grant.name);
    expect(listHtml).not.toContain('Create a grant');
    const detail = await (await adminGet(app, viewer, `/admin/grants/${grant.id}`)).text();
    expect(detail).toContain('repository_id exact 987654321');
    expect(detail).not.toContain('Save changes');

    expect((await adminGet(app, viewer, '/admin/grants/new')).status).toBe(403);
    for (const path of [
      '/admin/grants',
      `/admin/grants/${grant.id}`,
      `/admin/grants/${grant.id}/toggle`,
      `/admin/grants/${grant.id}/delete`,
    ]) {
      const res = await adminPost(app, viewer, path, { ...advancedFields(), enabled: '0' });
      expect(res.status, path).toBe(403);
    }
    expect(await grantAuditActions()).toEqual(['grant.create']);
    expect((await getGrant(env.DB, grant.id))?.enabled).toBe(true);
  });
});

describe('grants: new form', () => {
  it('asks for caller provider and service first', async () => {
    const html = await (await adminGet(app, admin, '/admin/grants/new')).text();
    expect(html).toContain('Step 1 of 2');
    expect(html).toContain(`<option value="${provider.id}"`);
  });

  it('points to the missing prerequisite when nothing is configured', async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM services'),
      env.DB.prepare('DELETE FROM caller_providers'),
    ]);
    const html = await (await adminGet(app, admin, '/admin/grants/new')).text();
    expect(html).toContain('href="/admin/caller-providers/new"');
  });

  it('prefills the GitHub builder from the tenant pin and rules from the service template', async () => {
    const res = await adminGet(
      app,
      admin,
      `/admin/grants/new?caller_provider=${provider.id}&service=${serviceId}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`name="owner_id" value="${OWNER_ID}"`);
    expect(html).toContain('GET /repos/OWNER/REPO/**');
    expect(html).toMatch(/name="require_protected_ref" value="1" checked/);
    expect(html).toContain(
      'Trusted events (event_name): push, workflow_dispatch, schedule, release',
    );
  });
});

describe('grants: create', () => {
  it('creates a grant with the GitHub builder and writes one audit row', async () => {
    const res = await adminPost(app, admin, '/admin/grants', presetFields());
    expect(res.status).toBe(303);
    expect(await grantAuditActions()).toEqual(['grant.create']);
    const grant = await getGrant(env.DB, grantIdFrom(res));
    expect(grant?.conditions).toEqual([
      { claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] },
      { claim: 'repository_id', match: 'exact', values: [REPOSITORY_ID] },
      { claim: 'ref_type', match: 'exact', values: ['branch'] },
      { claim: 'ref', match: 'glob', values: ['refs/heads/main'] },
      { claim: 'event_name', match: 'exact', values: ['push', 'workflow_dispatch', 'schedule'] },
      { claim: 'ref_protected', match: 'exact', values: ['true'] },
    ]);
    expect(grant?.rules).toEqual([{ methods: ['GET'], path: '/repos/**' }]);

    const detail = await (await adminGet(app, admin, res.headers.get('location') ?? '')).text();
    expect(detail).toContain('Grant created.');
    expect(detail).toContain('Implicitly excluded events');
    expect(detail).toContain('release and every other event_name value');
  });

  it('requires acknowledging the exact warnings shown before saving', async () => {
    const fields = presetFields({ require_protected_ref: '' });
    const first = await adminPost(app, admin, '/admin/grants', fields);
    expect(first.status).toBe(422);
    const html = await first.text();
    expect(html).toContain('protected refs are not required');
    expect(html).toContain('name="acknowledge_warnings"');
    const digest = /name="warnings_digest" value="([0-9a-f]{64})"/.exec(html)?.[1];
    expect(digest).toBeDefined();
    expect(await grantAuditActions()).toEqual([]);

    // A box ticked for other warnings does not count.
    const stale = await adminPost(app, admin, '/admin/grants', {
      ...fields,
      acknowledge_warnings: '1',
      warnings_digest: '0'.repeat(64),
    });
    expect(stale.status).toBe(422);
    expect(await grantAuditActions()).toEqual([]);

    const saved = await adminPost(app, admin, '/admin/grants', {
      ...fields,
      acknowledge_warnings: '1',
      warnings_digest: digest ?? '',
    });
    expect(saved.status).toBe(303);
    expect(await grantAuditActions()).toEqual(['grant.create']);
  });

  it('re-renders builder errors and unparseable text with 422 and no audit row', async () => {
    const builder = await adminPost(
      app,
      admin,
      '/admin/grants',
      presetFields({ owner_id: 'acme' }),
    );
    expect(builder.status).toBe(422);
    expect(await builder.text()).toContain('owner ID must be the numeric ID');

    const text = await adminPost(
      app,
      admin,
      '/admin/grants',
      advancedFields({ conditions_text: 'repository_id equals 1', rules_text: 'GET repos' }),
    );
    expect(text.status).toBe(422);
    const html = await text.text();
    expect(html).toContain('condition line 1');
    expect(html).toContain('rule line 1');
    expect(html).toContain('repository_id equals 1');
    expect(await grantAuditActions()).toEqual([]);
  });

  it('shows validation errors from the op (anchor rules) with 422 and no audit row', async () => {
    const res = await adminPost(
      app,
      admin,
      '/admin/grants',
      advancedFields({ conditions_text: 'ref exact refs/heads/main\nref_protected exact true' }),
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('I-AUTHZ-2');
    expect(await grantAuditActions()).toEqual([]);
  });

  it('stores an expiry given in UTC and can save the grant disabled', async () => {
    const res = await adminPost(
      app,
      admin,
      '/admin/grants',
      advancedFields({ expires_at: '2099-01-02T03:04', enabled: '' }),
    );
    expect(res.status).toBe(303);
    const grant = await getGrant(env.DB, grantIdFrom(res));
    expect(grant?.expires_at).toBe(Date.UTC(2099, 0, 2, 3, 4));
    expect(grant?.enabled).toBe(false);
  });

  it('escapes grant names', async () => {
    const res = await adminPost(
      app,
      admin,
      '/admin/grants',
      advancedFields({ name: '<script>alert(1)</script>' }),
    );
    expect(res.status).toBe(303);
    for (const path of ['/admin/grants', res.headers.get('location') ?? '']) {
      const html = await (await adminGet(app, admin, path)).text();
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
  });
});

describe('grants: detail actions', () => {
  it('edits conditions and rules as text', async () => {
    const grant = await seedGrant(app.deps, provider.id, serviceId);
    const res = await adminPost(app, admin, `/admin/grants/${grant.id}`, {
      name: 'renamed',
      conditions_text: `repository_owner_id exact ${OWNER_ID}\nrepository_id exact ${REPOSITORY_ID}, 5`,
      rules_text: 'GET,HEAD /repos/acme/**',
    });
    expect(res.status).toBe(303);
    const updated = await getGrant(env.DB, grant.id);
    expect(updated?.name).toBe('renamed');
    expect(updated?.conditions[1]?.values).toEqual([REPOSITORY_ID, '5']);
    expect(updated?.rules).toEqual([{ methods: ['GET', 'HEAD'], path: '/repos/acme/**' }]);
    expect(await grantAuditActions()).toEqual(['grant.create', 'grant.update']);
  });

  it('asks for acknowledgement when an edit introduces warnings', async () => {
    const grant = await seedGrant(app.deps, provider.id, serviceId);
    const res = await adminPost(app, admin, `/admin/grants/${grant.id}`, {
      name: grant.name,
      conditions_text: `repository_owner_id exact ${OWNER_ID}\nrepository_id exact ${REPOSITORY_ID}\nevent_name exact pull_request_target`,
      rules_text: 'GET /repos/**',
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('pwn request');
    expect(html).toContain('pull_request_target (opted in)');
    expect(await grantAuditActions()).toEqual(['grant.create']);
  });

  it('reports a save without changes as unchanged and writes nothing', async () => {
    const grant = await seedGrant(app.deps, provider.id, serviceId);
    const res = await adminPost(app, admin, `/admin/grants/${grant.id}`, {
      name: grant.name,
      conditions_text: `repository_owner_id exact ${OWNER_ID}\nrepository_id exact ${REPOSITORY_ID}`,
      rules_text: 'GET /repos/**',
      expected_updated_at: String(grant.updated_at),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin/grants/${grant.id}?notice=unchanged`);
    expect(await grantAuditActions()).toEqual(['grant.create']);
    expect((await getGrant(env.DB, grant.id))?.updated_at).toBe(grant.updated_at);
    const page = await (
      await adminGet(app, admin, `/admin/grants/${grant.id}?notice=unchanged`)
    ).text();
    expect(page).toContain('Nothing changed');
  });

  it('requires acknowledgement for non-POST rules on a path-injection service', async () => {
    const webhookId = await seedService(app.deps, {
      slug: 'discord-webhook',
      name: 'Discord webhook',
      base_url: 'https://discord.com/api/webhooks',
      injection: { kind: 'path' },
      forward_headers: [],
    });
    const fields = advancedFields({ service_id: webhookId, rules_text: 'GET,POST /' });
    const first = await adminPost(app, admin, '/admin/grants', fields);
    expect(first.status).toBe(422);
    const html = await first.text();
    expect(html).toContain('allow only POST');
    expect(html).toContain('name="acknowledge_warnings"');
    expect(await grantAuditActions()).toEqual([]);

    const postOnly = await adminPost(app, admin, '/admin/grants', {
      ...fields,
      rules_text: 'POST /',
    });
    expect(postOnly.status).toBe(303);
    expect(await grantAuditActions()).toEqual(['grant.create']);
  });

  it('disables, enables and deletes', async () => {
    const grant = await seedGrant(app.deps, provider.id, serviceId);
    const off = await adminPost(app, admin, `/admin/grants/${grant.id}/toggle`, { enabled: '0' });
    expect(off.status).toBe(303);
    expect((await getGrant(env.DB, grant.id))?.enabled).toBe(false);
    const on = await adminPost(app, admin, `/admin/grants/${grant.id}/toggle`, { enabled: '1' });
    expect(on.status).toBe(303);
    expect((await getGrant(env.DB, grant.id))?.enabled).toBe(true);
    const deleted = await adminPost(app, admin, `/admin/grants/${grant.id}/delete`, {
      confirm: '1',
    });
    expect(deleted.status).toBe(303);
    expect(deleted.headers.get('location')).toBe('/admin/grants?notice=deleted');
    expect(await getGrant(env.DB, grant.id)).toBeNull();
    expect(await grantAuditActions()).toEqual([
      'grant.create',
      'grant.disable',
      'grant.enable',
      'grant.delete',
    ]);
  });

  it('duplicates through a prefilled new-grant form', async () => {
    const grant = await seedGrant(app.deps, provider.id, serviceId, 'original');
    const detail = await (await adminGet(app, admin, `/admin/grants/${grant.id}`)).text();
    expect(detail).toContain(`/admin/grants/new?duplicate=${grant.id}`);
    const html = await (
      await adminGet(app, admin, `/admin/grants/new?duplicate=${grant.id}`)
    ).text();
    expect(html).toContain('value="original (copy)"');
    expect(html).toContain(`repository_id exact ${REPOSITORY_ID}`);
  });

  it('filters the list by service and caller provider', async () => {
    await seedGrant(app.deps, provider.id, serviceId, 'listed grant');
    const match = await (
      await adminGet(
        app,
        admin,
        `/admin/grants?service=${serviceId}&caller_provider=${provider.id}`,
      )
    ).text();
    expect(match).toContain('listed grant');
    const other = await (await adminGet(app, admin, '/admin/grants?service=svc_other')).text();
    expect(other).not.toContain('listed grant');
    expect(other).toContain('No grants match these filters.');
  });

  it('answers 404 for unknown ids', async () => {
    expect((await adminGet(app, admin, '/admin/grants/grt_missing')).status).toBe(404);
    expect((await adminGet(app, admin, '/admin/grants/new?duplicate=grt_missing')).status).toBe(
      404,
    );
  });
});

describe('grants: prefill from a request (I-LOG-2)', () => {
  function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
    return {
      id: 'req_01JTESTREQUEST000000000000',
      ts: Date.now(),
      outcome: 'denied',
      reason: 'no_matching_grant',
      status: 403,
      upstream_status: null,
      method: 'GET',
      path: '/repos/acme/app/contents/README.md',
      service_slug: 'github',
      service_id: serviceId,
      caller_provider_id: provider.id,
      grant_id: null,
      claims_verified: 1,
      caller_subject: 'repo:acme/app:ref:refs/heads/main',
      caller_repository: 'acme/app',
      caller_claims: JSON.stringify({
        sub: 'repo:acme/app:ref:refs/heads/main',
        repository: 'acme/app',
        repository_id: REPOSITORY_ID,
        repository_owner_id: OWNER_ID,
        ref: 'refs/heads/main',
        event_name: 'push',
      }),
      jti: null,
      untrusted_iss: null,
      eval_trace: null,
      duration_ms: 5,
      upstream_ms: null,
      weight: 1,
      ip: null,
      user_agent: null,
      colo: null,
      ...overrides,
    };
  }

  async function store(row: RequestRecord): Promise<void> {
    await env.TELEMETRY_DB.batch(insertRequestRecordsStatements(env.TELEMETRY_DB, [row]));
  }

  it('prefills exact anchor, ref and event conditions and the denied call as a rule', async () => {
    await store(record());
    const res = await adminGet(
      app,
      admin,
      '/admin/grants/new?from_request=req_01JTESTREQUEST000000000000',
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Prefilled from request req_01JTESTREQUEST000000000000');
    expect(html).toContain(
      [
        `repository_owner_id exact ${OWNER_ID}`,
        `repository_id exact ${REPOSITORY_ID}`,
        'ref exact refs/heads/main',
        'event_name exact push',
      ].join('\n'),
    );
    expect(html).toContain('GET /repos/acme/app/contents/README.md');
    expect(html).toContain('the rule matches exactly that call');
  });

  // A caller can put "*" in the path of a denied call; prefilled as is it would be a wildcard rule
  // that the banner calls exact. "%2F" paths only match through "**" (I-AUTHZ-1).
  it.each([
    ['/repos/acme/app/**', 'req_01JTESTWILDCARD00000000000'],
    ['/repos/acme/app/contents/a%2Fb', 'req_01JTESTENCODEDSLASH0000000'],
  ])('does not prefill a rule for the path %s', async (path, id) => {
    await store(record({ id, path }));
    const res = await adminGet(app, admin, `/admin/grants/new?from_request=${id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('No rule was prefilled');
    expect(html).not.toContain('the rule matches exactly that call');
    expect(html).not.toContain('GET /repos/acme/app/');
    expect(html).toContain(`repository_id exact ${REPOSITORY_ID}`);
  });

  it('refuses unverified, allowed or unknown records with 400', async () => {
    await store(record({ id: 'req_01JTESTUNVERIFIED00000000', claims_verified: 0 }));
    await store(record({ id: 'req_01JTESTALLOWED00000000000', outcome: 'allowed', reason: null }));
    await store(record({ id: 'req_01JTESTTENANT000000000000', reason: 'tenant_mismatch' }));
    for (const id of [
      'req_01JTESTUNVERIFIED00000000',
      'req_01JTESTALLOWED00000000000',
      'req_01JTESTTENANT000000000000',
      'req_01JTESTMISSING00000000000',
    ]) {
      const res = await adminGet(app, admin, `/admin/grants/new?from_request=${id}`);
      expect(res.status, id).toBe(400);
      expect(await res.text()).not.toContain('repository_id exact');
    }
    expect(await listGrants(env.DB)).toEqual([]);
  });
});

describe('grants: review findings', () => {
  it('deletes only with the confirmation box ticked', async () => {
    const grant = await seedGrant(app.deps, provider.id, serviceId);
    const detail = await (await adminGet(app, admin, `/admin/grants/${grant.id}`)).text();
    expect(detail).toContain(`action="/admin/grants/${grant.id}/delete"`);
    expect(detail).toContain('name="confirm"');

    const unconfirmed = await adminPost(app, admin, `/admin/grants/${grant.id}/delete`);
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.text()).toContain('Tick the confirmation box');
    expect(await getGrant(env.DB, grant.id)).not.toBeNull();
    expect(await grantAuditActions()).toEqual(['grant.create']);
  });

  it('refuses mutations without the CSRF token (I-CSRF-1)', async () => {
    const grant = await seedGrant(app.deps, provider.id, serviceId);
    for (const [path, fields] of [
      ['/admin/grants', advancedFields()],
      [`/admin/grants/${grant.id}`, { name: 'x' }],
      [`/admin/grants/${grant.id}/toggle`, { enabled: '0' }],
      [`/admin/grants/${grant.id}/delete`, { confirm: '1' }],
    ] as const) {
      const res = await adminPost(app, admin, path, fields, { csrf: null });
      expect(res.status, path).toBe(403);
    }
    expect(await grantAuditActions()).toEqual(['grant.create']);
    expect((await getGrant(env.DB, grant.id))?.enabled).toBe(true);
  });

  it('never echoes an unknown notice key', async () => {
    const grant = await seedGrant(app.deps, provider.id, serviceId);
    const html = await (
      await adminGet(app, admin, `/admin/grants/${grant.id}?notice=%3Cb%3Eowned%3C%2Fb%3E`)
    ).text();
    expect(html).not.toContain('owned');
  });

  it('explains why an enabled grant matches nothing', async () => {
    const grant = await seedGrant(app.deps, provider.id, serviceId);
    await env.DB.prepare('UPDATE caller_providers SET enabled = 0 WHERE id = ?')
      .bind(provider.id)
      .run();
    await env.DB.prepare('UPDATE grants SET expires_at = 1 WHERE id = ?').bind(grant.id).run();
    const html = await (await adminGet(app, admin, `/admin/grants/${grant.id}`)).text();
    expect(html).toContain('This grant has expired.');
    expect(html).toContain('is disabled, so this grant matches nothing');
  });

  it('escapes claim values from a request record in the prefilled form', async () => {
    const claims = {
      repository: 'acme/app',
      repository_id: REPOSITORY_ID,
      repository_owner_id: OWNER_ID,
      ref: 'refs/heads/</textarea><script>alert(1)</script>',
      event_name: 'push',
    };
    await env.TELEMETRY_DB.batch(
      insertRequestRecordsStatements(env.TELEMETRY_DB, [
        {
          id: 'req_01JTESTXSS000000000000000',
          ts: Date.now(),
          outcome: 'denied',
          reason: 'no_matching_grant',
          status: 403,
          upstream_status: null,
          method: 'GET',
          path: '/repos/acme/app',
          service_slug: 'github',
          service_id: serviceId,
          caller_provider_id: provider.id,
          grant_id: null,
          claims_verified: 1,
          caller_subject: 'repo:acme/app',
          caller_repository: 'acme/app',
          caller_claims: JSON.stringify(claims),
          jti: null,
          untrusted_iss: null,
          eval_trace: null,
          duration_ms: 1,
          upstream_ms: null,
          weight: 1,
          ip: null,
          user_agent: null,
          colo: null,
        },
      ]),
    );
    const res = await adminGet(
      app,
      admin,
      '/admin/grants/new?from_request=req_01JTESTXSS000000000000000',
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/textarea&gt;&lt;script&gt;');
  });
});
