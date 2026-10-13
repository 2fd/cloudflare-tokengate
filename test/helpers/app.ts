// Builds the real app with injected dependencies for integration tests.
// Background work passed to waitUntil is collected so tests can await it (e.g. request records).
import { env } from 'cloudflare:workers';
import { createApp } from '../../src/app';
import type { Deps } from '../../src/deps';
import type { AppEnv } from '../../src/env';

export interface TestAppOptions {
  /** Outbound fetch used for upstreams, JWKS and login providers. Defaults to a fetch that fails. */
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

export function createTestApp(options: TestAppOptions = {}): TestApp {
  const pending: Promise<unknown>[] = [];
  const testEnv = { ...env, ...options.env } as unknown as Env;
  const deps: Deps = {
    env: testEnv as unknown as AppEnv,
    fetch:
      options.fetch ??
      (async (input) => {
        throw new Error(
          `unexpected outbound fetch in test: ${String(input instanceof Request ? input.url : input)}`,
        );
      }),
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
