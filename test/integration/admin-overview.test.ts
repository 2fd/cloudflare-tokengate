// Dashboard end to end: onboarding checklist, traffic tiles and tables from real proxy records,
// banners from loadDashboard, role-dependent links and escaping.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROUTE_PERMISSIONS } from '../../src/admin/auth/rbac';
import { percentileText, VERIFIED_CALL_SQL } from '../../src/admin/routes/overview';
import { putSettingStatement } from '../../src/db/settings';
import type { User } from '../../src/db/types';
import { adminGet, adminPost, createUser, loginAs, resetControlPlane } from '../helpers/admin-auth';
import { createTestApp } from '../helpers/app';
import { TEST_EPOCH_MS } from '../helpers/jwt';
import { resetProxyState, setupProxy } from '../helpers/proxy-fixtures';

let owner: User;
let viewer: User;

beforeEach(async () => {
  await resetControlPlane();
  await resetProxyState();
  await env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly').run();
  owner = await createUser({ email: 'owner@example.com', role: 'owner' });
  viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
});

describe('GET /admin on a fresh deployment', () => {
  const app = () => createTestApp({ now: () => TEST_EPOCH_MS });

  it('shows the getting-started checklist with links for admins', async () => {
    const a = app();
    const res = await adminGet(a, await loginAs(a, owner), '/admin');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Get started');
    expect(html).toContain('href="/admin/consumers/new"');
    expect(html).toContain('href="/admin/tokens/new"');
    expect(html).toContain('href="/admin/access/new"');
    expect(html).toContain('docs/callers/github-actions.md');
    expect(html).toContain('No requests in the last 24 hours');
    expect(html).toContain('No denied requests in the last 24 hours');
  });

  it('tells viewers to ask an admin instead of linking to forms they cannot use', async () => {
    const a = app();
    const html = await (await adminGet(a, await loginAs(a, viewer), '/admin')).text();
    expect(html).toContain('Ask a token manager, admin or owner to do this step.');
    expect(html).toContain('Ask an access manager, admin or owner to do this step.');
    expect(html).not.toContain('href="/admin/tokens/new"');
  });

  it('renders operational banners from loadDashboard', async () => {
    const a = app();
    const html = await (await adminGet(a, await loginAs(a, viewer), '/admin')).text();
    // No TOKENGATE_KEK in the test env; cron never ran; one active owner.
    expect(html).toContain('Keyring unavailable');
    expect(html).toContain('The hourly maintenance job has not run yet.');
    expect(html).toContain('There is only one active owner.');
  });

  it('rejects a POST to the read-only dashboard', async () => {
    const a = app();
    const res = await adminPost(a, await loginAs(a, viewer), '/admin', {});
    expect(res.status).toBe(403);
  });
});

