// Overview "Top denials": denied records grouped by caller, token and reason, with one action each.
// Text from a token that was not verified never becomes part of a link or a prefilled form.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { insertRequestRecordsStatements } from '../../src/db/requests';
import { denialGroupsStatement } from '../../src/db/rollups';
import type { User } from '../../src/db/types';
import { idLowerBound, newId } from '../../src/lib/ids';
import type { RequestRecord } from '../../src/telemetry/types';
import { adminGet, createUser, loginAs, resetControlPlane } from '../helpers/admin-auth';
import { createTestApp } from '../helpers/app';
import { GITHUB_ISSUER, TEST_EPOCH_MS } from '../helpers/jwt';

const NOW = TEST_EPOCH_MS + 3_600_000;
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

function record(ts: number, overrides: Partial<RequestRecord>): RequestRecord {
  return {
    id: newId('req', ts, random),
    ts,
    outcome: 'denied',
    reason: 'no_matching_grant',
    status: 403,
    upstream_status: null,
    method: 'POST',
    path: '/chat.postMessage',
    service_slug: 'slack',
    service_id: 'svc_01JAAAAAAAAAAAAAAAAAAAAAAA',
    credential_access_rule_id: 'cpr_01JAAAAAAAAAAAAAAAAAAAAAAA',
    grant_id: null,
    claims_verified: 1,
    caller_subject: 'repo:acme/web:ref:refs/heads/main',
    caller_repository: 'acme/web',
    caller_claims: null,
    jti: null,
    untrusted_iss: null,
    eval_trace: null,
    duration_ms: 5,
    upstream_ms: null,
    weight: 1,
    ip: null,
    user_agent: null,
    colo: null,
    ...overrides,
  };
}

const unverified = (ts: number, iss: string): Partial<RequestRecord> => ({
  reason: 'issuer_unknown',
  status: 401,
  service_id: null,
  credential_access_rule_id: null,
  claims_verified: 0,
  caller_subject: null,
  caller_repository: null,
  untrusted_iss: iss,
  ts,
});

async function insert(records: RequestRecord[]): Promise<void> {
  await env.TELEMETRY_DB.batch(insertRequestRecordsStatements(env.TELEMETRY_DB, records));
}

function denials(html: string): string {
  return (
    /<section class="tray" id="denials" aria-labelledby="denials-h">[\s\S]*?<\/section>/.exec(
      html,
    )?.[0] ?? ''
  );
}

let owner: User;
let viewer: User;

beforeEach(async () => {
  await resetControlPlane();
  await env.TELEMETRY_DB.prepare('DELETE FROM request_log').run();
  owner = await createUser({ email: 'owner@example.com', role: 'owner' });
  viewer = await createUser({ email: 'viewer@example.com', role: 'viewer' });
});

