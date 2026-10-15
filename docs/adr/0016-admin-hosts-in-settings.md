# 16. Admin hosts in Settings instead of `PUBLIC_URL`

This ADR explains how the gateway decides on which hostnames `/admin` answers, and why that list is a D1 setting and not a variable. It is for security reviewers and platform engineers. It supersedes the `PUBLIC_URL` parts of [0013](0013-operator-variables-outside-wrangler-config.md) and [0015](0015-cloudflare-access-only-admin-login.md).

Date: 2026-10-14

## Status

Accepted

## Context

The operator variable `PUBLIC_URL` pinned `/admin` to one origin ([I-DEPLOY-1](../threat-model.md#i-deploy-1)). Access login required it on a custom https domain, and the local development login required it on a loopback origin. The admin UI used it as the canonical origin for the CSRF `Origin` check, invitation links and snippets.

This had three problems:

- Operators want the console on more than one hostname, for example during a domain change.
- A change needs the Cloudflare dashboard and a new Worker version. Owners cannot manage it in the admin UI.
- Variables are bindings of a Worker version. A rollback can bring back an older value or none, and an unset `PUBLIC_URL` turned host pinning off ([0013](0013-operator-variables-outside-wrangler-config.md)).

The upstream host allowlist moved from a variable to Settings for the same reasons.

## Decision

- **No variable.** `PUBLIC_URL` is removed, with no replacement. The operator variables are `AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD` and `AUTH_DEV_EMAIL`. The configuration features are `login.access` and `login.dev`.
- **Admin hosts in D1.** The `settings` key `admin_hosts` holds a JSON array. An entry is an exact hostname (`tokengate.example.com`) or `*.<domain>`, which matches the hosts strictly below the domain, not the domain itself. The domain needs at least two labels. `localhost`, `127.0.0.1` and `[::1]` are also valid. Entries on `workers.dev` are refused. No scheme, port or path. This is the format of the upstream host allowlist.
- **Initial value.** The first sign-in, which creates the first owner ([I-BOOT-1](../threat-model.md#i-boot-1)), stores the hostname of its request in the same D1 batch, only if `admin_hosts` is not set. The `user.bootstrap` audit diff records it as `host`. If the hostname is not a valid entry, nothing is stored.
- **Editing.** Owners edit the list in Settings > "Admin hosts" (`settings:write`, `POST /admin/settings/admin-hosts`). Each change writes a `settings.admin_hosts` audit event with a `before` and `after` diff. The list cannot be empty, and it must keep the hostname that the owner uses at that moment (lock-out guard). Owners put every added hostname behind their Access application.
- **Host pinning.** `src/http/security.ts` reads `admin_hosts` from D1 on every `/admin` request:
  - `/admin` never answers on `workers.dev` or `*.workers.dev` (404).
  - When `admin_hosts` is not set, `/admin` answers on every other hostname.
  - When it is set, `/admin` answers only on a listed hostname. A hostname that is not a loopback host must use https. The port is ignored. Other requests get 404.
  - A stored value that is not a valid list denies every host (fail closed).
  - `/proxy`, `/healthz` and `/readyz` are not pinned.
- **Logins.** Access login needs only the team domain and AUD. Because `/admin` never answers on `workers.dev`, it works only on a custom domain. The local development login applies only to a request whose hostname is `localhost`, `127.0.0.1` or `[::1]`, checked per request in `src/admin/auth/identity.ts`.
- **No canonical origin.** The CSRF `Origin` check, invitation links, the service proxy URL, the caller provider snippets and the setup page use the origin of the current request. Host pinning makes this safe.
- **SSRF self-exclusion.** A service base URL is refused ("must not point at this gateway") when its host matches an admin host entry, wildcards included, or the hostname of the current request ([I-SSRF-1](../threat-model.md#i-ssrf-1)). This applies when a service is saved and on every proxied request; the proxy reads the admin hosts in its per-request D1 batch.

## Consequences

- Host pinning needs no variable. A deploy or a Worker rollback does not change the admin hosts.
- Trust on first use: the first sign-in decides both the first owner and the first admin host. Keep the Access policy limited to yourself until you have signed in.
- Until that sign-in, `/admin` answers on every hostname of the Worker except `workers.dev`. Every admin request still needs a valid Access JWT, so nobody reaches the console without Access.
- Every `/admin` request reads one more D1 row.
- The admin UI has no canonical origin. Links and snippets show the hostname that the viewer uses.
- An owner cannot remove the hostname in use. A stored value that is not valid, or a lost domain, closes `/admin` everywhere. Recovery is a `wrangler d1 execute` on the `settings` table ([break-glass](../operations/break-glass.md#lost-admin-host)). Deleting the row opens `/admin` on every non-`workers.dev` hostname again.
- A wildcard admin host also blocks every host below it as an upstream.
- `wrangler.jsonc` still sets `keep_vars: true`. A blank committed `AUTH_ACCESS_AUD` would turn off admin sign-in, so `scripts/check-config.sh` still rejects blank variables.

## Note (2026-10-15)

The admin hosts moved from Settings to Users › Sign-in ([ADR 0019](0019-admin-information-architecture.md)). The decision is unchanged; only the editing changed:

- One host per change: `POST /admin/users/sign-in/hosts` with `add=<host>` or `remove=<host>`, instead of a textarea with the whole list. A pasted URL is reduced to its hostname.
- The lock-out guard is "the list still matches the hostname in use, wildcards included, and is not empty". So the explicit entry of the hostname in use can be removed while a `*.<domain>` entry still covers it. "Remove…" is offered only for such entries, behind a confirmation.
- While no list is set, one button pins the console to the hostname in use.
- The write is guarded on the stored value it was computed from. A change that races another owner's change is refused (`409`).