describe('GET /admin with traffic', () => {
  it('shows totals, the per-service table and recent denials, and hides the checklist', async () => {
    const fixture = await setupProxy({
      grant: { rules: [{ methods: ['GET'], path: '/ok/**' }] },
    });
    for (const path of ['/ok/1', '/ok/2', '/ok/3']) {
      expect((await fixture.call(path)).status).toBe(200);
    }
    expect((await fixture.call('/nope', { method: 'DELETE' })).status).toBe(403);
    await fixture.app.settle();

    const html = await (
      await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')
    ).text();
    expect(html).not.toContain('Get started');
    expect(html).toMatch(/<span>Requests<\/span><b>4<\/b>/);
    expect(html).toMatch(/<span>Allowed<\/span><b>3<\/b>/);
    expect(html).toMatch(/<span>Denied<\/span><b>1<\/b>/);
    expect(html).toContain(`href="/admin/tokens/${fixture.serviceId}"`);
    expect(html).toContain(`href="/admin/requests?token=${fixture.serviceId}"`);
    const denial = (await fixture.records()).find((r) => r.reason === 'no_matching_grant');
    expect(denial).toBeDefined();
    expect(html).toContain(`href="/admin/requests/${denial?.id}"`);
    expect(html).toContain('DELETE /nope');
  });

  it('does not mark "Make the first call" done for pre-trust rejections only', async () => {
    const fixture = await setupProxy();
    // No caller token: rejected before any claim is verified (claims_verified = 0).
    expect((await fixture.call('/x', { token: null })).status).toBe(401);
    await fixture.app.settle();
    expect((await fixture.records()).map((r) => r.claims_verified)).toEqual([0]);

    const a = fixture.app;
    const before = await (await adminGet(a, await loginAs(a, viewer), '/admin')).text();
    expect(before).toContain('Get started');
    expect(before).toMatch(/<b>Make the first call<\/b> <br/);

    expect((await fixture.call('/x')).status).toBe(200);
    await fixture.app.settle();
    const after = await (await adminGet(a, await loginAs(a, viewer), '/admin')).text();
    expect(after).not.toContain('Get started');
  });

  it('finds the first verified call through the partial index, not a table scan', async () => {
    const { results } = await env.TELEMETRY_DB.prepare(
      `EXPLAIN QUERY PLAN ${VERIFIED_CALL_SQL}`,
    ).all<{
      detail: string;
    }>();
    expect(results.map((row) => row.detail).join('\n')).toContain(
      'USING COVERING INDEX request_log_verified',
    );
  });

  it('escapes service names (XSS)', async () => {
    const fixture = await setupProxy();
    await env.DB.prepare('UPDATE services SET name = ? WHERE id = ?')
      .bind('<script>alert(1)</script>', fixture.serviceId)
      .run();
    expect((await fixture.call('/x')).status).toBe(200);
    await fixture.app.settle();
    const html = await (
      await adminGet(fixture.app, await loginAs(fixture.app, owner), '/admin')
    ).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('percentileText', () => {
  it('formats interpolated and open-ended percentiles', () => {
    expect(percentileText(null)).toBe('—');
    expect(percentileText({ ms: 42, overflow: false })).toBe('42 ms');
    expect(percentileText({ ms: 1500, overflow: false })).toBe('1.5 s');
    expect(percentileText({ ms: 5000, overflow: true })).toBe('≥ 5 s');
  });
});

describe('dashboard explanations', () => {
  it('explains denial reasons in plain language', async () => {
    const fixture = await setupProxy({ grant: { rules: [{ methods: ['GET'], path: '/ok/**' }] } });
    expect((await fixture.call('/nope', { method: 'DELETE' })).status).toBe(403);
    await fixture.app.settle();
    const html = await (
      await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')
    ).text();
    expect(html).toContain('no grant allows this caller to perform this request');
    expect(html).toContain('(HTTP 403)');
  });

  it('says allowed requests are not recorded when the sample rate is 0', async () => {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('allowed_sample_rate', '0', 0)",
    ).run();
    const a = createTestApp({ now: () => TEST_EPOCH_MS });
    const html = await (await adminGet(a, await loginAs(a, viewer), '/admin')).text();
    expect(html).toContain('Allowed requests are not recorded (sample rate 0 in Data retention)');
  });
});

describe('I-RBAC-1: dashboard, requests and audit routes', () => {
  it('are listed as read-only routes in the RBAC table', () => {
    for (const route of [
      'GET /admin',
      'GET /admin/requests',
      'GET /admin/requests/:id',
      'GET /admin/audit',
    ]) {
      expect(ROUTE_PERMISSIONS[route]).toEqual({ permission: 'read', mutates: false });
    }
  });
});

describe('GET /admin system status (moved from Settings)', () => {
  const app = () => createTestApp({ now: () => TEST_EPOCH_MS });

  it('renders the status in #health with names only', async () => {
    const a = app();
    const html = await (await adminGet(a, await loginAs(a, viewer), '/admin')).text();
    expect(html).toContain('<details id="health"><summary>System status</summary>');
    expect(html).toContain('<dt>Login providers</dt><dd>Cloudflare Access</dd>');
    expect(html).toContain('Control plane (DB): up to date');
    expect(html).not.toContain('First owner');
  });

  it('escapes stored text such as the last cron error', async () => {
    await env.DB.batch([
      putSettingStatement(
        env.DB,
        'cron_last_error',
        '<script>alert(1)</script>',
        TEST_EPOCH_MS,
        null,
      ),
      putSettingStatement(env.DB, 'cron_last_error_at', TEST_EPOCH_MS, TEST_EPOCH_MS, null),
    ]);
    const a = app();
    const html = await (await adminGet(a, await loginAs(a, viewer), '/admin')).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
