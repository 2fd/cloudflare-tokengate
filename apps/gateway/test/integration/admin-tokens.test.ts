// Credentials end to end (A13): the list with its accordion, one form per credential type, create
// with derived names, the token page and its forms (/secret rotates, /destination re-points with
// the secret again, details), test, toggle, delete, chips and the hand-off. Audited mutations go
// through the ops; submitted secrets are never rendered back (I-CRED-1).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { destinationFingerprint } from '../../src/admin/ops/credentials';
import { SERVICE_TEMPLATES } from '../../src/admin/service-templates';
import { loadKeyring } from '../../src/crypto/keyring';
import { getService } from '../../src/db/credentials';
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
import { createTestApp, TEST_ACCESS_ENV, type TestApp } from '../helpers/app';

const KEK = toBase64(new Uint8Array(32).fill(7));
const SECRET = 'sk-proj-test0123456789abcdefghijWXYZ';
const BAD_SECRET = 'sk-proj-wrong000000000000000000000';
const GH_SECRET = 'ghp_ghtest0123456789abcdefghijklmnQRST';
const SLACK_SECRET = 'xoxb-1111-2222-abcdefghijklmnopWXYZ';

/**
 * Fake upstreams: OpenAI /models answers 200 only for SECRET; GitHub answers 200; Slack's
 * auth.test names the bot B0123ABC and bots.info its display name, `slackBot.name`.
 */
function fakeUpstream() {
  const calls: string[] = [];
  const slackBot = { name: 'Deploy Bot' };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.href);
    const auth = new Headers(init?.headers).get('authorization');
    if (url.pathname.endsWith('/models')) {
      return auth === `Bearer ${SECRET}`
        ? Response.json({ data: [] })
        : Response.json({ error: 'invalid key' }, { status: 401 });
    }
    if (url.hostname === 'api.github.com') return Response.json({});
    if (url.hostname === 'slack.com' && auth === `Bearer ${SLACK_SECRET}`) {
      return url.pathname === '/api/bots.info'
        ? Response.json({ ok: true, bot: { id: 'B0123ABC', name: slackBot.name } })
        : Response.json({ ok: true, user: 'deploy-bot', bot_id: 'B0123ABC' });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch: fetchImpl, calls, slackBot };
}

/** Key id of KEK: its key check value (ADR 0027). */
async function kekKid(): Promise<string> {
  const loaded = await loadKeyring({ ...TEST_ACCESS_ENV, TOKENGATE_KEK: KEK });
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.keyring.activeKid;
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
  return env.DB.prepare('SELECT * FROM credentials WHERE slug = ?')
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
  const id = /^\/admin\/credentials\/(svc_[0-9A-Z]{26})\?notice=/.exec(location)?.[1];
  if (!id) throw new Error(`unexpected redirect ${res.status} ${location}`);
  return id;
}

/** Creates an OpenAI token (template card) as `session`. */
async function createOpenAi(session: AdminSession, fields: Record<string, string> = {}) {
  const res = await adminPost(app, session, '/admin/credentials', {
    template: 'openai',
    credential: SECRET,
    ...fields,
  });
  expect(res.status, await res.clone().text()).toBe(303);
  return idFrom(res);
}

async function createCustom(session: AdminSession, fields: Record<string, string> = {}) {
  const res = await adminPost(app, session, '/admin/credentials', {
    ...CUSTOM_FORM,
    credential: 'custom-secret-0123456789abcdefWXYZ',
    ...fields,
  });
  expect(res.status, await res.clone().text()).toBe(303);
  return idFrom(res);
}

const RULE_ID = 'acr_01JAAAAAAAAAAAAAAAAAAAAAAA';
const OLD_RULE_ID = 'acr_01JBBBBBBBBBBBBBBBBBBBBBBB';

/** A GitHub Actions credential access rule of `serviceId` for acme/api in production. */
async function insertRule(serviceId: string, name: string, id = RULE_ID): Promise<void> {
  const now = Date.now();
  const issuer = 'https://token.actions.githubusercontent.com';
  await env.DB.prepare(
    `INSERT INTO access_rules (id, credential_id, name, profile, issuer, issuer_key, jwks_uri, audience,
       allowed_algs, max_token_age_seconds, tenant_pin, anchor_claims, conditions, rules, enabled,
       created_at, updated_at)
     VALUES (?, ?, ?, 'github-actions', ?, ?, ?, 'tokengate:0123456789ABCDEF', '["RS256"]', 600, '[]',
       '[]', ?, '[{"methods":["POST"],"path":"/responses"}]', 1, ?, ?)`,
  )
    .bind(
      id,
      serviceId,
      name,
      issuer,
      issuer,
      `${issuer}/.well-known/jwks`,
      JSON.stringify([
        { claim: 'repository', match: 'exact', values: ['acme/api'] },
        { claim: 'environment', match: 'exact', values: ['production'] },
      ]),
      now,
      now,
    )
    .run();
}

beforeEach(async () => {
  await resetControlPlane();
  upstream = fakeUpstream();
  app = createTestApp({ env: { TOKENGATE_KEK: KEK }, fetch: upstream.fetch });
});

