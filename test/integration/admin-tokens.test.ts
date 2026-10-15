// Services admin pages end to end: rendering per role, RBAC, audited mutations through the ops,
// validation re-renders, credential handling (never rendered back) and output escaping.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '../../src/db/types';
import { toBase64 } from '../../src/lib/encoding';
import {
  type AdminSession,
  adminGet,
  adminPost,
  createUser,
  loginAs,
  resetControlPlane,
} from '../helpers/admin-auth';
import { createTestApp, type TestApp } from '../helpers/app';

const KEK = toBase64(new Uint8Array(32).fill(7));
const SECRET = 'sk-test-0123456789abcdefghijWXYZ';
const BAD_SECRET = 'sk-test-wrong-0000000000000000';

/** Fake upstream: `/models` answers 200 only for SECRET; records every call. */
function fakeUpstream() {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.href);
    const auth = new Headers(init?.headers).get('authorization');
    if (url.pathname.endsWith('/models')) {
      return auth === `Bearer ${SECRET}`
        ? Response.json({ data: [] })
        : Response.json({ error: 'invalid key' }, { status: 401 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch: fetchImpl, calls };
}

let app: TestApp;
let upstream: ReturnType<typeof fakeUpstream>;

async function sessionFor(role: Role): Promise<AdminSession> {
  const user = await createUser({ email: `${role}@example.com`, role });
  return loginAs(app, user);
}

/** Service audit actions in insertion order (logins also write audit rows). */
async function auditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT action FROM audit_log WHERE target_type = 'service' ORDER BY rowid",
  ).all<{
    action: string;
  }>();
  return results.map((row) => row.action);
}

async function serviceRow(slug: string) {
  return env.DB.prepare('SELECT * FROM services WHERE slug = ?')
    .bind(slug)
    .first<Record<string, unknown>>();
}

const OPENAI_FORM = {
  slug: 'openai',
  name: 'OpenAI',
  description: '',
  base_url: 'https://api.openai.com/v1',
  injection_kind: 'bearer',
  forward_headers: 'OpenAI-Beta\nopenai-project',
  timeout_ms: '60000',
  verify_method: 'GET',
  verify_path: '/models',
  verify_expect_status: '200',
};

/** Creates a service as `session` and returns its id. */
async function createViaForm(
  session: AdminSession,
  fields: Record<string, string> = {},
): Promise<string> {
  const res = await adminPost(app, session, '/admin/tokens', { ...OPENAI_FORM, ...fields });
  expect(res.status).toBe(303);
  const location = res.headers.get('location') ?? '';
  const id = /^\/admin\/tokens\/(svc_[0-9A-Z]{26})\?notice=/.exec(location)?.[1];
  if (!id) throw new Error(`unexpected redirect ${location}`);
  return id;
}

