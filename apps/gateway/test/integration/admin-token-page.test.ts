// The credential page and list on design D (A13.1, A13.3, A7.9): the "Who can use" map grouped by
// issuer with its scale rule and global statuses,
// problems as callouts that name the credential, the rail history, the delete dialog's "Disable
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
  const res = await adminPost(app, session, '/admin/credentials', {
    template: 'openai',
    credential: SECRET,
  });
  const id = /svc_[0-9A-Z]{26}/.exec(res.headers.get('location') ?? '')?.[0];
  if (!id) throw new Error(`unexpected ${res.status}`);
  return id;
}

/** A credential access rule id from a short Crockford tag. */
const acr = (tag: string) => `acr_01J${tag.padStart(23, '0')}`;

let seq = 0;

/** A credential access rule of `credentialId` for `issuer`, allowing POST /responses for `repo`. */
async function insertRule(
  id: string,
  credentialId: string,
  issuer: string,
  repo: string,
  extra: { expiresAt?: number | null; jwksUri?: string; tenantPin?: unknown[] } = {},
): Promise<void> {
  const at = Date.now() + seq++;
  await env.DB.prepare(
    `INSERT INTO access_rules (id, credential_id, name, profile, issuer, issuer_key, jwks_uri, audience,
       allowed_algs, max_token_age_seconds, tenant_pin, anchor_claims, conditions, rules, enabled,
       expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'generic', ?, ?, ?, 'tokengate:0123456789ABCDEF', '["RS256"]', 600, ?, '[]', ?,
       '[{"methods":["POST"],"path":"/responses"}]', 1, ?, ?, ?)`,
  )
    .bind(
      id,
      credentialId,
      repo,
      issuer,
      issuer.toLowerCase(),
      extra.jwksUri ?? `${issuer}/jwks`,
      JSON.stringify(extra.tenantPin ?? []),
      JSON.stringify([
        { claim: 'repository', match: 'exact', values: [repo] },
        { claim: 'ref', match: 'exact', values: ['refs/heads/main'] },
      ]),
      extra.expiresAt ?? null,
      at,
      at,
    )
    .run();
}

