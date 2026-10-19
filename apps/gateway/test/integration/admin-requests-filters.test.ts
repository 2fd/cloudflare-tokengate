// Requests filters: chips that each drop one parameter, hidden fields that keep link-only filters,
// the `none` values, repository suggestions from control-plane labels only (never from the request
// log), and "Find a request" taking an ID out of a pasted log line.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { insertRequestRecordsStatements } from '../../src/db/requests';
import type { User } from '../../src/db/types';
import { newId } from '../../src/lib/ids';
import type { RequestRecord } from '../../src/telemetry/types';
import {
  type AdminSession,
  adminGet,
  createUser,
  loginAs,
  resetControlPlane,
} from '../helpers/admin-auth';
import { createTestApp, type TestApp } from '../helpers/app';
import { TEST_EPOCH_MS } from '../helpers/jwt';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const SVC = 'svc_01JAAAAAAAAAAAAAAAAAAAAAAA';
const ACR = 'acr_01JAAAAAAAAAAAAAAAAAAAAAAA';
const GITHUB = 'https://token.actions.githubusercontent.com';

function record(ts: number, overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: newId('req', ts, random),
    ts,
    outcome: 'denied',
    reason: 'token_missing',
    status: 401,
    upstream_status: null,
    method: 'GET',
    path: '/x',
    service_slug: 'echo',
    service_id: null,
    credential_access_rule_id: null,
    global_access_rule_id: null,
    claims_verified: 0,
    caller_subject: null,
    caller_repository: null,
    caller_claims: null,
    jti: null,
    untrusted_iss: null,
    eval_trace: null,
    duration_ms: 12,
    upstream_ms: null,
    weight: 1,
    ip: null,
    user_agent: null,
    colo: null,
    ...overrides,
  };
}

function requestLinks(html: string): string[] {
  return [...html.matchAll(/href="\/admin\/requests\/(req_[0-9A-Z]{26})"/g)].map((m) => m[1] ?? '');
}

const decode = (href: string) => href.replaceAll('&amp;', '&');

