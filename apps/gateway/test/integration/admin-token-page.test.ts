// The token page and list on design D (A13.1, A13.3): the "Who can use" map with its scale rule,
// problems as callouts that name the token, the rail history, the delete dialog's "Disable
// instead" form, and the Allowed hosts and Encryption keys settings pages.
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
const SECRET = 'sk-proj-test0123456789abcdefghijWXYZ';
const DAY = 86_400_000;

let app: TestApp;

beforeEach(async () => {
  await resetControlPlane();
  app = createTestApp({
    env: { TOKENGATE_KEK: KEK },
    fetch: async () => Response.json({ data: [] }),
  });
});

async function sessionFor(role: Role, email = `${role}@example.com`): Promise<AdminSession> {
  return loginAs(app, await createUser({ email, role }));
}

async function createOpenAi(session: AdminSession): Promise<string> {
  const res = await adminPost(app, session, '/admin/tokens', {
    template: 'openai',
    credential: SECRET,
  });
  const id = /svc_[0-9A-Z]{26}/.exec(res.headers.get('location') ?? '')?.[0];
  if (!id) throw new Error(`unexpected ${res.status}`);
  return id;
}

async function insertConsumer(id: string, name: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO caller_providers (id, name, profile, issuer, jwks_uri, audience, allowed_algs,
       max_token_age_seconds, tenant_pin, anchor_claims, enabled, created_at, updated_at)
     VALUES (?, ?, 'generic', ?, ?, 'tokengate:0123456789ABCDEF',
       '["RS256"]', 600, '[]', '[]', 1, ?, ?)`,
  )
    .bind(id, name, `https://${id}.example.com`, `https://${id}.example.com/jwks`, now, now)
    .run();
}

