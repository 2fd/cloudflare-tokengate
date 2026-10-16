// Request detail "What to do": a text for every reason code, at most two actions per reason, each
// gated by its permission (others are told whom to ask), the I-CRED-2 out-of-band check in the
// secret texts, and no prefill from text of a token that was not verified (I-LOG-2).
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { NEXT_ACTIONS } from '../../src/admin/routes/requests';
import { REASON_CODES, REASON_GROUPS } from '../../src/admin/views/reasons';
import { insertRequestRecordsStatements } from '../../src/db/requests';
import type { Role, User } from '../../src/db/types';
import { newId } from '../../src/lib/ids';
import type { RequestRecord } from '../../src/telemetry/types';
import { adminGet, createUser, loginAs, resetControlPlane } from '../helpers/admin-auth';
import { createTestApp, type TestApp } from '../helpers/app';
import { GITHUB_ISSUER, TEST_EPOCH_MS } from '../helpers/jwt';
import { resetProxyState, setupProxy } from '../helpers/proxy-fixtures';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const SVC = 'svc_01JAAAAAAAAAAAAAAAAAAAAAAA';

function record(overrides: Partial<RequestRecord>): RequestRecord {
  return {
    id: newId('req', TEST_EPOCH_MS, random),
    ts: TEST_EPOCH_MS,
    outcome: 'error',
    reason: 'credential_missing',
    status: 503,
    upstream_status: null,
    method: 'POST',
    path: '/chat.postMessage',
    service_slug: 'slack',
    service_id: SVC,
    caller_provider_id: null,
    grant_id: null,
    claims_verified: 0,
    caller_subject: null,
    caller_repository: null,
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

let app: TestApp;
const users = new Map<Role, User>();

beforeEach(async () => {
  await resetControlPlane();
  await resetProxyState();
  app = createTestApp({ now: () => TEST_EPOCH_MS + 60_000 });
  users.clear();
  for (const role of ['viewer', 'token_manager', 'access_manager', 'admin', 'owner'] as const) {
    users.set(role, await createUser({ email: `${role}@example.com`, role }));
  }
});

async function detail(r: RequestRecord, role: Role): Promise<string> {
  const user = users.get(role) as User;
  return (await adminGet(app, await loginAs(app, user), `/admin/requests/${r.id}`)).text();
}

function whatToDo(html: string): string {
  return /<section class="next"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
}

describe('NEXT_ACTIONS', () => {
  it('has a text for every reason code, and every code is in exactly one filter group', () => {
    for (const code of REASON_CODES) {
      expect(NEXT_ACTIONS[code]?.text, code).toBeTruthy();
      expect(
        REASON_GROUPS.filter((g) => g.codes.includes(code)),
        code,
      ).toHaveLength(1);
    }
    expect(REASON_GROUPS.flatMap((g) => g.codes).sort()).toEqual([...REASON_CODES].sort());
  });

  it('I-CRED-2: keeps the out-of-band destination check in every secret text', () => {
    for (const code of [
      'credential_missing',
      'credential_binding_mismatch',
      'credential_unavailable',
      'keyring_missing_key',
      'sealed_malformed',
    ]) {
      expect(NEXT_ACTIONS[code]?.text, code).toContain(
        'check the base URL and injection against an out-of-band source',
      );
    }
  });
});

describe('Request detail actions', () => {
  it('gates "Set the secret again" by tokens:write and always offers "Open token"', async () => {
    const r = record({ reason: 'sealed_malformed' });
    await env.TELEMETRY_DB.batch(insertRequestRecordsStatements(env.TELEMETRY_DB, [r]));
    for (const role of ['viewer', 'token_manager', 'access_manager', 'admin', 'owner'] as const) {
      const box = whatToDo(await detail(r, role));
      expect(box, role).toContain(`href="/admin/tokens/${SVC}">Open token</a>`);
      const fix = `href="/admin/tokens/${SVC}?open=destination#destination">Set the secret again</a>`;
      if (role === 'token_manager' || role === 'admin' || role === 'owner') {
        expect(box, role).toContain(fix);
      } else {
        expect(box, role).not.toContain(fix);
        expect(box, role).toContain('Ask a token manager to set the secret again');
      }
      expect(box, role).toContain('out-of-band source');
    }
  });

  it('never prefills from the slug or issuer of a record', async () => {
    const notFound = record({
      reason: 'service_not_found',
      status: 404,
      outcome: 'denied',
      service_id: null,
      service_slug: 'typo-slug',
    });
    const unknown = record({
      reason: 'issuer_unknown',
      status: 401,
      outcome: 'denied',
      service_id: null,
      untrusted_iss: 'https://ci.example.com',
    });
    const github = record({
      reason: 'issuer_unknown',
      status: 401,
      outcome: 'denied',
      service_id: null,
      untrusted_iss: GITHUB_ISSUER,
    });
    await env.TELEMETRY_DB.batch(
      insertRequestRecordsStatements(env.TELEMETRY_DB, [notFound, unknown, github]),
    );
    const nf = whatToDo(await detail(notFound, 'owner'));
    expect(nf).toContain('href="/admin/requests?slug=typo-slug">Requests to this slug</a>');
    expect(nf).toContain('href="/admin/tokens/new">Add a service token</a>');
    const un = await detail(unknown, 'owner');
    expect(whatToDo(un)).toContain('href="/admin/consumers/new">Add a service consumer</a>');
    expect(un).toContain('<code>https://ci.example.com</code>');
    expect(un).not.toMatch(/href="[^"]*ci\.example\.com/);
    expect(whatToDo(await detail(github, 'owner'))).toContain(
      'href="/admin/consumers/new?type=github-actions">Add a service consumer</a>',
    );
    expect(whatToDo(await detail(github, 'token_manager'))).toContain(
      'Ask an access manager to add a service consumer',
    );
  });

  it('links caller-side reasons to the error reference', async () => {
    const r = record({ reason: 'token_missing', status: 401, outcome: 'denied', service_id: null });
    await env.TELEMETRY_DB.batch(insertRequestRecordsStatements(env.TELEMETRY_DB, [r]));
    expect(whatToDo(await detail(r, 'viewer'))).toContain('docs/errors.md#token_missing');
  });

  it('has a descriptive title and breadcrumbs', async () => {
    const r = record({});
    await env.TELEMETRY_DB.batch(insertRequestRecordsStatements(env.TELEMETRY_DB, [r]));
    const html = await detail(r, 'viewer');
    expect(html).toContain('<title>Error: POST /chat.postMessage – Monitoring – tokengate</title>');
    expect(html).toContain('<nav aria-label="Breadcrumb" class="breadcrumb">');
    expect(html).toContain(`aria-current="page">${r.id}</a>`);
  });
});

describe('I-LOG-2: Give access from this request', () => {
  it('is offered for a verified denial and hidden once the re-evaluation says allowed', async () => {
    const fixture = await setupProxy({ grant: { rules: [{ methods: ['GET'], path: '/ok/**' }] } });
    const owner = await createUser({ email: 'own2@example.com', role: 'owner' });
    expect((await fixture.call('/other', { method: 'POST' })).status).toBe(403);
    const denial = (await fixture.records()).find((r) => r.reason === 'no_matching_grant');
    const session = await loginAs(fixture.app, owner);
    const before = await (
      await adminGet(fixture.app, session, `/admin/requests/${denial?.id}`)
    ).text();
    expect(before).toContain(
      `href="/admin/access/new?from_request=${denial?.id}">Give access from this request</a>`,
    );
    await fixture.addGrant({ rules: [{ methods: ['POST'], path: '/other' }] });
    const after = await (
      await adminGet(fixture.app, session, `/admin/requests/${denial?.id}`)
    ).text();
    expect(after).toContain('<b>allowed</b>');
    expect(after).not.toContain('from_request=');
  });
});
