# 30. No admin host list

This ADR explains why the gateway no longer keeps a list of the hostnames on which `/admin` answers, and what decides those hostnames now. It is for security reviewers and platform engineers. It supersedes [0016](0016-admin-hosts-in-settings.md).

Date: 2026-10-22

## Status

Accepted

## Context

[0016](0016-admin-hosts-in-settings.md) pinned `/admin` to the admin hosts, a D1 setting that owners edited in Users › Sign-in. The first sign-in stored its hostname as the first entry.

This had three problems:

- The list repeated a decision that the operator already makes twice. The Worker routes and custom domains decide which hostnames reach the Worker. The Cloudflare Access application decides which of them need a sign-in.
- The login is the control. Every `/admin` request needs a valid Access JWT for the configured AUD. A hostname that is not behind the Access application gets no JWT, so it signs in nobody. The development login applies only to loopback hostnames, which Cloudflare's edge never sends to the Worker.
- Owners confused "Admin hosts" with "Allowed hosts". Admin hosts control inbound traffic to the console. Allowed hosts (the upstream host allowlist) control outbound traffic from the proxy. The two lists had similar names, similar formats and adjacent pages.

The list also had costs: one more D1 read on every `/admin` request, a lock-out guard, a race guard, and a break-glass procedure for a lost hostname.

## Decision

- **No list.** The `admin_hosts` setting, the "Admin hosts" section of Users › Sign-in, `POST /admin/users/sign-in/hosts`, the `settings.admin_hosts` audit action and the Overview health check for admin hosts are removed. The first sign-in stores no hostname, and the `user.bootstrap` audit diff has no `host`.
- **Host rule.** `apps/gateway/src/http/security.ts` decides from the request URL alone, with no D1 read ([I-DEPLOY-1](../threat-model.md#i-deploy-1)):
  - `/admin` never answers on `workers.dev` or `*.workers.dev` (404).
  - `/admin` answers only over https, unless the hostname is `localhost`, `127.0.0.1` or `[::1]` (404).
  - On every other hostname that routes to the Worker, `/admin` answers.
  - `/proxy`, `/healthz` and `/readyz` are not affected.
- **Operator duty.** The operator chooses the console hostnames with Worker routes and custom domains, and puts every one of them behind the Access application.
- **Origin.** The CSRF `Origin` check, invitation links, the proxy URL and the snippets keep the origin of the current request, as in 0016.
- **SSRF self-exclusion.** A base URL and an Allowed hosts entry are refused ("is this gateway") when the host matches the hostname of the current request ([I-SSRF-1](../threat-model.md#i-ssrf-1)). There is no other list of gateway hostnames.

## Consequences

- Owners manage one host list, Allowed hosts, and it is always outbound.
- Every hostname that routes to the Worker serves `/admin`. A route that is not behind the Access application shows the sign-in error page, not the console. The host rule is no longer a second line of defense behind Access.
- `/admin` requests read one D1 row less.
- The lock-out guard, the race guard and the "lost admin host" break-glass procedure are gone. A lost domain needs only a new route and an Access destination.
- SSRF self-exclusion covers only the hostname of the current request. Another hostname of the same Worker is not refused automatically. Do not add a hostname of this Worker to Allowed hosts: the upstream host allowlist is the control. An empty allowlist allows any public https host, including another hostname of this Worker.
- An `admin_hosts` row left in D1 by an earlier version is ignored.