describe('I-LOG-2: Top denials', () => {
  it('groups by caller, token and reason, largest first, linking the latest record', async () => {
    const web = [record(NOW - 3000, {}), record(NOW - 2000, {})];
    const api = record(NOW - 1000, { caller_repository: 'acme/api' });
    const tenant = record(NOW - 500, { reason: 'tenant_mismatch', status: 401 });
    await insert([...web, api, tenant]);
    const app = createTestApp({ now: () => NOW });
    const html = denials(await (await adminGet(app, await loginAs(app, owner), '/admin')).text());
    const rows = [
      ...html.matchAll(/<tr><th scope="row">[\s\S]*?<span class="ent-n">([^<]*)</g),
    ].map((m) => m[1]);
    // Two requests first; then the newest of the single ones.
    expect(rows).toEqual(['acme/web', 'acme/web', 'acme/api']);
    expect(html).toContain(`href="/admin/requests/${web[1]?.id}"`);
    expect(html).toContain(`href="/admin/issuer-access-rules/new?from_request=${web[1]?.id}"`);
    expect(html).toContain('Give access<span class="vh"> for acme/web on slack</span>');
    // The count links to exactly that group, and names it for screen readers.
    expect(html).toContain('>2<span class="vh"> denied requests from acme/web to slack</span></a>');
    // tenant_mismatch is not fixable by an access: the action is the list of exactly this group.
    expect(html).toContain(
      'href="/admin/requests?range=24h&amp;outcome=denied&amp;token=svc_01JAAAAAAAAAAAAAAAAAAAAAAA&amp;consumer=cpr_01JAAAAAAAAAAAAAAAAAAAAAAA&amp;reason=tenant_mismatch&amp;repo=acme%2Fweb"',
    );
    expect(html).toContain('href="/admin/requests?range=24h&amp;outcome=denied"');
  });

  it('gives an unverified group no create link and keeps its issuer out of every href', async () => {
    const iss = 'https://evil.example/"><script>';
    await insert([
      record(NOW - 2000, { ...unverified(NOW - 2000, iss), reason: 'no_matching_grant' }),
      record(NOW - 1000, unverified(NOW - 1000, iss)),
    ]);
    const app = createTestApp({ now: () => NOW });
    const html = denials(await (await adminGet(app, await loginAs(app, owner), '/admin')).text());
    expect(html).toContain(
      'Unverified token</span><span class="ctx"><span class="sep" aria-hidden="true">· </span>from <code>https://evil.example/&quot;&gt;&lt;script&gt;</code>',
    );
    expect(html).not.toContain('from_request=');
    expect(html).toContain('href="/admin/credential-access-rules/new">Add credential access rule');
    for (const href of html.matchAll(/href="([^"]*)"/g)) {
      expect(href[1]).not.toContain('evil');
    }
  });

  it('prefills the credential access rule type only when the unverified issuer is exactly a built-in one', async () => {
    await insert([record(NOW - 1000, unverified(NOW - 1000, GITHUB_ISSUER))]);
    const app = createTestApp({ now: () => NOW });
    const html = denials(await (await adminGet(app, await loginAs(app, owner), '/admin')).text());
    expect(html).toContain('href="/admin/credential-access-rules/new?type=github-actions"');
    await env.TELEMETRY_DB.prepare('DELETE FROM request_log').run();
    await insert([record(NOW - 1000, unverified(NOW - 1000, `${GITHUB_ISSUER}/`))]);
    const near = denials(await (await adminGet(app, await loginAs(app, owner), '/admin')).text());
    expect(near).toContain('href="/admin/credential-access-rules/new">');
    expect(near).not.toContain('?type=');
  });

  it('shows viewers the list of requests instead of a form', async () => {
    await insert([record(NOW - 1000, {}), record(NOW - 900, unverified(NOW - 900, GITHUB_ISSUER))]);
    const app = createTestApp({ now: () => NOW });
    const html = denials(await (await adminGet(app, await loginAs(app, viewer), '/admin')).text());
    expect(html).not.toContain('/admin/issuer-access-rules/new');
    expect(html).not.toContain('/admin/credential-access-rules/new');
    expect(html).toContain('See requests');
  });

  it('says when the groups come from the newest 2,000 denials only', async () => {
    const prefix = `${idLowerBound('req', NOW - 60_000).slice(0, 14)}DENY00`;
    await env.TELEMETRY_DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2001)
       INSERT INTO request_log (id, ts, outcome, reason, status, method, path, claims_verified, duration_ms)
       SELECT ?1 || printf('%010d', i), ?2, 'denied', 'token_missing', 401, 'GET', '/', 0, 1 FROM n`,
    )
      .bind(prefix, NOW - 60_000)
      .run();
    const app = createTestApp({ now: () => NOW });
    const html = denials(await (await adminGet(app, await loginAs(app, viewer), '/admin')).text());
    expect(html).toContain('Grouped from the newest 2,000 denials.');
    expect(html).toContain('>2,000<span class="vh"> denied requests from unverified callers');
  });

  it('reads the denials through the partial problems index', async () => {
    // The scan of denialGroupsStatement, explained on its own (the plan of its WITH term).
    expect(denialGroupsStatement(env.TELEMETRY_DB, NOW)).toBeDefined();
    const plan = await env.TELEMETRY_DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM request_log
       WHERE (outcome <> 'allowed' OR status >= 500) AND outcome = 'denied' AND id >= ?
       ORDER BY id DESC LIMIT 2000`,
    )
      .bind('req_0')
      .all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join('\n')).toContain('request_log_problems');
  });
});
