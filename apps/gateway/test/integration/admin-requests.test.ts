// Request log pages end to end: records produced by the real proxy, filters, keyset pagination,
// detail with stored claims and trace, re-evaluation against the current credential and global
// access rules, and RBAC.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { insertRequestRecordsStatements } from '../../src/db/requests';
import type { User } from '../../src/db/types';
import { newId } from '../../src/lib/ids';
import type { RequestRecord } from '../../src/telemetry/types';
import {
  type AdminSession,
  adminGet,
  adminPost,
  createUser,
  loginAs,
  resetControlPlane,
} from '../helpers/admin-auth';
import { createTestApp } from '../helpers/app';
import { TEST_EPOCH_MS } from '../helpers/jwt';
import {
  type CredentialRuleSeed,
  type ProxyFixture,
  resetProxyState,
  setupProxy,
} from '../helpers/proxy-fixtures';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

function requestRecord(ts: number, overrides: Partial<RequestRecord> = {}): RequestRecord {
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

async function insertRecords(records: RequestRecord[]): Promise<void> {
  await env.TELEMETRY_DB.batch(insertRequestRecordsStatements(env.TELEMETRY_DB, records));
}

function requestLinks(html: string): string[] {
  return [...html.matchAll(/href="\/admin\/requests\/(req_[0-9A-Z]{26})"/g)].map((m) => m[1] ?? '');
}

let owner: User;
let viewer: User;

beforeEach(async () => {
  await resetControlPlane();
  await resetProxyState();
  owner = await createUser({ email: 'owner@example.com', role: 'owner' });
  viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
});

describe('request log with records from the proxy', () => {
  let fixture: ProxyFixture;
  let ownerSession: AdminSession;
  let viewerSession: AdminSession;
  let allowed: RequestRecord;
  let noRule: RequestRecord;
  let noToken: RequestRecord;

  beforeEach(async () => {
    fixture = await setupProxy({
      rule: { rules: [{ methods: ['GET'], path: '/allowed/**' }] },
    });
    ownerSession = await loginAs(fixture.app, owner);
    viewerSession = await loginAs(fixture.app, viewer);
    expect((await fixture.call('/allowed/1')).status).toBe(200);
    fixture.clock.advance(5);
    expect((await fixture.call('/other', { method: 'POST' })).status).toBe(403);
    fixture.clock.advance(5);
    expect((await fixture.call('/x', { token: null })).status).toBe(401);
    const records = await fixture.records();
    const byReason = (reason: string | null) => {
      const found = records.find((r) => r.reason === reason);
      if (!found) throw new Error(`no record with reason ${reason}`);
      return found;
    };
    allowed = byReason(null);
    noRule = byReason('no_matching_rule');
    noToken = byReason('token_missing');
  });

  it('lists every record newest first for a viewer', async () => {
    const res = await adminGet(fixture.app, viewerSession, '/admin/requests');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(requestLinks(html)).toEqual([noToken.id, noRule.id, allowed.id]);
    expect(html).toContain('acme/app');
    expect(html).toContain('no_matching_rule');
    expect(html).toContain('No credential access rule allows this call');
    expect(html).toContain('unverified token');
  });

  it('filters by outcome, repository, service and slug', async () => {
    const get = async (query: string) =>
      requestLinks(
        await (await adminGet(fixture.app, viewerSession, `/admin/requests?${query}`)).text(),
      );
    expect(await get('outcome=denied')).toEqual([noToken.id, noRule.id]);
    expect(await get('outcome=allowed')).toEqual([allowed.id]);
    expect(await get('repo=acme%2Fapp')).toEqual([noRule.id, allowed.id]);
    expect(await get(`token=${fixture.serviceId}`)).toEqual([noRule.id, allowed.id]);
    expect(await get('slug=echo')).toEqual([noToken.id, noRule.id, allowed.id]);
    expect(await get('slug=other')).toEqual([]);
  });

  it('shows the detail of a denied request with stored claims, trace and the give-access link for admins', async () => {
    const res = await adminGet(fixture.app, ownerSession, `/admin/requests/${noRule.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`href="/admin/credential-access-rules/new?from_request=${noRule.id}"`);
    expect(html).toContain('Give access from this request');
    expect(html).toContain('<title>Denied: POST /other – Monitoring – tokengate</title>');
    // Allowlisted claims are shown; the token itself never was stored.
    expect(html).toContain('repository_id');
    expect(html).toContain('987654321');
    expect(html).not.toContain('repository_visibility');
    expect(html).toContain('Policy evaluation at request time');
    expect(html).toContain(`/admin/credential-access-rules/${fixture.ruleId}`);
    expect(html).toContain('no operation allows this method and path');
  });

  it('hides "Give access from this request" from viewers', async () => {
    const html = await (
      await adminGet(fixture.app, viewerSession, `/admin/requests/${noRule.id}`)
    ).text();
    expect(html).not.toContain('from_request=');
  });

  it('offers no access prefill or re-evaluation for unverified records', async () => {
    const res = await adminGet(fixture.app, ownerSession, `/admin/requests/${noToken.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('from_request=');
    expect(html).not.toContain('Check against current access rules');
    expect(html).toContain('the token was not verified');
    expect(html).toContain('x-tokengate-token');
  });

  it('re-evaluates stored claims against the current access rules on every load, changing nothing', async () => {
    const denied = await (
      await adminGet(fixture.app, viewerSession, `/admin/requests/${noRule.id}`)
    ).text();
    expect(denied).toContain('Stored claims subset only');
    expect(denied).toContain('<b>denied</b>');

    const ruleId = await fixture.addRule({
      rules: [{ methods: ['POST'], path: '/other' }],
    });
    const auditBefore = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{
      n: number;
    }>();
    const allowedNow = await (
      await adminGet(fixture.app, viewerSession, `/admin/requests/${noRule.id}`)
    ).text();
    expect(allowedNow).toContain('<b>allowed</b>');
    expect(allowedNow).toContain(`/admin/credential-access-rules/${ruleId}`);
    const auditAfter = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{
      n: number;
    }>();
    expect(auditAfter?.n).toBe(auditBefore?.n);
  });

  it('reports blockers that run before the access rules when re-evaluating', async () => {
    await env.DB.prepare('UPDATE credentials SET enabled = 0 WHERE id = ?')
      .bind(fixture.serviceId)
      .run();
    const html = await (
      await adminGet(fixture.app, viewerSession, `/admin/requests/${allowed.id}`)
    ).text();
    expect(html).toContain('The credential is disabled.');
    // A blocker refuses the request on its own: the verdict never says allowed, and comes first.
    expect(html).not.toContain('Would now be <b>allowed</b>');
    const verdict = html.indexOf('Would still be <b>refused</b>');
    expect(verdict).toBeGreaterThan(-1);
    expect(verdict).toBeLessThan(html.indexOf('<ul class="blockers">'));
    expect(html).toContain(
      `Once it passes, <a href="/admin/credential-access-rules/${fixture.ruleId}">`,
    );
  });

  it('re-evaluates with the proxy candidates: disabled, expired and other-issuer rules never allow', async () => {
    const allowingRule: CredentialRuleSeed = { rules: [{ methods: ['POST'], path: '/other' }] };
    await fixture.addRule({ ...allowingRule, enabled: false });
    await fixture.addRule({ ...allowingRule, expiresAt: fixture.clock.now() - 1 });
    await fixture.addRule({ ...allowingRule, issuer: `${fixture.issuer.issuer}/other` });

    const html = await (
      await adminGet(fixture.app, viewerSession, `/admin/requests/${noRule.id}`)
    ).text();
    expect(html).toContain('<b>denied</b>');
    expect(html).toContain('1 enabled credential access rule checked.');
  });

  it('lays the detail out as a runbook: where the call stopped, the check, what to do', async () => {
    const html = await (
      await adminGet(fixture.app, ownerSession, `/admin/requests/${noRule.id}`)
    ).text();
    expect(html).toContain('<ol class="trace" aria-label="Where the call stopped">');
    expect(html).toMatch(
      /<li class="tstep fail"><span class="s"><span aria-hidden="true">✕ <\/span>Failed, stopped here<\/span><span class="v">Access rule matched<\/span>/,
    );
    expect(html).toMatch(/<h2 id="recheck-h"><span class="fstep-n" aria-hidden="true">2<\/span>/);
    expect(html).toContain('Still denied now');
    // One primary, last in the header; the What to do buttons are secondary.
    expect(html.match(/class="btn primary"/g)).toHaveLength(1);
    expect(html).toContain(
      `<a class="btn primary" href="/admin/credential-access-rules/new?from_request=${noRule.id}">Give access from this request</a></div>`,
    );
    expect(html).toContain('<p class="prefill"><span class="vh">Filled in: </span>');
    // Retention: when the record goes away.
    expect(html).toContain('(14 days, <a href="/admin/retention">Data retention</a>)');
    // An unverified record has no re-evaluation tray: What happened, then What to do.
    const unverified = await (
      await adminGet(fixture.app, ownerSession, `/admin/requests/${noToken.id}`)
    ).text();
    expect(unverified).not.toContain('id="recheck"');
    expect(unverified).toMatch(
      /<h2 id="next-h"><span class="fstep-n" aria-hidden="true">2<\/span>/,
    );
  });

  it('offers the access form from the newest row when one caller is behind every denial', async () => {
    expect((await fixture.call('/other', { method: 'POST' })).status).toBe(403);
    await fixture.app.settle();
    const records = await fixture.records();
    const newest = records
      .filter((r) => r.reason === 'no_matching_rule')
      .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
    const query = `/admin/requests?outcome=denied&token=${fixture.serviceId}`;
    const owner = await (await adminGet(fixture.app, ownerSession, query)).text();
    expect(owner).toContain('All 2 on this page come from one caller: acme/app');
    expect(owner).toContain(
      `<a class="btn primary" href="/admin/credential-access-rules/new?from_request=${newest?.id}">Give access from the latest request</a>`,
    );
    const view = await (await adminGet(fixture.app, viewerSession, query)).text();
    expect(view).not.toContain('from_request=');
  });

  it('explains the reason and what to do without offering viewers the access form', async () => {
    const html = await (
      await adminGet(fixture.app, viewerSession, `/admin/requests/${noRule.id}`)
    ).text();
    expect(html).toMatch(
      /<h2 id="next-h"><span class="fstep-n" aria-hidden="true">\d<\/span>What to do<\/h2>/,
    );
    expect(html).toContain('An access manager, admin or owner can give access from this request.');
    expect(html).toContain('Only access managers can give access from this request');
    expect(html).not.toContain('/admin/credential-access-rules/new');
  });

  it('rejects mutations from a viewer (no POST routes)', async () => {
    const res = await adminPost(fixture.app, viewerSession, '/admin/requests', {});
    expect(res.status).toBe(403);
    const detail = await adminPost(fixture.app, viewerSession, `/admin/requests/${noRule.id}`, {});
    expect(detail.status).toBe(403);
  });
});

describe('request detail of a call refused by the global access rules', () => {
  it('names the global access rule, links the issuer filter and offers no access prefill', async () => {
    const fixture = await setupProxy({ rule: { rules: [{ methods: ['*'], path: '/**' }] } });
    const globalId = await fixture.addGlobalRule({
      name: 'reads only',
      rules: [{ methods: ['GET'], path: '/**' }],
    });
    const session = await loginAs(fixture.app, owner);
    const res = await fixture.call('/x', { method: 'POST' });
    expect(res.status).toBe(403);
    const id = res.headers.get('x-tokengate-request-id');
    const record = (await fixture.records()).find((r) => r.id === id);
    expect(record?.reason).toBe('outside_global_rules');
    expect(record?.credential_access_rule_id).toBe(fixture.ruleId);
    expect(record?.global_access_rule_id).toBeNull();

    const html = await (await adminGet(fixture.app, session, `/admin/requests/${id}`)).text();
    const issuerFilter =
      '/admin/global-access-rules?issuer=https%3A%2F%2Ftoken.actions.githubusercontent.com';
    // The stored trace and the re-evaluation both name the global rule and its issuer.
    expect(html).toContain('refused by the global access rules of its issuer');
    expect(html).toContain(`<a href="/admin/global-access-rules/${globalId}">reads only</a>`);
    expect(html).toContain(
      `Refused by the global access rules of <a href="${issuerFilter}">https://token.actions.githubusercontent.com</a>`,
    );
    expect(html).toContain('Would still be <b>denied</b> (<code>no_matching_rule</code>)');
    // What to do: the credential access rule and the global rules of the issuer; no prefill,
    // because a new credential access rule cannot pass a global ceiling.
    expect(html).toContain(`href="/admin/credential-access-rules/${fixture.ruleId}"`);
    expect(html).toContain(`href="${issuerFilter}"`);
    expect(html).toContain('Open the global access rules');
    expect(html).not.toContain('from_request=');
    // The facts name both kinds of rule.
    expect(html).toContain('Credential access rule');
    expect(html).toContain('Global access rule');
  });

  it('names the global access rule that let an allowed call through', async () => {
    const fixture = await setupProxy();
    const globalId = await fixture.addGlobalRule({ name: 'acme only' });
    const session = await loginAs(fixture.app, owner);
    const res = await fixture.call('/x');
    expect(res.status).toBe(200);
    const id = res.headers.get('x-tokengate-request-id');
    const record = (await fixture.records()).find((r) => r.id === id);
    expect(record?.global_access_rule_id).toBe(globalId);
    const html = await (await adminGet(fixture.app, session, `/admin/requests/${id}`)).text();
    expect(html).toContain(`<a href="/admin/global-access-rules/${globalId}">acme only</a>`);
    expect(html).toContain('within the global access rule');
  });
});

describe('request log pages without proxy traffic', () => {
  const app = () => createTestApp({ now: () => TEST_EPOCH_MS + 60_000 });

  it('shows a next-step empty state when nothing was recorded', async () => {
    const a = app();
    const session = await loginAs(a, viewer);
    const html = await (await adminGet(a, session, '/admin/requests')).text();
    expect(html).toContain('No requests recorded yet');
    expect(html).toContain('docs/callers/github-actions.md');
  });

  it('paginates by id with an "Older entries" link', async () => {
    const records = Array.from({ length: 55 }, (_, i) => requestRecord(TEST_EPOCH_MS + i * 1000));
    await insertRecords(records);
    const newest = [...records].sort((a, b) => (a.id < b.id ? 1 : -1));
    const a = app();
    const session = await loginAs(a, viewer);

    const first = await (await adminGet(a, session, '/admin/requests?outcome=denied')).text();
    expect(requestLinks(first)).toEqual(newest.slice(0, 50).map((r) => r.id));
    const older = first.match(/href="(\/admin\/requests\?[^"]*before=[^"]*)"/)?.[1];
    expect(older).toBeDefined();
    const olderUrl = (older ?? '').replaceAll('&amp;', '&');
    expect(olderUrl).toContain('outcome=denied');

    const second = await (await adminGet(a, session, olderUrl)).text();
    expect(requestLinks(second)).toEqual(newest.slice(50).map((r) => r.id));
    // The last page has no Older link (the pager shows the word as plain faint text).
    expect(second).not.toMatch(/<a [^>]*rel="next"/);
    expect(second).toContain('Newest entries');
    const newer = second.match(/href="(\/admin\/requests\?[^"]*after=[^"]*)"/)?.[1];
    expect(newer).toBeDefined();
    const back = await (await adminGet(a, session, (newer ?? '').replaceAll('&amp;', '&'))).text();
    expect(requestLinks(back)).toEqual(newest.slice(0, 50).map((r) => r.id));
  });

  it('answers 400 with an explanation for invalid filters, and still lists the results', async () => {
    const record = requestRecord(TEST_EPOCH_MS);
    await insertRecords([record]);
    const a = app();
    const session = await loginAs(a, viewer);
    for (const query of ['outcome=bogus', 'before=req_1', 'token=svc_%3Cscript%3E']) {
      const res = await adminGet(a, session, `/admin/requests?${query}`);
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain('class="callout bad errsum"');
      expect(requestLinks(html)).toEqual([record.id]);
      expect(html).not.toContain('<script>');
    }
    const html = await (
      await adminGet(a, session, '/admin/requests?token=svc_%3Cscript%3E')
    ).text();
    // The summary links the "+ Token" menu, rendered open on a list of valid tokens, and the
    // error follows the menus in the filter bar.
    expect(html).toContain('<details class="fadd" id="f-token" open="">');
    expect(html).toContain('<p class="field-error" id="f-token-error">');
    expect(html).toContain('<a href="#f-token">Choose a token from the list.</a>');
  });

  it('never turns filter text into page text (no spoofed option labels)', async () => {
    const a = app();
    const session = await loginAs(a, viewer);
    const spoof = 'Your session expired, sign in at evil.example';
    const res = await adminGet(a, session, `/admin/requests?token=${encodeURIComponent(spoof)}`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).not.toContain(`Deleted credential ${spoof}`);
    expect(html).not.toContain(`>${spoof}<`);

    // A well-formed id of a service that no longer exists keeps its own option.
    const gone = newId('svc', TEST_EPOCH_MS, random);
    const ok = await adminGet(a, session, `/admin/requests?token=${gone}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain(`Deleted credential ${gone}`);
  });

  it('answers 404 for unknown or malformed request ids', async () => {
    const a = app();
    const session = await loginAs(a, viewer);
    const unknown = newId('req', TEST_EPOCH_MS, random);
    expect((await adminGet(a, session, `/admin/requests/${unknown}`)).status).toBe(404);
    expect((await adminGet(a, session, '/admin/requests/not-an-id')).status).toBe(404);
  });

  it('escapes stored values (XSS)', async () => {
    const hostile = '<script>alert(1)</script>';
    const record = requestRecord(TEST_EPOCH_MS, {
      path: `/${hostile}`,
      user_agent: hostile,
      untrusted_iss: `https://evil.example/${hostile}`,
      service_slug: hostile,
    });
    await insertRecords([record]);
    const a = app();
    const session = await loginAs(a, viewer);
    for (const path of ['/admin/requests', `/admin/requests/${record.id}`]) {
      const html = await (await adminGet(a, session, path)).text();
      expect(html).not.toContain(hostile);
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
  });

  it('requires a signed-in user', async () => {
    const a = app();
    const res = await adminGet(a, null, '/admin/requests');
    expect(res.status).toBe(401);
  });

  it('shows the sample weight of sampled allowed records', async () => {
    const record = requestRecord(TEST_EPOCH_MS, {
      outcome: 'allowed',
      reason: null,
      status: 200,
      upstream_status: 200,
      weight: 4,
    });
    await insertRecords([record]);
    const a = app();
    const session = await loginAs(a, owner);
    const html = await (await adminGet(a, session, `/admin/requests/${record.id}`)).text();
    expect(html).toContain('stands for about 4 allowed requests');
  });
});
