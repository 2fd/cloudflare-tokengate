// Overview end to end: getting-started steps, KPIs, the chart, tokens in use and top denials from
// real proxy records, alerts from loadAlertData, the health checks, role-dependent links, escaping.
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

/** The hrefs of the getting-started section, in order. */
function stepLinks(html: string): string[] {
  const section = /<section id="get-started"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  return [...section.matchAll(/href="([^"]+)"/g)].map((m) => (m[1] ?? '').replaceAll('&amp;', '&'));
}

describe('GET /admin on a fresh deployment', () => {
  const app = () => createTestApp({ now: () => TEST_EPOCH_MS });

  it('shows the four getting-started steps with links, tokens first', async () => {
    const a = app();
    const res = await adminGet(a, await loginAs(a, owner), '/admin');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Overview (last 24 hours) – Monitoring – tokengate</title>');
    expect(stepLinks(html)).toEqual([
      '/admin/tokens/new',
      '/admin/consumers/new?type=github-actions',
      '/admin/access/new',
      'https://github.com/2fd/cloudflare-tokengate/blob/main/docs/callers/github-actions.md',
    ]);
    expect(html).toContain('Steps 1 and 2 can be done in any order, and by different people.');
    expect(html).toContain('No requests in the selected range.');
    expect(html).toContain('No denied requests in the selected range.');
  });

  it('adds the consumer inside the access form once a token exists', async () => {
    const a = app();
    await env.DB.prepare(
      `INSERT INTO services (id, slug, name, base_url, injection, created_at, updated_at)
       VALUES ('svc_01JAAAAAAAAAAAAAAAAAAAAAAA', 'slack', 'Slack', 'https://slack.com/api', '{"kind":"bearer"}', 0, 0)`,
    ).run();
    const html = await (await adminGet(a, await loginAs(a, owner), '/admin')).text();
    expect(stepLinks(html)[1]).toBe('/admin/access/new?consumer=new');
  });

  it('tells viewers whom to ask instead of linking to forms they cannot use', async () => {
    const a = app();
    const html = await (await adminGet(a, await loginAs(a, viewer), '/admin')).text();
    expect(html).toContain('Ask a token manager to add a service token: ');
    expect(html).toContain('Ask an access manager to add a service consumer: ');
    expect(html).toContain('href="mailto:owner@example.com"');
    expect(html).not.toContain('href="/admin/tokens/new"');
    expect(html).not.toContain('href="/admin/access/new');
  });

  it('renders the alerts inside the health panel, never as role=alert', async () => {
    const a = app();
    const html = await (await adminGet(a, await loginAs(a, viewer), '/admin')).text();
    const health = /<section id="health"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    // No TOKENGATE_KEK in the test env; cron never ran; one active owner.
    expect(health).toContain('<ul class="alerts">');
    expect(health).toContain('Encryption keys are not loaded (keyring_absent)');
    expect(health).toContain('The hourly job has not run yet; it starts within the hour.');
    expect(health).toContain('Only one active owner.');
    expect(html).not.toContain('role="alert"');
    // The health strip is not repeated on the Overview itself.
    expect(html).not.toContain('class="health-strip"');
  });

  it('falls back to 24 hours for an unknown range without echoing it', async () => {
    const a = app();
    const res = await adminGet(a, await loginAs(a, viewer), '/admin?range=%3Cscript%3E');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('That time range is not available; showing the last 24 hours.');
    expect(html).not.toContain('<script>');
  });

  it('rejects a POST to the read-only Overview', async () => {
    const a = app();
    const res = await adminPost(a, await loginAs(a, viewer), '/admin', {});
    expect(res.status).toBe(403);
  });
});

