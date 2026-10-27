// An owner may allow a blocked host from the token form (allow_host, field permission
// settings:write). The allowlist change is its own audited write, committed before the token's
// check sends the secret (I-SSRF-1, I-AUDIT-1); anyone else is told before typing anything.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAllowedUpstreamHosts } from '../../src/db/settings';
import type { Role } from '../../src/db/types';
import { TOKEN_FIXTURE_VARIANTS, expectedActions } from '../fixtures/admin-forms';
import { adminGet, adminPost, createUser, loginAs, resetControlPlane } from '../helpers/admin-auth';
import { createTestApp, setUpstreamHosts, type TestApp } from '../helpers/app';
import { fakeNetwork, KEK_1, seedService } from '../unit/admin/ops/helpers';

let app: TestApp;
let network: ReturnType<typeof fakeNetwork>;
/** The allowlist as the upstream saw it when the secret arrived. */
let listAtSend: Array<string[] | null>;

beforeEach(async () => {
  await resetControlPlane();
  listAtSend = [];
  network = fakeNetwork(async (url) => {
    listAtSend.push(await getAllowedUpstreamHosts(env.DB));
    return url.pathname.endsWith('/fail')
      ? new Response('{}', { status: 401 })
      : Response.json({ ok: true, data: [] });
  });
  app = createTestApp({ fetch: network.fetch, env: { TOKENGATE_KEK: KEK_1 } });
  await setUpstreamHosts(['api.github.com']);
});

async function session(role: Role) {
  return loginAs(app, await createUser({ email: `${role}@example.com`, role }));
}

async function actions(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT action FROM audit_log WHERE action LIKE 'service.%' OR action LIKE 'settings.%' ORDER BY rowid",
  ).all<{ action: string }>();
  return results.map((row) => row.action);
}

const DESTINATION_SECRET = 'custom-destination-0123456789abcdef';

/** A custom token at an allowed host: only a credential without a type changes its destination. */
async function customToken(owner: Awaited<ReturnType<typeof session>>) {
  const res = await adminPost(app, owner, '/admin/credentials', {
    template: 'custom',
    slug: 'custom',
    base_url: 'https://api.github.com/v3',
    injection_kind: 'bearer',
    verify_path: '',
    credential: DESTINATION_SECRET,
  });
  expect(res.status, await res.clone().text()).toBe(303);
  return /svc_[0-9A-Z]{26}/.exec(res.headers.get('location') ?? '')?.[0];
}