/** A global access rule of `issuer` that pins its JWKS URI. */
async function insertGlobalRule(id: string, issuer: string, jwksUri: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO access_rules (id, credential_id, name, profile, issuer, issuer_key, jwks_uri, enabled,
       created_at, updated_at)
     VALUES (?, NULL, 'pinned keys', 'generic', ?, ?, ?, 1, ?, ?)`,
  )
    .bind(id, issuer, issuer.toLowerCase(), jwksUri, now, now)
    .run();
}

describe('who can use a credential (A7.9)', () => {
  const ALPHA = 'https://alpha.example.com';

  it('groups the rules by issuer, draws at most 3 issuers and 3 rules each, and says what it leaves out', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    // Alpha has 5 rules (the last one expiring), the others one each.
    for (let n = 0; n < 5; n++) {
      await insertRule(acr(`A${n}`), id, ALPHA, `acme/a${n}`, {
        expiresAt: n === 4 ? Date.now() + 3 * DAY : null,
      });
    }
    await insertRule(acr('B'), id, 'https://beta.example.com', 'acme/b');
    await insertRule(acr('C'), id, 'https://gamma.example.com', 'acme/c');
    await insertRule(acr('D'), id, 'https://delta.example.com', 'acme/d');
    const html = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    const map = /<ul class="wgroups"[\s\S]*?<\/ul>\s*<div class="whub"/.exec(html)?.[0] ?? '';
    // Groups by requests, then name: Alpha, Beta, Delta drawn; Gamma goes to the rest node.
    expect(map.match(/<li class="wg">/g)).toHaveLength(3);
    expect(map).toContain('alpha.example.com');
    expect(map).not.toContain('gamma.example.com');
    expect(map.match(/<li class="wrow(?: warn)?">/g)).toHaveLength(5);
    expect(map).toContain(`href="/admin/credential-access-rules/${acr('A0')}"`);
    expect(map).toContain(
      `href="/admin/credential-access-rules?credential=${id}&amp;issuer=https%3A%2F%2Falpha.example.com">+ 2 more access rules<span class="vh"> of alpha.example.com to OpenAI</span></a>`,
    );
    expect(map).toContain('<span class="meta">1 expiring</span>');
    expect(map).toContain(
      `<a class="node group" href="/admin/credential-access-rules?credential=${id}">`,
    );
    expect(map).toContain('+ 1 more issuer · 1 access rule');
    expect(html).toContain('<b>4 issuers, 8 access rules.</b>');
    expect(html).toContain('Who can use OpenAI<span class="count">8</span>');
    // Each row names its jobs and its operations.
    expect(map).toContain('<code>POST /responses</code>');
  });

  it('marks a rule that the global access rules block, and names the global status in the row', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await insertRule(acr('OK'), id, ALPHA, 'acme/ok');
    await insertRule(acr('BAD'), id, ALPHA, 'acme/bad', { jwksUri: `${ALPHA}/other-keys` });
    await insertGlobalRule('gar_01JAAAAAAAAAAAAAAAAAAAAAAA', ALPHA, `${ALPHA}/jwks`);
    const html = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    const row = (rule: string) =>
      new RegExp(
        `<li class="wrow(?: warn)?">(?:(?!</li>)[\\s\\S])*?/admin/credential-access-rules/${rule}"[\\s\\S]*?</li>`,
      ).exec(html)?.[0] ?? '';
    expect(row(acr('BAD'))).toContain('<li class="wrow warn">');
    expect(row(acr('BAD'))).toContain('<span class="t-bad">blocked by global access rules</span>');
    expect(row(acr('BAD'))).toContain('Blocked by global access rules');
    expect(row(acr('OK'))).not.toContain('global access rules');
  });

  it('an access manager gets "Add another credential access rule"; nobody else does', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await insertRule(acr('A'), id, ALPHA, 'acme/a');
    const html = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    expect(html).toMatch(
      /<a class="btn sm ghost" href="\/admin\/credential-access-rules\/new\?credential=[^"]+">[\s\S]*?Add another credential access rule/,
    );
    const access = await (
      await adminGet(app, await sessionFor('access_manager'), `/admin/credentials/${id}`)
    ).text();
    expect(access).toContain('Add another credential access rule');
    for (const role of ['viewer', 'token_manager'] as const) {
      const page = await (
        await adminGet(app, await sessionFor(role), `/admin/credentials/${id}`)
      ).text();
      expect(page, role).not.toContain('Add another credential access rule');
      expect(page, role).toContain(
        'Access managers add credential access rules. Send them this link:',
      );
      expect(page, role).toContain(`/admin/credential-access-rules/new?credential=${id}`);
    }
  });
});

