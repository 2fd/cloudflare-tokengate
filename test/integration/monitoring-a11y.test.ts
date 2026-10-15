// WCAG 2.2 AA checks on the rendered Monitoring pages (string and regex checks on the HTML):
// tables in labelled focusable regions with captions and header scopes, <time datetime>, the chart
// as one image with a table alternative, aria-current on tabs, error summaries linked to fields,
// aria-describedby naming only rendered ids, one h1 and one autofocus, patterns that compile like
// browsers compile them, and no style attribute or element anywhere (CSP).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/db/types';
import { adminGet, adminPost, createUser, loginAs, resetControlPlane } from '../helpers/admin-auth';
import { type ProxyFixture, setupProxy } from '../helpers/proxy-fixtures';

let fixture: ProxyFixture;
let owner: User;
let viewer: User;

beforeEach(async () => {
  await resetControlPlane();
  owner = await createUser({ email: 'owner@example.com', role: 'owner' });
  viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  fixture = await setupProxy({ grant: { rules: [{ methods: ['GET'], path: '/ok/**' }] } });
  expect((await fixture.call('/ok/1')).status).toBe(200);
  expect((await fixture.call('/nope', { method: 'DELETE' })).status).toBe(403);
  await fixture.app.settle();
});

function checkPage(html: string, label: string): void {
  // CSP: no inline styles or scripts.
  expect(html, label).not.toMatch(/\sstyle=/);
  expect(html, label).not.toContain('<style');
  expect(html, label).not.toContain('<script');
  // One h1.
  expect(html.match(/<h1[\s>]/g) ?? [], label).toHaveLength(1);
  // Every table: caption, in a labelled focusable region, column header scopes.
  const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? [];
  for (const table of tables) {
    expect(table, label).toMatch(/^<table[^>]*>\s*<caption/);
    expect(table, label).toContain('<th scope="col"');
  }
  const regions =
    html.match(
      /<div class="table-region" role="region" aria-labelledby="[^"]+" tabindex="0">\s*<table/g,
    ) ?? [];
  expect(regions.length, label).toBe(tables.length);
  // aria-describedby and aria-labelledby only name ids that exist.
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const ref of html.matchAll(/aria-(?:describedby|labelledby)="([^"]+)"/g)) {
    for (const id of (ref[1] ?? '').split(' ')) expect(ids.has(id), `${label}: #${id}`).toBe(true);
  }
  // Every pattern compiles the way browsers compile it.
  for (const pattern of html.matchAll(/\spattern="([^"]+)"/g)) {
    const source = (pattern[1] ?? '').replaceAll('&amp;', '&');
    expect(() => new RegExp(`^(?:${source})$`, 'v'), `${label}: ${source}`).not.toThrow();
  }
  // At most one page-level autofocus (the Cancel buttons of closed dialogs do not count).
  const outsideDialogs = html.replace(/<dialog[\s\S]*?<\/dialog>/g, '');
  expect((outsideDialogs.match(/\sautofocus/g) ?? []).length, label).toBeLessThanOrEqual(1);
  // Every link that opens in-page tabs marks the current one.
  for (const nav of html.matchAll(
    /<nav aria-label="(Time range|Outcome|Category)" class="tabs">([\s\S]*?)<\/nav>/g,
  )) {
    expect(nav[2], `${label}: ${nav[1]}`).toContain('aria-current="page"');
  }
}

describe('Monitoring pages: WCAG 2.2 AA markup', () => {
  it('Overview, Requests, a request, the audit log and Data retention pass the checks', async () => {
    const a = fixture.app;
    const ownerSession = await loginAs(a, owner);
    const viewerSession = await loginAs(a, viewer);
    const [first] = await fixture.records();
    const pages = [
      '/admin',
      '/admin?range=7d',
      '/admin?range=30d',
      '/admin/requests',
      '/admin/requests?outcome=denied&range=24h',
      `/admin/requests/${first?.id}`,
      '/admin/audit',
      '/admin/retention',
    ];
    for (const path of pages) {
      for (const [who, session] of [
        ['owner', ownerSession],
        ['viewer', viewerSession],
      ] as const) {
        const res = await adminGet(a, session, path);
        expect(res.status, path).toBe(200);
        checkPage(await res.text(), `${who} ${path}`);
      }
    }
  });

  it('uses <time datetime> for times, and the chart is an image with a table alternative', async () => {
    const html = await (
      await adminGet(fixture.app, await loginAs(fixture.app, viewer), '/admin')
    ).text();
    expect(html).toMatch(/<time datetime="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z">/);
    expect(html).toMatch(
      /<svg class="chart-svg" viewBox="[^"]+" role="img" aria-labelledby="traffic-chart-title traffic-chart-desc">/,
    );
    expect(html).toContain('<desc id="traffic-chart-desc">Peak: ');
    expect(html).toMatch(
      /<\/svg><figcaption>[\s\S]*?<\/figcaption><details><summary>Show the numbers<\/summary><div class="table-region"/,
    );
    // Denied and errors differ by pattern, not only by colour.
    expect(html).toContain('<pattern id="chart-hatch"');
    expect(html).toContain('<pattern id="chart-dots"');
  });

  it('error re-renders: "Error:" title, a focused summary linking to invalid fields', async () => {
    const a = fixture.app;
    const res = await adminGet(
      a,
      await loginAs(a, viewer),
      '/admin/requests?token=bogus&reason=bogus',
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    checkPage(html, 'requests error');
    expect(html).toContain('<title>Error: Requests');
    expect(html).toContain(
      '<div class="error-summary" role="group" tabindex="-1" autofocus="" aria-labelledby="es-h">',
    );
    for (const field of ['token', 'reason']) {
      expect(html).toContain(`<a href="#f-${field}">`);
      expect(html).toMatch(
        new RegExp(
          `<select id="f-${field}" name="${field}" aria-describedby="f-${field}-hint f-${field}-error" aria-invalid="true">`,
        ),
      );
    }
    const retention = await adminPost(a, await loginAs(a, owner), '/admin/retention', {
      request_log_retention_days: '0',
    });
    expect(retention.status).toBe(400);
    const form = await retention.text();
    checkPage(form, 'retention error');
    expect(form).toContain('<a href="#f-request_log_retention_days">');
  });

  it('the notice after a save is the one autofocus, with role=status', async () => {
    const a = fixture.app;
    const html = await (
      await adminGet(a, await loginAs(a, owner), '/admin/retention?notice=saved')
    ).text();
    checkPage(html, 'retention notice');
    expect(html).toContain('<div class="notice" role="status" tabindex="-1" autofocus="">');
    await env.DB.prepare('DELETE FROM audit_log').run();
  });
});
