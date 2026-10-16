// End-to-end proxy fixture: a real app over D1 with one caller provider (GitHub issuer by default),
// one service with a sealed credential and one grant, plus a fake upstream that records what it
// received. No network: issuer JWKS and upstream are served through the injected fetch.
import { env } from 'cloudflare:workers';
import { credentialAad, sealCredential } from '../../src/crypto/envelope';
import { type KeyringEnv, loadKeyring } from '../../src/crypto/keyring';
import { listRequests } from '../../src/db/requests';
import type { AppEnv } from '../../src/env';
import { resetJwksCacheForTests } from '../../src/identity/jwt';
import type { ProfileId } from '../../src/identity/types';
import { toBase64 } from '../../src/lib/encoding';
import { newId } from '../../src/lib/ids';
import { canonicalJson } from '../../src/lib/json';
import type { Condition, Injection, Rule } from '../../src/policy/types';
import { resetPretrustBudgetForTests } from '../../src/telemetry/sinks';
import type { RequestRecord } from '../../src/telemetry/types';
import { createTestApp, type TestApp } from './app';
import {
  createClock,
  createTestIssuer,
  GITHUB_ISSUER,
  githubClaims,
  TEST_AUDIENCE,
  TEST_GITHUB_OWNER_ID,
  TEST_GITHUB_REPOSITORY_ID,
  type TestIssuer,
} from './jwt';

export const TEST_SECRET = 'sk-test-SECRET-0123456789abcdefXYZ';
export const TEST_BASE_URL = 'https://api.upstream.test/v1';
/** Fixed test KEK (32 bytes); only ever used in tests. */
export const TEST_KEK = toBase64(new Uint8Array(32).map((_, i) => i + 1));

export interface UpstreamCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
  redirect: RequestInit['redirect'];
  signal: AbortSignal | null | undefined;
}

export type UpstreamHandler = (call: UpstreamCall) => Response | Promise<Response>;

export interface ServiceSeed {
  slug?: string;
  baseUrl?: string;
  injection?: Injection;
  secret?: string | null;
  forwardHeaders?: string[];
  enabled?: boolean;
  timeoutMs?: number;
}

export interface GrantSeed {
  conditions?: Condition[];
  rules?: Rule[];
  enabled?: boolean;
  expiresAt?: number | null;
  callerProviderId?: string;
  serviceId?: string;
}

export interface ProxyFixtureOptions {
  service?: ServiceSeed;
  /** false: no grant is created. */
  grant?: GrantSeed | false;
  tenantPin?: Condition[];
  profile?: ProfileId;
  upstream?: UpstreamHandler;
  env?: Partial<AppEnv> & Record<string, unknown>;
}

export interface ProxyFixture {
  app: TestApp;
  clock: ReturnType<typeof createClock>;
  issuer: TestIssuer;
  providerId: string;
  serviceId: string;
  grantId: string | null;
  slug: string;
  /** Requests that reached the fake upstream. */
  upstreamCalls: UpstreamCall[];
  setUpstream(handler: UpstreamHandler): void;
  /** Signs GitHub claims (githubClaims + overrides) with the fixture issuer. */
  token(overrides?: Record<string, unknown>): Promise<string>;
  /** Calls `/proxy/<slug><path>`. Sends a fresh valid token in x-tokengate-token unless `token` is
   * null or the headers already carry that header. */
  call(
    path: string,
    init?: RequestInit & { token?: string | null; slug?: string },
  ): Promise<Response>;
  /** Settles background work and returns stored request records, newest first. */
  records(): Promise<RequestRecord[]>;
  addService(seed: ServiceSeed): Promise<{ id: string; slug: string }>;
  addGrant(seed: GrantSeed): Promise<string>;
}

export const DEFAULT_CONDITIONS: Condition[] = [
  { claim: 'repository_owner_id', match: 'exact', values: [TEST_GITHUB_OWNER_ID] },
  { claim: 'repository_id', match: 'exact', values: [TEST_GITHUB_REPOSITORY_ID] },
];
export const DEFAULT_RULES: Rule[] = [{ methods: ['*'], path: '/**' }];

const db = () => env.DB;

export async function resetProxyState(): Promise<void> {
  resetJwksCacheForTests();
  resetPretrustBudgetForTests();
  await db().batch([
    db().prepare('DELETE FROM grants'),
    db().prepare('DELETE FROM services'),
    db().prepare('DELETE FROM caller_providers'),
    db().prepare('DELETE FROM settings'),
  ]);
  await env.TELEMETRY_DB.prepare('DELETE FROM request_log').run();
}