async function insertGrant(serviceId: string, name: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO caller_providers (id, name, profile, issuer, jwks_uri, audience, allowed_algs,
         max_token_age_seconds, tenant_pin, anchor_claims, enabled, created_at, updated_at)
       VALUES ('cpr_TEST', 'GitHub Actions', 'github-actions', 'https://token.actions.githubusercontent.com',
         'https://token.actions.githubusercontent.com/.well-known/jwks', 'tokengate:0123456789ABCDEF',
         '["RS256"]', 600, '[]', '[]', 1, ?, ?)`,
    ).bind(now, now),
    env.DB.prepare(
      `INSERT INTO grants (id, name, description, caller_provider_id, service_id, conditions, rules,
         enabled, expires_at, created_by, created_at, updated_at)
       VALUES ('grt_TEST', ?, '', 'cpr_TEST', ?, '[]', '[]', 1, NULL, NULL, ?, ?)`,
    ).bind(name, serviceId, now, now),
  ]);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM grants'),
    env.DB.prepare('DELETE FROM services'),
    env.DB.prepare('DELETE FROM caller_providers'),
  ]);
  await resetControlPlane();
  upstream = fakeUpstream();
  app = createTestApp({ env: { TOKENGATE_KEK: KEK }, fetch: upstream.fetch });
});

describe('services list', () => {
  it('shows an empty state with the next step for admins', async () => {
    const admin = await sessionFor('admin');
    const res = await adminGet(app, admin, '/admin/tokens');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('No services yet');
    expect(html).toContain('href="/admin/tokens/new"');
  });

  it('renders services for a viewer without create links', async () => {
    const admin = await sessionFor('admin');
    await createViaForm(admin, { credential: SECRET });
    const viewer = await sessionFor('viewer');
    const res = await adminGet(app, viewer, '/admin/tokens');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<code>openai</code>');
    expect(html).toContain('api.openai.com');
    expect(html).toContain('…WXYZ');
    expect(html).not.toContain('href="/admin/tokens/new"');
    expect(html).not.toContain(SECRET);
  });
});

describe('new service form', () => {
  it('lists templates and prefills from ?template=', async () => {
    const admin = await sessionFor('admin');
    const picker = await (await adminGet(app, admin, '/admin/tokens/new')).text();
    expect(picker).toContain('/admin/tokens/new?template=slack-webhook');

    const res = await adminGet(app, admin, '/admin/tokens/new?template=openai');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('value="https://api.openai.com/v1"');
    expect(html).toContain('Suggested grant rules');
    expect(html).toContain('POST /responses');
    expect(html).toContain('type="password"');
  });

  it('is forbidden for viewers', async () => {
    const viewer = await sessionFor('viewer');
    expect((await adminGet(app, viewer, '/admin/tokens/new')).status).toBe(403);
  });
});

describe('create', () => {
  it('creates a service with a verified credential and one audit row', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin, { credential: SECRET });
    expect(await auditActions()).toEqual(['service.create']);
    const row = await serviceRow('openai');
    expect(row?.id).toBe(id);
    expect(row?.forward_headers).toBe('["openai-beta","openai-project"]');
    expect(upstream.calls).toEqual(['https://api.openai.com/v1/models']);

    const res = await adminGet(app, admin, `/admin/tokens/${id}?notice=created_verified`);
    const html = await res.text();
    expect(html).toContain('the credential check against the upstream passed');
    expect(html).toContain('https://gw.test/proxy/openai');
    expect(html).not.toContain(SECRET);
  });

  it('re-renders with errors, submitted values and no audit row on invalid input', async () => {
    const admin = await sessionFor('admin');
    const res = await adminPost(app, admin, '/admin/tokens', {
      ...OPENAI_FORM,
      slug: 'Bad Slug',
      base_url: 'http://127.0.0.1/api',
      credential: SECRET,
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain('value="Bad Slug"');
    expect(html).toContain('value="http://127.0.0.1/api"');
    expect(html).toContain('Enter it again to save');
    expect(html).not.toContain(SECRET);
    expect(await auditActions()).toEqual([]);
    expect(upstream.calls).toEqual([]);
  });

  it('rejects a malformed expiry date without calling the op', async () => {
    const admin = await sessionFor('admin');
    const res = await adminPost(app, admin, '/admin/tokens', {
      ...OPENAI_FORM,
      credential_expires_at: '31/12/2027',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('2027-01-31');
    expect(await auditActions()).toEqual([]);
  });

  it('shows the failed check and save_anyway; saves only when ticked', async () => {
    const admin = await sessionFor('admin');
    const first = await adminPost(app, admin, '/admin/tokens', {
      ...OPENAI_FORM,
      credential: BAD_SECRET,
    });
    expect(first.status).toBe(422);
    const html = await first.text();
    expect(html).toContain('Credential check failed (HTTP 401)');
    expect(html).toContain('name="save_anyway"');
    expect(html).not.toContain(BAD_SECRET);
    expect(await auditActions()).toEqual([]);

    await createViaForm(admin, { credential: BAD_SECRET, save_anyway: '1' });
    expect(await auditActions()).toEqual(['service.create']);
    expect((await serviceRow('openai'))?.credential_sealed).not.toBeNull();
  });

  it('is forbidden for viewers and writes nothing', async () => {
    const viewer = await sessionFor('viewer');
    const res = await adminPost(app, viewer, '/admin/tokens', OPENAI_FORM);
    expect(res.status).toBe(403);
    expect(await serviceRow('openai')).toBeNull();
    expect(await auditActions()).toEqual([]);
  });

  it('escapes names containing markup', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin, { name: '<script>alert(1)</script>' });
    for (const path of ['/admin/tokens', `/admin/tokens/${id}`]) {
      const html = await (await adminGet(app, admin, path)).text();
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
  });
});

describe('service detail', () => {
  it('shows read-only details to viewers and 404 for unknown ids', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin);
    const viewer = await sessionFor('viewer');
    const res = await adminGet(app, viewer, `/admin/tokens/${id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('missing');
    expect(html).toContain('No grant uses this service yet');
    expect(html).not.toContain('Change credential or destination');
    expect(html).not.toContain('<form method="post" action="/admin/tokens/');

    const missing = await adminGet(app, viewer, '/admin/tokens/svc_00000000000000000000000000');
    expect(missing.status).toBe(404);
  });

  it('warns about query injection', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin, {
      injection_kind: 'query',
      injection_param: 'api_key',
      verify_method: '',
    });
    const html = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    expect(html).toContain('Upstreams may echo URLs');
  });

  it('forbids viewer mutations', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin, { credential: SECRET });
    const viewer = await sessionFor('viewer');
    for (const [path, fields] of [
      [`/admin/tokens/${id}`, { name: 'x' }],
      [`/admin/tokens/${id}/credential`, { secret: SECRET }],
      [`/admin/tokens/${id}/test`, {}],
      [`/admin/tokens/${id}/toggle`, { enabled: '0' }],
      [`/admin/tokens/${id}/delete`, { confirm: '1' }],
    ] as const) {
      expect((await adminPost(app, viewer, path, fields)).status).toBe(403);
    }
    expect(await auditActions()).toEqual(['service.create']);
  });
});