async function insertAccess(
  id: string,
  consumerId: string,
  serviceId: string,
  repo: string,
  expiresAt: number | null = null,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO grants (id, name, description, caller_provider_id, service_id, conditions, rules,
       enabled, expires_at, created_by, created_at, updated_at)
     VALUES (?, ?, '', ?, ?, ?, '[{"methods":["POST"],"path":"/responses"}]', 1, ?, NULL, ?, ?)`,
  )
    .bind(
      id,
      repo,
      consumerId,
      serviceId,
      JSON.stringify([
        { claim: 'repository', match: 'exact', values: [repo] },
        { claim: 'ref', match: 'exact', values: ['refs/heads/main'] },
      ]),
      expiresAt,
      now,
      now,
    )
    .run();
}

describe('who can use a token', () => {
  it('draws at most 3 consumers and 3 accesses each, and says what it leaves out', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    for (const [n, name] of ['Alpha CI', 'Beta CI', 'Gamma CI', 'Delta CI'].entries()) {
      await insertConsumer(`cpr_${n}`, name);
    }
    // Alpha has 5 accesses (one expiring), the others one each.
    for (let n = 0; n < 5; n++) {
      await insertAccess(
        `grt_A${n}`,
        'cpr_0',
        id,
        `acme/a${n}`,
        n === 4 ? Date.now() + 3 * DAY : null,
      );
    }
    await insertAccess('grt_B', 'cpr_1', id, 'acme/b');
    await insertAccess('grt_C', 'cpr_2', id, 'acme/c');
    await insertAccess('grt_D', 'cpr_3', id, 'acme/d');
    const html = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    const map = /<ul class="wgroups"[\s\S]*?<\/ul>\s*<div class="whub"/.exec(html)?.[0] ?? '';
    // Groups by requests, then name: Alpha, Beta, Delta drawn; Gamma goes to the matrix node.
    expect(map.match(/<li class="wg">/g)).toHaveLength(3);
    expect(map).toContain('Alpha CI');
    expect(map).not.toContain('Gamma CI');
    expect(map.match(/<li class="wrow(?: warn)?">/g)).toHaveLength(5);
    expect(map).toContain(
      `href="/admin/access?token=${id}&amp;consumer=cpr_0">+ 2 more accesses<span class="vh"> of Alpha CI to OpenAI</span></a>`,
    );
    expect(map).toContain('<span class="meta">1 expiring</span>');
    expect(map).toContain(
      `<a class="node group" href="/admin/access?token=${id}&amp;view=matrix">`,
    );
    expect(map).toContain('+ 1 more consumer · 1 access');
    expect(html).toContain('<b>4 consumers, 8 accesses.</b>');
    expect(html).toContain(
      `<a href="/admin/access?token=${id}&amp;status=expiring">1 expiring</a>`,
    );
    expect(html).toContain('Who can use OpenAI<span class="count">8</span>');
  });

  it('an access manager gets "Give another consumer access"; nobody else does', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await insertConsumer('cpr_0', 'Alpha CI');
    await insertAccess('grt_A', 'cpr_0', id, 'acme/a');
    const html = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    expect(html).toMatch(
      /<a class="btn sm ghost" href="\/admin\/access\/new\?token=[^"]+">[\s\S]*?Give another consumer access/,
    );
    const viewer = await (
      await adminGet(app, await sessionFor('viewer'), `/admin/tokens/${id}`)
    ).text();
    expect(viewer).not.toContain('Give another consumer access');
    expect(viewer).toContain('Consumer access is granted by access managers. Send them this link:');
  });
});

describe('problems and history', () => {
  it('an expiring secret names the token and its date, with the fix for writers only', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const at = Date.now() + 3 * DAY + 3_600_000;
    await env.DB.prepare('UPDATE services SET credential_expires_at = ? WHERE id = ?')
      .bind(at, id)
      .run();
    const page = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    expect(page).toMatch(
      /<div class="callout warn">[\s\S]*?The secret of OpenAI expires on \d+ \w+ \d{4} \(in 4 days\)\./,
    );
    expect(page).toContain(`href="/admin/tokens/${id}#secret">Replace the secret</a>`);
    expect(page).toContain('Expires in 4 days');
    const list = await (await adminGet(app, admin, '/admin/tokens')).text();
    expect(list).toContain('The secret of OpenAI expires on');
    expect(list).toContain('Replace secret<span class="vh"> of OpenAI</span>');
    expect(list).toMatch(
      /<span class="meta t-warn"><span aria-hidden="true">⌛ <\/span>Expires in 4 days<\/span>/,
    );
    const viewer = await (
      await adminGet(app, await sessionFor('viewer'), `/admin/tokens/${id}`)
    ).text();
    expect(viewer).not.toContain('>Replace the secret</a>');
    expect(viewer).toContain('Only token managers can replace the secret.');
  });

  it('a disabled token says so first, with Enable for writers', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await adminPost(app, admin, `/admin/tokens/${id}/toggle`, { enabled: '0' });
    const page = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    expect(page).toContain('OpenAI is disabled: requests through it are refused.');
    const enable =
      /<form class="action-form" method="post" action="[^"]+\/toggle">(?:(?!<\/form>)[\s\S])*?>Enable<span class="vh"> OpenAI<\/span>/.exec(
        page,
      )?.[0] ?? '';
    expect(enable).toContain('name="_return" value="detail"');
    expect(enable).toContain('name="enabled" value="1"');
    expect(page).toContain('<h3>Enable token</h3>');
    expect(page).toMatch(/<h1>OpenAI <span class="badge off">/);
  });

  it('the rail shows the record, who created it and the newest changes', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await adminPost(app, admin, `/admin/tokens/${id}`, { name: 'OpenAI prod' });
    const page = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    const rail =
      /<aside class="rail" aria-label="OpenAI prod details">[\s\S]*?<\/aside>/.exec(page)?.[0] ??
      '';
    expect(rail).toContain('<dt>Token ID</dt><dd class="mono copyable">' + id);
    expect(rail).toContain('<small>by admin@example.com</small>');
    expect(rail).toMatch(
      /<ol class="feed compact">[\s\S]*?<b>admin@example\.com<\/b> created service openai with a credential/,
    );
    expect(rail.indexOf('updated service openai')).toBeGreaterThan(-1);
    expect(rail.indexOf('updated service openai')).toBeLessThan(rail.indexOf('created service'));
    expect(rail).toContain(`href="/admin/audit?target=${id}"`);
  });
});

describe('delete dialog', () => {
  it('offers "Disable instead" through a detached form that carries the CSRF token', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await insertConsumer('cpr_0', 'Alpha CI');
    await insertAccess('grt_A', 'cpr_0', id, 'acme/a');
    const page = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    const dialog = /<dialog class="dlg" id="dlg-delete"[\s\S]*?<\/dialog>/.exec(page)?.[0] ?? '';
    expect(dialog).toContain('Delete OpenAI and its 1 consumer access?');
    expect(dialog).toContain('<button class="btn sm secondary" type="submit" form="dlg-disable">');
    expect(dialog).toContain('name="confirm_slug"');
    expect(dialog).toContain('pattern="openai"');
    expect(dialog).toContain('href="/admin/access/grt_A"');
    const detached =
      /<form method="post" action="[^"]+\/toggle" id="dlg-disable" hidden="">[\s\S]*?<\/form>/.exec(
        page,
      )?.[0] ?? '';
    expect(detached).toContain(`name="_csrf" value="${admin.csrfToken}"`);
    expect(detached).toContain('name="enabled" value="0"');
    // A disabled token has nothing to disable instead.
    await adminPost(app, admin, `/admin/tokens/${id}/toggle`, { enabled: '0' });
    const disabled = await (await adminGet(app, admin, `/admin/tokens/${id}`)).text();
    expect(disabled).not.toContain('id="dlg-disable"');
    expect(disabled).toContain('commandfor="dlg-delete"');
  });
});

describe('settings pages', () => {
  it('Allowed hosts re-opens its dialog after a refused save', async () => {
    const owner = await sessionFor('owner');
    const res = await adminPost(app, owner, '/admin/tokens/hosts', { mode: 'list' });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/<dialog class="dlg wide lform" id="dlg-hosts"[^>]* open="">/);
    expect(html).toMatch(/name="mode" value="list" checked=""/);
  });

  it('Encryption keys lists the keys in a tray with their state as a word', async () => {
    const html = await (
      await adminGet(app, await sessionFor('viewer'), '/admin/tokens/keys')
    ).text();
    expect(html).toContain('<h1>Encryption keys</h1>');
    expect(html).toMatch(/<section class="tray" id="keys" aria-labelledby="keys-h">/);
    expect(html).toContain('<span class="badge ok"><span aria-hidden="true">✓</span>Active</span>');
    expect(html).toContain('Every stored secret uses the active key.');
    expect(html).not.toContain('commandfor="dlg-rewrap"');
  });
});
