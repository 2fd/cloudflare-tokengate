// A template card posts only the secret and display fields: the destination, injection, headers,
// timeout and check come from SERVICE_TEMPLATES, so a crafted form cannot point a template token
// elsewhere (I-SSRF-1). A secret pasted into the wrong card is refused before anything is sent,
// without echoing it (I-CRED-1). The slug is checked before the check sends the secret, and without
// a keyring no secret field is rendered at all.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '../../src/db/types';
import { adminGet, adminPost, createUser, loginAs, resetControlPlane } from '../helpers/admin-auth';
import { createTestApp, type TestApp } from '../helpers/app';
import { fakeNetwork, KEK_1 } from '../unit/admin/ops/helpers';

let network: ReturnType<typeof fakeNetwork>;
let app: TestApp;

beforeEach(async () => {
  await resetControlPlane();
  network = fakeNetwork();
  app = createTestApp({ fetch: network.fetch, env: { TOKENGATE_KEK: KEK_1 } });
});

async function session(role: Role = 'admin') {
  return loginAs(app, await createUser({ email: `${role}@example.com`, role }));
}

const row = (slug: string) =>
  env.DB.prepare('SELECT * FROM credentials WHERE slug = ?')
    .bind(slug)
    .first<Record<string, unknown>>();

describe('I-SSRF-1: template fields cannot be overridden from the form', () => {
  it('stores the template destination, headers, timeout and check whatever else is posted', async () => {
    const res = await adminPost(app, await session(), '/admin/credentials', {
      template: 'slack',
      credential: 'xoxb-1111-2222-integritytest0000',
      base_url: 'https://evil.example',
      injection_kind: 'query',
      injection_param: 'token',
      forward_headers: 'x-evil',
      timeout_ms: '900000',
      verify_path: '/steal',
      verify_method: 'GET',
    });
    expect(res.status).toBe(303);
    expect(await row('slack')).toMatchObject({
      base_url: 'https://slack.com/api',
      injection: '{"kind":"bearer"}',
      forward_headers: '[]',
      timeout_ms: 30000,
      verify: '{"expect_ok_field":true,"expect_status":200,"method":"POST","path":"/auth.test"}',
      template_id: 'slack',
    });
    expect(network.calls.map((call) => new URL(call.url).host)).toEqual(['slack.com']);
  });

  it('refuses an unknown template id without creating anything', async () => {
    const res = await adminPost(app, await session(), '/admin/credentials', {
      template: 'constructor',
      credential: 'xoxb-1111-2222-integritytest0000',
      base_url: 'https://evil.example',
    });
    expect(res.status).toBe(400);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM credentials').first('n')).toBe(0);
    expect(network.calls).toEqual([]);
  });

  it('checks a typed slug before the check sends the secret', async () => {
    const admin = await session();
    await adminPost(app, admin, '/admin/credentials', {
      template: 'slack',
      credential: 'xoxb-1111-2222-integritytest0000',
    });
    const sent = network.calls.length;
    const res = await adminPost(app, admin, '/admin/credentials', {
      template: 'slack',
      credential: 'xoxb-3333-4444-integritytest0000',
      slug: 'slack',
    });
    expect(res.status).toBe(409);
    expect(network.calls.length).toBe(sent);
  });

  it('splits a whole webhook URL: the template base stays, only the path secret is sealed', async () => {
    const res = await adminPost(app, await session(), '/admin/credentials', {
      template: 'discord-webhook',
      credential:
        'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    });
    expect(res.status).toBe(303);
    expect(await row('discord-webhook')).toMatchObject({
      base_url: 'https://discord.com/api/webhooks',
      injection: '{"kind":"path"}',
      credential_hint: '…2345 (51 chars)',
    });
  });

  it('a wrong webhook prefix gives 400 with the error at the secret field', async () => {
    const res = await adminPost(app, await session(), '/admin/credentials', {
      template: 'slack-webhook',
      credential: 'https://hooks.example.com/services/T0/B0/abc',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(
      /id="f-slack-webhook-credential"[^>]*aria-describedby="[^"]*f-slack-webhook-credential-error/,
    );
    expect(html).toMatch(/id="f-slack-webhook-credential"[^>]*aria-invalid="true"/);
    expect(html).not.toContain('hooks.example.com/services/T0');
  });
});

describe('I-CRED-1: a secret pasted into the wrong card never leaves the gateway', () => {
  it.each([
    ['slack', 'ghp_wrongcard0123456789abcdefghijklmn', 'GitHub REST API'],
    ['openai', 'sk-ant-api03-wrongcard0123456789abcdef', 'Anthropic API'],
    ['github', 'xoxb-1111-2222-wrongcard0123456789', 'Slack Web API'],
    ['anthropic', 'https://hooks.slack.com/services/T0/B0/wrongcard', 'Slack incoming webhook'],
  ])(
    '%s card refuses %s before any fetch, naming the likely card',
    async (template, secret, likely) => {
      const res = await adminPost(app, await session(), '/admin/credentials', {
        template,
        credential: secret,
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain(`This looks like a ${likely} secret`);
      expect(html).toContain('href="#f-' + template + '-credential"');
      expect(html).not.toContain(secret);
      expect(html).not.toContain(encodeURIComponent(secret));
      // No draft for a refused secret: it would only follow the wrong card around.
      expect(html).not.toContain('name="credential_draft"');
      expect(network.calls).toEqual([]);
      expect(await env.DB.prepare('SELECT count(*) AS n FROM credentials').first('n')).toBe(0);
    },
  );

  it('a URL pasted into a card that takes no URL is refused', async () => {
    const res = await adminPost(app, await session(), '/admin/credentials', {
      template: 'openai',
      credential: 'https://api.example.com/?key=abc',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('This is a URL. Paste the API key of OpenAI API itself');
    expect(network.calls).toEqual([]);
  });

  it('without a keyring no secret field is rendered (keyring gate)', async () => {
    const noKey = createTestApp({ fetch: network.fetch, env: { TOKENGATE_KEK: '' } });
    const admin = await loginAs(noKey, await createUser({ email: 'a@example.com', role: 'admin' }));
    for (const path of [
      '/admin/credentials',
      '/admin/credentials/new',
      '/admin/credentials/new?template=slack',
    ]) {
      const html = await (await adminGet(noKey, admin, path)).text();
      expect(html, path).not.toContain('type="password"');
      expect(html, path).toContain('Secrets cannot be stored:');
      expect(html, path).toContain('href="/admin/credentials/keys"');
    }
  });
});
