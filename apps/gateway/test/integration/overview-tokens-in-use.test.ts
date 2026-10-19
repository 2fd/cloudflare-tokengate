// Overview "Tokens in use": the connections map of which callers (by issuer) can use which
// credential, with the credential access rule statuses (the map's text list), traffic counts that link to the
// filtered list, problems first and the idle tokens tagged.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/db/types';
import { adminGet, createUser, loginAs, resetControlPlane } from '../helpers/admin-auth';
import { type ProxyFixture, setupProxy } from '../helpers/proxy-fixtures';

let owner: User;
let viewer: User;
let fixture: ProxyFixture;

/** The "Tokens in use" tray. */
function section(html: string): string {
  return (
    /<section class="tray" id="tokens" aria-labelledby="tokens-h">[\s\S]*?<\/section>/.exec(
      html,
    )?.[0] ?? ''
  );
}

/** The map's text list: one item per access (arrow row + status word). */
function listItems(html: string): string[] {
  const list = /<ul class="cmap-list">[\s\S]*?<\/ul>/.exec(html)?.[0] ?? '';
  return [...list.matchAll(/<li>[\s\S]*?<\/li>/g)].map((m) => m[0]);
}

beforeEach(async () => {
  await resetControlPlane();
  owner = await createUser({ email: 'owner@example.com', role: 'owner' });
  viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  fixture = await setupProxy({ rule: { rules: [{ methods: ['GET'], path: '/ok/**' }] } });
});

