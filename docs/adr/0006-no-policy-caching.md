# 6. No policy caching

This ADR explains why the proxy reads its configuration from D1 on every request. It is for security reviewers, operators and contributors.

Date: 2026-10-13

## Status

Accepted

## Context

Each proxied request needs the service, the enabled caller providers, the matching grants and some settings. A per-isolate cache with a 5 to 30 second TTL was proposed to save the D1 round trip.

A cache delays revocation. During an incident, an admin disables a grant, service or caller provider and needs it to stop working at once. With a cache, the delay is the TTL in each of many isolates, plus any D1 read-replica lag. Operators would need to know this delay and wait it out.

## Decision

The proxy does not cache policy. `loadProxyContext` in `apps/gateway/src/db/proxy-context.ts` reads the service, enabled caller providers, enabled and unexpired grants and settings in one D1 batch on every request.

Caches that do not decide authorization are allowed: JWKS per `jwks_uri`, OIDC discovery for admin login, the schema status and the `/readyz` answer ([architecture.md](../architecture.md#why-no-policy-caching)).

> Note (2026-10-14): since [0015](0015-cloudflare-access-only-admin-login.md) there is no OIDC discovery for admin login. The Cloudflare Access team keys are cached instead, the same way as JWKS.

## Consequences

- Disabling or deleting a grant, service or caller provider takes effect on the next request. The same holds for grant expiry.
- Each proxied request costs one D1 batch and the rows it reads. This adds latency and counts toward D1 read limits ([observability.md](../observability.md)).
- If `DB` is unavailable, proxied requests fail with 500 `internal_error`. The gateway fails closed.
- Revocation does not stop a request already in progress. A streaming response that started before the change runs to its end ([threat-model.md](../threat-model.md)).
- A bounded policy cache stays a possible later option if latency requires it ([roadmap.md](../roadmap.md)). It would need its own ADR, because it changes the revocation guarantee.
