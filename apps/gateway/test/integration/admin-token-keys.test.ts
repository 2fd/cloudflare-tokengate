// Settings › Rotate encryption (`/admin/credentials/keys`, ADR 0027): the two key secrets with their
// key ids and credentials, the five rotation steps, and the background re-encryption with the
// active key (owners only, keyring:rewrap).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { setServiceCredential } from '../../src/admin/ops/credentials';
import type { RewrapJob } from '../../src/admin/ops/keyring';
import { registerTokenKeysRoutes } from '../../src/admin/routes/token-keys';
import { loadKeyring } from '../../src/crypto/keyring';
import { putSettingStatement } from '../../src/db/settings';
import type { Role } from '../../src/db/types';
import { toBase64 } from '../../src/lib/encoding';
import {
  type AdminSession,
  type AdminTestApp,
  adminGet,
  adminPost,
  createAdminTestApp,
  createUser,
  loginAs,
  resetControlPlane,
} from '../helpers/admin-auth';
import { TEST_ACCESS_ENV } from '../helpers/app';
import {
  ACTOR,
  CONTEXT,
  KEK_1,
  KEK_2,
  opsDeps,
  ROTATION_ENV,
  seedService,
} from '../unit/admin/ops/helpers';

const T0 = Date.UTC(2026, 9, 13, 12);
const KEK = toBase64(new Uint8Array(32).fill(7));
/** 32 printable ASCII bytes: a passphrase, not a random key. */
const TEXT_KEY = btoa('correct-horse-battery-staple-123');
const PATH = '/admin/credentials/keys';

let app: AdminTestApp;

beforeEach(async () => {
  await resetControlPlane();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM credentials'),
    env.DB.prepare("DELETE FROM settings WHERE key IN ('keyring_rewrap', 'keyring_kcv')"),
  ]);
  app = createAdminTestApp({
    routes: registerTokenKeysRoutes,
    now: () => T0,
    env: { TOKENGATE_KEK: KEK },
  });
});

async function sessionFor(role: Role): Promise<AdminSession> {
  return loginAs(app, await createUser({ email: `${role}@example.com`, role }, T0));
}

async function auditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT action FROM audit_log ORDER BY rowid').all<{
    action: string;
  }>();
  return results.map((row) => row.action);
}

function appWith(keys: Record<string, string>): AdminTestApp {
  return createAdminTestApp({ routes: registerTokenKeysRoutes, now: () => T0, env: keys });
}

async function ownerOf(target: AdminTestApp): Promise<AdminSession> {
  return loginAs(target, await createUser({ email: 'o@example.com', role: 'owner' }));
}

async function page(target: AdminTestApp, session: AdminSession, path = PATH): Promise<string> {
  const res = await adminGet(target, session, path);
  expect(res.status).toBe(200);
  return res.text();
}

async function kidOf(keyEnv: Record<string, string>): Promise<string> {
  const loaded = await loadKeyring({ ...TEST_ACCESS_ENV, ...keyEnv });
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.keyring.activeKid;
}

/** The state of each rotation step, in order: current, failed, done, todo. */
function steps(html: string): string[] {
  return [...html.matchAll(/<li class="fstep(?: is-([a-z]+))?"/g)].map((m) => m[1] ?? '');
}

/** The table row of one secret (or of `Unknown`), from its row header to the end of the row. */
function row(html: string, secret: string): string {
  const start = html.indexOf(
    secret === 'Unknown'
      ? '<span class="muted">Unknown</span>'
      : `<span class="mono">${secret}</span>`,
  );
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</tr>', start));
}