describe('I-SSRF-1: allowing a host from the token form', () => {
  it('a blocked card shows owners a required checkbox and others who to ask, before any typing', async () => {
    const owner = await session('owner');
    const ownerHtml = await (
      await adminGet(app, owner, '/admin/credentials/new?template=openai')
    ).text();
    expect(ownerHtml).toContain(
      'api.openai.com · project API key sk-proj-… · api.openai.com is not an allowed host',
    );
    expect(ownerHtml).toMatch(
      /<input type="checkbox" id="f-openai-allow_host" name="allow_host" value="api.openai.com" required=""/,
    );

    for (const role of ['token_manager', 'admin'] as const) {
      const html = await (
        await adminGet(app, await session(role), '/admin/credentials/new?template=openai')
      ).text();
      const card =
        /<details class="type-card" name="token-type" id="type-openai"[\s\S]*?<\/details>/.exec(
          html,
        )?.[0] ?? '';
      expect(card, role).toContain('api.openai.com is not an allowed host.');
      expect(card, role).toContain('mailto:owner@example.com');
      expect(card, role).not.toContain('<form');
      expect(card, role).not.toContain('name="allow_host"');
    }
  });

  it('commits the allowlist first, then creates the token (two rows, two batches)', async () => {
    const owner = await session('owner');
    const request = await TOKEN_FIXTURE_VARIANTS.createWithAllowHost();
    const res = await adminPost(app, owner, request.path, request.fields);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('also=host_added');
    expect(await actions()).toEqual(expectedActions(request));
    // The upstream received the secret only after api.openai.com was on the list.
    expect(listAtSend).toEqual([['api.github.com', 'api.openai.com']]);
    const page = await (await adminGet(app, owner, res.headers.get('location') ?? '')).text();
    expect(page).toContain('api.openai.com was added to Allowed hosts.');
  });

  it('a repeat for a covered host is a no-op without an allowlist row', async () => {
    const owner = await session('owner');
    await setUpstreamHosts(['api.github.com', 'api.openai.com']);
    const res = await adminPost(app, owner, '/admin/credentials', {
      template: 'openai',
      credential: 'sk-proj-repeat0123456789abcdefghij',
      allow_host: 'api.openai.com',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).not.toContain('also=');
    expect(await actions()).toEqual(['service.create']);
  });

  it('a value that is not the card host is a field error, with nothing written or sent', async () => {
    const owner = await session('owner');
    const res = await adminPost(app, owner, '/admin/credentials', {
      template: 'openai',
      credential: 'sk-proj-mismatch0123456789abcdefgh',
      allow_host: 'evil.example',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('href="#f-openai-allow_host"');
    expect(await getAllowedUpstreamHosts(env.DB)).toEqual(['api.github.com']);
    expect(await actions()).toEqual([]);
    expect(network.calls).toEqual([]);
  });

  it('without the box an owner is told to tick it, before anything is sent', async () => {
    const res = await adminPost(app, await session('owner'), '/admin/credentials', {
      template: 'openai',
      credential: 'sk-proj-nobox0123456789abcdefghijk',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(
      'api.openai.com is not an allowed host. Tick &quot;Also allow&quot;',
    );
    expect(network.calls).toEqual([]);
  });

  it.each(['token_manager', 'admin'] as const)(
    '%s posting allow_host is refused and nothing changes',
    async (role) => {
      const res = await adminPost(app, await session(role), '/admin/credentials', {
        template: 'openai',
        credential: 'sk-proj-refused0123456789abcdefghi',
        allow_host: 'api.openai.com',
      });
      expect(res.status).toBe(403);
      expect(await getAllowedUpstreamHosts(env.DB)).toEqual(['api.github.com']);
      expect(network.calls).toEqual([]);
    },
  );

  it('says the host was added when the token itself then fails', async () => {
    const owner = await session('owner');
    const res = await adminPost(app, owner, '/admin/credentials', {
      template: 'custom',
      base_url: 'https://api.example.com',
      injection_kind: 'bearer',
      verify_path: '/fail',
      credential: 'custom-fails-0123456789abcdefghij',
      allow_host: '1',
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(
      'api.example.com was added to Allowed hosts; the credential was not saved:',
    );
    expect(await getAllowedUpstreamHosts(env.DB)).toEqual(['api.github.com', 'api.example.com']);
    expect(await actions()).toEqual(['settings.upstream_hosts']);
  });

  it('the custom base URL pattern comes from the list for non-owners and compiles with the v flag', async () => {
    await setUpstreamHosts(['api.github.com', '*.slack.com']);
    const html = await (
      await adminGet(app, await session('admin'), '/admin/credentials/new?template=custom')
    ).text();
    const pattern = /id="f-custom-base_url"[^>]*pattern="([^"]+)"/.exec(html)?.[1] ?? '';
    const decoded = pattern.replaceAll('&amp;', '&').replaceAll('&quot;', '"');
    const re = new RegExp(`^(?:${decoded})$`, 'v');
    expect(re.test('https://api.github.com/v3')).toBe(true);
    expect(re.test('https://hooks.slack.com/services')).toBe(true);
    expect(re.test('https://evil.example.com')).toBe(false);
    const ownerHtml = await (
      await adminGet(app, await session('owner'), '/admin/credentials/new?template=custom')
    ).text();
    expect(ownerHtml).not.toMatch(/id="f-custom-base_url"[^>]*pattern=/);
    expect(ownerHtml).toContain('name="allow_host" value="1"');
  });

  it('the destination form allows the submitted host only while the box names it', async () => {
    const owner = await session('owner');
    const id = await customToken(owner);
    const path = `/admin/credentials/${id}/destination`;
    const stale = await adminPost(app, owner, path, {
      base_url: 'https://api.example.com',
      injection_kind: 'bearer',
      credential: DESTINATION_SECRET,
      allow_host: 'api.other.example',
    });
    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain('Check the box again: the base URL changed');
    const saved = await adminPost(app, owner, path, {
      base_url: 'https://api.example.com',
      injection_kind: 'bearer',
      credential: DESTINATION_SECRET,
      allow_host: 'api.example.com',
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toContain('also=host_added');
    expect(await getAllowedUpstreamHosts(env.DB)).toEqual(['api.github.com', 'api.example.com']);
  });

  it('a destination refused for another reason never changes the allowlist', async () => {
    const owner = await session('owner');
    // No stored secret: the host must be confirmed first (I-CRED-2), and that is checked first.
    // A custom credential, so the posted base URL is the one to allow.
    const id = await seedService(app.deps, { slug: 'bare', base_url: 'https://api.github.com/v3' });
    const sent = network.calls.length;
    const res = await adminPost(app, owner, `/admin/credentials/${id}/destination`, {
      base_url: 'https://api.example.com',
      injection_kind: 'bearer',
      credential: DESTINATION_SECRET,
      allow_host: 'api.example.com',
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Confirm destination host');
    expect(await getAllowedUpstreamHosts(env.DB)).toEqual(['api.github.com']);
    expect(await actions()).not.toContain('settings.upstream_hosts');
    expect(network.calls.length).toBe(sent);
  });
});

describe('I-SSRF-1: the GitHub uploads token when uploads.github.com is not allowed', () => {
  const GH = 'ghp_pairSecret0123456789abcdefghijklmn';

  it('an owner gets one box that adds the uploads token and allows its host in the same submit', async () => {
    const owner = await session('owner');
    const html = await (
      await adminGet(app, owner, '/admin/credentials/new?template=github')
    ).text();
    expect(html).toMatch(
      /<input type="checkbox" id="f-github-also_uploads" name="allow_host" value="uploads.github.com"/,
    );
    expect(html).toContain('and allow uploads.github.com in Allowed hosts');
    const res = await adminPost(app, owner, '/admin/credentials', {
      template: 'github',
      credential: GH,
      allow_host: 'uploads.github.com',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('also=uploads_host_added');
    expect(await getAllowedUpstreamHosts(env.DB)).toEqual(['api.github.com', 'uploads.github.com']);
    // The allowlist first, then both tokens: one submit, one paste.
    expect(await actions()).toEqual([
      'settings.upstream_hosts',
      'service.create',
      'service.create',
    ]);
    const page = await (await adminGet(app, owner, res.headers.get('location') ?? '')).text();
    expect(page).toContain('uploads.github.com was added to Allowed hosts.');
    expect(page).not.toContain('uploads credential was not created');
  });

  it.each(['token_manager', 'admin'] as const)(
    '%s gets no box, only the reason and whom to ask; a posted also_uploads is refused before anything is sent',
    async (role) => {
      const viewer = await session(role);
      await createUser({ email: 'owner@example.com', role: 'owner' });
      const html = await (
        await adminGet(app, viewer, '/admin/credentials/new?template=github')
      ).text();
      const card =
        /<details class="type-card" name="token-type" id="type-github"[\s\S]*?<\/details>/.exec(
          html,
        )?.[0] ?? '';
      expect(card).not.toContain('also_uploads');
      expect(card).toContain('uploads.github.com is not an allowed host');
      expect(card).toContain('mailto:owner@example.com');
      const res = await adminPost(app, viewer, '/admin/credentials', {
        template: 'github',
        credential: GH,
        also_uploads: '1',
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('href="#f-github-also_uploads"');
      expect(await actions()).toEqual([]);
      expect(network.calls).toEqual([]);
    },
  );

  it('the token page names why the uploads token was not created', async () => {
    const owner = await session('owner');
    const res = await adminPost(app, owner, '/admin/credentials', {
      template: 'github',
      credential: GH,
    });
    const path = (res.headers.get('location') ?? '').split('?')[0] ?? '';
    for (const [code, reason] of [
      ['pair_failed_hosts', 'uploads.github.com is not an allowed host'],
      ['pair_failed_check', 'its secret check failed'],
      ['pair_failed', 'its settings were refused'],
    ] as const) {
      const page = await (await adminGet(app, owner, `${path}?also=${code}`)).text();
      expect(page, code).toContain(
        `The GitHub release asset uploads credential was not created: ${reason}.`,
      );
    }
  });
});

describe('I-SSRF-1: Change destination allows a new host in one submit', () => {
  it('an owner gets the box from the start, and one submit allows the host and saves', async () => {
    const owner = await session('owner');
    const id = await customToken(owner);
    const html = await (
      await adminGet(app, owner, `/admin/credentials/${id}?open=destination`)
    ).text();
    const form =
      new RegExp(`action="/admin/credentials/${id}/destination"[\\s\\S]*?</form>`).exec(
        html,
      )?.[0] ?? '';
    expect(form).toContain('id="f-destination-allow_host" name="allow_host" value="1"');
    expect(form).not.toMatch(/id="f-destination-base_url"[^>]*pattern=/);
    const res = await adminPost(app, owner, `/admin/credentials/${id}/destination`, {
      base_url: 'https://api.example.com',
      injection_kind: 'bearer',
      credential: DESTINATION_SECRET,
      allow_host: '1',
    });
    expect(res.status).toBe(303);
    expect(await getAllowedUpstreamHosts(env.DB)).toEqual(['api.github.com', 'api.example.com']);
    // A box ticked for a covered host changes nothing.
    const again = await adminPost(app, owner, `/admin/credentials/${id}/destination`, {
      base_url: 'https://api.github.com',
      injection_kind: 'bearer',
      credential: DESTINATION_SECRET,
      allow_host: '1',
    });
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).not.toContain('also=');
    expect(await getAllowedUpstreamHosts(env.DB)).toEqual(['api.github.com', 'api.example.com']);
  });

  it('a non-owner gets the generated base URL pattern and no box', async () => {
    const owner = await session('owner');
    const id = await customToken(owner);
    const html = await (
      await adminGet(app, await session('admin'), `/admin/credentials/${id}?open=destination`)
    ).text();
    expect(html).toContain(`action="/admin/credentials/${id}/destination"`);
    const pattern = /id="f-destination-base_url"[^>]*pattern="([^"]+)"/.exec(html)?.[1] ?? '';
    const re = new RegExp(`^(?:${pattern.replaceAll('&amp;', '&')})$`, 'v');
    expect(re.test('https://api.github.com')).toBe(true);
    expect(re.test('https://api.example.com')).toBe(false);
    expect(html).not.toContain('id="f-destination-allow_host"');
  });

  it('format and allowlist errors come back together, format first', async () => {
    const owner = await session('owner');
    const id = await customToken(owner);
    const res = await adminPost(
      app,
      await session('admin'),
      `/admin/credentials/${id}/destination`,
      {
        base_url: 'https://blocked.example.com',
        injection_kind: 'header',
        credential: DESTINATION_SECRET,
      },
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    const header = html.indexOf('Enter the header name in lower case, like x-api-key');
    const blocked = html.indexOf('blocked.example.com is not an allowed host');
    expect(header).toBeGreaterThan(-1);
    expect(blocked).toBeGreaterThan(header);
    expect(network.calls.filter((call) => call.url.includes('blocked'))).toEqual([]);
  });
});

describe('A7.4: create reports every check that sends nothing in one re-render', () => {
  it('format, then type, then allowlist errors come back together; nothing is sent', async () => {
    const admin = await session('admin');
    await seedService(app.deps, { slug: 'foo', base_url: 'https://api.github.com' });
    const audited = (await actions()).length;
    const res = await adminPost(app, admin, '/admin/credentials', {
      template: 'custom',
      base_url: 'https://foo.example.com',
      injection_kind: 'bearer',
      forward_headers: 'bad header',
      credential: 'custom-secret-0123456789abcdefghij',
      slug: 'foo',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    const order = [
      'Extra header &quot;bad header&quot; must be a lower-case HTTP token',
      'Credentials of type foo call https://api.github.com; leave empty to use foo-2',
      'foo.example.com is not an allowed host. Ask an owner to allow it',
    ].map((text) => html.indexOf(text));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(network.calls).toEqual([]);
    expect((await actions()).length).toBe(audited);
  });
});