describe('token list', () => {
  it('an empty list offers "Add a credential"; the catalog has one form per credential type', async () => {
    const manager = await sessionFor('token_manager');
    const html = await (await adminGet(app, manager, '/admin/credentials')).text();
    expect(html).toContain('<title>Credentials – tokengate</title>');
    expect(html).toContain('No credentials yet');
    // One primary per view: the empty state holds it, the header has none.
    const primaries = html.match(/<a class="btn primary" href="\/admin\/credentials\/new">/g) ?? [];
    expect(primaries).toHaveLength(1);
    expect(html).toMatch(
      /<a class="btn primary" href="\/admin\/credentials\/new">[\s\S]*?Add a credential<\/a>/,
    );
    expect(html).not.toMatch(/<form\b[^>]*\bmethod="post"[^>]*action="\/admin\/credentials"/);

    const catalog = await (await adminGet(app, manager, '/admin/credentials/new')).text();
    const forms =
      catalog.match(/<form class="type-body[^"]*" method="post" action="\/admin\/credentials"/g) ??
      [];
    expect(forms).toHaveLength(SERVICE_TEMPLATES.length + 1);
    for (const template of SERVICE_TEMPLATES) {
      expect(catalog).toContain(`id="type-${template.id}"`);
      expect(catalog).toContain(`name="template" value="${template.id}"`);
    }
    expect(catalog).toContain('name="template" value="custom"');
    // No picker page: the cards are the choice, so there is no link to ?template=.
    expect(catalog).not.toContain('/admin/credentials/new?template=');
  });

  it('lists tokens for a viewer with the masked secret and who to ask, and no form', async () => {
    const admin = await sessionFor('admin');
    await createOpenAi(admin);
    const html = await (
      await adminGet(app, await sessionFor('viewer'), '/admin/credentials')
    ).text();
    expect(html).toContain('<caption class="vh">Credentials (1)</caption>');
    expect(html).toMatch(
      /<a class="ent-n" href="\/admin\/credentials\/svc_[0-9A-Z]{26}">OpenAI<\/a> <span class="slug">openai<\/span>/,
    );
    expect(html).toContain('OpenAI API');
    expect(html).toContain('api.openai.com');
    expect(html).toContain('<span class="vh">Secret ending in </span>WXYZ');
    expect(html).toContain('No credential access rule');
    expect(html).not.toContain('Add credential');
    expect(html).not.toContain('type="password"');
    expect(html).toContain('Only credential managers can add a credential');
    expect(html).not.toContain(SECRET);
  });

  it('shows who uses a credential: issuer tiles, a count link and the issuers', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await insertRule(id, 'deploy');
    const html = await (await adminGet(app, admin, '/admin/credentials')).text();
    expect(html).toMatch(
      /<span class="lstack" aria-hidden="true"><span class="tiles"><span class="logo sm lg-github"/,
    );
    expect(html).toContain(
      `<a class="nlink" href="/admin/credential-access-rules?credential=${id}">1 usable rule · 1 access rule<span class="vh"> can use OpenAI</span></a>`,
    );
    expect(html).toContain('<span class="meta">github.com · <span class="t-warn">');
  });

  it('filters by status and key, and ignores unknown values', async () => {
    const admin = await sessionFor('admin');
    await createOpenAi(admin);
    const missing = await (
      await adminGet(app, admin, '/admin/credentials?status=no_credential')
    ).text();
    expect(missing).toContain('No credential matches these filters.');
    // The filter in use stays a current quick link, also with no match.
    expect(missing).toMatch(
      /<a class="ql bad" href="\/admin\/credentials\?status=no_credential" aria-current="true">[\s\S]*?No secret/,
    );
    expect(missing).toContain(
      '<a class="btn sm secondary" href="/admin/credentials">Show all credentials</a>',
    );
    const kid = await kekKid();
    const byKey = await (await adminGet(app, admin, `/admin/credentials?key=${kid}`)).text();
    expect(byKey).toContain('Credentials (1)');
    expect(byKey).toContain(`Key ${kid}`);
    const unknown = await (
      await adminGet(app, admin, '/admin/credentials?status=<b>x</b>&key=zz')
    ).text();
    expect(unknown).toContain('Credentials (1)');
    expect(unknown).not.toContain('<b>x</b>');
  });

  it('filters disabled tokens, and by name or slug without echoing markup', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await createCustom(admin);
    await adminPost(app, admin, `/admin/credentials/${id}/toggle`, { enabled: '0' });
    const all = await (await adminGet(app, admin, '/admin/credentials')).text();
    expect(all).toMatch(
      /<a class="ql" href="\/admin\/credentials\?status=disabled">[\s\S]*?Disabled <span class="n">1<\/span>/,
    );
    const disabled = await (
      await adminGet(app, admin, '/admin/credentials?status=disabled')
    ).text();
    expect(disabled).toContain('Credentials (1)');
    expect(disabled).toContain('>OpenAI</a>');
    expect(disabled).not.toContain('>example</a>');
    const found = await (await adminGet(app, admin, '/admin/credentials?q=EXAM')).text();
    expect(found).toContain('Credentials (1)');
    expect(found).toContain('>example</a>');
    expect(found).toContain('value="EXAM"');
    const markup = await (
      await adminGet(app, admin, `/admin/credentials?q=${encodeURIComponent('<b>x</b>')}`)
    ).text();
    expect(markup).toContain('No credential matches these filters.');
    expect(markup).not.toContain('<b>x</b>');
  });

  it('the count link a screen reader hears starts with its visible text (WCAG 2.5.3)', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await insertRule(id, 'deploy');
    const html = await (await adminGet(app, admin, '/admin/credentials')).text();
    expect(html).toContain('1 usable rule · 1 access rule<span class="vh"> can use OpenAI</span>');
    const page = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    expect(page).toContain(
      `<a class="ent-n" href="/admin/credential-access-rules/${RULE_ID}">deploy</a> <span class="ctx">· acme/api · environment production</span>`,
    );
  });

  it('keeps the key filter in the status links and the search', async () => {
    const admin = await sessionFor('admin');
    await createCustom(admin, { slug: 'api-0' });
    await createCustom(admin, { slug: 'api-1' });
    await env.DB.prepare("UPDATE credentials SET enabled = 0 WHERE slug = 'api-1'").run();
    const kid = await kekKid();
    const html = await (await adminGet(app, admin, `/admin/credentials?key=${kid}`)).text();
    expect(html).toContain(`href="/admin/credentials?key=${kid}"`);
    expect(html).toContain(`href="/admin/credentials?status=disabled&amp;key=${kid}"`);
    const form = /<form class="filters" role="search"[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
    expect(form).toContain(`<input type="hidden" name="key" value="${kid}"/>`);
    const none = await (await adminGet(app, admin, '/admin/credentials')).text();
    const plain = /<form class="filters" role="search"[\s\S]*?<\/form>/.exec(none)?.[0] ?? '';
    expect(plain).toContain('name="q"');
    expect(plain).not.toContain('name="key"');
  });

  it('a stored base URL that does not parse fails closed but every page still renders', async () => {
    const owner = await sessionFor('owner');
    const id = await createOpenAi(owner);
    await env.DB.prepare("UPDATE credentials SET base_url = 'not a url' WHERE id = ?")
      .bind(id)
      .run();
    const list = await adminGet(app, owner, '/admin/credentials');
    expect(list.status).toBe(200);
    const listHtml = await list.text();
    expect(listHtml).toContain('1 credential has a base URL that cannot be read');
    expect(listHtml).toContain(`href="/admin/credentials/${id}?open=destination#destination"`);
    expect((await adminGet(app, owner, '/admin/credentials/hosts')).status).toBe(200);
    const page = await adminGet(app, owner, `/admin/credentials/${id}`);
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain('The stored base URL cannot be read');
    expect(pageHtml).toMatch(/<details[^>]*id="destination-edit"[^>]*open=""/);
    // The destination form fixes it, with the host typed again (the binding is not attested).
    const calls = upstream.calls.length;
    const saved = await adminPost(app, owner, `/admin/credentials/${id}/destination`, {
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

  it('has "Add credential" as the header primary, and sends old ?open=add links to the catalog', async () => {
    const admin = await sessionFor('admin');
    await createOpenAi(admin);
    const list = await (await adminGet(app, admin, '/admin/credentials')).text();
    const header = /<header class="ph">[\s\S]*?<\/header>/.exec(list)?.[0] ?? '';
    expect(header).toMatch(
      /<a class="btn primary" href="\/admin\/credentials\/new">[\s\S]*?Add credential<\/a>/,
    );
    expect(header).toContain('Credentials<span class="count">1</span>');
    const old = await adminGet(app, admin, '/admin/credentials?open=add');
    expect(old.status).toBe(302);
    expect(old.headers.get('location')).toBe('/admin/credentials/new');
    // Someone who cannot add tokens gets the list, not a forbidden page.
    const viewer = await adminGet(app, await sessionFor('viewer'), '/admin/credentials?open=add');
    expect(viewer.status).toBe(200);
  });
});

describe('the Add credential catalog', () => {
  it('opens the card named by ?template=', async () => {
    const res = await adminGet(
      app,
      await sessionFor('admin'),
      '/admin/credentials/new?template=slack-webhook',
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Add a credential – Credentials – tokengate</title>');
    expect(html).toMatch(
      /<details class="type-card" name="token-type" id="type-slack-webhook" open="">/,
    );
    expect(html).not.toMatch(/id="type-slack" open/);
    expect(html).toContain(
      'placeholder="https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"',
    );
  });

  it.each(['viewer', 'access_manager'] as const)('is forbidden for %s', async (role) => {
    expect((await adminGet(app, await sessionFor(role), '/admin/credentials/new')).status).toBe(
      403,
    );
  });
});

describe('create', () => {
  it('one submit: the template supplies destination, headers, timeout and check', async () => {
    const admin = await sessionFor('admin');
    const res = await adminPost(app, admin, '/admin/credentials', {
      template: 'openai',
      credential: SECRET,
    });
    expect(res.status).toBe(303);
    const id = idFrom(res);
    expect(res.headers.get('location')).toBe(`/admin/credentials/${id}?notice=created_verified`);
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
      await adminGet(app, admin, `/admin/credentials/${id}?notice=created_verified`)
    ).text();
    expect(page).toContain('OpenAI created (slug openai); the secret check passed.');
    expect(page).toContain('href="/admin/credential-access-rules/new?credential=' + id);
    expect(page).toContain('aria-label="Proxy base URL">https://gw.test/proxy/openai</pre>');
    expect(page).not.toContain(SECRET);
  });

  it('derives a free slug and name on a clash; a template card has no slug or name fields', async () => {
    const admin = await sessionFor('admin');
    await createOpenAi(admin);
    await createOpenAi(admin);
    expect(await serviceRow('openai-2')).toMatchObject({ name: 'OpenAI 2' });
    const form = await (
      await adminGet(app, admin, '/admin/credentials/new?template=openai')
    ).text();
    expect(form).not.toContain('id="f-openai-slug"');
    expect(form).not.toContain('id="f-openai-name"');

    await createOpenAi(admin, { slug: 'typed', name: 'Typed' });
    expect(await serviceRow('openai-3')).toMatchObject({ name: 'OpenAI 3' });
    expect(await serviceRow('typed')).toBeNull();
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
    const res = await adminPost(app, admin, '/admin/credentials', {
      ...CUSTOM_FORM,
      slug: 'Bad Slug',
      base_url: 'http://127.0.0.1/api',
      credential: SECRET,
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('<title>Error: Add a credential');
    expect(html).toContain('href="#f-custom-base_url"');
    expect(html).toMatch(/id="f-custom-base_url"[^>]*aria-invalid="true"/);
    expect(html).toContain('value="Bad Slug"');
    expect(html).toContain('value="http://127.0.0.1/api"');
    expect(html).toMatch(
      /<details class="type-card lform" name="token-type" id="type-custom" open="">/,
    );
    // No draft: the destination is invalid, so there is nothing to bind it to.
    expect(html).not.toContain('name="credential_draft"');
    expect(html).not.toContain(SECRET);
    expect(await auditActions()).toEqual([]);
    expect(upstream.calls).toEqual([]);
  });

  it('reports a taken slug before anything is sent', async () => {
    const admin = await sessionFor('admin');
    await createOpenAi(admin);
    const calls = upstream.calls.length;
    const res = await adminPost(app, admin, '/admin/credentials', {
      ...CUSTOM_FORM,
      credential: SECRET,
      slug: 'openai',
    });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('Another credential already uses openai; leave empty to use openai-2');
    expect(html).toContain('href="#f-custom-slug"');
    expect(upstream.calls.length).toBe(calls);
  });

  it('the custom card says how an empty slug and name are derived', async () => {
    const html = await (
      await adminGet(app, await sessionFor('admin'), '/admin/credentials/new?template=custom')
    ).text();
    const card = /id="type-custom"[\s\S]*?<\/details>/.exec(html)?.[0] ?? '';
    expect(card).toContain(
      'Leave empty to use the API host&#39;s name, e.g. stripe for https://api.stripe.com/v1.',
    );
    expect(card).toContain('Leave empty to use the slug.');
    expect(card).not.toContain('Leave empty to use the placeholder.');
  });

  it('names a Slack token without a typed name after its bot; a typed name is kept', async () => {
    const admin = await sessionFor('admin');
    const res = await adminPost(app, admin, '/admin/credentials', {
      template: 'slack',
      credential: SLACK_SECRET,
    });
    expect(res.status, await res.clone().text()).toBe(303);
    expect(await serviceRow('slack')).toMatchObject({ name: 'Deploy Bot', name_from_check: 1 });
    const page = await (await adminGet(app, admin, `/admin/credentials/${idFrom(res)}`)).text();
    expect(page).toContain('Deploy Bot');

    // A typed name renames the credential and stops the check from renaming it.
    const renamed = await adminPost(app, admin, `/admin/credentials/${idFrom(res)}`, {
      name: 'Alerts',
    });
    expect(renamed.status, await renamed.clone().text()).toBe(303);
    expect(await serviceRow('slack')).toMatchObject({ name: 'Alerts', name_from_check: 0 });
  });

  it('keeps the secret as a draft after a failed check; "Save without a passing check" saves', async () => {
    const admin = await sessionFor('admin');
    const first = await adminPost(app, admin, '/admin/credentials', {
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

    const saved = await adminPost(app, admin, '/admin/credentials', {
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
    const res = await adminPost(app, admin, '/admin/credentials', {
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
    expect(await auditActions()).toEqual(['service.create', 'service.create']);
  });

  it('is forbidden for viewers and access managers and writes nothing', async () => {
    for (const role of ['viewer', 'access_manager'] as const) {
      const res = await adminPost(app, await sessionFor(role), '/admin/credentials', {
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
    const id = await createCustom(admin, { name: '<script>alert(1)</script>' });
    for (const path of ['/admin/credentials', `/admin/credentials/${id}`]) {
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
    const res = await adminGet(app, viewer, `/admin/credentials/${id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const section of ['rules', 'secret', 'use', 'destination']) {
      expect(html).toContain(`id="${section}"`);
    }
    expect(html).toContain('<p class="relline">No workload can use OpenAI yet.</p>');
    expect(html).toContain('No credential access rules yet');
    expect(html).toContain('OpenAI API');
    // Identity: one H1 with the status, the ID chip, and no header action for a viewer.
    expect(html).toMatch(/<h1>OpenAI <span class="badge ok">/);
    expect(html).toContain(`>${id}</span>`);
    expect(html).not.toContain('class="ph-actions"');
    expect(html).not.toMatch(/<form\b[^>]*\bmethod="post" action="\/admin\/credentials\//);
    expect(html).not.toContain('id="danger"');
    expect(html).toContain(`href="/admin/audit?target=${id}"`);

    const missing = await adminGet(
      app,
      viewer,
      '/admin/credentials/svc_00000000000000000000000000',
    );
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('There is no credential with this ID');
  });

  it('warns about query injection', async () => {
    const admin = await sessionFor('admin');
    const id = await createCustom(admin, { injection_kind: 'query', injection_param: 'api_key' });
    const html = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    expect(html).toContain('Upstreams may echo URLs');
  });

  it('a token without a secret opens Change destination with the host confirmation', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await env.DB.prepare('UPDATE credentials SET credential_sealed = NULL WHERE id = ?')
      .bind(id)
      .run();
    const html = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    expect(html).toContain('No secret is stored, so requests through this credential fail.');
    expect(html).toMatch(/<details[^>]*id="destination-edit"[^>]*open=""/);
    expect(html).toContain('name="confirm_destination"');
    expect(html).toContain('Set the secret through Change destination below');
    expect(html).not.toContain(`action="/admin/credentials/${id}/secret"`);
  });

  it('counts the issuers and rules that can use the credential and lists the hand-off for credential managers', async () => {
    await createUser({ email: 'am@example.com', role: 'access_manager' });
    await createUser({ email: 'gone@example.com', role: 'access_manager', status: 'suspended' });
    const manager = await sessionFor('token_manager');
    const id = await createOpenAi(manager);
    await insertRule(id, 'deploy');
    await insertRule(id, 'old', OLD_RULE_ID);
    await env.DB.prepare('UPDATE access_rules SET enabled = 0 WHERE id = ?')
      .bind(OLD_RULE_ID)
      .run();
    const html = await (await adminGet(app, manager, `/admin/credentials/${id}`)).text();
    expect(html).toContain(
      `Workloads of <a href="/admin/credential-access-rules?credential=${id}">1 issuer</a> can use OpenAI through <a href="/admin/credential-access-rules?credential=${id}">1 credential access rule</a>.`,
    );
    expect(html).toContain(
      `<a class="ent-n" href="/admin/credential-access-rules/${RULE_ID}">deploy</a> <span class="ctx">· acme/api · environment production</span>`,
    );
    expect(html).toContain('<code>POST /responses</code>');
    // The disabled rule is listed, but not counted as one that can call.
    expect(html).toContain(`href="/admin/credential-access-rules/${OLD_RULE_ID}"`);
    expect(html).toContain('Access managers add credential access rules. Send them this link:');
    expect(html).toContain(
      `value="https://gw.test/admin/credential-access-rules/new?credential=${id}"`,
    );
    expect(html).toContain('mailto:am@example.com?subject=Access%20to%20credential%20OpenAI');
    // The page's one primary hands the token to an access manager, with the link in the mail.
    const header = /<header class="ph">[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
    expect(header).toMatch(
      /<a class="btn primary" href="mailto:am@example\.com\?subject=Access%20to%20credential%20OpenAI&amp;body=[^"]*admin%2Fcredential-access-rules%2Fnew%3Fcredential%3D/,
    );
    expect(header).toContain('Ask an access manager');
    expect(html).not.toContain('gone@example.com');
    expect(html).not.toContain('>Add credential access rule<');

    const access = await sessionFor('access_manager', 'am2@example.com');
    const accessHtml = await (await adminGet(app, access, `/admin/credentials/${id}`)).text();
    expect(accessHtml).toContain(`href="/admin/credential-access-rules/new?credential=${id}"`);
    expect(accessHtml).not.toMatch(/<form\b[^>]*\bmethod="post" action="\/admin\/credentials\//);
  });
});

describe('last used', () => {
  it('comes from the hourly rollups, or says the sample rate records nothing', async () => {
    await env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly').run();
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await insertRule(id, 'deploy');
    const hour = Math.floor((Date.now() - 3 * 3_600_000) / 3_600_000) * 3_600_000;
    await env.TELEMETRY_DB.prepare(
      `INSERT INTO request_rollup_hourly (hour, service_id, credential_access_rule_id, outcome, status_class,
         requests, upstream_auth_fail, duration_sum_ms) VALUES (?, ?, ?, 'allowed', 2, 4, 0, 40)`,
    )
      .bind(hour, id, RULE_ID)
      .run();
    const list = await (await adminGet(app, admin, '/admin/credentials')).text();
    expect(list).toContain(`<time datetime="${new Date(hour).toISOString()}">3 h ago</time>`);
    const page = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    expect(page).toContain('last used 3 h ago');

    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('allowed_sample_rate', '0', 0, NULL)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run();
    const unrecorded = await (await adminGet(app, admin, '/admin/credentials')).text();
    expect(unrecorded).toContain('not recorded (sample rate 0)');
    await env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly').run();
  });
});

describe('details form', () => {
  it('updates non-binding fields and ignores a posted base URL', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const res = await adminPost(app, admin, `/admin/credentials/${id}`, {
      name: 'OpenAI prod',
      timeout_ms: '300000',
      verify_path: '/models',
      base_url: 'https://evil.example.com',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin/credentials/${id}?notice=updated#details`);
    expect(await serviceRow('openai')).toMatchObject({
      name: 'OpenAI prod',
      timeout_ms: 300000,
      base_url: 'https://api.openai.com/v1',
    });
    expect(await auditActions()).toEqual(['service.create', 'service.update']);
  });

  it('re-renders open with the errors at the fields', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const res = await adminPost(app, admin, `/admin/credentials/${id}`, {
      name: 'OpenAI',
      forward_headers: 'authorization',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/<details[^>]*id="details"[^>]*open=""/);
    expect(html).toContain('href="#f-details-forward_headers"');
    expect(html).toMatch(/<details class="more" open="">/);
    expect(await auditActions()).toEqual(['service.create']);
  });

  it('refuses a save over a newer change with 409', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const page = await (await adminGet(app, admin, `/admin/credentials/${id}?open=details`)).text();
    const opened = /name="expected_updated_at" value="(\d+)"/.exec(page)?.[1] ?? '';
    const first = await adminPost(app, admin, `/admin/credentials/${id}`, {
      name: 'First',
      expected_updated_at: opened,
    });
    expect(first.status).toBe(303);
    const stale = await adminPost(app, admin, `/admin/credentials/${id}`, {
      name: 'Second',
      expected_updated_at: opened,
    });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain('changed by someone else since you opened this page');
    expect((await serviceRow('openai'))?.name).toBe('First');
  });

  it('a name typed here stops following the Slack bot name', async () => {
    const admin = await sessionFor('admin');
    const id = idFrom(
      await adminPost(app, admin, '/admin/credentials', {
        template: 'slack',
        credential: SLACK_SECRET,
      }),
    );
    expect(await serviceRow('slack')).toMatchObject({ name: 'Deploy Bot', name_from_check: 1 });
    // The details form posts every field: the Slack check stays as it was.
    const res = await adminPost(app, admin, `/admin/credentials/${id}`, {
      name: 'Alerts',
      verify_method: 'POST',
      verify_path: '/auth.test',
      verify_expect_status: '200',
      verify_expect_ok_field: '1',
    });
    expect(res.status).toBe(303);
    expect(await serviceRow('slack')).toMatchObject({ name: 'Alerts', name_from_check: 0 });
    upstream.slackBot.name = 'Release Bot';
    const tested = await adminPost(app, admin, `/admin/credentials/${id}/test`);
    expect(tested.status).toBe(200);
    expect(await tested.text()).toContain('The secret belongs to Release Bot.');
    expect((await serviceRow('slack'))?.name).toBe('Alerts');
  });
});

describe('rotate (POST /admin/credentials/:id/secret)', () => {
  it('the Replace secret dialog has only the secret and the destination digest', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const html = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    const dialog = /<dialog[^>]*id="dlg-replace"[\s\S]*?<\/dialog>/.exec(html)?.[0] ?? '';
    const form =
      new RegExp(
        `<form method="post" action="/admin/credentials/${id}/secret"[\\s\\S]*?</form>`,
      ).exec(dialog)?.[0] ?? '';
    const names = [...form.matchAll(/ name="([^"]+)"/g)].map((match) => match[1]);
    expect(names.sort()).toEqual(['_csrf', 'credential', 'expected_destination']);
    expect(form).toContain('Sent to api.openai.com.');
    expect(form).toContain('Replaces …WXYZ');
    // A digest of the destination, never the destination itself (I-CRED-2).
    expect(form).toContain(
      `name="expected_destination" value="${(await rotateFields(id)).expected_destination}"`,
    );
    expect(form).not.toMatch(/value="https:/);
  });

  it('keeps the stored destination and ignores a posted base URL', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const before = await serviceRow('openai');
    const res = await adminPost(app, admin, `/admin/credentials/${id}/secret`, {
      ...(await rotateFields(id)),
      credential: SECRET,
      base_url: 'https://evil.example.com',
      injection_kind: 'query',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(
      `/admin/credentials/${id}?notice=secret_verified#secret`,
    );
    const after = await serviceRow('openai');
    expect(after?.base_url).toBe('https://api.openai.com/v1');
    expect(after?.injection).toBe('{"kind":"bearer"}');
    expect(after?.credential_sealed).not.toBe(before?.credential_sealed);
    expect(upstream.calls.filter((call) => call.includes('evil'))).toEqual([]);
  });

  it('refuses a token repointed since the page was loaded: 409, nothing sent, nothing written, no draft', async () => {
    const admin = await sessionFor('admin');
    const other = await sessionFor('token_manager');
    // Only a custom credential can change its destination.
    const id = await createCustom(admin, { slug: 'custom' });
    const loaded = await rotateFields(id);
    // Another credential manager repoints it (with a dummy secret of their own) after A loaded the page.
    const repoint = await adminPost(app, other, `/admin/credentials/${id}/destination`, {
      base_url: 'https://api.attacker.example/v1',
      injection_kind: 'bearer',
      credential: 'attacker-dummy-0123456789abcdef',
      save_anyway: '1',
    });
    expect(repoint.status).toBe(303);
    const row = await serviceRow('custom');
    const audits = (await auditActions()).length;
    const calls = upstream.calls.length;
    const rotated = 'custom-rotated-0123456789abcdefWXYZ';
    const res = await adminPost(app, admin, `/admin/credentials/${id}/secret`, {
      ...loaded,
      credential: rotated,
    });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('it now sends the secret to api.attacker.example');
    expect(html).not.toContain('name="credential_draft"');
    expect(html).not.toContain(rotated);
    expect(upstream.calls.slice(calls)).toEqual([]);
    expect(await serviceRow('custom')).toEqual(row);
    expect((await auditActions()).length).toBe(audits);
    // The re-rendered form names the new destination and carries its digest.
    expect(html).toContain('Sent to api.attacker.example.');
    expect(html).toContain(`value="${(await rotateFields(id)).expected_destination}"`);
  });

  it('refuses a rotate without the destination digest', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const calls = upstream.calls.length;
    const res = await adminPost(app, admin, `/admin/credentials/${id}/secret`, {
      credential: SECRET,
    });
    expect(res.status).toBe(409);
    expect(upstream.calls.slice(calls)).toEqual([]);
  });

  it('a new Slack secret renames a token named after its bot', async () => {
    const admin = await sessionFor('admin');
    const id = idFrom(
      await adminPost(app, admin, '/admin/credentials', {
        template: 'slack',
        credential: SLACK_SECRET,
      }),
    );
    upstream.slackBot.name = 'Release Bot';
    const res = await adminPost(app, admin, `/admin/credentials/${id}/secret`, {
      ...(await rotateFields(id)),
      credential: SLACK_SECRET,
    });
    expect(res.status).toBe(303);
    expect(await serviceRow('slack')).toMatchObject({ name: 'Release Bot', name_from_check: 1 });
  });

  it('re-renders the Replace secret dialog open after a failed check', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const res = await adminPost(app, admin, `/admin/credentials/${id}/secret`, {
      ...(await rotateFields(id)),
      credential: BAD_SECRET,
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toMatch(/<dialog[^>]*id="dlg-replace"[^>]*open=""/);
    const dialog = /<dialog[^>]*id="dlg-replace"[\s\S]*?<\/dialog>/.exec(html)?.[0] ?? '';
    expect(dialog).toContain('name="save_anyway" value="1"');
    expect(dialog).toMatch(/name="credential_draft" value="cd1\./);
    expect(dialog).not.toContain(BAD_SECRET);
  });

  it('is refused with 422 while the stored binding is not attested, pointing to Change destination', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await env.DB.prepare(
      "UPDATE credentials SET base_url = 'https://api.openai.com/v2' WHERE id = ?",
    )
      .bind(id)
      .run();
    const res = await adminPost(app, admin, `/admin/credentials/${id}/secret`, {
      ...(await rotateFields(id)),
      credential: SECRET,
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('href="#f-destination-base_url"');
    expect(html).toMatch(/<details[^>]*id="destination-edit"[^>]*open=""/);
    expect(upstream.calls.filter((call) => call.includes('/v2'))).toEqual([]);
  });

  it('replaces the same secret in the GitHub uploads sibling, one audit row each', async () => {
    const admin = await sessionFor('admin');
    const api = idFrom(
      await adminPost(app, admin, '/admin/credentials', {
        template: 'github',
        credential: GH_SECRET,
        also_uploads: '1',
      }),
    );
    // Same hint, different secret: not a sibling.
    const other = `ghp_otherSecret00000000000000000${GH_SECRET.slice(-4)}`;
    await adminPost(app, admin, '/admin/credentials', {
      template: 'github-uploads',
      credential: other,
      slug: 'uploads-other',
    });
    const uploads = (await serviceRow('github-uploads'))?.id as string;
    const html = await (await adminGet(app, admin, `/admin/credentials/${api}`)).text();
    expect(html).toMatch(new RegExp(`name="also_replace" value="${uploads}" checked=""`));
    expect(html).toContain('Also replace in github-uploads');
    expect(html).not.toContain('Also replace in uploads-other');

    const rotated = 'ghp_rotated000000000000000000000000ROTA';
    const before = (await auditActions()).length;
    const res = await adminPost(app, admin, `/admin/credentials/${api}/secret`, {
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
      await adminPost(app, admin, '/admin/credentials', {
        template: 'github',
        credential: GH_SECRET,
      }),
    );
    const other = idFrom(
      await adminPost(app, admin, '/admin/credentials', {
        template: 'github-uploads',
        credential: `ghp_otherSecret00000000000000000${GH_SECRET.slice(-4)}`,
      }),
    );
    const res = await adminPost(app, admin, `/admin/credentials/${api}/secret`, {
      ...(await rotateFields(api)),
      credential: 'ghp_rotated000000000000000000000000ROTA',
      also_replace: other,
    });
    expect(res.headers.get('location')).toBe(
      `/admin/credentials/${api}?notice=secret_verified&also=sibling_failed#secret`,
    );
    const html = await (await adminGet(app, admin, res.headers.get('location') ?? '')).text();
    expect(html).toContain(
      'It was not replaced in every other credential that held the same secret',
    );
  });
});

describe('change destination (POST /admin/credentials/:id/destination)', () => {
  it('re-seals with a new destination; a failed check keeps a draft for "Save without"', async () => {
    const admin = await sessionFor('admin');
    const id = await createCustom(admin, {
      slug: 'custom',
      verify_path: '/models',
      credential: SECRET,
    });
    const before = await serviceRow('custom');
    const fields = { base_url: 'https://api.example.com/v2', injection_kind: 'bearer' };
    const failed = await adminPost(app, admin, `/admin/credentials/${id}/destination`, {
      ...fields,
      credential: BAD_SECRET,
    });
    expect(failed.status).toBe(422);
    const html = await failed.text();
    expect(html).toMatch(/<details[^>]*id="destination-edit"[^>]*open=""/);
    expect(html).toContain('value="https://api.example.com/v2"');
    expect(html).not.toContain(BAD_SECRET);
    const draft = /name="credential_draft" value="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(await serviceRow('custom')).toEqual(before);

    const saved = await adminPost(app, admin, `/admin/credentials/${id}/destination`, {
      ...fields,
      credential_draft: draft,
      save_anyway: '1',
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe(
      `/admin/credentials/${id}?notice=destination_changed#destination`,
    );
    const after = await serviceRow('custom');
    expect(after?.base_url).toBe('https://api.example.com/v2');
    expect(after?.template_id).toBeNull();
    expect(await auditActions()).toEqual(['service.create', 'service.credential.set']);
  });

  it('requires the secret', async () => {
    const admin = await sessionFor('admin');
    const id = await createCustom(admin);
    const res = await adminPost(app, admin, `/admin/credentials/${id}/destination`, {
      base_url: 'https://api.example.com/v1',
      injection_kind: 'header',
      injection_header_name: 'X-Api-Key',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Enter the secret');
    expect(await auditActions()).toEqual(['service.create']);
  });

  it('recomputes the template when a destination becomes a template one, which fixes it', async () => {
    const admin = await sessionFor('admin');
    const id = await createCustom(admin, { slug: 'gh', base_url: 'https://api.github.com/v3' });
    expect((await serviceRow('gh'))?.template_id).toBeNull();
    const res = await adminPost(app, admin, `/admin/credentials/${id}/destination`, {
      base_url: 'https://api.github.com',
      injection_kind: 'bearer',
      credential: GH_SECRET,
    });
    expect(res.status).toBe(303);
    expect((await serviceRow('gh'))?.template_id).toBe('github');
    // A type's destination is fixed: the page offers no Change destination any more.
    const page = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    expect(page).not.toContain(`href="/admin/credentials/${id}?open=destination#destination"`);
  });
});

describe('test, toggle, delete', () => {
  it('tests the stored secret and shows the result as a status', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const res = await adminPost(app, admin, `/admin/credentials/${id}/test`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(
      /<div class="callout ok" role="status">[\s\S]*?Check passed \(HTTP 200\)\./,
    );
    expect(await auditActions()).toEqual(['service.create', 'service.credential.test']);
  });

  it('a test that reads a new Slack bot name renames the token as its own audited change', async () => {
    const admin = await sessionFor('admin');
    const id = idFrom(
      await adminPost(app, admin, '/admin/credentials', {
        template: 'slack',
        credential: SLACK_SECRET,
      }),
    );
    upstream.slackBot.name = 'Release Bot';
    const res = await adminPost(app, admin, `/admin/credentials/${id}/test`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('The secret belongs to Release Bot.');
    // The page reads the row again: the new name is shown at once.
    expect(html).toContain('<title>Release Bot');
    expect(await auditActions()).toEqual([
      'service.create',
      'service.credential.test',
      'service.update',
    ]);
    expect((await serviceRow('slack'))?.name).toBe('Release Bot');
  });

  it('disables with an "Enable again" undo, and enables', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const off = await adminPost(app, admin, `/admin/credentials/${id}/toggle`, {
      enabled: '0',
      _return: 'detail',
    });
    expect(off.headers.get('location')).toBe(`/admin/credentials/${id}?notice=disabled`);
    const page = await (
      await adminGet(app, admin, `/admin/credentials/${id}?notice=disabled`)
    ).text();
    expect(page).toContain('Enable again');
    expect((await serviceRow('openai'))?.enabled).toBe(0);
    const on = await adminPost(app, admin, `/admin/credentials/${id}/toggle`, { enabled: '1' });
    expect(on.headers.get('location')).toBe(`/admin/credentials/${id}?notice=enabled`);
    const list = await adminPost(app, admin, `/admin/credentials/${id}/toggle`, {
      enabled: '0',
      _return: 'list',
    });
    expect(list.headers.get('location')).toBe('/admin/credentials?notice=disabled');
    expect(await auditActions()).toEqual([
      'service.create',
      'service.disable',
      'service.enable',
      'service.disable',
    ]);
    const bad = await adminPost(app, admin, `/admin/credentials/${id}/toggle`, { enabled: 'yes' });
    expect(bad.status).toBe(400);
  });

  it('deletes through the confirm dialog; the server requires confirm=1', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const page = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    expect(page).toContain('commandfor="dlg-delete"');
    expect(page).toContain('Delete OpenAI…');
    const unconfirmed = await adminPost(app, admin, `/admin/credentials/${id}/delete`);
    expect(unconfirmed.status).toBe(400);
    const deleted = await adminPost(app, admin, `/admin/credentials/${id}/delete`, {
      confirm: '1',
    });
    expect(deleted.headers.get('location')).toBe('/admin/credentials?notice=deleted');
    expect(await serviceRow('openai')).toBeNull();
  });

  it('refuses a plain delete while credential access rules use the credential', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await insertRule(id, 'deploy <bot>');
    const blocked = await adminPost(app, admin, `/admin/credentials/${id}/delete`, {
      confirm: '1',
    });
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
    // A custom credential: a typed one has no destination form.
    const id = await createCustom(admin, { verify_path: '/models', credential: SECRET });
    // test, rotate, disable, delete (+ the account menu export), and the one edit form that
    // `?open=` draws: destination or details
    for (const open of ['destination', 'details']) {
      const html = await (
        await adminGet(app, admin, `/admin/credentials/${id}?open=${open}`)
      ).text();
      const forms = html.match(/<form\b[^>]*\bmethod="post"[\s\S]*?<\/form>/g) ?? [];
      expect(forms.length).toBeGreaterThanOrEqual(5);
      expect(html).toContain(
        `action="/admin/credentials/${id}${open === 'details' ? '' : '/destination'}"`,
      );
      for (const form of forms) expect(form).toContain(`name="_csrf" value="${admin.csrfToken}"`);
    }
  });

  it('draws the destination and details forms only when their header button opens them', async () => {
    const admin = await sessionFor('admin');
    const id = await createCustom(admin);
    const html = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    expect(html).toContain(`href="/admin/credentials/${id}?open=destination#destination"`);
    expect(html).toContain(`href="/admin/credentials/${id}?open=details#details"`);
    expect(html).not.toContain(`action="/admin/credentials/${id}/destination"`);
    expect(html).not.toContain('id="destination-edit"');
    expect(html).not.toMatch(/<details[^>]*id="details"/);
    const open = await (await adminGet(app, admin, `/admin/credentials/${id}?open=details`)).text();
    expect(open).toMatch(/<details[^>]*id="details"[^>]*open=""/);
    expect(open).not.toContain(`href="/admin/credentials/${id}?open=details#details"`);
    expect(open).toContain(`href="/admin/credentials/${id}?open=destination#destination"`);
  });

  it('refuses a POST without the CSRF token and writes nothing', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const res = await adminPost(
      app,
      admin,
      `/admin/credentials/${id}/toggle`,
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
          `/admin/credentials/${id}?notice=${encodeURIComponent(notice)}&also=<i>x</i>`,
        )
      ).text();
      expect(html).not.toContain('pwned');
      expect(html).not.toContain('<i>x</i>');
      expect(html).not.toMatch(/class="[^"]*\bnotice\b/);
    }
  });
});