/** A credential with slug `labels` and one credential access rule `id` named `name` (direct SQL). */
async function insertRule(id: string, name: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO credentials (id, slug, name, base_url, injection, created_at, updated_at)
     VALUES (?, 'labels', 'Labels fixture', 'https://api.example.com', '{"kind":"bearer"}', 0, 0)`,
  )
    .bind(SVC)
    .run();
  await env.DB.prepare(
    `INSERT INTO access_rules (id, credential_id, name, profile, issuer, issuer_key, jwks_uri, audience,
       allowed_algs, max_token_age_seconds, tenant_pin, anchor_claims, conditions, rules, enabled,
       created_at, updated_at)
     VALUES (?, ?, ?, 'github-actions', ?, ?, ?, 'tokengate-test-audience', '["RS256"]', 300, '[]', '[]',
       '[{"claim":"repository_owner","match":"exact","values":["acme"]}]', '[{"methods":["*"],"path":"/**"}]', 1, 0, 0)`,
  )
    .bind(id, SVC, name, GITHUB, GITHUB, `${GITHUB}/.well-known/jwks`)
    .run();
}

let app: TestApp;
let session: AdminSession;
let viewer: User;

beforeEach(async () => {
  await resetControlPlane();
  await env.TELEMETRY_DB.prepare('DELETE FROM request_log').run();
  app = createTestApp({ now: () => TEST_EPOCH_MS + 60_000 });
  viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
  session = await loginAs(app, viewer);
});

describe('Requests filters', () => {
  it('turns each active filter into a chip whose link drops exactly that one', async () => {
    const query = `range=24h&outcome=denied&token=${SVC}&rule=${ACR}&repo=acme%2Fapi&reason=no_matching_rule&slug=echo`;
    const html = await (await adminGet(app, session, `/admin/requests?${query}`)).text();
    const chips =
      /<div class="achips" role="group" aria-label="Active filters">[\s\S]*?<\/div>/.exec(
        html,
      )?.[0] ?? '';
    const hrefs = [...chips.matchAll(/class="achip" href="([^"]+)"/g)].map((m) =>
      decode(m[1] ?? ''),
    );
    // Five filters plus the outcome: each chip drops exactly one key.
    expect(hrefs).toHaveLength(6);
    expect(html.indexOf('aria-label="Active filters"')).toBeGreaterThan(
      html.indexOf('aria-label="Filter requests"'),
    );
    expect(html).toContain('<h2 id="requests-h">Requests, newest first</h2>');
    const full = new URLSearchParams(query);
    for (const href of hrefs) {
      const params = new URL(href, 'https://x').searchParams;
      const dropped = [...full.keys()].filter((key) => !params.has(key));
      expect(dropped, href).toHaveLength(1);
      for (const key of full.keys()) {
        if (!dropped.includes(key)) expect(params.get(key), `${href} ${key}`).toBe(full.get(key));
      }
    }
    expect(chips).toContain('<a class="sm" href="/admin/requests">Clear filters</a>');
  });

  it('keeps link-only filters in hidden fields of the filter form', async () => {
    const html = await (
      await adminGet(app, session, `/admin/requests?range=1h&outcome=error&rule=${ACR}&slug=echo`)
    ).text();
    const form =
      /<form class="filters" role="search" method="get" action="\/admin\/requests" aria-label="Filter requests">[\s\S]*?<\/form>/.exec(
        html,
      )?.[0] ?? '';
    for (const [name, value] of [
      ['range', '1h'],
      ['outcome', 'error'],
      ['rule', ACR],
      ['slug', 'echo'],
    ]) {
      expect(form).toContain(`<input type="hidden" name="${name}" value="${value}"/>`);
    }
  });

  it('filters requests refused before a credential or a credential access rule was resolved with `none`', async () => {
    const bare = record(TEST_EPOCH_MS);
    const resolved = record(TEST_EPOCH_MS + 1000, {
      service_id: SVC,
      credential_access_rule_id: ACR,
    });
    await env.TELEMETRY_DB.batch(
      insertRequestRecordsStatements(env.TELEMETRY_DB, [bare, resolved]),
    );
    const get = async (query: string) =>
      requestLinks(await (await adminGet(app, session, `/admin/requests?${query}`)).text());
    expect(await get('token=none')).toEqual([bare.id]);
    expect(await get('rule=none')).toEqual([bare.id]);
    expect(await get(`token=${SVC}`)).toEqual([resolved.id]);
    expect(await get(`rule=${ACR}`)).toEqual([resolved.id]);
  });

  it('suggests repositories from claim labels only, never from the request log', async () => {
    await insertRule(ACR, 'GitHub');
    await env.DB.prepare(
      `INSERT INTO claim_labels (access_rule_id, claim, value, label, updated_at)
       VALUES (?, 'repository_id', '987654321', 'acme/labelled', 0)`,
    )
      .bind(ACR)
      .run();
    await env.TELEMETRY_DB.batch(
      insertRequestRecordsStatements(env.TELEMETRY_DB, [
        record(TEST_EPOCH_MS, { claims_verified: 1, caller_repository: 'acme/only-in-log' }),
      ]),
    );
    // One row and no filter: no filter form (A7.1); the repository is a filter link in the table.
    const plain = await (await adminGet(app, session, '/admin/requests')).text();
    expect(plain).not.toContain('aria-label="Filter requests"');
    expect(plain).toContain('href="/admin/requests?repo=acme%2Fonly-in-log"');
    // An active filter shows the form; its suggestions come from claim labels only.
    const html = await (await adminGet(app, session, '/admin/requests?outcome=denied')).text();
    const list = /<datalist id="f-repo-list">[\s\S]*?<\/datalist>/.exec(html)?.[0] ?? '';
    expect(list).toContain('<option value="acme/labelled">');
    expect(list).not.toContain('only-in-log');
  });

  it('shows the filter form above 10 rows without any filter', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => record(TEST_EPOCH_MS + i * 1000));
    await env.TELEMETRY_DB.batch(insertRequestRecordsStatements(env.TELEMETRY_DB, rows));
    const html = await (await adminGet(app, session, '/admin/requests')).text();
    expect(html).toContain('aria-label="Filter requests"');
  });

  it('states the actual start of a time range', async () => {
    const html = await (await adminGet(app, session, '/admin/requests?range=24h')).text();
    expect(html).toMatch(/<p>Since <time datetime="[^"]+">[^<]+<\/time> · newest first/);
    expect(await (await adminGet(app, session, '/admin/requests')).text()).not.toContain(
      'Since <time',
    );
  });

  it('names the reason filter in plain text in the chip and the title', async () => {
    const html = await (
      await adminGet(app, session, '/admin/requests?reason=no_matching_rule')
    ).text();
    expect(html).toMatch(/<title>Requests: [^<]*\(no_matching_rule\)/);
    expect(html).toMatch(/Reason: [^<]+ \(no_matching_rule\)/);
    expect(html).not.toContain('Reason: no_matching_rule');
  });

  it('re-renders an invalid repository with the field error and a 400', async () => {
    const res = await adminGet(app, session, '/admin/requests?repo=not%20a%20repo');
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('value="not a repo"');
    expect(html).toContain(
      '<a href="#f-repo">Enter the owner and name, like acme/api, or pick a suggestion.</a>',
    );
    expect(html).toMatch(/id="f-repo"[^>]*name="repo"[^>]*aria-invalid="true"/);
    expect(html).toContain('<p class="field-error" id="f-repo-error">');
  });
});

describe('Credential access rule filter (?rule=)', () => {
  const ACR_2 = 'acr_01JBBBBBBBBBBBBBBBBBBBBBBB';
  const bar = (html: string) =>
    /<form class="filters" role="search" method="get" action="\/admin\/requests" aria-label="Filter requests">[\s\S]*?<\/form>/.exec(
      html,
    )?.[0] ?? '';
  /** The filter controls in order, by their id: the stable part of the filter bar. */
  const controls = (html: string) =>
    [...bar(html).matchAll(/id="(f-[a-z]+)"/g)]
      .map((m) => m[1])
      .filter((id) => id !== 'f-repo-s' && !id?.endsWith('-error'));

  beforeEach(async () => {
    await insertRule(ACR, 'deploy api');
    await insertRule(ACR_2, 'nightly');
  });

  it('lists only the rule records, keeps the menu and the controls in place, and puts the chip after them', async () => {
    const own = record(TEST_EPOCH_MS, { service_id: SVC, credential_access_rule_id: ACR });
    const other = record(TEST_EPOCH_MS + 1000, {
      service_id: SVC,
      credential_access_rule_id: ACR_2,
    });
    const fillers = Array.from({ length: 10 }, (_, i) => record(TEST_EPOCH_MS + 2000 + i));
    await env.TELEMETRY_DB.batch(
      insertRequestRecordsStatements(env.TELEMETRY_DB, [own, other, ...fillers]),
    );
    const unfiltered = await (await adminGet(app, session, '/admin/requests')).text();
    const selected = await (await adminGet(app, session, `/admin/requests?rule=${ACR}`)).text();
    expect(requestLinks(selected)).toEqual([own.id]);
    // Same controls in the same order with and without the selection; the menu still offers
    // every rule (from the configuration, not the results), so the value can be replaced in place.
    expect(controls(selected)).toEqual(controls(unfiltered));
    expect(controls(selected)).toEqual(['f-repo', 'f-token', 'f-rule', 'f-reason']);
    expect(bar(selected)).toContain(`href="/admin/requests?rule=${ACR_2}"`);
    expect(bar(selected)).toContain('nightly');
    // The title stays; the chip follows the controls and drops the rule.
    expect(selected).toContain('<h2 id="requests-h">Requests, newest first</h2>');
    expect(selected).toContain('Access rule: deploy api');
    expect(selected.indexOf('aria-label="Active filters"')).toBeGreaterThan(
      selected.indexOf('aria-label="Filter requests"'),
    );
    expect(selected).toContain('<a class="achip" href="/admin/requests">');
    // The row links its rule as a filter.
    expect(unfiltered).toContain(`href="/admin/requests?rule=${ACR}"`);
  });

  it('keeps the explanation and the controls on zero results', async () => {
    await env.TELEMETRY_DB.batch(
      insertRequestRecordsStatements(env.TELEMETRY_DB, [
        record(TEST_EPOCH_MS, { service_id: SVC, credential_access_rule_id: ACR }),
      ]),
    );
    const res = await adminGet(app, session, `/admin/requests?rule=${ACR_2}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(requestLinks(html)).toEqual([]);
    expect(controls(html)).toEqual(['f-repo', 'f-token', 'f-rule', 'f-reason']);
    expect(html).toContain('Access rule: nightly');
    expect(html).toContain('<h2 id="requests-h">Requests, newest first</h2>');
  });

  it('names a deleted rule by its id and answers 400 for an invalid id, still listing the results', async () => {
    const gone = 'acr_01JCCCCCCCCCCCCCCCCCCCCCCC';
    const deleted = await (await adminGet(app, session, `/admin/requests?rule=${gone}`)).text();
    expect(deleted).toContain(`Access rule: Deleted credential access rule ${gone}`);

    const kept = record(TEST_EPOCH_MS);
    await env.TELEMETRY_DB.batch(insertRequestRecordsStatements(env.TELEMETRY_DB, [kept]));
    for (const value of ['acr_bogus', 'gar_01JAAAAAAAAAAAAAAAAAAAAAAA', '%3Cscript%3E']) {
      const res = await adminGet(app, session, `/admin/requests?rule=${value}`);
      expect(res.status, value).toBe(400);
      const html = await res.text();
      expect(html).toContain('class="callout bad errsum"');
      expect(html).toContain('<details class="fadd" id="f-rule" open="">');
      expect(html).toContain('<p class="field-error" id="f-rule-error">');
      expect(html).toContain(
        '<a href="#f-rule">Choose a credential access rule from the list.</a>',
      );
      expect(requestLinks(html)).toEqual([kept.id]);
      expect(controls(html)).toEqual(['f-repo', 'f-token', 'f-rule', 'f-reason']);
      expect(html).not.toContain('<script>');
    }
  });
});

