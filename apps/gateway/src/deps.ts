// Side effects the application depends on, injected so security-critical code is testable
// without network or clock mocks. Production values are built in src/index.ts.
import type { AppEnv } from './env';

export interface Deps {
  env: AppEnv;
  /** Outbound fetch for upstream APIs, JWKS, discovery and login providers. */
  fetch: typeof fetch;
  /** Milliseconds since the Unix epoch. */
  now: () => number;
  /** Cryptographically secure random bytes. */
  random: (length: number) => Uint8Array;
  /** Keeps the invocation alive for background work (telemetry). Never awaited by callers. */
  waitUntil: (promise: Promise<unknown>) => void;
}

export function productionDeps(env: AppEnv, ctx: Pick<ExecutionContext, 'waitUntil'>): Deps {
  return {
    env,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    random: (length) => crypto.getRandomValues(new Uint8Array(length)),
    waitUntil: (promise) => ctx.waitUntil(promise),
  };
}
