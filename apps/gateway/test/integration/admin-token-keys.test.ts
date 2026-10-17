// Credentials › Encryption keys (`/admin/credentials/keys`): key ids and check values, credentials
// per key, and re-encryption with the active key (owners only, keyring:rewrap).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { setServiceCredential } from '../../src/admin/ops/credentials';
import { registerTokenKeysRoutes } from '../../src/admin/routes/token-keys';
import { loadKeyring } from '../../src/crypto/keyring';
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
  KEK_2,
  KEYRING_1_2,
  opsDeps,
  seedService,
} from '../unit/admin/ops/helpers';

const T0 = Date.UTC(2026, 9, 13, 12);
const KEK = toBase64(new Uint8Array(32).fill(7));

let app: AdminTestApp;

beforeEach(async () => {
  await resetControlPlane();
  await env.DB.prepare('DELETE FROM credentials').run();
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

describe('GET /admin/credentials/keys', () => {
  it('shows the key check values to a viewer, never the key', async () => {
    const res = await adminGet(app, await sessionFor('viewer'), '/admin/credentials/keys');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Encryption keys – Credentials – tokengate</title>');
    const keyring = await loadKeyring({ ...TEST_ACCESS_ENV, TOKENGATE_KEK: KEK });
    if (!keyring.ok) throw new Error(keyring.error);
    expect(html).toContain(keyring.keyring.kcv.k1);
    expect(html).not.toContain(KEK);
  });

  it('explains a missing keyring', async () => {
    const noKey = appWith({ TOKENGATE_KEK: '', TOKENGATE_KEYRING: '' });
    const html = await (
      await adminGet(noKey, await ownerOf(noKey), '/admin/credentials/keys')
    ).text();
    expect(html).toContain('No encryption key is configured');
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
});

describe('key rotation flow', () => {
  it('offers re-encryption when credentials use an older key, then re-encrypts them', async () => {
    await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    const rotated = appWith({ TOKENGATE_KEK: '', TOKENGATE_KEYRING: KEYRING_1_2 });
    const session = await ownerOf(rotated);
    const before = await (await adminGet(rotated, session, '/admin/credentials/keys')).text();
    expect(before).toContain('1 secret is still encrypted with an older key');
    expect(before).toContain('Re-encrypt 1 secret…');
    expect(before).toContain('name="_return" value="detail"');
    expect(before).toContain('action="/admin/credentials/keys/rewrap"');

    const res = await adminPost(rotated, session, '/admin/credentials/keys/rewrap');
    expect(res.headers.get('location')).toBe('/admin/credentials/keys?notice=rewrapped');
    const after = await (await adminGet(rotated, session, '/admin/credentials/keys')).text();
    expect(after).toContain('Every stored secret uses the active key.');
  });

  it('recovers from a replaced key: the button is offered for a changed check value alone', async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'keyring_kcv'").run();
    // "one" sealed under k1 = KEK_1; then TOKENGATE_KEK is replaced with KEK_2, still kid k1.
    const one = await seedService(opsDeps(), { slug: 'one', secret: 'secret-one-0123456789' });
    const keyB = opsDeps({ env: { TOKENGATE_KEK: KEK_2 } });
    await seedService(keyB, { slug: 'two', secret: 'secret-two-0123456789' });
    const replaced = appWith({ TOKENGATE_KEK: KEK_2 });
    const session = await ownerOf(replaced);
    const before = await (await adminGet(replaced, session, '/admin/credentials/keys')).text();
    expect(before).toContain('Key k1 is not the key that encrypted its secrets');
    expect(before).toContain('Changed</span>');
    expect(before).toContain('Confirming also accepts the new check value');
    expect(before).not.toContain('still encrypted with an older key');
    expect(before).not.toContain('Fix the problems above first');
    expect(before).toContain('action="/admin/credentials/keys/rewrap"');

    // "one" still needs the old key: nothing changes and it is named.
    const refused = await adminPost(replaced, session, '/admin/credentials/keys/rewrap');
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('service one was encrypted with an earlier key');

    const reset = await setServiceCredential(
      keyB,
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
    const res = await adminPost(replaced, session, '/admin/credentials/keys/rewrap');
    expect(res.headers.get('location')).toBe('/admin/credentials/keys?notice=key_confirmed');
    const after = await (
      await adminGet(replaced, session, '/admin/credentials/keys?notice=key_confirmed')
    ).text();
    expect(after).toContain('New key confirmed: every secret opens with it.');
    expect(after).not.toContain('its check value changed');
    expect(after).toContain('Every stored secret uses the active key.');
  });
});

describe('the key check command', () => {
  it('names pnpm keyring check and the login variables it needs (I-CRED-3)', async () => {
    const html = await (
      await adminGet(app, await sessionFor('viewer'), '/admin/credentials/keys')
    ).text();
    expect(html).toContain('<code>pnpm keyring check</code>');
    expect(html).toContain('<code>AUTH_ACCESS_DEVELOPMENT</code>');
    expect(html).toContain('Active key k1. 1 key loaded. Every stored secret opens.');
    expect(html).toContain('<caption class="vh">Keys in the keyring</caption>');
  });
});

describe('re-encrypt control', () => {
  it('does not offer re-encryption or blame the role when the keyring is missing', async () => {
    await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    const noKey = appWith({ TOKENGATE_KEK: '', TOKENGATE_KEYRING: '' });
    const html = await (
      await adminGet(noKey, await ownerOf(noKey), '/admin/credentials/keys')
    ).text();
    expect(html).toContain('No encryption key is configured');
    expect(html).not.toContain('still encrypted with an older key');
    expect(html).not.toContain('can re-encrypt the secrets');
    expect(html).not.toContain('action="/admin/credentials/keys/rewrap"');
  });

  it('hides the re-encrypt button from admins and explains why', async () => {
    await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    const rotated = appWith({ TOKENGATE_KEK: '', TOKENGATE_KEYRING: KEYRING_1_2 });
    const session = await loginAs(
      rotated,
      await createUser({ email: 'a@example.com', role: 'admin' }),
    );
    const html = await (await adminGet(rotated, session, '/admin/credentials/keys')).text();
    expect(html).toContain('still encrypted with an older key');
    expect(html).not.toContain('action="/admin/credentials/keys/rewrap"');
    expect(html).toContain('Only owners can re-encrypt the secrets.');
  });

  it('does not offer re-encryption while a key used by credentials is missing', async () => {
    // Sealed under k1 (TOKENGATE_KEK), then the keyring only has k2.
    await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    const onlyK2 = JSON.stringify({
      active: 'k2',
      keys: { k2: toBase64(new Uint8Array(32).fill(2)) },
    });
    const missing = appWith({ TOKENGATE_KEK: '', TOKENGATE_KEYRING: onlyK2 });
    const html = await (
      await adminGet(missing, await ownerOf(missing), '/admin/credentials/keys')
    ).text();
    expect(html).toContain('is not in the keyring');
    expect(html).not.toContain('action="/admin/credentials/keys/rewrap"');
  });
});