describe('Find a request', () => {
  it('takes the first request ID out of a pasted log line, any case, and redirects to it', async () => {
    const target = record(TEST_EPOCH_MS);
    await env.TELEMETRY_DB.batch(insertRequestRecordsStatements(env.TELEMETRY_DB, [target]));
    const line = `Error: 403 x-tokengate-request-id: ${target.id.toLowerCase()} (see logs)`;
    const res = await adminGet(app, session, `/admin/requests?id=${encodeURIComponent(line)}`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin/requests/${target.id}`);
  });

  it('answers 404 with the error at the field and the pasted text kept', async () => {
    const missing = newId('req', TEST_EPOCH_MS, random);
    const res = await adminGet(app, session, `/admin/requests?id=${missing}`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<title>Error: Requests – Monitoring – tokengate</title>');
    expect(html).toContain(`value="${missing}"`);
    expect(html).toContain('<a href="#f-id">There is no request record with this ID.');
    expect(html).toMatch(/id="f-id"[^>]*name="id"[^>]*aria-invalid="true"/);
    expect(html).toContain('<p class="field-error" id="f-id-error">');
    const garbage = await adminGet(app, session, '/admin/requests?id=%3Cscript%3E');
    expect(garbage.status).toBe(404);
    const text = await garbage.text();
    expect(text).toContain('Enter a request ID like req_01JB8Z5K2Q7W3N4M6P8R9T0V1X');
    expect(text).not.toContain('<script>');
  });

  it('is on every Monitoring page', async () => {
    for (const path of ['/admin', '/admin/requests', '/admin/audit', '/admin/retention']) {
      const html = await (await adminGet(app, session, path)).text();
      expect(html, path).toContain(
        '<form class="field-inline find-request" role="search" method="get" action="/admin/requests" aria-label="Find a request">',
      );
    }
  });
});