describe('GET /admin/credentials/keys', () => {
  it('shows the key ids to a viewer, never the key', async () => {
    const html = await page(app, await sessionFor('viewer'));
    expect(html).toContain('<title>Rotate encryption – Settings – tokengate</title>');
    expect(html).toContain('<caption class="vh">Keys in the keyring</caption>');
    expect(row(html, 'TOKENGATE_KEK')).toContain(
      `<code>${await kidOf({ TOKENGATE_KEK: KEK })}</code>`,
    );
    expect(row(html, 'TOKENGATE_KEK')).toContain('Active');
    expect(row(html, 'TOKENGATE_KEYRING')).toContain('Not set');
    expect(html).not.toContain(KEK);
    // The key check section is gone.
    expect(html).not.toContain('pnpm keyring check');
  });

  it('explains a missing keyring and shows no steps', async () => {
    const noKey = appWith({ TOKENGATE_KEK: '', TOKENGATE_KEYRING: '' });
    const html = await page(noKey, await ownerOf(noKey));
    expect(html).toContain('No encryption key is configured');
    expect(steps(html)).toEqual([]);
    expect(html).not.toContain('action="/admin/credentials/keys/rewrap"');
  });
});

describe('the rotation steps', () => {
  it('1: asks for TOKENGATE_KEYRING while only TOKENGATE_KEK is set', async () => {
    const html = await page(app, await sessionFor('viewer'));
    expect(html).toContain('To rotate the encryption, follow these steps');
    expect(steps(html)).toEqual(['current', 'todo', 'todo', 'todo', 'todo']);
    expect(html).toContain('<li class="fstep is-current" aria-current="step">');
    expect(html).toContain('openssl rand -base64 32');
    expect(html).toContain('pnpm wrangler secret put TOKENGATE_KEYRING');
    expect(html).toContain('Every stored secret uses the active key.');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it('2: fails the check of a TOKENGATE_KEYRING that is not random; TOKENGATE_KEK stays active', async () => {
    const weak = appWith({ TOKENGATE_KEK: KEK, TOKENGATE_KEYRING: TEXT_KEY });
    const html = await page(weak, await ownerOf(weak));
    expect(steps(html)).toEqual(['done', 'failed', 'todo', 'todo', 'todo']);
    expect(html).toContain('<li class="fstep is-failed" aria-current="step">');
    expect(html).toContain('<span class="vh">Step 2, failed: </span>');
    expect(html).toContain('is not random');
    expect(row(html, 'TOKENGATE_KEYRING')).toContain('Not used');
    expect(row(html, 'TOKENGATE_KEK')).toContain('Active');
  });

  it('3 to 5: re-encrypts in the background, then asks to move the key to TOKENGATE_KEK', async () => {
    await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    const rotated = appWith(ROTATION_ENV);
    const session = await ownerOf(rotated);
    const before = await page(rotated, session);
    expect(steps(before)).toEqual(['done', 'done', 'current', 'todo', 'todo']);
    expect(before).toContain('1 secret is still encrypted with the previous key.');
    expect(before).toContain('Re-encrypt 1 secret…');
    expect(before).toContain('1 secret is still encrypted with a key other than the active one.');
    expect(before).toContain('name="_return" value="detail"');
    expect(before).toContain('action="/admin/credentials/keys/rewrap"');
    expect(row(before, 'TOKENGATE_KEK')).toContain('Previous');
    expect(row(before, 'TOKENGATE_KEYRING')).toContain('Active');
    expect(row(before, 'TOKENGATE_KEYRING')).toContain(`<code>${await kidOf(ROTATION_ENV)}</code>`);

    const res = await adminPost(rotated, session, '/admin/credentials/keys/rewrap');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/credentials/keys?notice=rewrap_started');
    await rotated.settle();
    expect((await auditActions()).at(-1)).toBe('keyring.rewrap');

    const after = await page(rotated, session, `${PATH}?notice=rewrap_started`);
    expect(after).toContain('Re-encryption started.');
    expect(steps(after)).toEqual(['done', 'done', 'done', 'done', 'current']);
    expect(after).toContain('1 secret re-encrypted.');
    expect(after).toContain('Started by o@example.com');
    expect(after).toContain('Every stored secret uses the active key.');
    expect(after).toContain(
      'Edit <code>TOKENGATE_KEK</code>, paste the value of <code>TOKENGATE_KEYRING</code>',
    );
    expect(after).toContain('The old key is no longer needed');
    expect(after).not.toContain('http-equiv="refresh"');
  });

  it('4: shows the progress of a running re-encryption and reloads itself', async () => {
    await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    const job: RewrapJob = {
      state: 'running',
      active_kid: await kidOf(ROTATION_ENV),
      started_at: T0 - 3000,
      started_by: 'o@example.com',
      heartbeat_at: T0 - 1000,
      total: 5,
      written: 2,
      skipped: 0,
    };
    await putSettingStatement(env.DB, 'keyring_rewrap', job, T0, null).run();
    const rotated = appWith(ROTATION_ENV);
    const html = await page(rotated, await ownerOf(rotated));
    expect(steps(html)).toEqual(['done', 'done', 'done', 'current', 'todo']);
    expect(html).toContain('<meta http-equiv="refresh" content="2"/>');
    expect(html).toContain('<progress class="rotate-progress" value="2" max="5"');
    expect(html).toContain('2 of 5 secrets re-encrypted.');
    expect(html).toContain('Re-encrypting: 2 of 5 secrets done.');
    expect(html).not.toContain('action="/admin/credentials/keys/rewrap"');
  });

  it('3: reports a re-encryption that stopped and offers to start again', async () => {
    await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    const stale: RewrapJob = {
      state: 'running',
      active_kid: await kidOf(ROTATION_ENV),
      started_at: T0 - 600_000,
      started_by: 'o@example.com',
      heartbeat_at: T0 - 120_000,
      total: 5,
      written: 2,
      skipped: 0,
    };
    await putSettingStatement(env.DB, 'keyring_rewrap', stale, T0, null).run();
    const rotated = appWith(ROTATION_ENV);
    const html = await page(rotated, await ownerOf(rotated));
    expect(steps(html)).toEqual(['done', 'done', 'current', 'todo', 'todo']);
    expect(html).toContain('The last re-encryption stopped after 2 of 5 secrets.');
    expect(html).toContain('action="/admin/credentials/keys/rewrap"');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it('5: asks to delete TOKENGATE_KEYRING once TOKENGATE_KEK holds the same key', async () => {
    await seedService(opsDeps({ env: { TOKENGATE_KEK: KEK_2 } }), {
      slug: 'gh',
      secret: 'ghp_0123456789abcdefghij',
    });
    const same = appWith({ TOKENGATE_KEK: KEK_2, TOKENGATE_KEYRING: KEK_2 });
    const html = await page(same, await ownerOf(same));
    expect(steps(html)).toEqual(['done', 'done', 'done', 'done', 'current']);
    expect(html).toContain('holds the same key as <code>TOKENGATE_KEK</code>');
    expect(html).toContain('Delete <code>TOKENGATE_KEYRING</code> in Cloudflare to finish.');
    expect(row(html, 'TOKENGATE_KEYRING')).toContain('Same as TOKENGATE_KEK');
  });

  it('5: asks to add TOKENGATE_KEK when only TOKENGATE_KEYRING is set', async () => {
    const only = appWith({ TOKENGATE_KEK: '', TOKENGATE_KEYRING: KEK_2 });
    const html = await page(only, await ownerOf(only));
    expect(steps(html)).toEqual(['done', 'done', 'done', 'done', 'current']);
    expect(html).toContain('Only <code>TOKENGATE_KEYRING</code> is set.');
    expect(row(html, 'TOKENGATE_KEK')).toContain('Not set');
  });
});

describe('POST /admin/credentials/keys/rewrap', () => {
  it('is forbidden for admins', async () => {
    const res = await adminPost(app, await sessionFor('admin'), '/admin/credentials/keys/rewrap');
    expect(res.status).toBe(403);
    expect(await auditActions()).toEqual([]);
  });

  it('reports when there is nothing to re-encrypt', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/credentials/keys/rewrap');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/credentials/keys?notice=rewrap_none');
    expect(await auditActions()).toEqual([]);
  });

  it.each([
    ['overview', '/admin?notice=rewrap_none'],
    ['detail', '/admin/credentials/keys?notice=rewrap_none'],
    ['matrix', '/admin/credentials/keys?notice=rewrap_none'],
    ['https://evil.example/', '/admin/credentials/keys?notice=rewrap_none'],
    ['//evil.example', '/admin/credentials/keys?notice=rewrap_none'],
  ])('returns to a fixed path for _return=%s', async (value, location) => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/credentials/keys/rewrap', {
      _return: value,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(location);
  });

  it('shows the keyring problem when the keyring is missing', async () => {
    const noKey = appWith({ TOKENGATE_KEK: '', TOKENGATE_KEYRING: '' });
    const res = await adminPost(noKey, await ownerOf(noKey), '/admin/credentials/keys/rewrap');
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('No encryption key is configured.');
    expect(html).toContain('Nothing was re-encrypted.');
  });

  it('is refused from another site and does not run on GET', async () => {
    const owner = await sessionFor('owner');
    const crossSite = await adminPost(
      app,
      owner,
      '/admin/credentials/keys/rewrap',
      {},
      { headers: { 'sec-fetch-site': 'cross-site' } },
    );
    expect(crossSite.status).toBe(403);
    const get = await adminGet(app, owner, '/admin/credentials/keys/rewrap');
    expect(get.status).toBeGreaterThanOrEqual(400);
    expect(await auditActions()).toEqual([]);
  });

  it('accepts a changed check value of the legacy kid k1 once every secret under it opens', async () => {
    // "one" was sealed before ADR 0027 under k1 = KEK_1; then TOKENGATE_KEK became KEK_2.
    const one = await seedService(opsDeps(), { slug: 'one', secret: 'secret-one-0123456789' });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE credentials SET credential_sealed = json_set(credential_sealed, '$.kid', 'k1') WHERE id = ?",
      ).bind(one),
      env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('keyring_kcv', json_object('k1', ?), 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).bind(await kidOf({ TOKENGATE_KEK: KEK_1 })),
    ]);
    const replaced = appWith({ TOKENGATE_KEK: KEK_2 });
    const session = await ownerOf(replaced);
    const before = await page(replaced, session);
    expect(before).toContain('Key k1 is not the key that encrypted its secrets');
    expect(row(before, 'TOKENGATE_KEK')).toContain('Changed');
    // No step offers the rewrap (TOKENGATE_KEYRING is not set): the callout does.
    expect(before).toContain('Accept the new key…');
    expect(before).toContain('id="dlg-rewrap"');

    // "one" still needs the old key: nothing changes and it is named.
    const refused = await adminPost(replaced, session, '/admin/credentials/keys/rewrap');
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('credential one was encrypted with an earlier key');

    const reset = await setServiceCredential(
      opsDeps({ env: { TOKENGATE_KEK: KEK_2 } }),
      ACTOR,
      one,
      {
        base_url: 'https://api.github.com',
        injection: { kind: 'bearer' },
        secret: 'secret-one-new-0123456789',
        // The old key is gone, so the stored destination is unattested (I-CRED-2).
        confirm_destination: 'api.github.com',
      },
      CONTEXT,
    );
    expect(reset.ok).toBe(true);
    const after = await page(replaced, session);
    expect(after).not.toContain('its check value changed');
    expect(after).toContain('Every stored secret uses the active key.');
  });
});

describe('re-encrypt control', () => {
  it('hides the re-encrypt button from admins and explains why', async () => {
    await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    const rotated = appWith(ROTATION_ENV);
    const session = await loginAs(
      rotated,
      await createUser({ email: 'a@example.com', role: 'admin' }),
    );
    const html = await page(rotated, session);
    expect(html).toContain('still encrypted with the previous key');
    expect(html).not.toContain('action="/admin/credentials/keys/rewrap"');
    expect(html).toContain('Only owners can re-encrypt the secrets.');
  });

  it('does not offer re-encryption while a key used by credentials is missing', async () => {
    // Sealed under KEK_1; then TOKENGATE_KEK holds another key and KEK_1 is in neither secret.
    await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    const missing = appWith({ TOKENGATE_KEK: KEK, TOKENGATE_KEYRING: KEK_2 });
    const html = await page(missing, await ownerOf(missing));
    expect(html).toContain('but neither TOKENGATE_KEK nor TOKENGATE_KEYRING holds it');
    expect(html).toContain('Fix the problems above first');
    expect(row(html, 'Unknown')).toContain('Missing');
    expect(html).not.toContain('action="/admin/credentials/keys/rewrap"');
  });
});
