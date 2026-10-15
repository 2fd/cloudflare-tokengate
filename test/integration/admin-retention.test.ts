// Monitoring › Data retention (`/admin/retention`): retention periods, sampling and the row cap.
// Owners edit them (settings:write); everyone else sees the values.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerRetentionRoutes } from '../../src/admin/routes/retention';
import { getSettings, SETTING_DEFAULTS } from '../../src/db/settings';
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

const T0 = Date.UTC(2026, 9, 13, 12);
const KEK = toBase64(new Uint8Array(32).fill(7));

let app: AdminTestApp;

beforeEach(async () => {
  await resetControlPlane();
  app = createAdminTestApp({
    routes: registerRetentionRoutes,
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

describe('GET /admin/retention', () => {
  it('renders read-only settings for a viewer', async () => {
    const res = await adminGet(app, await sessionFor('viewer'), '/admin/retention');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Data retention · tokengate</title>');
    expect(html).toContain('Only owners can change these settings.');
    expect(html).not.toContain('name="request_log_retention_days"');
  });

  it('never shows secret values from the environment', async () => {
    const html = await (await adminGet(app, await sessionFor('owner'), '/admin/retention')).text();
    expect(html).not.toContain(KEK);
  });

  it('shows owners the settings form with floors', async () => {
    const html = await (await adminGet(app, await sessionFor('owner'), '/admin/retention')).text();
    expect(html).toContain('action="/admin/retention"');
    expect(html).toContain('name="audit_log_retention_days"');
    expect(html).toContain('min="90"');
    expect(html).toContain('Soft upper limit on stored request records, checked every hour.');
  });
});

describe('POST /admin/retention', () => {
  it('is forbidden for admins and viewers', async () => {
    for (const role of ['viewer', 'admin'] as const) {
      const res = await adminPost(app, await sessionFor(role), '/admin/retention', {
        request_log_retention_days: '30',
      });
      expect(res.status).toBe(403);
    }
    expect(await getSettings(env.DB)).toEqual(SETTING_DEFAULTS);
  });

  it('saves changes for an owner with an audit row', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/retention', {
      request_log_retention_days: '30',
      audit_log_retention_days: '365',
      rollup_retention_days: '400',
      allowed_sample_rate: '0.5',
      request_log_max_rows: '5000000',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/retention?notice=saved');
    expect(await getSettings(env.DB)).toMatchObject({
      request_log_retention_days: 30,
      allowed_sample_rate: 0.5,
    });
    expect(await auditActions()).toEqual(['settings.update']);
  });

  it('re-renders with the submitted values when a value is below its floor', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/retention', {
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

  it('rejects a change without the CSRF token', async () => {
    const res = await adminPost(
      app,
      await sessionFor('owner'),
      '/admin/retention',
      { request_log_retention_days: '30' },
      { csrf: null },
    );
    expect(res.status).toBe(403);
    expect(await getSettings(env.DB)).toEqual(SETTING_DEFAULTS);
    expect(await auditActions()).toEqual([]);
  });

  it('ignores unknown and repeated fields instead of saving them', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/retention', {
      request_log_retention_days: ['30', '1'],
      bootstrap_completed_at: '1',
    });
    expect(res.headers.get('location')).toBe('/admin/retention?notice=unchanged');
    expect(await getSettings(env.DB)).toEqual(SETTING_DEFAULTS);
    expect(await auditActions()).toEqual([]);
  });

  it('rejects fractional day counts', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/retention', {
      request_log_retention_days: '1.5',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('must be a whole number');
  });
});
