// Overview "Tokens in use": which consumers can use which token, one row per token, with access
// chips in the A9 vocabulary, traffic counts that link to the filtered list, problems first and
// idle tokens folded away.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/db/types';
import { adminGet, createUser, loginAs, resetControlPlane } from '../helpers/admin-auth';
import { type ProxyFixture, setupProxy } from '../helpers/proxy-fixtures';

let owner: User;
let viewer: User;
let fixture: ProxyFixture;

/** The "Tokens in use" section. */
function section(html: string): string {
  return /<section aria-labelledby="tokens-h">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
}

beforeEach(async () => {
  await resetControlPlane();
  owner = await createUser({ email: 'owner@example.com', role: 'owner' });
  viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  fixture = await setupProxy({ grant: { rules: [{ methods: ['GET'], path: '/ok/**' }] } });
});

describe('Tokens in use', () => {
  it('shows each access of a token as a chip with its status, linked to the access', async () => {
    const disabled = await fixture.addGrant({ enabled: false });
    const expired = await fixture.addGrant({ expiresAt: fixture.clock.now() - 1 });
    expect((await fixture.call('/ok/1')).status).toBe(200);
    await fixture.app.settle();
    const html = section(
      await (await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')).text(),
    );
    expect(html).toContain('<ul class="chips" aria-label="Consumers that can use echo">');
    expect(html).toContain(`href="/admin/access/${fixture.grantId}"`);
    expect(html).toContain(`href="/admin/access/${disabled}"`);
    expect(html).toContain(`href="/admin/access/${expired}"`);
    // The chip's spoken text is a sentence; the status is text, not colour.
    expect(html).toMatch(/can use echo: Active\.<\/span>/);
    expect(html).toContain('Disabled');
    expect(html).toContain('Expired');
    // Counts link to the filtered request list for the range.
    expect(html).toContain(`href="/admin/requests?token=${fixture.serviceId}&amp;range=24h"`);
    expect(html).toContain(
      `href="/admin/requests?token=${fixture.serviceId}&amp;range=24h&amp;outcome=denied"`,
    );
    expect(html).toContain('href="/admin/access"');
  });

  it('marks a consumer that is disabled and a token without a secret', async () => {
    await env.DB.prepare('UPDATE caller_providers SET enabled = 0 WHERE id = ?')
      .bind(fixture.providerId)
      .run();
    const bare = await fixture.addService({ slug: 'bare', secret: null });
    await fixture.addGrant({ serviceId: bare.id });
    const html = section(
      await (await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')).text(),
    );
    expect(html).toContain('Inactive: consumer disabled');
    expect(html).toContain('No credential');
    // A token with a problem is listed first even without traffic.
    expect(html.indexOf('>bare</a>')).toBeLessThan(html.indexOf('>echo</a>'));
  });

  it('shows at most 3 chips and links the rest to the access list of the token', async () => {
    for (let i = 0; i < 4; i++) await fixture.addGrant({});
    const html = section(
      await (await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')).text(),
    );
    expect(html).toContain(`<a href="/admin/access?token=${fixture.serviceId}">and 2 more</a>`);
  });

  it('folds tokens without traffic or problems into a details', async () => {
    const html = section(
      await (await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')).text(),
    );
    expect(html).toContain('<summary>1 idle token</summary>');
  });

  it('offers "Give a consumer access" on a token with none, only to access:write holders', async () => {
    await fixture.addService({ slug: 'lonely' });
    const a = fixture.app;
    const own = section(await (await adminGet(a, await loginAs(a, owner), '/admin')).text());
    expect(own).toContain('No consumer can use this token yet.');
    expect(own).toMatch(
      /href="\/admin\/access\/new\?token=svc_[0-9A-Z]{26}">Give a consumer access/,
    );
    const tokenManager = await createUser({ email: 'tm@example.com', role: 'token_manager' });
    const tm = section(await (await adminGet(a, await loginAs(a, tokenManager), '/admin')).text());
    expect(tm).toContain('No consumer can use this token yet.');
    expect(tm).not.toContain('/admin/access/new');
    const view = section(await (await adminGet(a, await loginAs(a, viewer), '/admin')).text());
    expect(view).not.toContain('/admin/access/new');
  });

  it('counts requests refused before a token was chosen, with a link to them', async () => {
    expect((await fixture.call('/x', { slug: 'nope' })).status).toBe(404);
    await fixture.app.settle();
    const html = section(
      await (await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')).text(),
    );
    expect(html).toContain('Refused before a token was chosen: 1');
    expect(html).toContain('href="/admin/requests?token=none&amp;range=24h"');
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
});
