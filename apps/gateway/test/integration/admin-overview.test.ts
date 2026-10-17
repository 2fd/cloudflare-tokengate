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
  const section = /<section class="tray" id="get-started"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
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
    // Get started is the content: one primary, on step 1, and no empty charts or tables.
    expect(html.match(/class="btn primary"/g) ?? []).toHaveLength(1);
    expect(html).toContain('<a class="btn primary" href="/admin/tokens/new">');
    expect(html).toContain('0 of 4 done');
    expect(html).toContain('<section class="tray" id="plan" aria-labelledby="plan-h">');
    expect(html).toContain('No requests yet.');
    expect(html).toContain('aria-label="Where calls went, all zero"');
    expect(html).not.toContain('No denied requests in the selected range.');
    expect(html).not.toContain('class="pipe"');
    expect(html).not.toContain('class="cmap"');
    expect(html).not.toContain('<svg class="chart"');
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
    expect(html).toContain('Only token managers can add a service token. Ask ');
    expect(html).toContain('Only access managers can add a service consumer. Ask ');
    expect(html).toContain('href="mailto:owner@example.com');
    expect(html).not.toContain('href="/admin/tokens/new"');
    expect(html).not.toContain('href="/admin/access/new');
  });

  it('renders the alerts after Get started, never as role=alert', async () => {
    const a = app();
    const html = await (await adminGet(a, await loginAs(a, viewer), '/admin')).text();
    const attention =
      /<section class="tray" id="attention"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    const notes = /<div class="notes" id="notes">[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
    // No TOKENGATE_KEK in the test env (an error); cron never ran and one active owner (notes).
    expect(attention).toContain('<ul class="att">');
    expect(attention).toContain('Encryption keys are not loaded (keyring_absent)');
    expect(notes).toContain(
      '<span class="vh">Note: </span>The hourly job has not run yet; it starts within the hour.',
    );
    expect(notes).toContain('Only one active owner.');
    // The empty install puts Get started first, the problems after it.
    expect(html.indexOf('id="get-started"')).toBeLessThan(html.indexOf('id="attention"'));
    expect(html).toContain('<section class="tray" id="health" aria-labelledby="health-h">');
    expect(html).not.toContain('role="alert"');
    // The health strip is not repeated on the Overview itself.
    expect(html).not.toContain('class="hstrip"');
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
    // The pipeline: every count links to the request list it counts.
    expect(html).toContain('<ol class="pipe">');
    expect(html).toContain(
      '<a class="stage in" href="/admin/requests?range=24h"><span class="lbl">Received</span><span class="big">4</span>',
    );
    expect(html).toContain(
      '<a class="stage out" href="/admin/requests?range=24h&amp;outcome=allowed"><span class="lbl">Upstream OK · allowed</span><span class="big">3</span>',
    );
    expect(html).toContain(
      '<a href="/admin/requests?range=24h&amp;outcome=denied"><span class="tl">Denied</span><b>1</b>',
    );
    expect(html).toContain('role="img"');
    // The map: the token node opens its consumer accesses, the counts the request list.
    expect(html).toContain(`href="/admin/access?token=${fixture.serviceId}"`);
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
      expect(html, role).toContain('No consumer access allows this call');
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

  it('shows a new install with refused calls the setup layout: steps first, then the traffic', async () => {
    const fixture = await setupProxy();
    expect((await fixture.call('/x', { token: null })).status).toBe(401);
    await fixture.app.settle();
    const html = await (
      await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')
    ).text();
    const order = [
      'id="get-started"',
      'id="attention"',
      'id="flow"',
      'id="denials"',
      'id="tokens"',
    ];
    const at = order.map((id) => html.indexOf(id));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The Overview has no solid primary of its own in the header.
    const header = /<header class="ph">[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
    expect(header).not.toContain('btn primary');
    expect(header).toContain('<nav class="seg sm" aria-label="Time range">');
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
    expect(html).toMatch(
      /<summary>All checks \(\d+ ok, \d+ problems?\) <span class="hint"><span class="badge (?:ok|bad)">/,
    );
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
    expect(html).toMatch(
      /<details class="disc" id="checks" open=""><summary>All checks \(\d+ ok, 0 problems\)/,
    );
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
    expect(html).toMatch(
      /<details class="disc" id="checks" open=""><summary>All checks \(\d+ ok, [1-9]\d* problems?\)/,
    );
  });
});
