import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { setServiceCredential } from '../../src/admin/ops/services';
import { registerSettingsRoutes } from '../../src/admin/routes/settings';
import { loadKeyring } from '../../src/crypto/keyring';
import { getSettings, putSettingStatement, SETTING_DEFAULTS } from '../../src/db/settings';
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
const SECRET_ENV = {
  TOKENGATE_KEK: KEK,
  AUTH_GITHUB_CLIENT_ID: 'gh-client',
  AUTH_GITHUB_CLIENT_SECRET: 'gh-secret-value-do-not-show',
};

let app: AdminTestApp;

beforeEach(async () => {
  await resetControlPlane();
  await env.DB.prepare('DELETE FROM services').run();
  app = createAdminTestApp({ routes: registerSettingsRoutes, now: () => T0, env: SECRET_ENV });
});

async function sessionFor(role: Role): Promise<AdminSession> {
  return loginAs(app, await createUser({ email: `${role}@example.com`, role }, T0));
}

async function auditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT action FROM audit_log WHERE action <> 'user.login' ORDER BY rowid",
  ).all<{ action: string }>();
  return results.map((row) => row.action);
}

describe('GET /admin/settings', () => {
  it('renders read-only settings, key status and system status for a viewer', async () => {
    const res = await adminGet(app, await sessionFor('viewer'), '/admin/settings');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Only owners can change these settings.');
    expect(html).not.toContain('name="request_log_retention_days"');
    expect(html).not.toContain('action="/admin/export"');
    const keyring = await loadKeyring({ TOKENGATE_KEK: KEK });
    if (!keyring.ok) throw new Error(keyring.error);
    expect(html).toContain(keyring.keyring.kcv.k1);
    expect(html).toContain('GitHub');
  });

  it('never shows secret values from the environment', async () => {
    const html = await (await adminGet(app, await sessionFor('owner'), '/admin/settings')).text();
    expect(html).not.toContain(SECRET_ENV.AUTH_GITHUB_CLIENT_SECRET);
    expect(html).not.toContain(KEK);
    expect(html).not.toContain('gh-client');
  });

  it('shows owners the settings form with floors and the export form (POST + CSRF)', async () => {
    const session = await sessionFor('owner');
    const html = await (await adminGet(app, session, '/admin/settings')).text();
    expect(html).toContain('name="audit_log_retention_days"');
    expect(html).toContain('min="90"');
    expect(html).toContain('Soft upper limit on stored request records, checked every hour.');
    const exportForm = /<form method="post" action="\/admin\/export">(.*?)<\/form>/s.exec(html);
    expect(exportForm?.[1]).toContain(`name="_csrf" value="${session.csrfToken}"`);
    expect(html).not.toContain('href="/admin/export"');
  });

  it('explains a missing keyring', async () => {
    const noKey = createAdminTestApp({
      routes: registerSettingsRoutes,
      now: () => T0,
      env: { TOKENGATE_KEK: '', TOKENGATE_KEYRING: '' },
    });
    const session = await loginAs(
      noKey,
      await createUser({ email: 'o@example.com', role: 'owner' }),
    );
    const html = await (await adminGet(noKey, session, '/admin/settings')).text();
    expect(html).toContain('No encryption key is configured');
  });

  it('escapes stored text such as the last cron error', async () => {
    await env.DB.batch([
      putSettingStatement(env.DB, 'cron_last_error', '<script>alert(1)</script>', T0, null),
      putSettingStatement(env.DB, 'cron_last_error_at', T0, T0, null),
    ]);
    const html = await (await adminGet(app, await sessionFor('viewer'), '/admin/settings')).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('POST /admin/settings', () => {
  it('is forbidden for admins and viewers', async () => {
    for (const role of ['viewer', 'admin'] as const) {
      const res = await adminPost(app, await sessionFor(role), '/admin/settings', {
        request_log_retention_days: '30',
      });
      expect(res.status).toBe(403);
    }
    expect(await getSettings(env.DB)).toEqual(SETTING_DEFAULTS);
  });

  it('saves changes for an owner with an audit row', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/settings', {
      request_log_retention_days: '30',
      audit_log_retention_days: '365',
      rollup_retention_days: '400',
      allowed_sample_rate: '0.5',
      request_log_max_rows: '5000000',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/settings?notice=saved');
    expect(await getSettings(env.DB)).toMatchObject({
      request_log_retention_days: 30,
      allowed_sample_rate: 0.5,
    });
    expect(await auditActions()).toEqual(['settings.update']);
  });

  it('re-renders with the submitted values when a value is below its floor', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/settings', {
      audit_log_retention_days: '10',
      allowed_sample_rate: '',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Audit log retention (days) must be between 90 and 3650.');
    expect(html).toContain('Share of allowed requests to record must be a number.');
    expect(html).toContain('value="10"');
    expect(await auditActions()).toEqual([]);
  });
});

describe('POST /admin/settings/rewrap', () => {
  it('is forbidden for admins', async () => {
    const res = await adminPost(app, await sessionFor('admin'), '/admin/settings/rewrap');
    expect(res.status).toBe(403);
    expect(await auditActions()).toEqual([]);
  });

  it('reports when there is nothing to re-encrypt', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/settings/rewrap');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/settings?notice=rewrap_none');
    expect(await auditActions()).toEqual([]);
  });

  it('shows the keyring problem when the keyring is missing', async () => {
    const noKey = createAdminTestApp({
      routes: registerSettingsRoutes,
      now: () => T0,
      env: { TOKENGATE_KEK: '', TOKENGATE_KEYRING: '' },
    });
    const session = await loginAs(
      noKey,
      await createUser({ email: 'o@example.com', role: 'owner' }),
    );
    const res = await adminPost(noKey, session, '/admin/settings/rewrap');
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('No encryption key is configured.');
    expect(html).toContain('Nothing was re-encrypted.');
  });
});