describe('Tokens in use', () => {
  it('lists each credential access rule of a credential with its status, linked to the rule', async () => {
    const disabled = await fixture.addRule({ enabled: false });
    const expired = await fixture.addRule({ expiresAt: fixture.clock.now() - 1 });
    expect((await fixture.call('/ok/1')).status).toBe(200);
    await fixture.app.settle();
    const html = section(
      await (await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')).text(),
    );
    expect(html).toContain('<div class="cmap" id="ov-map" role="group"');
    const items = listItems(html);
    expect(items).toHaveLength(3);
    const item = (rule: string | null) =>
      items.find((li) => li.includes(`/admin/credential-access-rules/${rule}"`));
    // The spoken text of each item is a sentence; the status is a word, not a colour.
    expect(item(fixture.ruleId)).toMatch(
      /<span class="vh"> can use <\/span>[\s\S]*echo[\s\S]*<\/a><span class="st">Active<\/span>/,
    );
    expect(item(disabled)).toContain('<span class="st off">Disabled</span>');
    expect(item(expired)).toContain('<span class="st bad">Expired</span>');
    // Counts link to the filtered request list for the range.
    expect(html).toContain(`href="/admin/requests?token=${fixture.serviceId}&amp;range=24h"`);
    expect(html).toContain(
      `href="/admin/requests?token=${fixture.serviceId}&amp;range=24h&amp;outcome=denied"`,
    );
    expect(html).toContain(
      '<a class="linkish" href="/admin/credential-access-rules">Open credential access rules (3)',
    );
    // The credential node opens the credential access rules of the credential.
    expect(html).toContain(`href="/admin/credential-access-rules?credential=${fixture.serviceId}"`);
  });

  it('marks the rules of a disabled credential and of a credential without a secret', async () => {
    await env.DB.prepare('UPDATE credentials SET enabled = 0 WHERE id = ?')
      .bind(fixture.serviceId)
      .run();
    const bare = await fixture.addService({ slug: 'bare', secret: null });
    await fixture.addRule({ serviceId: bare.id });
    const html = section(
      await (await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')).text(),
    );
    expect(html).toContain('<span class="st off">Inactive: credential disabled</span>');
    expect(html).toContain('<span class="st off">Inactive: credential has no secret</span>');
    expect(html).toContain('<span class="t-bad">No credential</span>');
    // A token with a problem is listed first even without traffic.
    expect(html.indexOf('<span class="nm">bare ')).toBeLessThan(
      html.indexOf('<span class="nm">echo '),
    );
  });

  it('marks the rules that the global access rules block or limit', async () => {
    const limited = await fixture.addRule({ rules: [{ methods: ['GET'], path: '/**' }] });
    // Ceiling: GET /ok/** with the fixture's JWKS URI. The fixture rule (GET /ok/**) is within,
    // `limited` is not, and a rule with another JWKS URI can never pass.
    await fixture.addGlobalRule({
      name: 'ok only',
      jwksUri: fixture.issuer.jwksUri,
      rules: [{ methods: ['GET'], path: '/ok/**' }],
    });
    const blocked = await fixture.addRule({ jwksUri: 'https://jwks.example.net/keys' });
    const items = listItems(
      section(
        await (await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')).text(),
      ),
    );
    const item = (rule: string | null) =>
      items.find((li) => li.includes(`/admin/credential-access-rules/${rule}"`)) ?? '';
    expect(item(fixture.ruleId)).toContain('<span class="st">Active</span>');
    expect(item(limited)).toContain('Limited by global access rules');
    expect(item(blocked)).toContain('Blocked by global access rules');
  });

  it('draws every access in the text list, however many a token has', async () => {
    for (let i = 0; i < 4; i++) await fixture.addRule({});
    const html = section(
      await (await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')).text(),
    );
    expect(listItems(html)).toHaveLength(5);
    expect(html).toContain('<summary>Show the map as a list (5 accesses)</summary>');
  });

  it('tags the tokens without traffic or problems as idle', async () => {
    const html = section(
      await (await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')).text(),
    );
    expect(html).toContain('<li class="node tnode idle"><span class="tag">1 idle token</span>');
  });

  it('offers "Add credential access rule" on a credential with none, only to access:write holders', async () => {
    await fixture.addService({ slug: 'lonely' });
    const a = fixture.app;
    const own = section(await (await adminGet(a, await loginAs(a, owner), '/admin')).text());
    expect(own).toContain('no job can use this credential yet.');
    expect(own).toMatch(
      /href="\/admin\/credential-access-rules\/new\?credential=svc_[0-9A-Z]{26}">Add credential access rule/,
    );
    const tokenManager = await createUser({ email: 'tm@example.com', role: 'token_manager' });
    const tm = section(await (await adminGet(a, await loginAs(a, tokenManager), '/admin')).text());
    expect(tm).toContain('no job can use this credential yet.');
    expect(tm).not.toContain('/admin/credential-access-rules/new');
    const view = section(await (await adminGet(a, await loginAs(a, viewer), '/admin')).text());
    expect(view).not.toContain('/admin/credential-access-rules/new');
  });

  it('counts requests refused before a token was chosen, with a link to them', async () => {
    expect((await fixture.call('/x', { slug: 'nope' })).status).toBe(404);
    await fixture.app.settle();
    const html = section(
      await (await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')).text(),
    );
    expect(html).toContain('Refused before a token was chosen: <b class="t-bad">1</b>');
    expect(html).toContain('href="/admin/requests?token=none&amp;range=24h"');
  });

  it('labels the counts with the range of the page', async () => {
    const html = section(
      await (
        await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin?range=7d')
      ).text(),
    );
    expect(html).toContain('<span class="keep">Req 7 d</span>');
    expect(html).toContain('<span class="vh"> requests in 7 days</span>');
    expect(html).not.toContain('24 h');
  });

  it('says "use not recorded" for last use when the sample rate is 0', async () => {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('allowed_sample_rate', '0', 0)",
    ).run();
    expect((await fixture.call('/nope', { method: 'DELETE' })).status).toBe(403);
    await fixture.app.settle();
    const html = section(
      await (await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')).text(),
    );
    expect(html).toContain('use not recorded');
    expect(html).not.toContain('Unused 30+ days');
  });

  it('focuses the issuer of a credential access rule from ?focus=, and ignores any other value', async () => {
    const a = fixture.app;
    const session = await loginAs(a, viewer);
    const focused = section(
      await (await adminGet(a, session, `/admin?focus=${fixture.ruleId}`)).text(),
    );
    expect(focused).toContain('aria-label="Connections map focused on');
    const spoof = section(await (await adminGet(a, session, '/admin?focus=%3Cscript%3E')).text());
    expect(spoof).toContain(
      'aria-label="Connections map. Every line is also listed as text below."',
    );
    expect(spoof).not.toContain('<script>');
  });
});
