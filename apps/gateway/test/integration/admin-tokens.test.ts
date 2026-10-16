// Service tokens end to end (A13): the list with its accordion, one form per token type, create
// with derived names, the token page and its forms (/secret rotates, /destination re-points with
// the secret again, details), test, toggle, delete, chips and the hand-off. Audited mutations go
// through the ops; submitted secrets are never rendered back (I-CRED-1).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { destinationFingerprint } from '../../src/admin/ops/services';
import { SERVICE_TEMPLATES } from '../../src/admin/service-templates';
import { getService } from '../../src/db/services';
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
const SECRET = 'sk-proj-test0123456789abcdefghijWXYZ';
const BAD_SECRET = 'sk-proj-wrong000000000000000000000';
const GH_SECRET = 'ghp_ghtest0123456789abcdefghijklmnQRST';
const GH_EXPIRY = '2031-03-04 05:06:07 UTC';

/** Fake upstreams: OpenAI /models answers 200 only for SECRET; GitHub reports an expiry. */
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
    if (url.hostname === 'api.github.com') {
      return Response.json(
        {},
        { headers: { 'github-authentication-token-expiration': GH_EXPIRY } },
      );
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch: fetchImpl, calls };
}

let app: TestApp;
let upstream: ReturnType<typeof fakeUpstream>;

async function sessionFor(role: Role, email = `${role}@example.com`): Promise<AdminSession> {
  return loginAs(app, await createUser({ email, role }));
}

/** Service audit actions in insertion order (logins also write audit rows). */
async function auditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT action FROM audit_log WHERE target_type = 'service' ORDER BY rowid",
  ).all<{ action: string }>();
  return results.map((row) => row.action);
}

/** The rotate form's hidden digest of the destination it shows, as the token page renders it. */
async function rotateFields(id: string): Promise<{ expected_destination: string }> {
  const row = await getService(env.DB, id);
  if (!row) throw new Error(`no service ${id}`);
  return { expected_destination: await destinationFingerprint(row) };
}

async function serviceRow(slug: string) {
  return env.DB.prepare('SELECT * FROM services WHERE slug = ?')
    .bind(slug)
    .first<Record<string, unknown>>();
}

const CUSTOM_FORM = {
  template: 'custom',
  base_url: 'https://api.example.com/v1',
  injection_kind: 'bearer',
  verify_path: '',
};

function idFrom(res: Response): string {
  const location = res.headers.get('location') ?? '';
  const id = /^\/admin\/tokens\/(svc_[0-9A-Z]{26})\?notice=/.exec(location)?.[1];
  if (!id) throw new Error(`unexpected redirect ${res.status} ${location}`);
  return id;
}

/** Creates an OpenAI token (template card) as `session`. */
async function createOpenAi(session: AdminSession, fields: Record<string, string> = {}) {
  const res = await adminPost(app, session, '/admin/tokens', {
    template: 'openai',
    credential: SECRET,
    ...fields,
  });
  expect(res.status, await res.clone().text()).toBe(303);
  return idFrom(res);
}

async function createCustom(session: AdminSession, fields: Record<string, string> = {}) {
  const res = await adminPost(app, session, '/admin/tokens', {
    ...CUSTOM_FORM,
    credential: 'custom-secret-0123456789abcdefWXYZ',
    ...fields,
  });
  expect(res.status, await res.clone().text()).toBe(303);
  return idFrom(res);
}

