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
    expect(html).toContain('<title>Data retention – Monitoring – tokengate</title>');
    expect(html).toContain('Only owners can change these settings');
    expect(html).toContain('<dt>Request log retention (days)</dt><dd>14</dd>');
    expect(html).toContain('<dt>Share of allowed requests to record</dt><dd>100 % (all)</dd>');
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
    expect(html).toContain('Upper limit on stored request records, checked every hour.');
    for (const legend of ['Request records', 'Hourly summaries', 'Audit log']) {
      expect(html).toContain(`<legend>${legend}</legend>`);
    }
    // Numbers are prefilled, bounded and have a suggestion list.
    const input = /<input [^>]*id="f-request_log_retention_days"[^>]*>/.exec(html)?.[0] ?? '';
    for (const attribute of [
      'name="request_log_retention_days"',
      'type="number"',
      'value="14"',
      'placeholder="14"',
      'required=""',
      'min="1"',
      'max="3650"',
      'step="1"',
      'inputmode="numeric"',
      'autocomplete="off"',
      'list="f-request_log_retention_days-list"',
    ]) {
      expect(input).toContain(attribute);
    }
    expect(html).toContain('<option value="30">');
    // The sample rate is a pick, the current value marked.
    expect(html).toMatch(
      /type="radio" id="f-allowed_sample_rate-\d" name="allowed_sample_rate" value="1" checked=""/,
    );
    expect(html).toContain('100 % (all) (current)');
    expect(html).toContain('Stored now: up to about 0 records (upper estimate).');
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

describe('Data retention settings cards', () => {
  it('shows owners an Edit… on each card that opens one closed dialog with the form', async () => {
    const html = await (await adminGet(app, await sessionFor('owner'), '/admin/retention')).text();
    for (const id of ['records', 'summaries', 'audit']) {
      expect(html).toContain(`<section class="tray" id="${id}" aria-labelledby="${id}-h">`);
    }
    expect(html.match(/commandfor="retention-edit" popovertarget="retention-edit"/g)).toHaveLength(
      3,
    );
    expect(html).toContain(
      '<dialog class="dlg wide" id="retention-edit" aria-labelledby="retention-edit-h" aria-describedby="retention-edit-d" popover="auto">',
    );
    expect(html).toMatch(
      /<form method="post" action="\/admin\/retention"><input type="hidden" name="_csrf"/,
    );
    // The values are read-only on the cards for everyone.
    expect(html).toContain('<dt>Request log retention (days)</dt><dd>14</dd>');
    expect(html).not.toContain('Only owners can change these settings');
  });

  it('re-renders the dialog open in the page flow after a failed save', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/retention', {
      audit_log_retention_days: '10',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/<dialog class="dlg wide" id="retention-edit"[^>]* open="">/);
  });

  it('marks a sampled share of allowed requests on its card', async () => {
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('allowed_sample_rate', '0.1', 0)",
    ).run();
    const html = await (await adminGet(app, await sessionFor('viewer'), '/admin/retention')).text();
    expect(html).toContain(
      '<dt>Share of allowed requests to record</dt><dd>10 % <span class="badge warn"><span aria-hidden="true">⚠</span>Sampled</span></dd>',
    );
    expect(html).not.toContain('id="retention-edit"');
  });
});

describe('Data retention form details', () => {
  it('offers a stored non-preset sample rate as its own "(current)" choice', async () => {
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('allowed_sample_rate', '0.25', 0)",
    ).run();
    const html = await (await adminGet(app, await sessionFor('owner'), '/admin/retention')).text();
    expect(html).toContain('value="0.25" checked=""');
    expect(html).toContain('25.0% (current)');
  });

  it('refuses summaries kept for less time than request records, at the field', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/retention', {
      request_log_retention_days: '60',
      rollup_retention_days: '30',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('<title>Error: Data retention – Monitoring – tokengate</title>');
    expect(html).toContain(
      '<a href="#f-rollup_retention_days">Traffic summary retention (days) must be at least the request record retention (60 days). Enter 60 or more.</a>',
    );
    expect(html).toMatch(/id="f-rollup_retention_days"[^>]*aria-invalid="true"/);
    expect(await auditActions()).toEqual([]);
  });

  it('shows the per-field bound errors next to their field', async () => {
    const res = await adminPost(app, await sessionFor('owner'), '/admin/retention', {
      audit_log_retention_days: '10',
    });
    const html = await res.text();
    expect(html).toContain('id="f-audit_log_retention_days-error"');
  });

  it("suggests a row cap from last week's traffic", async () => {
    const hour = T0 - 2 * 3_600_000;
    await env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly').run();
    await env.TELEMETRY_DB.prepare(
      `INSERT INTO request_rollup_hourly (hour, service_id, credential_access_rule_id, outcome, status_class, requests, upstream_auth_fail, duration_sum_ms)
       VALUES (?, 'svc_A', 'acr_A', 'allowed', 2, 70000, 0, 0), (?, 'svc_A', '', 'denied', 4, 700, 0, 0)`,
    )
      .bind(hour, hour)
      .run();
    const html = await (await adminGet(app, await sessionFor('owner'), '/admin/retention')).text();
    expect(html).toContain('Last 7 days: about 10 k records a day kept after sampling.');
    expect(html).toContain('rate (about 10,100 a day), 14 days needs about 141,400 rows.');
    await env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly').run();
  });
});