describe('POST /admin/export', () => {
  it('downloads the export as an attachment and audits it', async () => {
    const res = await adminPost(app, await sessionFor('admin'), '/admin/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="tokengate-export-2026-10-13.json"',
    );
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.json<{ schema_version: number; users: Array<{ email: string }> }>();
    expect(body.schema_version).toBe(1);
    expect(body.users.map((user) => user.email)).toEqual(['admin@example.com']);
    expect(await auditActions()).toEqual(['config.export']);
  });

  it('is forbidden for viewers', async () => {
    const res = await adminPost(app, await sessionFor('viewer'), '/admin/export');
    expect(res.status).toBe(403);
    expect(await auditActions()).toEqual([]);
  });
});

describe('key rotation flow', () => {
  it('offers re-encryption when credentials use an older key, then re-encrypts them', async () => {
    await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    const rotated = createAdminTestApp({
      routes: registerSettingsRoutes,
      now: () => T0,
      env: { TOKENGATE_KEK: '', TOKENGATE_KEYRING: KEYRING_1_2 },
    });
    const session = await loginAs(
      rotated,
      await createUser({ email: 'o@example.com', role: 'owner' }),
    );
    const before = await (await adminGet(rotated, session, '/admin/settings')).text();
    expect(before).toContain('1 credential(s) are still encrypted with an older key');
    expect(before).toContain('action="/admin/settings/rewrap"');

    const res = await adminPost(rotated, session, '/admin/settings/rewrap');
    expect(res.headers.get('location')).toBe('/admin/settings?notice=rewrapped');
    const after = await (await adminGet(rotated, session, '/admin/settings')).text();
    expect(after).toContain('Every stored credential uses the active key.');
  });

  it('recovers from a replaced key: the button is offered for a changed check value alone', async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'keyring_kcv'").run();
    // "one" sealed under k1 = KEK_1; then TOKENGATE_KEK is replaced with KEK_2, still kid k1.
    const one = await seedService(opsDeps(), { slug: 'one', secret: 'secret-one-0123456789' });
    const keyB = opsDeps({ env: { TOKENGATE_KEK: KEK_2 } });
    await seedService(keyB, { slug: 'two', secret: 'secret-two-0123456789' });
    const replaced = createAdminTestApp({
      routes: registerSettingsRoutes,
      now: () => T0,
      env: { TOKENGATE_KEK: KEK_2 },
    });
    const session = await loginAs(
      replaced,
      await createUser({ email: 'o@example.com', role: 'owner' }),
    );
    const before = await (await adminGet(replaced, session, '/admin/settings')).text();
    expect(before).toContain(
      'Restore the original key, or set those credentials again and then re-encrypt credentials to accept the new key.',
    );
    expect(before).not.toContain('still encrypted with an older key');
    expect(before).not.toContain('Fix the problems listed above first');
    expect(before).toContain('action="/admin/settings/rewrap"');

    // "one" still needs the old key: nothing changes and it is named.
    const refused = await adminPost(replaced, session, '/admin/settings/rewrap');
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
    const res = await adminPost(replaced, session, '/admin/settings/rewrap');
    expect(res.headers.get('location')).toBe('/admin/settings?notice=key_confirmed');
    const after = await (
      await adminGet(replaced, session, '/admin/settings?notice=key_confirmed')
    ).text();
    expect(after).toContain('New key confirmed: every credential opens with it.');
    expect(after).not.toContain('its check value changed');
    expect(after).toContain('Every stored credential uses the active key.');
  });
});