async function insertGrant(serviceId: string, name: string, id = 'grt_TEST'): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO caller_providers (id, name, profile, issuer, jwks_uri, audience, allowed_algs,
         max_token_age_seconds, tenant_pin, anchor_claims, enabled, created_at, updated_at)
       VALUES ('cpr_TEST', 'GitHub Actions', 'github-actions', 'https://token.actions.githubusercontent.com',
         'https://token.actions.githubusercontent.com/.well-known/jwks', 'tokengate:0123456789ABCDEF',
         '["RS256"]', 600, '[]', '[]', 1, ?, ?)`,
    ).bind(now, now),
    env.DB.prepare(
      `INSERT INTO grants (id, name, description, caller_provider_id, service_id, conditions, rules,
         enabled, expires_at, created_by, created_at, updated_at)
       VALUES (?, ?, '', 'cpr_TEST', ?, ?, '[{"methods":["POST"],"path":"/responses"}]', 1, NULL, NULL, ?, ?)`,
    ).bind(
      id,
      name,
      serviceId,
      JSON.stringify([
        { claim: 'repository', match: 'exact', values: ['acme/api'] },
        { claim: 'environment', match: 'exact', values: ['production'] },
      ]),
      now,
      now,
    ),
  ]);
}

beforeEach(async () => {
  await resetControlPlane();
  upstream = fakeUpstream();
  app = createTestApp({ env: { TOKENGATE_KEK: KEK }, fetch: upstream.fetch });
});

describe('token list', () => {
  it('opens "Add your first token" with one form per token type for token writers', async () => {
    const html = await (
      await adminGet(app, await sessionFor('token_manager'), '/admin/tokens')
    ).text();
    expect(html).toContain('<title>Service tokens – Service tokens – tokengate</title>');
    expect(html).toMatch(
      /<details id="add" class="add-token" open=""><summary>Add your first token/,
    );
    const forms = html.match(/<form method="post" action="\/admin\/tokens"/g) ?? [];
    expect(forms).toHaveLength(SERVICE_TEMPLATES.length + 1);
    for (const template of SERVICE_TEMPLATES) {
      expect(html).toContain(`id="type-${template.id}"`);
      expect(html).toContain(`name="template" value="${template.id}"`);
    }
    expect(html).toContain('name="template" value="custom"');
    // No picker page: the cards are the choice, so there is no link to ?template=.
    expect(html).not.toContain('/admin/tokens/new?template=');
  });

  it('lists tokens for a viewer without the accordion, with the secret hint only', async () => {
    const admin = await sessionFor('admin');
    await createOpenAi(admin);
    const html = await (await adminGet(app, await sessionFor('viewer'), '/admin/tokens')).text();
    expect(html).toContain('<caption id="tokens-cap">Service tokens (1)</caption>');
    expect(html).toContain('<code>openai</code>');
    expect(html).toContain('OpenAI API');
    expect(html).toContain('api.openai.com');
    expect(html).toContain('…WXYZ');
    expect(html).toContain('0 consumers');
    expect(html).not.toContain('id="add"');
    expect(html).not.toContain('type="password"');
    expect(html).toContain('Ask a token manager to add a token');
    expect(html).not.toContain(SECRET);
  });

  it('shows "Used by" chips with consumer, subject and context', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await insertGrant(id, 'deploy');
    const html = await (await adminGet(app, admin, '/admin/tokens')).text();
    expect(html).toContain('GitHub Actions · acme/api · environment production');
    expect(html).toContain('href="/admin/access/grt_TEST"');
  });

  it('filters by status and key, and ignores unknown values', async () => {
    const admin = await sessionFor('admin');
    await createOpenAi(admin);
    const missing = await (await adminGet(app, admin, '/admin/tokens?status=no_credential')).text();
    expect(missing).toContain('No token matches these filters.');
    expect(missing).toContain('No secret');
    const byKey = await (await adminGet(app, admin, '/admin/tokens?key=k1')).text();
    expect(byKey).toContain('Service tokens (1)');
    const unknown = await (
      await adminGet(app, admin, '/admin/tokens?status=<b>x</b>&key=zz')
    ).text();
    expect(unknown).toContain('Service tokens (1)');
    expect(unknown).not.toContain('<b>x</b>');
  });

  it('the chip a screen reader hears starts with its visible text (WCAG 2.5.3)', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await insertGrant(id, 'deploy');
    const html = await (await adminGet(app, admin, '/admin/tokens')).text();
    expect(html).toContain(
      '<span class="vh">GitHub Actions · acme/api · environment production: can use OpenAI',
    );
    const page = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    expect(page).toContain(
      '<span class="vh">acme/api · environment production · 1 operation: can use OpenAI',
    );
  });

  it('keeps the key filter when the status filter is submitted', async () => {
    const admin = await sessionFor('admin');
    for (let n = 0; n < 11; n++) await createCustom(admin, { slug: `api-${n}` });
    const html = await (await adminGet(app, admin, '/admin/tokens?key=k1')).text();
    const form =
      /<form method="get" action="\/admin\/tokens"[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
    expect(form).toContain('<input type="hidden" name="key" value="k1"/>');
    const none = await (await adminGet(app, admin, '/admin/tokens')).text();
    const plain =
      /<form method="get" action="\/admin\/tokens"[\s\S]*?<\/form>/.exec(none)?.[0] ?? '';
    expect(plain).not.toContain('name="key"');
  });

  it('a stored base URL that does not parse fails closed but every page still renders', async () => {
    const owner = await sessionFor('owner');
    const id = await createOpenAi(owner);
    await env.DB.prepare("UPDATE services SET base_url = 'not a url' WHERE id = ?").bind(id).run();
    const list = await adminGet(app, owner, '/admin/tokens');
    expect(list.status).toBe(200);
    const listHtml = await list.text();
    expect(listHtml).toContain('1 token has a base URL that cannot be read');
    expect(listHtml).toContain(`href="/admin/tokens/${id}?open=destination#destination"`);
    expect((await adminGet(app, owner, '/admin/tokens/hosts')).status).toBe(200);
    const page = await adminGet(app, owner, `/admin/tokens/${id}`);
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain('The stored base URL cannot be read');
    expect(pageHtml).toMatch(/<details id="destination-edit" open="">/);
    // The destination form fixes it, with the host typed again (the binding is not attested).
    const calls = upstream.calls.length;
    const saved = await adminPost(app, owner, `/admin/tokens/${id}/destination`, {
      base_url: 'https://api.openai.com/v1',
      injection_kind: 'bearer',
      credential: SECRET,
      confirm_destination: 'api.openai.com',
    });
    expect(saved.status).toBe(303);
    expect((await serviceRow('openai'))?.base_url).toBe('https://api.openai.com/v1');
    expect(
      upstream.calls.slice(calls).every((call) => call.startsWith('https://api.openai.com/')),
    ).toBe(true);
  });

  it('opens the accordion with ?open=add once tokens exist', async () => {
    const admin = await sessionFor('admin');
    await createOpenAi(admin);
    const closed = await (await adminGet(app, admin, '/admin/tokens')).text();
    expect(closed).toMatch(/<details id="add" class="add-token"><summary>Add a token/);
    const open = await (await adminGet(app, admin, '/admin/tokens?open=add')).text();
    expect(open).toMatch(/<details id="add" class="add-token" open=""><summary>Add a token/);
  });
});

describe('the standalone accordion', () => {
  it('opens the card named by ?template=', async () => {
    const res = await adminGet(
      app,
      await sessionFor('admin'),
      '/admin/tokens/new?template=slack-webhook',
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Add a service token – Service tokens – tokengate</title>');
    expect(html).toMatch(
      /<details name="token-type" class="type-card" id="type-slack-webhook" open="">/,
    );
    expect(html).not.toMatch(/id="type-slack" open/);
    expect(html).toContain(
      'placeholder="https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"',
    );
  });

  it.each(['viewer', 'access_manager'] as const)('is forbidden for %s', async (role) => {
    expect((await adminGet(app, await sessionFor(role), '/admin/tokens/new')).status).toBe(403);
  });
});

describe('create', () => {
  it('one submit: the template supplies destination, headers, timeout and check', async () => {
    const admin = await sessionFor('admin');
    const res = await adminPost(app, admin, '/admin/tokens', {
      template: 'openai',
      credential: SECRET,
    });
    expect(res.status).toBe(303);
    const id = idFrom(res);
    expect(res.headers.get('location')).toBe(`/admin/tokens/${id}?notice=created_verified`);
    const row = await serviceRow('openai');
    expect(row).toMatchObject({
      name: 'OpenAI',
      base_url: 'https://api.openai.com/v1',
      injection: '{"kind":"bearer"}',
      forward_headers: '["openai-organization","openai-project","openai-beta"]',
      timeout_ms: 600000,
      verify: '{"expect_status":200,"method":"GET","path":"/models"}',
      template_id: 'openai',
    });
    expect(upstream.calls).toEqual(['https://api.openai.com/v1/models']);
    expect(await auditActions()).toEqual(['service.create']);

    const page = await (
      await adminGet(app, admin, `/admin/tokens/${id}?notice=created_verified`)
    ).text();
    expect(page).toContain('OpenAI created (slug openai); the secret check passed.');
    expect(page).toContain('href="/admin/access/new?token=' + id);
    expect(page).toContain('value="https://gw.test/proxy/openai"');
    expect(page).not.toContain(SECRET);
  });

  it('derives a free slug and name on a clash, and refuses a typed taken slug before the check', async () => {
    const admin = await sessionFor('admin');
    await createOpenAi(admin);
    await createOpenAi(admin);
    expect(await serviceRow('openai-2')).toMatchObject({ name: 'OpenAI 2' });
    const form = await (await adminGet(app, admin, '/admin/tokens/new?template=openai')).text();
    expect(form).toContain('placeholder="openai-3"');
    expect(form).toContain('placeholder="OpenAI 3"');

    const calls = upstream.calls.length;
    const taken = await adminPost(app, admin, '/admin/tokens', {
      template: 'openai',
      credential: SECRET,
      slug: 'openai',
    });
    expect(taken.status).toBe(409);
    const html = await taken.text();
    expect(html).toContain('Another token already uses openai; leave empty to use openai-3');
    expect(html).toContain('href="#f-openai-slug"');
    expect(upstream.calls.length).toBe(calls);
  });

  it('a custom token maps the per-kind fields and derives its slug from the host', async () => {
    const admin = await sessionFor('admin');
    await createCustom(admin, {
      injection_kind: 'header',
      injection_header_name: ' X-Api-Key ',
      injection_header_prefix: 'Token ',
      injection_param: 'ignored',
      forward_headers: 'OpenAI-Beta, openai-project',
    });
    const row = await serviceRow('example');
    expect(row).toMatchObject({
      name: 'example',
      injection: '{"kind":"header","name":"x-api-key","prefix":"Token "}',
      forward_headers: '["openai-beta","openai-project"]',
      verify: null,
      template_id: null,
    });
  });

  it('re-renders an invalid custom form with linked errors and values, never the secret', async () => {
    const admin = await sessionFor('admin');
    const res = await adminPost(app, admin, '/admin/tokens', {
      ...CUSTOM_FORM,
      slug: 'Bad Slug',
      base_url: 'http://127.0.0.1/api',
      credential: SECRET,
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('<title>Error: Add a service token');
    expect(html).toContain('href="#f-custom-base_url"');
    expect(html).toMatch(/id="f-custom-base_url"[^>]*aria-invalid="true"/);
    expect(html).toContain('value="Bad Slug"');
    expect(html).toContain('value="http://127.0.0.1/api"');
    expect(html).toMatch(/<details name="token-type" class="type-card" id="type-custom" open="">/);
    // No draft: the destination is invalid, so there is nothing to bind it to.
    expect(html).not.toContain('name="credential_draft"');
    expect(html).not.toContain(SECRET);
    expect(await auditActions()).toEqual([]);
    expect(upstream.calls).toEqual([]);
  });

  it('reports a bad expiry and a taken slug in the same re-render, before anything is sent', async () => {
    const admin = await sessionFor('admin');
    await createOpenAi(admin);
    const calls = upstream.calls.length;
    const res = await adminPost(app, admin, '/admin/tokens', {
      template: 'openai',
      credential: SECRET,
      slug: 'openai',
      credential_expires_at: '31/12/2027',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('href="#f-openai-credential_expires_at"');
    expect(html).toContain('Another token already uses openai; leave empty to use openai-2');
    expect(upstream.calls.length).toBe(calls);
  });

  it('the custom card says how an empty slug and name are derived', async () => {
    const html = await (
      await adminGet(app, await sessionFor('admin'), '/admin/tokens/new?template=custom')
    ).text();
    const card = /id="type-custom"[\s\S]*?<\/details>/.exec(html)?.[0] ?? '';
    expect(card).toContain(
      'Leave empty to use the API host&#39;s name, e.g. stripe for https://api.stripe.com/v1.',
    );
    expect(card).toContain('Leave empty to use the slug.');
    expect(card).not.toContain('Leave empty to use the placeholder.');
  });

  it('rejects a malformed expiry date', async () => {
    const res = await adminPost(app, await sessionFor('admin'), '/admin/tokens', {
      template: 'openai',
      credential: SECRET,
      credential_expires_at: '31/12/2027',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('2027-01-31');
    expect(await auditActions()).toEqual([]);
  });

  it('keeps the secret as a draft after a failed check; "Save without a passing check" saves', async () => {
    const admin = await sessionFor('admin');
    const first = await adminPost(app, admin, '/admin/tokens', {
      template: 'openai',
      credential: BAD_SECRET,
    });
    expect(first.status).toBe(422);
    const html = await first.text();
    expect(html).toContain('Check failed');
    expect(html).toContain('(HTTP 401)');
    expect(html).toContain('Check again and save');
    expect(html).toContain('name="save_anyway" value="1"');
    expect(html.indexOf('Check again and save')).toBeLessThan(html.indexOf('name="save_anyway"'));
    // The error names the secret's label and the way out (A7.3).
    expect(html).toContain(
      'The check of the API key failed (expected HTTP 200, got 401). Check the API key, or choose Save without a passing check',
    );
    expect(html).toContain('Secret kept for 15 minutes');
    expect(html).not.toContain(BAD_SECRET);
    const draft = /name="credential_draft" value="([^"]+)"/.exec(html)?.[1];
    expect(draft).toMatch(/^cd1\./);
    expect(await auditActions()).toEqual([]);

    const saved = await adminPost(app, admin, '/admin/tokens', {
      template: 'openai',
      credential_draft: draft ?? '',
      save_anyway: '1',
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toContain('?notice=created_unverified');
    expect((await serviceRow('openai'))?.credential_hint).toBe(
      `…${BAD_SECRET.slice(-4)} (${BAD_SECRET.length} chars)`,
    );
  });

  it('GitHub with also_uploads creates both tokens from one paste', async () => {
    const admin = await sessionFor('admin');
    const res = await adminPost(app, admin, '/admin/tokens', {
      template: 'github',
      credential: GH_SECRET,
      also_uploads: '1',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).not.toContain('also=');
    const api = await serviceRow('github');
    const uploads = await serviceRow('github-uploads');
    expect(uploads).toMatchObject({
      template_id: 'github-uploads',
      credential_hint: api?.credential_hint,
    });
    expect(api?.credential_expires_at).toBe(Date.UTC(2031, 2, 4, 5, 6, 7));
    expect(uploads?.credential_expires_at).toBe(Date.UTC(2031, 2, 4, 5, 6, 7));
    expect(await auditActions()).toEqual(['service.create', 'service.create']);
  });

  it('is forbidden for viewers and access managers and writes nothing', async () => {
    for (const role of ['viewer', 'access_manager'] as const) {
      const res = await adminPost(app, await sessionFor(role), '/admin/tokens', {
        template: 'openai',
        credential: SECRET,
      });
      expect(res.status).toBe(403);
    }
    expect(await serviceRow('openai')).toBeNull();
    expect(await auditActions()).toEqual([]);
  });

  it('escapes names containing markup', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin, { name: '<script>alert(1)</script>' });
    for (const path of ['/admin/tokens', `/admin/tokens/${id}`]) {
      const html = await (await adminGet(app, admin, path)).text();
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
  });
});

describe('token page', () => {
  it('shows read-only sections to viewers and 404 for unknown ids', async () => {
    const id = await createOpenAi(await sessionFor('admin'));
    const viewer = await sessionFor('viewer');
    const res = await adminGet(app, viewer, `/admin/tokens/${id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const section of ['consumers', 'secret', 'use', 'destination']) {
      expect(html).toContain(`id="${section}"`);
    }
    expect(html).toContain('0 consumers can use this token');
    expect(html).toContain('OpenAI API');
    expect(html).not.toContain('<form method="post" action="/admin/tokens/');
    expect(html).not.toContain('id="danger"');
    expect(html).toContain(`href="/admin/audit?target=${id}"`);

    const missing = await adminGet(app, viewer, '/admin/tokens/svc_00000000000000000000000000');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('There is no service token with this ID');
  });

  it('warns about query injection', async () => {
    const admin = await sessionFor('admin');
    const id = await createCustom(admin, { injection_kind: 'query', injection_param: 'api_key' });
    const html = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    expect(html).toContain('Upstreams may echo URLs');
  });

  it('a token without a secret opens Change destination with the host confirmation', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await env.DB.prepare('UPDATE services SET credential_sealed = NULL WHERE id = ?')
      .bind(id)
      .run();
    const html = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    expect(html).toContain('No secret is stored, so requests through this token fail.');
    expect(html).toMatch(/<details id="destination-edit" open="">/);
    expect(html).toContain('name="confirm_destination"');
    expect(html).toContain('Set the secret through Change destination below');
    expect(html).not.toContain(`action="/admin/tokens/${id}/secret"`);
  });

  it('counts consumers that can use the token and lists the hand-off for token managers', async () => {
    await createUser({ email: 'am@example.com', role: 'access_manager' });
    await createUser({ email: 'gone@example.com', role: 'access_manager', status: 'suspended' });
    const manager = await sessionFor('token_manager');
    const id = await createOpenAi(manager);
    await insertGrant(id, 'deploy');
    await insertGrant(id, 'old', 'grt_OLD');
    await env.DB.prepare("UPDATE grants SET enabled = 0 WHERE id = 'grt_OLD'").run();
    const html = await (await adminGet(app, manager, `/admin/tokens/${id}`)).text();
    expect(html).toContain('1 consumer can use this token (1 access)');
    expect(html).toContain('acme/api · environment production · 1 operation');
    expect(html).toContain('Consumer access is granted by access managers. Send them this link:');
    expect(html).toContain(`value="https://gw.test/admin/access/new?token=${id}"`);
    expect(html).toContain('mailto:am@example.com?subject=Access%20to%20service%20token%20OpenAI');
    expect(html).not.toContain('gone@example.com');
    expect(html).not.toContain('>Give a consumer access<');

    const access = await sessionFor('access_manager', 'am2@example.com');
    const accessHtml = await (await adminGet(app, access, `/admin/tokens/${id}`)).text();
    expect(accessHtml).toContain(`href="/admin/access/new?token=${id}"`);
    expect(accessHtml).not.toContain('<form method="post" action="/admin/tokens/');
  });
});