export async function setupProxy(options: ProxyFixtureOptions = {}): Promise<ProxyFixture> {
  await resetProxyState();
  const clock = createClock();
  const issuer = await createTestIssuer({ issuer: GITHUB_ISSUER, now: clock.now });
  const upstreamCalls: UpstreamCall[] = [];
  let upstream: UpstreamHandler =
    options.upstream ?? (() => Response.json({ ok: true }, { status: 200 }));

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(issuer.issuer)) return issuer.fetch(input, init);
    const request = new Request(url, init);
    const call: UpstreamCall = {
      url,
      method: request.method,
      headers: new Headers(request.headers),
      body: request.body ? await request.text() : null,
      redirect: init?.redirect,
      signal: init?.signal,
    };
    upstreamCalls.push(call);
    return upstream(call);
  };

  const app = createTestApp({
    fetch: fetchImpl,
    now: clock.now,
    env: { TOKENGATE_KEK: TEST_KEK, ...options.env },
  });
  const now = clock.now();
  const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

  const providerId = newId('cpr', now, random);
  const profile = options.profile ?? 'github-actions';
  await db()
    .prepare(
      `INSERT INTO caller_providers (id, name, profile, issuer, jwks_uri, audience, allowed_algs,
         max_token_age_seconds, tenant_pin, anchor_claims, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 600, ?, '[]', 1, ?, ?)`,
    )
    .bind(
      providerId,
      'GitHub Actions',
      profile,
      issuer.issuer,
      issuer.jwksUri,
      TEST_AUDIENCE,
      JSON.stringify([issuer.alg]),
      JSON.stringify(
        options.tenantPin ?? [
          { claim: 'repository_owner_id', match: 'exact', values: [TEST_GITHUB_OWNER_ID] },
        ],
      ),
      now,
      now,
    )
    .run();

  const addService = async (seed: ServiceSeed) => {
    const id = newId('svc', clock.now(), random);
    const slug = seed.slug ?? 'echo';
    const baseUrl = seed.baseUrl ?? TEST_BASE_URL;
    const injectionJson = canonicalJson(seed.injection ?? { kind: 'bearer' });
    const secret = seed.secret === undefined ? TEST_SECRET : seed.secret;
    const sealed =
      secret === null ? null : await sealFor(app.deps.env, id, baseUrl, injectionJson, secret);
    await db()
      .prepare(
        `INSERT INTO services (id, slug, name, base_url, injection, forward_headers, timeout_ms,
           credential_sealed, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        slug,
        slug,
        baseUrl,
        injectionJson,
        JSON.stringify(seed.forwardHeaders ?? []),
        seed.timeoutMs ?? 120000,
        sealed,
        seed.enabled === false ? 0 : 1,
        clock.now(),
        clock.now(),
      )
      .run();
    return { id, slug };
  };

  let grantSeq = 0;
  const addGrant = async (seed: GrantSeed) => {
    const id = newId('grt', clock.now(), random);
    grantSeq++;
    await db()
      .prepare(
        `INSERT INTO grants (id, name, caller_provider_id, service_id, conditions, rules, enabled,
           expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        `grant ${grantSeq}`,
        seed.callerProviderId ?? providerId,
        seed.serviceId ?? service.id,
        JSON.stringify(seed.conditions ?? DEFAULT_CONDITIONS),
        JSON.stringify(seed.rules ?? DEFAULT_RULES),
        seed.enabled === false ? 0 : 1,
        seed.expiresAt ?? null,
        clock.now() + grantSeq,
        clock.now() + grantSeq,
      )
      .run();
    return id;
  };

  const service = await addService(options.service ?? {});
  const grantId = options.grant === false ? null : await addGrant(options.grant ?? {});

  return {
    app,
    clock,
    issuer,
    providerId,
    serviceId: service.id,
    grantId,
    slug: service.slug,
    upstreamCalls,
    setUpstream(handler) {
      upstream = handler;
    },
    token: (overrides = {}) => issuer.sign(githubClaims(overrides)),
    async call(path, init = {}) {
      const { token, slug = service.slug, headers, ...rest } = init;
      const merged = new Headers(headers);
      const value = token === undefined ? await issuer.sign(githubClaims()) : token;
      if (value !== null && !merged.has('x-tokengate-token')) {
        merged.set('x-tokengate-token', value);
      }
      return app.request(`/proxy/${slug}${path}`, { ...rest, headers: merged });
    },
    async records() {
      await app.settle();
      return listRequests(env.TELEMETRY_DB, { limit: 200 });
    },
    addService,
    addGrant,
  };
}

/** Seals `secret` for a service row exactly like the admin credential operation does. */
export async function sealFor(
  appEnv: KeyringEnv,
  serviceId: string,
  baseUrl: string,
  injectionJson: string,
  secret: string,
): Promise<string> {
  const keyring = await loadKeyring(appEnv);
  if (!keyring.ok) throw new Error(`test keyring: ${keyring.error}`);
  return sealCredential(
    keyring.keyring,
    secret,
    credentialAad(serviceId, baseUrl, injectionJson),
    (n) => crypto.getRandomValues(new Uint8Array(n)),
  );
}