describe('replace secret and destination', () => {
  const dangerZone = (html: string) =>
    /<section class="tray danger-zone" id="danger"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  const destinationTray = (html: string) =>
    /<section class="tray" id="destination"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  const replaceDialog = (html: string) =>
    /<dialog[^>]*id="dlg-replace"[\s\S]*?<\/dialog>/.exec(html)?.[0] ?? '';

  async function createCustom(session: AdminSession): Promise<string> {
    const res = await adminPost(app, session, '/admin/credentials', {
      template: 'custom',
      slug: 'custom',
      base_url: 'https://api.example.com/v1',
      injection_kind: 'bearer',
      verify_path: '',
      credential: 'custom-secret-0123456789abcdefWXYZ',
    });
    const id = /svc_[0-9A-Z]{26}/.exec(res.headers.get('location') ?? '')?.[0];
    if (!id) throw new Error(`unexpected ${res.status}`);
    return id;
  }

  it('"Replace secret…" is a danger zone action that opens the dlg-replace dialog', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    const page = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    const danger = dangerZone(page);
    expect(danger).toContain('Replace secret</h3>');
    expect(danger).toMatch(/<button[^>]*commandfor="dlg-replace"[^>]*>Replace secret…/);
    const dialog = replaceDialog(page);
    expect(dialog).toContain(`action="/admin/credentials/${id}/secret"`);
    expect(dialog).toContain('name="credential"');
    expect(dialog).toContain('name="expected_destination"');
    // Closed until the button opens it.
    expect(dialog).toMatch(/^<dialog[^>]*popover="auto"/);
    expect(dialog).not.toMatch(/^<dialog[^>]*\bopen=""/);
    // The Secret tray no longer holds the rotate form.
    const secretTray = /<section class="tray" id="secret"[\s\S]*?<\/section>/.exec(page)?.[0] ?? '';
    expect(secretTray).not.toContain(`action="/admin/credentials/${id}/secret"`);

    for (const role of ['viewer', 'access_manager'] as const) {
      const other = await (
        await adminGet(app, await sessionFor(role), `/admin/credentials/${id}`)
      ).text();
      expect(other, role).not.toContain('id="dlg-replace"');
      expect(other, role).not.toContain('Replace secret…');
    }
  });

  it('offers no Replace secret while the stored destination is not attested', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await env.DB.prepare(
      "UPDATE credentials SET base_url = 'https://attacker.example' WHERE id = ?",
    )
      .bind(id)
      .run();
    const page = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    expect(page).not.toContain('Replace secret…');
    expect(page).not.toContain('commandfor="dlg-replace"');
  });

  it('a template credential has a fixed destination: a Settings tray, no Change destination', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    for (const path of [`/admin/credentials/${id}`, `/admin/credentials/${id}?open=destination`]) {
      const page = await (await adminGet(app, admin, path)).text();
      const tray = destinationTray(page);
      expect(tray, path).toMatch(/id="destination-h">Settings</);
      expect(tray, path).toContain('OpenAI API: the destination is fixed.');
      expect(tray, path).not.toContain('Base URL');
      expect(tray, path).not.toContain('Secret sent as');
      expect(page, path).not.toContain('Change destination…');
      expect(page, path).not.toContain('?open=destination#destination');
      expect(page, path).not.toContain(`action="/admin/credentials/${id}/destination"`);
      expect(tray, path).toContain(`href="/admin/credentials/${id}?open=details#details"`);
    }
  });

  it('a template credential without a secret gets "Set the secret", with no destination fields', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await env.DB.prepare(
      'UPDATE credentials SET credential_sealed = NULL, credential_hint = NULL WHERE id = ?',
    )
      .bind(id)
      .run();
    const page = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    expect(page).toMatch(/<details[^>]*id="destination-edit"[^>]*open=""/);
    expect(page).toContain('Set the secret');
    const form =
      new RegExp(`<form[^>]*action="/admin/credentials/${id}/destination"[\\s\\S]*?</form>`).exec(
        page,
      )?.[0] ?? '';
    expect(form).toContain('name="credential"');
    expect(form).toContain('name="confirm_destination"');
    expect(form).not.toContain('name="base_url"');
    expect(form).not.toContain('name="injection_kind"');
    expect(page).not.toContain('Change destination…');
  });

  it('a custom credential keeps Change destination and its Destination tray', async () => {
    const admin = await sessionFor('admin');
    const id = await createCustom(admin);
    const page = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    const tray = destinationTray(page);
    expect(tray).toMatch(/id="destination-h">Destination</);
    expect(tray).toContain('Base URL');
    expect(tray).toContain('https://api.example.com/v1');
    expect(tray).toContain(`href="/admin/credentials/${id}?open=destination#destination"`);
    expect(tray).toContain('Change destination…');
    const open = await (
      await adminGet(app, admin, `/admin/credentials/${id}?open=destination`)
    ).text();
    const form =
      new RegExp(`<form[^>]*action="/admin/credentials/${id}/destination"[\\s\\S]*?</form>`).exec(
        open,
      )?.[0] ?? '';
    expect(form).toContain('name="base_url"');
    expect(form).toContain('name="injection_kind"');
    expect(open).toContain('Replace secret…');
  });
});