describe('edit settings', () => {
  it('updates non-binding fields with one audit row', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin);
    const res = await adminPost(app, admin, `/admin/tokens/${id}`, {
      ...OPENAI_FORM,
      name: 'OpenAI prod',
      timeout_ms: '300000',
      credential_expires_at: '2030-06-01',
      // Ignored by the route: the destination changes only with the credential (I-CRED-2).
      base_url: 'https://evil.example.com',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin/tokens/${id}?notice=updated`);
    const row = await serviceRow('openai');
    expect(row?.name).toBe('OpenAI prod');
    expect(row?.timeout_ms).toBe(300000);
    expect(row?.base_url).toBe('https://api.openai.com/v1');
    expect(row?.credential_expires_at).toBe(Date.UTC(2030, 5, 1));
    expect(await auditActions()).toEqual(['service.create', 'service.update']);
  });

  it('re-renders the edit form on validation errors', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin);
    const res = await adminPost(app, admin, `/admin/tokens/${id}`, {
      ...OPENAI_FORM,
      timeout_ms: '5',
      forward_headers: 'authorization',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('timeout must be an integer');
    expect(html).toContain('value="5"');
    expect(await auditActions()).toEqual(['service.create']);
  });
});

describe('change credential or destination', () => {
  it('re-seals with a new destination; a failed check needs save_anyway', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin, { credential: SECRET });
    const before = await serviceRow('openai');

    const failed = await adminPost(app, admin, `/admin/tokens/${id}/credential`, {
      base_url: 'https://api.openai.com/v2',
      injection_kind: 'bearer',
      credential: BAD_SECRET,
    });
    expect(failed.status).toBe(422);
    const html = await failed.text();
    expect(html).toContain('Credential check failed');
    expect(html).toContain('name="save_anyway"');
    expect(html).toContain('value="https://api.openai.com/v2"');
    expect(html).not.toContain(BAD_SECRET);
    expect(await serviceRow('openai')).toEqual(before);

    const saved = await adminPost(app, admin, `/admin/tokens/${id}/credential`, {
      base_url: 'https://api.openai.com/v2',
      injection_kind: 'bearer',
      credential: SECRET,
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe(`/admin/tokens/${id}?notice=credential_verified`);
    const after = await serviceRow('openai');
    expect(after?.base_url).toBe('https://api.openai.com/v2');
    expect(after?.credential_sealed).not.toBe(before?.credential_sealed);
    expect(await auditActions()).toEqual(['service.create', 'service.credential.set']);
  });

  it('requires the credential', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin, { credential: SECRET });
    const res = await adminPost(app, admin, `/admin/tokens/${id}/credential`, {
      base_url: 'https://api.openai.com/v1',
      injection_kind: 'header',
      injection_header_name: 'X-Api-Key',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('credential is empty');
    expect(await auditActions()).toEqual(['service.create']);
  });
});

describe('test, toggle, delete', () => {
  it('tests the stored credential and shows the result', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin, { credential: SECRET });
    const res = await adminPost(app, admin, `/admin/tokens/${id}/test`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Credential check passed (HTTP 200)');
    expect(await auditActions()).toEqual(['service.create', 'service.credential.test']);
  });

  it('disables and enables', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin);
    const off = await adminPost(app, admin, `/admin/tokens/${id}/toggle`, { enabled: '0' });
    expect(off.headers.get('location')).toBe(`/admin/tokens/${id}?notice=disabled`);
    expect((await serviceRow('openai'))?.enabled).toBe(0);
    const on = await adminPost(app, admin, `/admin/tokens/${id}/toggle`, { enabled: '1' });
    expect(on.headers.get('location')).toBe(`/admin/tokens/${id}?notice=enabled`);
    expect((await serviceRow('openai'))?.enabled).toBe(1);
    expect(await auditActions()).toEqual(['service.create', 'service.disable', 'service.enable']);

    const bad = await adminPost(app, admin, `/admin/tokens/${id}/toggle`, { enabled: 'yes' });
    expect(bad.status).toBe(400);
  });

  it('blocks delete while grants use the service, then deletes', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin);
    await insertGrant(id, 'deploy <bot>');

    const page = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    expect(page).toContain('used by 1 grant(s)');
    expect(page).toContain('href="/admin/access/grt_TEST"');
    expect(page).toContain('deploy &lt;bot&gt;');

    const blocked = await adminPost(app, admin, `/admin/tokens/${id}/delete`, { confirm: '1' });
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain('delete them first');

    await env.DB.prepare('DELETE FROM grants').run();
    const unconfirmed = await adminPost(app, admin, `/admin/tokens/${id}/delete`);
    expect(unconfirmed.status).toBe(400);
    const deleted = await adminPost(app, admin, `/admin/tokens/${id}/delete`, { confirm: '1' });
    expect(deleted.headers.get('location')).toBe('/admin/tokens?notice=deleted');
    expect(await serviceRow('openai')).toBeNull();
    expect(await auditActions()).toEqual(['service.create', 'service.delete']);
  });
});

describe('review: forms, notices and per-kind fields', () => {
  it('puts a CSRF token in every POST form of the detail page', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin, { credential: SECRET });
    const html = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    const forms = html.match(/<form method="post"[\s\S]*?<\/form>/g) ?? [];
    // toggle, test, settings, credential, delete (+ the layout's sign-out form)
    expect(forms.length).toBeGreaterThanOrEqual(5);
    for (const form of forms) expect(form).toContain(`name="_csrf" value="${admin.csrfToken}"`);
  });

  it('refuses a POST without the CSRF token and writes nothing', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin);
    const res = await adminPost(
      app,
      admin,
      `/admin/tokens/${id}/toggle`,
      { enabled: '0' },
      { csrf: null },
    );
    expect(res.status).toBe(403);
    expect((await serviceRow('openai'))?.enabled).toBe(1);
    expect(await auditActions()).toEqual(['service.create']);
  });

  it('shows only known notices, never query text', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin);
    for (const notice of ['<b>pwned</b>', 'constructor', '__proto__', 'toString']) {
      const html = await (
        await adminGet(app, admin, `/admin/tokens/${id}?notice=${encodeURIComponent(notice)}`)
      ).text();
      expect(html).not.toContain('pwned');
      expect(html).not.toContain('class="banner info" role="status"');
    }
  });

  it('warns that a service without a credential cannot serve requests', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin);
    const adminHtml = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    expect(adminHtml).toContain('No credential is stored yet');
    expect(adminHtml).toContain('Change credential or destination&quot; below');
    const viewer = await sessionFor('viewer');
    const viewerHtml = await (await adminGet(app, viewer, `/admin/tokens/${id}`)).text();
    expect(viewerHtml).toContain('Ask an admin to add it');

    await adminPost(app, admin, `/admin/tokens/${id}/credential`, {
      base_url: OPENAI_FORM.base_url,
      injection_kind: 'bearer',
      credential: SECRET,
    });
    const after = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    expect(after).not.toContain('No credential is stored yet');
  });

  it('shows action results and form problems at the top of the re-rendered page', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin, { credential: SECRET });
    const top = (html: string, text: string) => {
      expect(html).toContain(text);
      expect(html.indexOf(text)).toBeLessThan(html.indexOf('<dl class="details">'));
    };

    top(
      await (await adminPost(app, admin, `/admin/tokens/${id}/test`)).text(),
      'Credential check passed',
    );
    top(
      await (await adminPost(app, admin, `/admin/tokens/${id}/toggle`, { enabled: 'x' })).text(),
      'choose whether to enable or disable',
    );
    top(
      await (await adminPost(app, admin, `/admin/tokens/${id}/delete`)).text(),
      'tick the confirmation box',
    );

    const edit = await (
      await adminPost(app, admin, `/admin/tokens/${id}`, { ...OPENAI_FORM, timeout_ms: '5' })
    ).text();
    top(edit, 'href="#settings"');
    expect(edit).toContain('<h2 id="settings">');

    const credential = await (
      await adminPost(app, admin, `/admin/tokens/${id}/credential`, {
        base_url: OPENAI_FORM.base_url,
        injection_kind: 'bearer',
        credential: BAD_SECRET,
      })
    ).text();
    top(credential, 'The credential check failed, so nothing was saved');
    top(credential, 'href="#change-credential"');
    expect(credential).toContain('<h2 id="change-credential">');
    expect(credential).not.toContain(BAD_SECRET);
  });

  it('points to the failed check at the top of the new-service form', async () => {
    const admin = await sessionFor('admin');
    const res = await adminPost(app, admin, '/admin/tokens', {
      ...OPENAI_FORM,
      credential: BAD_SECRET,
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html.indexOf('The credential check failed, so nothing was saved')).toBeLessThan(
      html.indexOf('<form method="post" action="/admin/tokens"'),
    );
  });

  it('maps the per-kind injection fields (header name lower-cased, path prefix)', async () => {
    const admin = await sessionFor('admin');
    await createViaForm(admin, {
      slug: 'custom',
      injection_kind: 'header',
      injection_header_name: ' X-Api-Key ',
      injection_header_prefix: 'Token ',
      // Fields of other kinds are ignored.
      injection_param: 'ignored',
      verify_method: '',
    });
    expect((await serviceRow('custom'))?.injection).toBe(
      '{"kind":"header","name":"x-api-key","prefix":"Token "}',
    );

    await createViaForm(admin, {
      slug: 'hook',
      base_url: 'https://hooks.slack.com/services',
      injection_kind: 'path',
      injection_path_prefix: '',
      injection_header_name: 'ignored',
      verify_method: '',
      credential: 'T000/B000/abcdefghijklmnopqrstuvwx',
    });
    const hook = await serviceRow('hook');
    expect(hook?.injection).toBe('{"kind":"path"}');
    expect(hook?.credential_hint).toBe('…uvwx (34 chars)');
  });

  it('refuses a settings save over a newer change with 409 and keeps the newer values', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin);
    const page = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    const opened = /name="expected_updated_at" value="(\d+)"/.exec(page)?.[1];
    expect(opened).toBeDefined();
    const fields = { ...OPENAI_FORM, credential_expires_at: '', expected_updated_at: opened ?? '' };

    const first = await adminPost(app, admin, `/admin/tokens/${id}`, {
      ...fields,
      name: 'First',
    });
    expect(first.status).toBe(303);
    const stale = await adminPost(app, admin, `/admin/tokens/${id}`, {
      ...fields,
      name: 'Second',
    });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain('changed by someone else since you opened this page');
    expect((await serviceRow('openai'))?.name).toBe('First');
  });

  it('keeps the stored time of day when the expiry date is unchanged', async () => {
    const admin = await sessionFor('admin');
    const id = await createViaForm(admin);
    const stored = Date.UTC(2030, 0, 15, 13, 45);
    await env.DB.prepare('UPDATE services SET credential_expires_at = ? WHERE id = ?')
      .bind(stored, id)
      .run();
    const res = await adminPost(app, admin, `/admin/tokens/${id}`, {
      ...OPENAI_FORM,
      name: 'Renamed',
      credential_expires_at: '2030-01-15',
    });
    expect(res.status).toBe(303);
    expect((await serviceRow('openai'))?.credential_expires_at).toBe(stored);
  });

  it('reports a duplicate slug with the form kept', async () => {
    const admin = await sessionFor('admin');
    await createViaForm(admin);
    const res = await adminPost(app, admin, '/admin/tokens', { ...OPENAI_FORM, name: 'Again' });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('another service already uses this slug');
    expect(html).toContain('value="Again"');
    expect(await auditActions()).toEqual(['service.create']);
  });
});
