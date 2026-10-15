// I-CRED-1, I-LOG-1, I-TOK-1 end to end: every upstream credential and every caller token carries a
// unique canary; the test drives allowed, denied and error proxy paths, upstream redirects and
// echoes, timeouts, credential verify/test, export and every admin page, and then searches every
// sink (responses, console, both D1 databases, queue and pipeline payloads) for any encoding of
// any canary. services.credential_sealed is the only place a credential may live.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTE_PERMISSIONS } from '../../src/admin/auth/rbac';
import type { Injection } from '../../src/policy/types';
import { runCron } from '../../src/telemetry/cron';
import { consumeRequestLogBatch } from '../../src/telemetry/queue-consumer';
import type { ArchiveRecord, RequestRecord } from '../../src/telemetry/types';
import { resetAdminWorld } from '../fixtures/admin-forms';
import { type AdminSession, adminGet, adminPost, createUser, loginAs } from '../helpers/admin-auth';
import {
  createTestIssuer,
  GITHUB_ISSUER,
  githubClaims,
  TEST_AUDIENCE,
  type TestIssuer,
} from '../helpers/jwt';
import {
  type ProxyFixture,
  setupProxy,
  TEST_KEK,
  type UpstreamCall,
} from '../helpers/proxy-fixtures';

// ---------------------------------------------------------------------------------------------
// Canaries and the detector.

const rand = () => crypto.randomUUID().replaceAll('-', '').slice(0, 20);
/** Includes characters that URL encoding changes (+ = @), so encoded copies differ from raw. */
const credentialCanary = (label: string) => `cnry${label}${rand()}+Q=Z@x`;

interface Canary {
  label: string;
  value: string;
}

/** Raw, URL-encoded (upper/lower hex, form) and base64/base64url at every 3-byte alignment. */
function encodings(value: string): string[] {
  const out = new Set<string>([value]);
  const encoded = encodeURIComponent(value);
  out.add(encoded);
  out.add(encoded.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()));
  out.add(new URLSearchParams({ v: value }).toString().slice(2));
  for (let shift = 0; shift < 3; shift++) {
    const b64 = btoa('\0'.repeat(shift) + value);
    // Drop the groups that mix in neighbouring bytes; what is left is pure canary.
    const core = b64.slice(shift === 0 ? 0 : 4, -4);
    out.add(core);
    out.add(core.replaceAll('+', '-').replaceAll('/', '_'));
  }
  return [...out].filter((needle) => needle.length >= 16);
}

interface Hit {
  canary: string;
  sink: string;
  needle: string;
}