describe('problems and history', () => {
  it('a disabled token says so first, with Enable for writers', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await adminPost(app, admin, `/admin/credentials/${id}/toggle`, { enabled: '0' });
    const page = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    expect(page).toContain('OpenAI is disabled: requests through it are refused.');
    const enable =
      /<form class="action-form" method="post" action="[^"]+\/toggle">(?:(?!<\/form>)[\s\S])*?>Enable<span class="vh"> OpenAI<\/span>/.exec(
        page,
      )?.[0] ?? '';
    expect(enable).toContain('name="_return" value="detail"');
    expect(enable).toContain('name="enabled" value="1"');
    expect(page).toContain('<h3>Enable credential</h3>');
    expect(page).toMatch(/<h1>OpenAI <span class="badge off">/);
  });

  it('the rail shows the record, who created it and the newest changes', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await adminPost(app, admin, `/admin/credentials/${id}`, { name: 'OpenAI prod' });
    const page = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    const rail =
      /<aside class="rail" aria-label="OpenAI prod details">[\s\S]*?<\/aside>/.exec(page)?.[0] ??
      '';
    expect(rail).toContain('<dt>Credential ID</dt><dd class="mono copyable">' + id);
    expect(rail).toContain('<small>by admin@example.com</small>');
    expect(rail).toMatch(
      /<ol class="feed compact">[\s\S]*?<b>admin@example\.com<\/b> created credential openai with a secret/,
    );
    expect(rail.indexOf('updated credential openai')).toBeGreaterThan(-1);
    expect(rail.indexOf('updated credential openai')).toBeLessThan(
      rail.indexOf('created credential'),
    );
    expect(rail).toContain(`href="/admin/audit?target=${id}"`);
  });
});

describe('delete dialog', () => {
  it('offers "Disable instead" through a detached form that carries the CSRF token', async () => {
    const admin = await sessionFor('admin');
    const id = await createOpenAi(admin);
    await insertRule(acr('A'), id, 'https://alpha.example.com', 'acme/a');
    const page = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    const dialog = /<dialog class="dlg" id="dlg-delete"[\s\S]*?<\/dialog>/.exec(page)?.[0] ?? '';
    expect(dialog).toContain('Delete OpenAI and its 1 credential access rule?');
    expect(dialog).toContain('<button class="btn sm secondary" type="submit" form="dlg-disable">');
    expect(dialog).toContain('name="confirm_slug"');
    expect(dialog).toContain('pattern="openai"');
    expect(dialog).toContain(`href="/admin/credential-access-rules/${acr('A')}"`);
    const detached =
      /<form method="post" action="[^"]+\/toggle" id="dlg-disable" hidden="">[\s\S]*?<\/form>/.exec(
        page,
      )?.[0] ?? '';
    expect(detached).toContain(`name="_csrf" value="${admin.csrfToken}"`);
    expect(detached).toContain('name="enabled" value="0"');
    // A disabled token has nothing to disable instead.
    await adminPost(app, admin, `/admin/credentials/${id}/toggle`, { enabled: '0' });
    const disabled = await (await adminGet(app, admin, `/admin/credentials/${id}`)).text();
    expect(disabled).not.toContain('id="dlg-disable"');
    expect(disabled).toContain('commandfor="dlg-delete"');
  });
});

describe('settings pages', () => {
  it('Allowed hosts re-opens its dialog after a refused save', async () => {
    const owner = await sessionFor('owner');
    const res = await adminPost(app, owner, '/admin/credentials/hosts', { mode: 'list' });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/<dialog class="dlg wide lform" id="dlg-hosts"[^>]* open="">/);
    expect(html).toMatch(/name="mode" value="list" checked=""/);
  });

  it('Rotate encryption lists the keys in a tray with their state as a word', async () => {
    const html = await (
      await adminGet(app, await sessionFor('viewer'), '/admin/credentials/keys')
    ).text();
    expect(html).toContain('<h1>Rotate encryption</h1>');
    expect(html).toMatch(/<section class="tray" id="keys" aria-labelledby="keys-h">/);
    expect(html).toContain('<span class="badge ok"><span aria-hidden="true">✓</span>Active</span>');
    expect(html).toContain('Every stored secret uses the active key.');
    expect(html).not.toContain('commandfor="dlg-rewrap"');
  });
});
