// Fixtures for admin ops tests: deps with injectable fetch/env, a test actor, fake upstream and
// OIDC discovery endpoints, and seeders that go through the real ops.
import { env } from 'cloudflare:workers';
import {
  createCredentialAccessRule,
  type CredentialRuleInput,
} from '../../../../src/admin/ops/credential-access-rules';
import { createService, type ServiceCreateInput } from '../../../../src/admin/ops/credentials';
import {
  createGlobalAccessRule,
  type GlobalRuleInput,
} from '../../../../src/admin/ops/global-access-rules';
import { auditFromRow } from '../../../../src/db/audit';
import type {
  Actor,
  AuditEvent,
  CredentialAccessRule,
  GlobalAccessRule,
} from '../../../../src/db/types';
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
/** Passes the next-key checks (ADR 0027): 32 distinct byte values, not all printable. */
export const KEK_2 = toBase64(Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i * 5));
/** A rotation in progress: KEK_1 is the current key, KEK_2 the next one. */
export const ROTATION_ENV = { TOKENGATE_KEK: KEK_1, TOKENGATE_KEYRING: KEK_2 };

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
    env.DB.prepare('DELETE FROM claim_labels'),
    env.DB.prepare('DELETE FROM access_rules'),
    env.DB.prepare('DELETE FROM credentials'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare("DELETE FROM settings WHERE key = 'keyring_rewrap'"),
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
  const tables = ['credentials', 'access_rules', 'claim_labels', 'audit_log', 'settings'];
  const dumps = await Promise.all(
    tables.map((table) => env.DB.prepare(`SELECT * FROM ${table}`).all()),
  );
  return JSON.stringify(dumps.map((dump) => dump.results));
}

export function serviceInput(overrides: Partial<ServiceCreateInput> = {}): ServiceCreateInput {
  const slug = overrides.slug ?? 'github';
  return {
    slug,
    name: 'GitHub',
    // One destination per credential type (ADR 0031): another slug defaults to another host.
    base_url: slug === 'github' ? 'https://api.github.com' : `https://${slug}.example.com`,
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
  if (Object.keys(overrides).length === 0) {
    const existing = await deps.env.DB.prepare(
      "SELECT id FROM credentials WHERE slug = 'github'",
    ).first<{ id: string }>();
    if (existing) return existing.id;
  }
  const result = await createService(deps, ACTOR, serviceInput(overrides), CONTEXT);
  if (!result.ok) throw new Error(`seedService: ${result.errors.join('; ')}`);
  return result.service.id;
}

export function anchoredConditions() {
  return [
    { claim: 'repository_owner_id', match: 'exact' as const, values: [OWNER_ID] },
    { claim: 'repository_id', match: 'exact' as const, values: [REPOSITORY_ID] },
  ];
}

/**
 * A GitHub Actions credential access rule through the real op: the newest credential (or a new one),
 * the test organization's pin, the anchored jobs and `GET /repos/**`.
 */
export async function seedCredentialRule(
  deps: Deps,
  overrides: Partial<CredentialRuleInput> = {},
): Promise<CredentialAccessRule> {
  const credentialId = overrides.credential_id ?? (await testCredentialId(deps));
  const result = await createCredentialAccessRule(deps, ACTOR, {
    credential_id: credentialId,
    name: 'read repo',
    profile: 'github-actions',
    tenant_pin: [{ claim: 'repository_owner_id', match: 'exact', values: [OWNER_ID] }],
    conditions: anchoredConditions(),
    rules: [{ methods: ['GET'], path: '/repos/**' }],
    acknowledge_warnings: true,
    ...overrides,
  });
  if (!result.ok) throw new Error(`seedCredentialRule: ${result.errors.join('; ')}`);
  return result.rule;
}

/** A global access rule of the GitHub issuer through the real op, confirmed. */
export async function seedGlobalRule(
  deps: Deps,
  overrides: Partial<GlobalRuleInput> = {},
): Promise<GlobalAccessRule> {
  const result = await createGlobalAccessRule(deps, ACTOR, {
    name: 'acme only',
    profile: 'github-actions',
    ...overrides,
    confirm_new_ceiling: true,
    confirm_widening: true,
  });
  if (!result.ok) throw new Error(`seedGlobalRule: ${result.errors.join('; ')}`);
  return result.rule;
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

/** A credential for tests exercising rule validation rather than credential creation. */
export async function testCredentialId(deps: Deps): Promise<string> {
  const existing = await deps.env.DB.prepare(
    'SELECT id FROM credentials ORDER BY created_at DESC, id LIMIT 1',
  ).first<{ id: string }>();
  return existing?.id ?? seedService(deps);
}
