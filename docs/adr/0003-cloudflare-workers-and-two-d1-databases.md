# 3. Cloudflare Workers with two D1 databases

This ADR explains why tokengate runs as one Cloudflare Worker with two D1 databases. It is for platform engineers and contributors.

Date: 2026-10-13

## Status

Accepted

## Context

Each company deploys and runs its own copy. The gateway must therefore be cheap and simple to operate, with no servers to patch. It sits on the request path of CI jobs everywhere, so it must be close to callers and stream request and response bodies without buffering. It needs durable storage for configuration, for encrypted credentials and for a request log.

Request volume and control-plane data behave differently:

- The request log grows with traffic. Anyone on the internet can send rejected requests that may be logged.
- The control plane is small, changes rarely, and must stay writable, because revocation is a write.
- A D1 database has a maximum size and processes one query at a time. Source: https://developers.cloudflare.com/d1/platform/limits/

## Decision

- tokengate is one Cloudflare Worker written in TypeScript, with Hono for routing and server-rendered pages, jose for JWT verification and oauth4webapi for admin login.
- It uses two D1 databases:
  - `DB` (control plane): Users, sessions, caller providers, services, grants, settings, audit log. Schema in `apps/gateway/migrations/`.
  - `TELEMETRY_DB`: request log and hourly rollups. Schema in `apps/gateway/migrations-telemetry/`.
- `pnpm run deploy` applies the migrations of both databases, then deploys the Worker.
- Workers Paid is the recommended plan. See [getting-started.md](../getting-started.md) and [observability.md](../observability.md) for plan limits.

> Note (2026-10-14): [0015](0015-cloudflare-access-only-admin-login.md) removed `oauth4webapi` and the `sessions` table. Admin login is Cloudflare Access only.

## Consequences

- There are no servers. A deployment is one Worker, two databases and a few secrets ([configuration.md](../configuration.md)).
- Request traffic cannot fill the control-plane database. Telemetry purges and rollups do not compete with the per-request control-plane read. Control-plane backups stay small ([operations/backup-restore.md](../operations/backup-restore.md)).
- The two databases cannot be joined in SQL. Pages that combine them (dashboard, request log) read each one separately.
- Every proxied request makes one D1 batch read on `DB` ([ADR 0006](0006-no-policy-caching.md)).
- The project depends on Cloudflare features: D1, Workers Assets, Cron Triggers, and optionally Queues, Pipelines and Rate Limiting. It cannot run elsewhere without changes.
- Workers behavior applies to outbound requests. The `global_fetch_strictly_public` flag sends same-zone upstream requests through Cloudflare's front door, and Workers adds a `CF-Worker` header to outbound requests ([threat-model.md](../threat-model.md)).
