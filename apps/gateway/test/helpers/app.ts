// Builds the real app with injected dependencies for integration tests.
// Background work passed to waitUntil is collected so tests can await it (e.g. request records).
import { env } from 'cloudflare:workers';
import { createApp } from '../../src/app';
import type { Deps } from '../../src/deps';
import type { AppEnv } from '../../src/env';
import { TEST_ACCESS_TEAM, withTestAccessCerts } from './login-providers';

export interface TestAppOptions {
  /**
   * Outbound fetch used for upstreams and JWKS. Defaults to a fetch that fails. The test Access
   * team's certs are always served (TEST_ACCESS_ENV).
   */
  fetch?: typeof fetch;
  /** Fixed or advancing clock. Defaults to the real clock. */
  now?: () => number;
  /** Extra vars/secrets/bindings layered over the wrangler.jsonc test env. */
  env?: Partial<AppEnv> & Record<string, unknown>;
}

export interface TestApp {
  deps: Deps;
  env: Env;
  request(path: string, init?: RequestInit & { origin?: string }): Promise<Response>;
  /** Resolves every promise handed to waitUntil so far (and any they schedule). */
  settle(): Promise<void>;
}

export const TEST_ORIGIN = 'https://gw.test';

/** Admin login every test app gets unless `env` overrides it: the shared fake Access team. */
export const TEST_ACCESS_ENV = {
  AUTH_ACCESS_TEAM_DOMAIN: TEST_ACCESS_TEAM,
  AUTH_ACCESS_AUD: 'a'.repeat(64),
} as const satisfies Partial<AppEnv>;

export function createTestApp(options: TestAppOptions = {}): TestApp {
  const pending: Promise<unknown>[] = [];
  const testEnv = { ...env, ...TEST_ACCESS_ENV, ...options.env } as unknown as Env;
  const deps: Deps = {
    env: testEnv as unknown as AppEnv,
    fetch: withTestAccessCerts(
      options.fetch ??
        (async (input) => {
          throw new Error(
            `unexpected outbound fetch in test: ${String(input instanceof Request ? input.url : input)}`,
          );
        }),
    ),
    now: options.now ?? (() => Date.now()),
    random: (length) => crypto.getRandomValues(new Uint8Array(length)),
    waitUntil: (promise) => {
      pending.push(promise);
    },
  };
  const app = createApp({ makeDeps: () => deps });
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => deps.waitUntil(promise),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  return {
    deps,
    env: testEnv,
    request: (path, init = {}) => {
      const { origin = TEST_ORIGIN, ...rest } = init;
      return Promise.resolve(app.fetch(new Request(new URL(path, origin), rest), testEnv, ctx));
    },
    settle: async () => {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
  };
}

/** Sets the upstream host allowlist setting (null = any public https host). */
export async function setUpstreamHosts(hosts: string[] | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('allowed_upstream_hosts', ?, 0, NULL)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  )
    .bind(JSON.stringify(hosts))
    .run();
}

/** Sets the admin host allowlist setting (null = not set yet, any host but workers.dev). */
export async function setAdminHosts(hosts: string[] | null): Promise<void> {
  if (hosts === null) {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'admin_hosts'").run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('admin_hosts', ?, 0, NULL)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  )
    .bind(JSON.stringify(hosts))
    .run();
}