function findCanaries(canaries: Canary[], sink: string, haystack: string): Hit[] {
  const hits: Hit[] = [];
  for (const canary of canaries) {
    for (const needle of encodings(canary.value)) {
      if (haystack.includes(needle)) hits.push({ canary: canary.label, sink, needle });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// Sinks.

interface CapturedResponse {
  what: string;
  text: string;
}

let responses: CapturedResponse[];
let consoleLines: string[];
let queued: RequestRecord[];
let archived: ArchiveRecord[];

async function capture(what: string, response: Response): Promise<Response> {
  const headers = [...response.headers].map(([name, value]) => `${name}: ${value}`);
  const body = await response.clone().text();
  responses.push({
    what,
    text: [`${response.status} ${response.statusText}`, ...headers, '', body].join('\n'),
  });
  return response;
}

/** Every row of every table of both databases; services.credential_sealed is removed. */
async function dumpDatabases(): Promise<Array<{ sink: string; text: string }>> {
  const out: Array<{ sink: string; text: string }> = [];
  for (const [name, db] of [
    ['DB', env.DB],
    ['TELEMETRY_DB', env.TELEMETRY_DB],
  ] as const) {
    const { results: tables } = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .all<{ name: string }>();
    for (const { name: table } of tables) {
      const { results } = await db
        .prepare(`SELECT * FROM "${table}"`)
        .all<Record<string, unknown>>();
      const rows = results.map((row) => {
        if (table !== 'services') return row;
        const { credential_sealed: _sealed, ...rest } = row;
        return rest;
      });
      out.push({ sink: `${name}.${table}`, text: JSON.stringify(rows) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fake upstream. Echoes whatever carries the credential (authorization, x-api-key, the URL) in
// the places a careless or hostile upstream would: headers, redirects, Link, status text.

function carriers(call: UpstreamCall): string[] {
  return [call.headers.get('authorization'), call.headers.get('x-api-key'), call.url].filter(
    (value): value is string => value !== null && value !== '',
  );
}

function upstreamPath(call: UpstreamCall): string {
  return new URL(call.url).pathname;
}

const echoUpstream = (call: UpstreamCall): Response | Promise<Response> => {
  const path = upstreamPath(call);
  const seen = carriers(call);
  const [first = ''] = seen;
  if (path.endsWith('/network')) {
    throw new TypeError(`connect ECONNREFUSED ${call.url} ${seen.join(' ')}`);
  }
  if (path.endsWith('/hang')) {
    return new Promise<Response>((_, reject) => {
      call.signal?.addEventListener('abort', () =>
        reject(new DOMException(`aborted ${call.url} ${seen.join(' ')}`, 'AbortError')),
      );
    });
  }
  if (path.endsWith('/echo-headers')) {
    const headers = new Headers({ 'content-type': 'application/json' });
    seen.forEach((value, i) => {
      headers.set(`x-echo-${i}`, value);
      headers.set(`x-echo-enc-${i}`, encodeURIComponent(value));
    });
    headers.append('set-cookie', `session=${encodeURIComponent(first)}; Path=/`);
    headers.set('www-authenticate', `Bearer error="invalid_token", token="${first}"`);
    headers.set('x-request-url', call.url);
    return new Response('{"ok":true}', { status: 200, headers });
  }
  if (path.endsWith('/redirect-same')) {
    const self = new URL(call.url);
    self.pathname += '/next';
    return new Response(null, {
      status: 302,
      headers: {
        location: self.href,
        link: `<${self.href}>; rel="next", <https://elsewhere.test/p?c=${encodeURIComponent(first)}>; rel="prev"`,
        'content-location': call.url,
      },
    });
  }
  if (path.endsWith('/redirect-cross')) {
    return new Response(null, {
      status: 307,
      headers: {
        location: `https://evil.test/cb?leak=${encodeURIComponent(first)}&u=${encodeURIComponent(call.url)}`,
        refresh: `0; url=${call.url}`,
      },
    });
  }
  if (path.endsWith('/status-text')) {
    return new Response('{"error":"unauthorized"}', {
      status: 401,
      statusText: `Unauthorized ${first}`.replace(/[^\x21-\x7e ]/g, ''),
      headers: { 'content-type': 'application/json' },
    });
  }
  if (path.endsWith('/echo-base64')) {
    return new Response('{"ok":true}', { status: 200, headers: { 'x-debug-auth': btoa(first) } });
  }
  if (path.endsWith('/verify')) {
    // Admin verify/test: the body echoes the credential (the preview must mask it).
    const failing = seen.some((value) => value.includes('rotatedfail'));
    return new Response(JSON.stringify({ ok: !failing, seen, url: call.url }), {
      status: failing ? 401 : 200,
      headers: { 'content-type': 'application/json', 'x-echo': first },
    });
  }
  return Response.json({ ok: true }, { status: 200 });
};

// ---------------------------------------------------------------------------------------------
// Scenario.

interface ServiceSpec {
  slug: string;
  injection: Injection;
  /** Value stored as the credential. */
  stored: (canary: string) => string;
  timeoutMs?: number;
}

const SERVICE_SPECS: ServiceSpec[] = [
  { slug: 'svc-bearer', injection: { kind: 'bearer' }, stored: (c) => c },
  { slug: 'svc-header', injection: { kind: 'header', name: 'x-api-key' }, stored: (c) => c },
  {
    slug: 'svc-header-prefix',
    injection: { kind: 'header', name: 'x-api-key', prefix: 'Key ' },
    stored: (c) => c,
  },
  { slug: 'svc-basic', injection: { kind: 'basic', username: 'api' }, stored: (c) => c },
  { slug: 'svc-basic-userpass', injection: { kind: 'basic' }, stored: (c) => `acct:${c}` },
  { slug: 'svc-query', injection: { kind: 'query', param: 'key' }, stored: (c) => c },
  { slug: 'svc-path', injection: { kind: 'path', prefix: '/bot' }, stored: (c) => c },
  { slug: 'svc-slow', injection: { kind: 'bearer' }, stored: (c) => c, timeoutMs: 50 },
];

let fx: ProxyFixture;
let credentials: Canary[];
let tokens: Canary[];
let serviceIds: Map<string, string>;
let foreignIssuer: TestIssuer;
let impostorIssuer: TestIssuer;
let owner: AdminSession;

/** Signs a caller token whose payload carries a unique canary claim; tracks token and claim. */
async function callerToken(
  overrides: Record<string, unknown> = {},
  issuer?: TestIssuer,
  options?: Parameters<TestIssuer['sign']>[1],
): Promise<string> {
  const claimCanary = `claimcnry${rand()}`;
  const token = await (issuer ?? fx.issuer).sign(
    githubClaims({ tg_canary: claimCanary, ...overrides }),
    options,
  );
  const [, payload = '', signature = ''] = token.split('.');
  const label = `token#${tokens.length / 4}`;
  tokens.push(
    { label: `${label}.jws`, value: token },
    { label: `${label}.payload`, value: payload },
    { label: `${label}.signature`, value: signature },
    { label: `${label}.claim`, value: claimCanary },
  );
  return token;
}

async function proxy(
  what: string,
  slug: string,
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<Response> {
  const token = init.token === undefined ? await callerToken() : init.token;
  return capture(`proxy ${what}`, await fx.call(path, { ...init, slug, token }));
}

beforeEach(async () => {
  await resetAdminWorld();
  responses = [];
  consoleLines = [];
  queued = [];
  archived = [];
  tokens = [];
  credentials = [];
  serviceIds = new Map();
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleLines.push(
        args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
      );
    });
  }

  fx = await setupProxy({
    grant: false,
    upstream: echoUpstream,
    env: {
      REQUEST_LOG_QUEUE: {
        send: async (record: RequestRecord) => void queued.push(structuredClone(record)),
        sendBatch: async (batch: Array<{ body: RequestRecord }>) =>
          void queued.push(...batch.map((m) => structuredClone(m.body))),
      },
      REQUEST_ARCHIVE: {
        send: async (records: ArchiveRecord[]) => void archived.push(...structuredClone(records)),
      },
    } as never,
  });
  // setupProxy always creates one service; it gets a grant and a canary like the others.
  await env.DB.prepare('DELETE FROM services').run();
  for (const spec of SERVICE_SPECS) {
    const canary = credentialCanary(spec.slug.replace('svc-', ''));
    credentials.push({ label: spec.slug, value: canary });
    const { id } = await fx.addService({
      slug: spec.slug,
      injection: spec.injection,
      secret: spec.stored(canary),
      timeoutMs: spec.timeoutMs,
    });
    serviceIds.set(spec.slug, id);
    await fx.addGrant({ serviceId: id });
  }
  const noCredential = await fx.addService({ slug: 'svc-nocred', secret: null });
  await fx.addGrant({ serviceId: noCredential.id });
  // Sealed for one base URL, then repointed in D1: the AAD no longer matches (I-CRED-2).
  const tamperedCanary = credentialCanary('tampered');
  credentials.push({ label: 'svc-tampered', value: tamperedCanary });
  const tampered = await fx.addService({ slug: 'svc-tampered', secret: tamperedCanary });
  await fx.addGrant({ serviceId: tampered.id });
  await env.DB.prepare("UPDATE services SET base_url = 'https://api.other.test/v1' WHERE id = ?")
    .bind(tampered.id)
    .run();

  foreignIssuer = await createTestIssuer({ issuer: 'https://unknown-issuer.example' });
  // Same issuer and kid as the configured one, different key: signature_invalid.
  impostorIssuer = await createTestIssuer({ issuer: GITHUB_ISSUER, now: fx.clock.now });

  const user = await createUser({ email: 'owner@example.com', role: 'owner' });
  owner = await loginAs(fx.app, user);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function driveProxy(): Promise<void> {
  // Allowed, through each accepted token source.
  for (const spec of SERVICE_SPECS.filter((s) => s.slug !== 'svc-slow')) {
    expect((await proxy('ok', spec.slug, '/ok')).status, spec.slug).toBe(200);
    const bearer = await callerToken();
    await proxy('authorization bearer', spec.slug, '/ok', {
      token: null,
      headers: { authorization: `Bearer ${bearer}` },
    });
    const scheme = await callerToken();
    await proxy('authorization token', spec.slug, '/ok', {
      token: null,
      headers: { authorization: `token ${scheme}` },
    });
    for (const path of ['/echo-headers', '/redirect-same', '/redirect-cross']) {
      await proxy(path, spec.slug, `${path}?q=1`);
    }
    await proxy('network error', spec.slug, '/network');
  }
  // The token in the service's own injection header (no standard token header present).
  const inHeader = await callerToken();
  expect(
    (
      await proxy('token in injection header', 'svc-header', '/ok', {
        token: null,
        headers: { 'x-api-key': inHeader },
      })
    ).status,
  ).toBe(200);

  // Errors.
  expect((await proxy('timeout', 'svc-slow', '/hang')).status).toBe(504);
  expect((await proxy('no credential', 'svc-nocred', '/ok')).status).toBe(503);
  expect((await proxy('binding mismatch', 'svc-tampered', '/ok')).status).toBe(503);

  // Denied: pre-trust and post-trust.
  const ambiguousA = await callerToken();
  const ambiguousB = await callerToken();
  expect(
    (
      await proxy('ambiguous', 'svc-bearer', '/ok', {
        token: ambiguousA,
        headers: { authorization: `Bearer ${ambiguousB}` },
      })
    ).status,
  ).toBe(400);
  const junk = `${credentialCanary('junkhdr')}.${credentialCanary('junkpayload')}.sig`;
  tokens.push({ label: 'junk token', value: junk });
  await proxy('malformed', 'svc-bearer', '/ok', { token: junk });
  expect(
    (
      await proxy('unknown issuer', 'svc-bearer', '/ok', {
        token: await callerToken({}, foreignIssuer),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await proxy('bad signature', 'svc-bearer', '/ok', {
        token: await callerToken({}, impostorIssuer),
      })
    ).status,
  ).toBe(401);
  const nowSeconds = Math.floor(fx.clock.now() / 1000);
  expect(
    (
      await proxy('expired', 'svc-bearer', '/ok', {
        token: await callerToken({}, undefined, { iat: nowSeconds - 1200, exp: nowSeconds - 900 }),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await proxy('audience', 'svc-bearer', '/ok', {
        token: await callerToken({ aud: `${TEST_AUDIENCE}-other` }),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await proxy('tenant', 'svc-bearer', '/ok', {
        token: await callerToken({ repository_owner_id: '999' }),
      })
    ).status,
  ).toBe(401);
  expect((await proxy('missing token', 'svc-bearer', '/ok', { token: null })).status).toBe(401);
  expect((await proxy('unknown service', 'svc-nope', '/ok')).status).toBe(404);
  expect((await proxy('path traversal', 'svc-bearer', '/a/..%2fb')).status).toBe(400);
  expect(
    (
      await proxy('no grant', 'svc-bearer', '/ok', {
        token: await callerToken({ repository_id: '1' }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await proxy('untrusted event', 'svc-bearer', '/ok', {
        token: await callerToken({ event_name: 'pull_request_target' }),
      })
    ).status,
  ).toBe(403);
  expect((await proxy('method', 'svc-bearer', '/ok', { method: 'PROPFIND' })).status).toBe(405);

  // Telemetry delivery: the queue consumer writes what the producer sent.
  await fx.app.settle();
  await consumeRequestLogBatch(fakeBatch(queued), fx.app.deps);
}

function fakeBatch(records: RequestRecord[]): MessageBatch<unknown> {
  return {
    queue: 'tokengate-request-log',
    messages: records.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => {},
      retry: () => {},
    })),
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<unknown>;
}

async function admin(what: string, path: string): Promise<Response> {
  return capture(`admin GET ${what}`, await adminGet(fx.app, owner, path));
}

async function adminForm(
  what: string,
  path: string,
  fields: Record<string, string>,
): Promise<Response> {
  return capture(`admin POST ${what}`, await adminPost(fx.app, owner, path, fields));
}

async function driveAdmin(): Promise<void> {
  const verify = { verify_method: 'GET', verify_path: '/verify', verify_expect_status: '200' };
  const created = credentialCanary('formcreate');
  const rotated = credentialCanary('rotatedfail');
  credentials.push(
    { label: 'form create', value: created },
    { label: 'form rotate (verify fails)', value: rotated },
  );
  const serviceForm = {
    slug: 'svc-form',
    name: 'Form service',
    description: '',
    base_url: 'https://api.formupstream.test/v2',
    injection_kind: 'bearer',
    forward_headers: '',
    timeout_ms: '60000',
    ...verify,
    credential: created,
  };
  // Rejected create: the form is re-rendered, the credential is not.
  expect(
    (await adminForm('create invalid', '/admin/tokens', { ...serviceForm, slug: '-' })).status,
  ).toBe(400);
  const createdRes = await adminForm('create', '/admin/tokens', serviceForm);
  expect(createdRes.status).toBe(303);
  const formServiceId = /svc_[0-9A-Z]{26}/.exec(createdRes.headers.get('location') ?? '')?.[0];
  expect(formServiceId).toBeDefined();
  serviceIds.set('svc-form', formServiceId ?? '');

  const credentialForm = {
    base_url: 'https://api.formupstream.test/v2',
    injection_kind: 'bearer',
    credential: rotated,
  };
  const path = `/admin/tokens/${formServiceId}`;
  expect(
    (await adminForm('credential verify fails', `${path}/credential`, credentialForm)).status,
  ).toBe(422);
  expect(
    (
      await adminForm('credential save anyway', `${path}/credential`, {
        ...credentialForm,
        save_anyway: '1',
      })
    ).status,
  ).toBe(303);
  expect((await adminForm('test (fails, echoes)', `${path}/test`, {})).status).toBe(200);

  // Verify configured on a proxy service whose upstream echoes the credential in body and header.
  const bearerId = serviceIds.get('svc-bearer') ?? '';
  await env.DB.prepare('UPDATE services SET verify = ? WHERE id = ?')
    .bind(JSON.stringify({ method: 'GET', path: '/verify', expect_status: 200 }), bearerId)
    .run();
  expect(
    (await adminForm('test (passes, echoes)', `/admin/tokens/${bearerId}/test`, {})).status,
  ).toBe(200);
  // An expiring credential produces a cron audit event that names the service.
  await env.DB.prepare('UPDATE services SET credential_expires_at = ? WHERE id = ?')
    .bind(fx.clock.now() + 2 * 86_400_000, bearerId)
    .run();
  await runCron(fx.app.deps);
  expect((await adminForm('rewrap', '/admin/tokens/keys/rewrap', {})).status).toBe(303);

  // Every read page of the RBAC table, with every seeded id, plus query variants.
  const { results: requestRows } = await env.TELEMETRY_DB.prepare(
    'SELECT id FROM request_log ORDER BY id',
  ).all<{ id: string }>();
  expect(requestRows.length).toBeGreaterThan(20);
  const { results: grantRows } = await env.DB.prepare('SELECT id FROM grants').all<{
    id: string;
  }>();
  const { results: userRows } = await env.DB.prepare('SELECT id FROM users').all<{ id: string }>();
  // Seeded ids (or full URLs) per `:id` route, one block per admin section.
  const ids: Record<string, string[]> = {
    // == monitoring ==
    '/admin/requests/:id': requestRows.flatMap((row) => [
      `/admin/requests/${row.id}`,
      `/admin/requests/${row.id}?reevaluate=1`,
    ]),
    // == users ==
    '/admin/users/:id': userRows.map((row) => row.id),
    // == tokens ==
    '/admin/tokens/:id': [...serviceIds.values()],
    // == consumers ==
    '/admin/consumers/:id': [fx.providerId],
    '/admin/access/:id': grantRows.map((row) => row.id),
  };
  for (const key of Object.keys(ROUTE_PERMISSIONS)) {
    if (!key.startsWith('GET ')) continue;
    const pattern = key.slice(4);
    if (!pattern.includes(':')) {
      expect((await admin(pattern, pattern)).status, pattern).toBe(200);
      continue;
    }
    const values = ids[pattern];
    expect(values, `no ids for ${pattern}`).toBeDefined();
    for (const value of values ?? []) {
      const url = value.startsWith('/') ? value : pattern.replace(':id', value);
      expect((await admin(pattern, url)).status, url).toBe(200);
    }
  }
  // Query variants of the read pages, one array per admin section (append to your own only).
  const monitoringVariants = [
    '/admin/requests?outcome=denied',
    '/admin/requests?outcome=error',
    '/admin/audit?target_type=service',
  ];
  const usersVariants = [
    '/admin/users?role=owner',
    '/admin/users?status=expired',
    '/admin/users?q=owner',
    '/admin/users?notice=invited',
  ];
  const tokensVariants = ['/admin/tokens/new?template=github'];
  const consumersVariants = requestRows.map((row) => `/admin/access/new?from_request=${row.id}`);
  for (const url of [
    ...monitoringVariants,
    ...usersVariants,
    ...tokensVariants,
    ...consumersVariants,
  ]) {
    expect((await admin(url, url)).status, url).toBeLessThan(500);
  }
  // Login pages render the configured login provider (not its secret).
  await capture('auth login', await fx.app.request('/auth/login'));
  await capture(
    'auth github start',
    await fx.app.request('/auth/github/start', { redirect: 'manual' }),
  );
}

describe('I-CRED-1 / I-LOG-1 / I-TOK-1: no credential or caller token reaches any sink', () => {
  it('the detector finds raw, URL-encoded and embedded base64 copies (positive control)', () => {
    const canary = { label: 'c', value: credentialCanary('control') };
    for (const prefix of ['', 'a', 'ab', 'Basic api:']) {
      expect(findCanaries([canary], 'b64', `x ${btoa(prefix + canary.value)} y`)).not.toEqual([]);
    }
    expect(findCanaries([canary], 'url', `?k=${encodeURIComponent(canary.value)}`)).not.toEqual([]);
    expect(findCanaries([canary], 'raw', `"${canary.value}"`)).not.toEqual([]);
    expect(findCanaries([canary], 'none', 'nothing here')).toEqual([]);
  });

  it('responses, console, both databases and telemetry payloads never contain one', async () => {
    await driveProxy();
    await driveAdmin();
    await fx.app.settle();

    // The scenario really carried each credential upstream and recorded the traffic.
    const outbound = JSON.stringify(fx.upstreamCalls.map((call) => [call.url, [...call.headers]]));
    for (const spec of SERVICE_SPECS) {
      const canary = credentials.find((c) => c.label === spec.slug);
      expect(findCanaries([canary as Canary], 'outbound', outbound), spec.slug).not.toEqual([]);
    }
    expect(queued.length).toBeGreaterThan(20);
    expect(archived).toHaveLength(queued.length);
    expect(tokens.length).toBeGreaterThan(100);
    expect(findCanaries(tokens, 'outbound', outbound)).toEqual([]);

    const canaries = [
      ...credentials,
      ...tokens,
      { label: 'KEK', value: TEST_KEK },
      // The admin's Access JWT is a bearer credential for the console (I-SESS-1).
      { label: 'admin Access JWT', value: owner.assertion },
    ];
    const hits: Hit[] = [];
    for (const response of responses)
      hits.push(...findCanaries(canaries, response.what, response.text));
    hits.push(...findCanaries(canaries, 'console', consoleLines.join('\n')));
    for (const dump of await dumpDatabases())
      hits.push(...findCanaries(canaries, dump.sink, dump.text));
    hits.push(...findCanaries(canaries, 'queue', JSON.stringify(queued)));
    hits.push(...findCanaries(canaries, 'pipeline', JSON.stringify(archived)));

    const summary = [...new Set(hits.map((hit) => `${hit.sink} <- ${hit.canary}`))];
    expect(summary).toEqual([]);

    // The echoes really happened and were redacted rather than never produced.
    const echoes = responses.filter((r) => r.what === 'proxy /echo-headers');
    expect(echoes).toHaveLength(SERVICE_SPECS.length - 1);
    for (const echo of echoes) expect(echo.text).toMatch(/^x-tokengate-redacted: .*x-echo-0/m);
  });
});

/** Proxies `path` once per credential-carrying service and returns the canaries in responses. */
async function responseLeaks(path: string): Promise<string[]> {
  for (const spec of SERVICE_SPECS.filter((s) => s.slug !== 'svc-slow')) {
    await proxy(path, spec.slug, path);
  }
  const hits = responses.flatMap((r) => findCanaries(credentials, r.what, r.text));
  return [...new Set(hits.map((hit) => hit.canary))];
}

// An upstream answering e.g. "401 Unauthorized Bearer <credential>": the reason phrase is
// upstream-controlled and is never forwarded (src/proxy/handler.ts step 15).
describe('I-CRED-1: upstream status text echoing the credential', () => {
  it('is not passed through to the caller', async () => {
    expect(await responseLeaks('/status-text')).toEqual([]);
  });
});

// An upstream echoing base64("Bearer <credential>") in a header: redaction matches base64 and
// base64url copies of the credential at any byte alignment (secretVariants in src/proxy/inject.ts).
describe('I-CRED-1: upstream header echoing the credential base64-encoded', () => {
  it('is redacted', async () => {
    expect(await responseLeaks('/echo-base64')).toEqual([]);
  });
});
