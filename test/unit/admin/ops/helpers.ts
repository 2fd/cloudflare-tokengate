// Fixtures for admin ops tests: deps with injectable fetch/env, a test actor, fake upstream and
// OIDC discovery endpoints, and seeders that go through the real ops.
import { env } from 'cloudflare:workers';
import { createCallerProvider } from '../../../../src/admin/ops/caller-providers';
import { createGrant } from '../../../../src/admin/ops/grants';
import { createService, type ServiceCreateInput } from '../../../../src/admin/ops/services';
import { auditFromRow } from '../../../../src/db/audit';
import type { Actor, AuditEvent, CallerProvider, Grant } from '../../../../src/db/types';
import type { Deps } from '../../../../src/deps';
import type { AppEnv } from '../../../../src/env';
import { toBase64 } from '../../../../src/lib/encoding';
import { TEST_ACCESS_ENV } from '../../../helpers/app';

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITHUB_JWKS = 'https://token.actions.githubusercontent.com/.well-known/jwks';
export const OWNER_ID = '4242';
export const REPOSITORY_ID = '987654321';
export const CONTEXT = { requestHost: 'gw.example.com' };

export const KEK_1 = toBase64(new Uint8Array(32).fill(1));
export const KEK_2 = toBase64(new Uint8Array(32).fill(2));
export const KEYRING_1_2 = JSON.stringify({ active: 'k2', keys: { k1: KEK_1, k2: KEK_2 } });

export const ACTOR: Actor = {
  type: 'user',
  id: 'usr_01JTESTACTOR0000000000000',
  email: 'admin@example.com',
  ip: '203.0.113.7',
  userAgent: 'vitest',
};

export interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
  redirect: RequestInit['redirect'];
}

/** Fake network: OIDC discovery for known issuers plus a programmable upstream handler. */
export function fakeNetwork(
  upstream: (url: URL, init: RequestInit) => Response | Promise<Response> = () =>
    new Response('{"ok":true}', { status: 200 }),
  issuers: Record<string, string> = { [GITHUB_ISSUER]: GITHUB_JWKS },
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({
      url: url.href,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      redirect: init.redirect,
    });
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      const issuer = url.href.slice(0, -'/.well-known/openid-configuration'.length);
      const jwksUri = issuers[issuer];
      if (jwksUri === undefined) return new Response('not found', { status: 404 });
      return Response.json({ issuer, jwks_uri: jwksUri });
    }
    return upstream(url, init);
  };
  return { fetch: fetchImpl, calls };
}

export function opsDeps(
  options: { fetch?: typeof fetch; env?: Partial<AppEnv>; now?: () => number } = {},
): Deps {
  return {
    // Same login variables as the test apps: keys are bound to them (I-CRED-3).
    env: {
      ...(env as unknown as AppEnv),
      ...TEST_ACCESS_ENV,
      TOKENGATE_KEK: KEK_1,
      ...options.env,
    },
    fetch: options.fetch ?? fakeNetwork().fetch,
    now: options.now ?? (() => Date.now()),
    random: (length) => crypto.getRandomValues(new Uint8Array(length)),
    waitUntil: () => {},
  };
}

/** Empties the control-plane tables touched by ops (storage is per test file). */
export async function resetControlPlane(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM grants'),
    env.DB.prepare('DELETE FROM services'),
    env.DB.prepare('DELETE FROM caller_providers'),
    env.DB.prepare('DELETE FROM audit_log'),
  ]);
}

// Insertion order (rowid): ids created in the same millisecond do not sort by creation.
export async function auditRows(targetId?: string): Promise<AuditEvent[]> {
  const statement =
    targetId === undefined
      ? env.DB.prepare('SELECT * FROM audit_log ORDER BY rowid')
      : env.DB.prepare('SELECT * FROM audit_log WHERE target_id = ? ORDER BY rowid').bind(targetId);
  const { results } = await statement.all<Record<string, unknown>>();
  return results.map(auditFromRow);
}

export async function auditCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT count(*) AS n FROM audit_log').first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Every text column of every control-plane row, for "secret appears nowhere" assertions. */
export async function dumpControlPlane(): Promise<string> {
  const tables = ['services', 'caller_providers', 'grants', 'audit_log', 'settings'];
  const dumps = await Promise.all(
    tables.map((table) => env.DB.prepare(`SELECT * FROM ${table}`).all()),
  );
  return JSON.stringify(dumps.map((dump) => dump.results));
}

export function serviceInput(overrides: Partial<ServiceCreateInput> = {}): ServiceCreateInput {
  return {
    slug: 'github',
    name: 'GitHub',
    base_url: 'https://api.github.com',
    injection: { kind: 'bearer' },
    forward_headers: ['x-github-api-version'],
    verify: null,
    ...overrides,
  };
}

export async function seedService(
  deps: Deps,
  overrides: Partial<ServiceCreateInput> = {},
): Promise<string> {
  const result = await createService(deps, ACTOR, serviceInput(overrides), CONTEXT);
  if (!result.ok) throw new Error(`seedService: ${result.errors.join('; ')}`);
  return result.service.id;
}

export async function seedGithubProvider(deps: Deps): Promise<CallerProvider> {
  const result = await createCallerProvider(deps, ACTOR, {
    name: 'GitHub Actions',
    profile: 'github-actions',
    tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
  });
  if (!result.ok) throw new Error(`seedGithubProvider: ${result.errors.join('; ')}`);
  return result.callerProvider;
}

export function anchoredConditions() {
  return [
    { claim: 'repository_owner_id', match: 'exact' as const, values: [OWNER_ID] },
    { claim: 'repository_id', match: 'exact' as const, values: [REPOSITORY_ID] },
  ];
}

export async function seedGrant(
  deps: Deps,
  callerProviderId: string,
  serviceId: string,
  name = 'read repo',
): Promise<Grant> {
  const result = await createGrant(deps, ACTOR, {
    name,
    caller_provider_id: callerProviderId,
    service_id: serviceId,
    conditions: anchoredConditions(),
    rules: [{ methods: ['GET'], path: '/repos/**' }],
  });
  if (!result.ok) throw new Error(`seedGrant: ${result.errors.join('; ')}`);
  return result.grant;
}

/**
 * Deps whose DB runs `before` once, right before the op's first db.batch: simulates a concurrent
 * admin request landing between the op's reads and its write.
 */
export function racingDeps(deps: Deps, before: () => Promise<unknown>): Deps {
  const db = deps.env.DB;
  let fired = false;
  const racing = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (!fired) {
            fired = true;
            await before();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...deps, env: { ...deps.env, DB: racing } };
}