describe('last used', () => {
  it('comes from the hourly rollups, or says the sample rate records nothing', async () => {
    await env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly').run();
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await insertGrant(id, 'deploy');
    const hour = Math.floor((Date.now() - 3 * 3_600_000) / 3_600_000) * 3_600_000;
    await env.TELEMETRY_DB.prepare(
      `INSERT INTO request_rollup_hourly (hour, service_id, grant_id, outcome, status_class, requests,
         upstream_auth_fail, duration_sum_ms) VALUES (?, ?, 'grt_TEST', 'allowed', 2, 4, 0, 40)`,
    )
      .bind(hour, id)
      .run();
    const list = await (await adminGet(app, admin, '/admin/tokens')).text();
    expect(list).toContain(`<time datetime="${new Date(hour).toISOString()}">3 h ago</time>`);
    const page = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    expect(page).toContain('last used 3 h ago');

    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('allowed_sample_rate', '0', 0, NULL)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run();
    const unrecorded = await (await adminGet(app, admin, '/admin/tokens')).text();
    expect(unrecorded).toContain('not recorded (sample rate 0)');
    await env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly').run();
  });
});

describe('details form', () => {
  it('updates non-binding fields and ignores a posted base URL', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const res = await adminPost(app, admin, `/admin/tokens/${id}`, {
      name: 'OpenAI prod',
      timeout_ms: '300000',
      verify_path: '/models',
      credential_expires_at: '2030-06-01',
      base_url: 'https://evil.example.com',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin/tokens/${id}?notice=updated#details`);
    expect(await serviceRow('openai')).toMatchObject({
      name: 'OpenAI prod',
      timeout_ms: 300000,
      base_url: 'https://api.openai.com/v1',
      credential_expires_at: Date.UTC(2030, 5, 1),
    });
    expect(await auditActions()).toEqual(['service.create', 'service.update']);
  });

  it('re-renders open with the errors at the fields', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const res = await adminPost(app, admin, `/admin/tokens/${id}`, {
      name: 'OpenAI',
      forward_headers: 'authorization',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/<details id="details" open="">/);
    expect(html).toContain('href="#f-details-forward_headers"');
    expect(html).toMatch(/<details class="advanced" open="">/);
    expect(await auditActions()).toEqual(['service.create']);
  });

  it('refuses a save over a newer change with 409 and keeps the stored time of day', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const page = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    const opened = /name="expected_updated_at" value="(\d+)"/.exec(page)?.[1] ?? '';
    const first = await adminPost(app, admin, `/admin/tokens/${id}`, {
      name: 'First',
      expected_updated_at: opened,
    });
    expect(first.status).toBe(303);
    const stale = await adminPost(app, admin, `/admin/tokens/${id}`, {
      name: 'Second',
      expected_updated_at: opened,
    });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain('changed by someone else since you opened this page');

    const stored = Date.UTC(2030, 0, 15, 13, 45);
    await env.DB.prepare('UPDATE services SET credential_expires_at = ? WHERE id = ?')
      .bind(stored, id)
      .run();
    await adminPost(app, admin, `/admin/tokens/${id}`, {
      name: 'Renamed',
      credential_expires_at: '2030-01-15',
    });
    expect((await serviceRow('openai'))?.credential_expires_at).toBe(stored);
  });
});