describe('GET /admin with traffic', () => {
  it('shows the KPIs as a list of links, the chart and the token row, and hides the steps', async () => {
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
    expect(html).not.toContain('id="get-started"');
    expect(html).toContain('<dl class="kpis">');
    expect(html).toMatch(
      /<dt>Requests<\/dt><dd><a href="\/admin\/requests\?range=24h">4<span class="vh"> requests, last 24 hours<\/span><\/a>/,
    );
    expect(html).toMatch(
      /<dt>Allowed<\/dt><dd><a href="\/admin\/requests\?range=24h&amp;outcome=allowed">3<span class="vh"> allowed requests, last 24 hours<\/span><\/a>/,
    );
    expect(html).toMatch(
      /<dt>Denied<\/dt><dd><a href="\/admin\/requests\?range=24h&amp;outcome=denied">1<span class="vh"> denied requests, last 24 hours<\/span><\/a>/,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain(`href="/admin/tokens/${fixture.serviceId}"`);
    expect(html).toContain(`href="/admin/requests?token=${fixture.serviceId}&amp;range=24h"`);
    expect(html).toContain(`href="/admin/access/${fixture.grantId}"`);
    expect(html).toContain('href="/admin/access"');
  });

  it('lists top denials with a link to the latest record, and Create access only for access:write', async () => {
    const fixture = await setupProxy({ grant: { rules: [{ methods: ['GET'], path: '/ok/**' }] } });
    expect((await fixture.call('/nope', { method: 'DELETE' })).status).toBe(403);
    await fixture.app.settle();
    const denial = (await fixture.records()).find((r) => r.reason === 'no_matching_grant');
    expect(denial).toBeDefined();
    const a = fixture.app;
    const create = `href="/admin/access/new?from_request=${denial?.id}"`;
    for (const role of ['owner', 'admin', 'access_manager'] as const) {
      const user =
        role === 'owner' ? owner : await createUser({ email: `${role}@example.com`, role });
      const html = await (await adminGet(a, await loginAs(a, user), '/admin')).text();
      expect(html, role).toContain('Top denied callers since');
      expect(html, role).toContain(`href="/admin/requests/${denial?.id}"`);
      expect(html, role).toContain(create);
      expect(html, role).toContain('no consumer access allows this call');
    }
    for (const role of ['viewer', 'token_manager'] as const) {
      const user =
        role === 'viewer' ? viewer : await createUser({ email: `${role}@example.com`, role });
      const html = await (await adminGet(a, await loginAs(a, user), '/admin')).text();
      expect(html, role).not.toContain('from_request=');
      expect(html, role).toContain('See requests');
    }
  });

  it('does not mark "Make the first call" done for pre-trust rejections only', async () => {
    const fixture = await setupProxy();
    // No caller token: rejected before any claim is verified (claims_verified = 0).
    expect((await fixture.call('/x', { token: null })).status).toBe(401);
    await fixture.app.settle();
    expect((await fixture.records()).map((r) => r.claims_verified)).toEqual([0]);

    const a = fixture.app;
    const before = await (await adminGet(a, await loginAs(a, viewer), '/admin')).text();
    expect(before).toContain('id="get-started"');
    expect(before).toContain(`href="/admin/access/${fixture.grantId}#use"`);

    expect((await fixture.call('/x')).status).toBe(200);
    await fixture.app.settle();
    const after = await (await adminGet(a, await loginAs(a, viewer), '/admin')).text();
    expect(after).not.toContain('id="get-started"');
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

  it('escapes token names (XSS)', async () => {
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

describe('sampling notes', () => {
  it('says allowed requests are not recorded when the sample rate is 0', async () => {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('allowed_sample_rate', '0', 0)",
    ).run();
    const a = createTestApp({ now: () => TEST_EPOCH_MS });
    const html = await (await adminGet(a, await loginAs(a, viewer), '/admin')).text();
    expect(html).toContain('Allowed requests are not recorded (sample rate 0)');
    expect(html).toContain('href="/admin/retention"');
  });

  it('says counts are estimates below 100 %', async () => {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('allowed_sample_rate', '0.1', 0)",
    ).run();
    const a = createTestApp({ now: () => TEST_EPOCH_MS });
    const html = await (await adminGet(a, await loginAs(a, viewer), '/admin')).text();
    expect(html).toContain('Allowed requests are sampled at 10.0%, so counts are estimates.');
  });
});

describe('I-RBAC-1: Monitoring read routes', () => {
  it('are listed as read-only routes in the RBAC table', () => {
    for (const route of [
      'GET /admin',
      'GET /admin/requests',
      'GET /admin/requests/:id',
      'GET /admin/audit',
      'GET /admin/retention',
    ]) {
      expect(ROUTE_PERMISSIONS[route]).toEqual({ permission: 'read', mutates: false });
    }
  });
});

describe('GET /admin health checks', () => {
  const app = () => createTestApp({ now: () => TEST_EPOCH_MS });

  it('lists every check with an id, names only', async () => {
    const a = app();
    const html = await (await adminGet(a, await loginAs(a, viewer), '/admin')).text();
    expect(html).toMatch(/<summary>All checks \(\d+ ok, \d+ problems?\)<\/summary>/);
    for (const id of [
      'schema',
      'telemetry-schema',
      'maintenance',
      'keys',
      'sign-in',
      'admin-hosts',
      'config',
    ]) {
      expect(html).toContain(`id="check-${id}"`);
    }
    expect(html).toContain('Cloudflare Access.');
    expect(html).not.toContain('First owner');
  });

  it('opens "All checks" for cron_never although its check passes, so #check-maintenance lands', async () => {
    // Keys loaded, so every check passes; the job has never run, which is not a problem.
    const fixture = await setupProxy({ grant: false });
    const html = await (
      await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')
    ).text();
    expect(html).toContain('The hourly job has not run yet; it starts within the hour.');
    expect(html).toContain('href="/admin#check-maintenance"');
    expect(html).toMatch(/<details open="">\s*<summary>All checks \(\d+ ok, 0 problems\)/);
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
    // A failing check opens "All checks", so the alert's #check-maintenance link lands on its row.
    expect(html).toContain('href="/admin#check-maintenance"');
    expect(html).toMatch(/<details open="">\s*<summary>All checks \(\d+ ok, [1-9]\d* problems?\)/);
  });
});