describe('review: CSRF and method safety', () => {
  it('rejects a settings change without the CSRF token or from another site', async () => {
    const session = await sessionFor('owner');
    const noToken = await adminPost(
      app,
      session,
      '/admin/settings',
      { request_log_retention_days: '30' },
      { csrf: null },
    );
    expect(noToken.status).toBe(403);
    const crossSite = await adminPost(
      app,
      session,
      '/admin/settings/rewrap',
      {},
      { headers: { 'sec-fetch-site': 'cross-site' } },
    );
    expect(crossSite.status).toBe(403);
    expect(await getSettings(env.DB)).toEqual(SETTING_DEFAULTS);
    expect(await auditActions()).toEqual([]);
  });

  it('does not re-encrypt on GET', async () => {
    const res = await adminGet(app, await sessionFor('owner'), '/admin/settings/rewrap');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await auditActions()).toEqual([]);
  });

  it('ignores unknown and repeated fields instead of saving them', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/settings', {
      request_log_retention_days: ['30', '1'],
      bootstrap_completed_at: '1',
    });
    expect(res.headers.get('location')).toBe('/admin/settings?notice=unchanged');
    expect(await getSettings(env.DB)).toEqual(SETTING_DEFAULTS);
    expect(await auditActions()).toEqual([]);
  });

  it('rejects fractional day counts', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/settings', {
      request_log_retention_days: '1.5',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('must be a whole number');
  });
});

describe('review: keyring section', () => {
  it('does not offer re-encryption or blame the role when the keyring is missing', async () => {
    await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    const noKey = createAdminTestApp({
      routes: registerSettingsRoutes,
      now: () => T0,
      env: { TOKENGATE_KEK: '', TOKENGATE_KEYRING: '' },
    });
    const session = await loginAs(
      noKey,
      await createUser({ email: 'o@example.com', role: 'owner' }),
    );
    const html = await (await adminGet(noKey, session, '/admin/settings')).text();
    expect(html).toContain('No encryption key is configured');
    expect(html).not.toContain('still encrypted with an older key');
    expect(html).not.toContain('Only owners can re-encrypt');
    expect(html).not.toContain('action="/admin/settings/rewrap"');
  });

  it('hides the re-encrypt button from admins and explains why', async () => {
    await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    const rotated = createAdminTestApp({
      routes: registerSettingsRoutes,
      now: () => T0,
      env: { TOKENGATE_KEK: '', TOKENGATE_KEYRING: KEYRING_1_2 },
    });
    const session = await loginAs(
      rotated,
      await createUser({ email: 'a@example.com', role: 'admin' }),
    );
    const html = await (await adminGet(rotated, session, '/admin/settings')).text();
    expect(html).toContain('still encrypted with an older key');
    expect(html).not.toContain('action="/admin/settings/rewrap"');
    expect(html).toContain('Only owners can re-encrypt');
  });

  it('does not offer re-encryption while a key used by credentials is missing', async () => {
    // Sealed under k1 (TOKENGATE_KEK), then the keyring only has k2.
    await seedService(opsDeps(), { slug: 'gh', secret: 'ghp_0123456789abcdefghij' });
    const onlyK2 = JSON.stringify({
      active: 'k2',
      keys: { k2: toBase64(new Uint8Array(32).fill(2)) },
    });
    const missing = createAdminTestApp({
      routes: registerSettingsRoutes,
      now: () => T0,
      env: { TOKENGATE_KEK: '', TOKENGATE_KEYRING: onlyK2 },
    });
    const session = await loginAs(
      missing,
      await createUser({ email: 'o@example.com', role: 'owner' }),
    );
    const html = await (await adminGet(missing, session, '/admin/settings')).text();
    expect(html).toContain('is not in the keyring');
    expect(html).not.toContain('action="/admin/settings/rewrap"');
  });
});