describe('rotate (POST /admin/tokens/:id/secret)', () => {
  it('the inline form has only the secret and the prefilled future expiry', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin, { credential_expires_at: '2032-01-01' });
    const html = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    const form =
      new RegExp(`<form method="post" action="/admin/tokens/${id}/secret"[\\s\\S]*?</form>`).exec(
        html,
      )?.[0] ?? '';
    const names = [...form.matchAll(/ name="([^"]+)"/g)].map((match) => match[1]);
    expect(names.sort()).toEqual([
      '_csrf',
      'credential',
      'credential_expires_at',
      'expected_destination',
    ]);
    expect(form).toContain('value="2032-01-01"');
    expect(form).toContain('Sent to api.openai.com. Replaces …WXYZ');
    // A digest of the destination, never the destination itself (I-CRED-2).
    expect(form).toContain(
      `name="expected_destination" value="${(await rotateFields(id)).expected_destination}"`,
    );
    expect(form).not.toMatch(/value="https:/);
  });

  it('does not prefill a past or near expiry', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await env.DB.prepare('UPDATE services SET credential_expires_at = ? WHERE id = ?')
      .bind(Date.now() - 86_400_000, id)
      .run();
    const html = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    const form =
      new RegExp(`action="/admin/tokens/${id}/secret"[\\s\\S]*?</form>`).exec(html)?.[0] ?? '';
    expect(form).toMatch(/name="credential_expires_at" type="date" value=""/);
    expect(html).toContain('enter the new one&#39;s');
  });

  it('keeps the stored destination, ignores a posted base URL and keeps an unchanged expiry', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin, { credential_expires_at: '2032-01-01' });
    const before = await serviceRow('openai');
    const res = await adminPost(app, admin, `/admin/tokens/${id}/secret`, {
      ...(await rotateFields(id)),
      credential: SECRET,
      credential_expires_at: '2032-01-01',
      base_url: 'https://evil.example.com',
      injection_kind: 'query',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin/tokens/${id}?notice=secret_verified#secret`);
    const after = await serviceRow('openai');
    expect(after?.base_url).toBe('https://api.openai.com/v1');
    expect(after?.injection).toBe('{"kind":"bearer"}');
    expect(after?.credential_expires_at).toBe(Date.UTC(2032, 0, 1));
    expect(after?.credential_sealed).not.toBe(before?.credential_sealed);
    expect(upstream.calls.filter((call) => call.includes('evil'))).toEqual([]);
  });

  it('refuses a token repointed since the page was loaded: 409, nothing sent, nothing written, no draft', async () => {
    const admin = await sessionFor('admin');
    const other = await sessionFor('token_manager');
    const id = await createOpenAi(admin);
    const loaded = await rotateFields(id);
    // Another token manager repoints it (with a dummy secret of their own) after A loaded the page.
    const repoint = await adminPost(app, other, `/admin/tokens/${id}/destination`, {
      base_url: 'https://api.attacker.example/v1',
      injection_kind: 'bearer',
      credential: BAD_SECRET,
      save_anyway: '1',
    });
    expect(repoint.status).toBe(303);
    const row = await serviceRow('openai');
    const audits = (await auditActions()).length;
    const calls = upstream.calls.length;
    const res = await adminPost(app, admin, `/admin/tokens/${id}/secret`, {
      ...loaded,
      credential: SECRET,
    });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('it now sends the secret to api.attacker.example');
    expect(html).not.toContain('name="credential_draft"');
    expect(html).not.toContain(SECRET);
    expect(upstream.calls.slice(calls)).toEqual([]);
    expect(await serviceRow('openai')).toEqual(row);
    expect((await auditActions()).length).toBe(audits);
    // The re-rendered form names the new destination and carries its digest.
    expect(html).toContain('Sent to api.attacker.example.');
    expect(html).toContain(`value="${(await rotateFields(id)).expected_destination}"`);
  });

  it('refuses a rotate without the destination digest', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const calls = upstream.calls.length;
    const res = await adminPost(app, admin, `/admin/tokens/${id}/secret`, { credential: SECRET });
    expect(res.status).toBe(409);
    expect(upstream.calls.slice(calls)).toEqual([]);
  });

  it('reads a GitHub expiry from the check (no expiry field)', async () => {
    const admin = await sessionFor('admin');
    const id = idFrom(
      await adminPost(app, admin, '/admin/tokens', { template: 'github', credential: GH_SECRET }),
    );
    const html = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    const form =
      new RegExp(`action="/admin/tokens/${id}/secret"[\\s\\S]*?</form>`).exec(html)?.[0] ?? '';
    expect(form).not.toContain('credential_expires_at');
    expect(html).toContain('(read from GitHub)');
    await env.DB.prepare('UPDATE services SET credential_expires_at = NULL WHERE id = ?')
      .bind(id)
      .run();
    const res = await adminPost(app, admin, `/admin/tokens/${id}/secret`, {
      ...(await rotateFields(id)),
      credential: GH_SECRET,
    });
    expect(res.status).toBe(303);
    expect((await serviceRow('github'))?.credential_expires_at).toBe(Date.UTC(2031, 2, 4, 5, 6, 7));
  });

  it('is refused with 422 while the stored binding is not attested, pointing to Change destination', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await env.DB.prepare("UPDATE services SET base_url = 'https://api.openai.com/v2' WHERE id = ?")
      .bind(id)
      .run();
    const res = await adminPost(app, admin, `/admin/tokens/${id}/secret`, {
      ...(await rotateFields(id)),
      credential: SECRET,
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('href="#f-destination-base_url"');
    expect(html).toMatch(/<details id="destination-edit" open="">/);
    expect(upstream.calls.filter((call) => call.includes('/v2'))).toEqual([]);
  });

  it('replaces the same secret in the GitHub uploads sibling, one audit row each', async () => {
    const admin = await sessionFor('admin');
    const api = idFrom(
      await adminPost(app, admin, '/admin/tokens', {
        template: 'github',
        credential: GH_SECRET,
        also_uploads: '1',
      }),
    );
    // Same hint, different secret: not a sibling.
    const other = `ghp_otherSecret00000000000000000${GH_SECRET.slice(-4)}`;
    await adminPost(app, admin, '/admin/tokens', {
      template: 'github-uploads',
      credential: other,
      slug: 'uploads-other',
    });
    const uploads = (await serviceRow('github-uploads'))?.id as string;
    const html = await (await adminGet(app, admin, `/admin/tokens/${api}`)).text();
    expect(html).toMatch(new RegExp(`name="also_replace" value="${uploads}" checked=""`));
    expect(html).toContain('Also replace in github-uploads');
    expect(html).not.toContain('Also replace in uploads-other');

    const rotated = 'ghp_rotated000000000000000000000000ROTA';
    const before = (await auditActions()).length;
    const res = await adminPost(app, admin, `/admin/tokens/${api}/secret`, {
      ...(await rotateFields(api)),
      credential: rotated,
      also_replace: uploads,
    });
    expect(res.status).toBe(303);
    expect((await auditActions()).slice(before)).toEqual([
      'service.credential.set',
      'service.credential.set',
    ]);
    expect((await serviceRow('github-uploads'))?.credential_hint).toBe('…ROTA (39 chars)');
    expect((await serviceRow('uploads-other'))?.credential_hint).not.toBe('…ROTA (39 chars)');
  });

  it('says so when a ticked sibling no longer holds the same secret', async () => {
    const admin = await sessionFor('admin');
    const api = idFrom(
      await adminPost(app, admin, '/admin/tokens', { template: 'github', credential: GH_SECRET }),
    );
    const other = idFrom(
      await adminPost(app, admin, '/admin/tokens', {
        template: 'github-uploads',
        credential: `ghp_otherSecret00000000000000000${GH_SECRET.slice(-4)}`,
      }),
    );
    const res = await adminPost(app, admin, `/admin/tokens/${api}/secret`, {
      ...(await rotateFields(api)),
      credential: 'ghp_rotated000000000000000000000000ROTA',
      also_replace: other,
    });
    expect(res.headers.get('location')).toBe(
      `/admin/tokens/${api}?notice=secret_verified&also=sibling_failed#secret`,
    );
    const html = await (await adminGet(app, admin, res.headers.get('location') ?? '')).text();
    expect(html).toContain('It was not replaced in every other token that held the same secret');
  });
});

