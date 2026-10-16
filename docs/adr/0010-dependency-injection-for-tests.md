# 10. Dependency injection for tests

This ADR explains how tokengate code gets network, clock and randomness, and how tests replace them. It is for contributors.

Date: 2026-10-13

## Status

Accepted

## Context

Most security behavior depends on side effects:

- `fetch` for JWKS, OIDC discovery, login providers and upstream APIs;
- the clock for token expiry, sessions, invites and retention;
- randomness for ids, tokens and sampling;
- `waitUntil` for background work.

> Note (2026-10-14): since [0015](0015-cloudflare-access-only-admin-login.md) there are no gateway sessions and no OIDC discovery or GitHub login. Tests inject `fetch` for the Cloudflare Access team keys instead.

Tests must run these paths exactly as in production: in the Workers runtime, with real D1, and with attacker-controlled upstream responses. Global mocks (HTTP interception libraries, patched `globalThis.fetch`, fake timers) are fragile in workerd. They can also hide a code path that bypasses the mock.

## Decision

- Side effects go through one `Deps` object (`apps/gateway/src/deps.ts`): `env`, `fetch`, `now()`, `random(length)`, `waitUntil(promise)`.
- `productionDeps()` builds the real values. `apps/gateway/src/index.ts` and `createApp()` in `apps/gateway/src/app.ts` are the only places that call it.
- `createApp({ makeDeps })` lets tests supply their own `Deps`. jose receives `deps.fetch` through its `customFetch` option.
- Tests run in workerd with `@cloudflare/vitest-plugin`, against local D1 databases migrated by `apps/gateway/test/helpers/apply-migrations.ts`. No HTTP mocking library is used.
- In `apps/gateway/test/helpers/app.ts`, the default test `fetch` throws. Every outbound call must be expected by the test.
- Cryptographic formats and parsers are pinned by vectors in `apps/gateway/test/vectors/`.

## Consequences

- Tests can serve a malicious JWKS, a redirecting upstream or a slow login provider through a plain function.
- Time-based behavior is tested with a controlled clock, without fake timers.
- Production wiring stays in two small functions, so a reviewer can check it quickly.
- Every module that does I/O takes `deps` as a parameter. This is more verbose than calling `fetch` or `Date.now()` directly. Direct calls in feature code are review findings.
- A few per-isolate caches are module-level state. They expose reset functions for tests only (for example `resetJwksCacheForTests`, `resetPretrustBudgetForTests`).