describe('change destination (POST /admin/tokens/:id/destination)', () => {
  it('re-seals with a new destination; a failed check keeps a draft for "Save without"', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const before = await serviceRow('openai');
    const fields = { base_url: 'https://api.openai.com/v2', injection_kind: 'bearer' };
    const failed = await adminPost(app, admin, `/admin/tokens/${id}/destination`, {
      ...fields,
      credential: BAD_SECRET,
    });
    expect(failed.status).toBe(422);
    const html = await failed.text();
    expect(html).toMatch(/<details id="destination-edit" open="">/);
    expect(html).toContain('value="https://api.openai.com/v2"');
    expect(html).not.toContain(BAD_SECRET);
    const draft = /name="credential_draft" value="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(await serviceRow('openai')).toEqual(before);

    const saved = await adminPost(app, admin, `/admin/tokens/${id}/destination`, {
      ...fields,
      credential_draft: draft,
      save_anyway: '1',
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe(
      `/admin/tokens/${id}?notice=destination_changed#destination`,
    );
    const after = await serviceRow('openai');
    expect(after?.base_url).toBe('https://api.openai.com/v2');
    // No longer the OpenAI template's destination.
    expect(after?.template_id).toBeNull();
    expect(await auditActions()).toEqual(['service.create', 'service.credential.set']);
  });

  it('requires the secret', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const res = await adminPost(app, admin, `/admin/tokens/${id}/destination`, {
      base_url: 'https://api.openai.com/v1',
      injection_kind: 'header',
      injection_header_name: 'X-Api-Key',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Enter the secret');
    expect(await auditActions()).toEqual(['service.create']);
  });

  it('recomputes the template when a destination becomes a template one', async () => {
    const admin = await sessionFor('admin');
    const id = await createCustom(admin, { base_url: 'https://api.github.com' });
    expect((await serviceRow('github'))?.template_id).toBe('github');
    const res = await adminPost(app, admin, `/admin/tokens/${id}/destination`, {
      base_url: 'https://api.github.com/v3',
      injection_kind: 'bearer',
      credential: GH_SECRET,
    });
    expect(res.status).toBe(303);
    expect((await serviceRow('github'))?.template_id).toBeNull();
  });
});

describe('test, toggle, delete', () => {
  it('tests the stored secret and shows the result as a status', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const res = await adminPost(app, admin, `/admin/tokens/${id}/test`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<div class="check-result passed" role="status">/);
    expect(await auditActions()).toEqual(['service.create', 'service.credential.test']);
  });

  it('a test that reads a new GitHub expiry saves it as its own audited change', async () => {
    const admin = await sessionFor('admin');
    const id = idFrom(
      await adminPost(app, admin, '/admin/tokens', { template: 'github', credential: GH_SECRET }),
    );
    await env.DB.prepare('UPDATE services SET credential_expires_at = 1 WHERE id = ?')
      .bind(id)
      .run();
    const res = await adminPost(app, admin, `/admin/tokens/${id}/test`);
    expect(res.status).toBe(200);
    expect(await auditActions()).toEqual([
      'service.create',
      'service.credential.test',
      'service.update',
    ]);
    expect((await serviceRow('github'))?.credential_expires_at).toBe(Date.UTC(2031, 2, 4, 5, 6, 7));
  });

  it('disables with an "Enable again" undo, and enables', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const off = await adminPost(app, admin, `/admin/tokens/${id}/toggle`, {
      enabled: '0',
      _return: 'detail',
    });
    expect(off.headers.get('location')).toBe(`/admin/tokens/${id}?notice=disabled`);
    const page = await (await adminGet(app, admin, `/admin/tokens/${id}?notice=disabled`)).text();
    expect(page).toContain('Enable again');
    expect((await serviceRow('openai'))?.enabled).toBe(0);
    const on = await adminPost(app, admin, `/admin/tokens/${id}/toggle`, { enabled: '1' });
    expect(on.headers.get('location')).toBe(`/admin/tokens/${id}?notice=enabled`);
    const list = await adminPost(app, admin, `/admin/tokens/${id}/toggle`, {
      enabled: '0',
      _return: 'list',
    });
    expect(list.headers.get('location')).toBe('/admin/tokens?notice=disabled');
    expect(await auditActions()).toEqual([
      'service.create',
      'service.disable',
      'service.enable',
      'service.disable',
    ]);
    const bad = await adminPost(app, admin, `/admin/tokens/${id}/toggle`, { enabled: 'yes' });
    expect(bad.status).toBe(400);
  });

  it('deletes through the confirm dialog; the server requires confirm=1', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const page = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    expect(page).toContain('commandfor="dlg-delete"');
    expect(page).toContain('Delete OpenAI…');
    const unconfirmed = await adminPost(app, admin, `/admin/tokens/${id}/delete`);
    expect(unconfirmed.status).toBe(400);
    const deleted = await adminPost(app, admin, `/admin/tokens/${id}/delete`, { confirm: '1' });
    expect(deleted.headers.get('location')).toBe('/admin/tokens?notice=deleted');
    expect(await serviceRow('openai')).toBeNull();
  });

  it('refuses a plain delete while consumer access uses the token', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await insertGrant(id, 'deploy <bot>');
    const blocked = await adminPost(app, admin, `/admin/tokens/${id}/delete`, { confirm: '1' });
    expect(blocked.status).toBe(409);
    const html = await blocked.text();
    expect(html).toContain('delete them first');
    expect(html).toContain('deploy &lt;bot&gt;');
    expect(await serviceRow('openai')).not.toBeNull();
  });
});

describe('review: forms and notices', () => {
  it('puts a CSRF token in every POST form of the token page', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const html = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    const forms = html.match(/<form method="post"[\s\S]*?<\/form>/g) ?? [];
    // test, rotate, destination, details, disable, delete (+ the footer export)
    expect(forms.length).toBeGreaterThanOrEqual(6);
    for (const form of forms) expect(form).toContain(`name="_csrf" value="${admin.csrfToken}"`);
  });

  it('refuses a POST without the CSRF token and writes nothing', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const res = await adminPost(
      app,
      admin,
      `/admin/tokens/${id}/toggle`,
      { enabled: '0' },
      { csrf: null },
    );
    expect(res.status).toBe(403);
    expect((await serviceRow('openai'))?.enabled).toBe(1);
  });

  it('shows only known notices, never query text', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    for (const notice of ['<b>pwned</b>', 'constructor', '__proto__', 'toString']) {
      const html = await (
        await adminGet(
          app,
          admin,
          `/admin/tokens/${id}?notice=${encodeURIComponent(notice)}&also=<i>x</i>`,
        )
      ).text();
      expect(html).not.toContain('pwned');
      expect(html).not.toContain('<i>x</i>');
      expect(html).not.toContain('class="notice"');
    }
  });
});
