# Configuration

This page lists every variable, secret, binding and runtime setting of cloudflare-tokengate. It is for
platform engineers who deploy and operate the gateway.

The code is the reference: variables are declared in `src/env.ts` and parsed in `src/config.ts`;
settings live in `src/db/settings.ts`.

## Where each kind of value lives

| Kind | Where you set it | Survives `pnpm run deploy` |
|---|---|---|
| Operator variable (`AUTH_*`) | Cloudflare dashboard: Workers & Pages > tokengate > Settings > Variables and Secrets | Yes (`keep_vars: true`) |
| Secret (`TOKENGATE_KEK`, `TOKENGATE_KEYRING`) | `pnpm wrangler secret put <NAME>` | Yes, always |
| Binding (D1, queue, pipeline, rate limiter) | `wrangler.jsonc` | Part of the deploy |
| Runtime setting (retention, sampling, upstream host allowlist, admin hosts) | Admin UI: Settings | Stored in D1 |

`wrangler.jsonc` sets `"keep_vars": true` and declares no `vars`. So `pnpm run deploy` and Workers Builds
keep the values you set in the dashboard. Set each variable in one place only.

If you prefer to keep configuration in git, add the variable with a non-empty value under `"vars"` in
your clone's `wrangler.jsonc`. Every deploy then overwrites the dashboard value. Never commit `""`
placeholders. An empty `AUTH_ACCESS_AUD` turns off admin sign-in
([I-DEPLOY-1](threat-model.md#i-deploy-1)). Whitespace-only values count as empty. `scripts/check-config.sh` rejects them, in top-level `vars` and in `env.<name>.vars` blocks.

Rolling back to an earlier Worker version (`pnpm wrangler rollback` or the dashboard) restores that
version's variables. The upstream host allowlist and the admin hosts are stored in D1, so a rollback
does not change them.

For local development (`pnpm dev`), put all variables and secrets in `.dev.vars`. `pnpm run setup`
creates it from `.dev.vars.example` ([CONTRIBUTING.md](../CONTRIBUTING.md#set-up)). The example lists
every variable and secret with a comment, except `TOKENGATE_KEYRING`, which it only mentions. It
works with `pnpm dev` as is:

- `TOKENGATE_KEK` is the public [development key](#development-key) (base64 of
  `DEV-ONLY-KEY-NOT-FOR-PRODUCTION!`).
- `AUTH_ACCESS_DEVELOPMENT=dev@example.com` turns on the [development login](#local-development-login-auth_access_development).
- `AUTH_ACCESS_TEAM_DOMAIN` and `AUTH_ACCESS_AUD` are commented out.

These defaults fail closed in production ([I-DEPLOY-1](threat-model.md#i-deploy-1)). The development
login signs in no request through Cloudflare's edge, and the Worker refuses the development key as soon
as an Access variable is set.

## How invalid configuration fails

Configuration is parsed per feature: `login.access` and `login.dev` ([I-CFG-1](threat-model.md#i-cfg-1)). A malformed feature is turned off; it never runs half
configured. Errors name the variable and never echo its value. They appear in two places:

- Settings > System status > "Configuration problems".
- The setup page at `/admin`, as error banners, while no login works (login features only).

Values are trimmed. An empty or whitespace-only value counts as unset. Lists are comma-separated;
entries are trimmed and empty entries are dropped.

## Variables

| Name | Kind | Required | Format |
|---|---|---|---|
| `TOKENGATE_KEK` | secret | One of `TOKENGATE_KEK` / `TOKENGATE_KEYRING` | Standard base64 of 32 bytes |
| `TOKENGATE_KEYRING` | secret | One of `TOKENGATE_KEK` / `TOKENGATE_KEYRING` | JSON keyring |
| `AUTH_ACCESS_TEAM_DOMAIN` | var | For the admin UI | `<team>`, `<team>.cloudflareaccess.com` or `https://<team>.cloudflareaccess.com` |
| `AUTH_ACCESS_AUD` | var | For the admin UI | Access application audience (AUD) tag |
| `AUTH_ACCESS_DEVELOPMENT` | var | Local development only; never together with Access | Email address |

Sign-in to the admin UI goes through Cloudflare Access only
([ADR 0015](adr/0015-cloudflare-access-only-admin-login.md)). Without a working Access login, `/admin`
shows a setup page (`503`) that lists the variables to set. `AUTH_ACCESS_DEVELOPMENT` is for `pnpm dev`
only. The keyring is [bound to the three `AUTH_ACCESS_*` variables](#login-binding): set them before
you add services, and do not change them after.

### First owner

There is no variable for it. While no owner exists, the first person to sign in becomes an active
owner, once per deployment ([I-BOOT-1](threat-model.md#i-boot-1)). Keep the Access policy limited to
your own email until you have signed in, then widen it. The hostname of that sign-in becomes the first
[admin host](#admin-hosts). Everyone after joins with the join defaults
and is managed by owners on the Users page. The bootstrap is recorded in settings and does not run
again, even if every owner is later removed: recover with
[operations/break-glass.md](operations/break-glass.md).

### Keyring: `TOKENGATE_KEK` or `TOKENGATE_KEYRING`

The key-encryption key that seals stored upstream credentials ([I-CRED-2](threat-model.md#i-cred-2)). Set exactly
one of the two. Each key is [bound to the login variables](#login-binding).

- `TOKENGATE_KEK`: standard base64 (padding optional) of exactly 32 bytes. Its key id is `k1`.
- `TOKENGATE_KEYRING`: JSON with exactly the keys `active` and `keys`, for example
  `{"active":"k2","keys":{"k1":"<base64>","k2":"<base64>"}}`. Key ids match
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. New credentials are sealed with the active key.
- Generate and check keys outside Cloudflare, and keep a copy in your company vault. Losing the key
  loses every stored credential. `vault-read` and `vault-write` stand for your vault's CLI, as in
  [key rotation](operations/key-rotation.md#before-you-start). `pnpm keyring` needs Node.js 22.18 or later.

  ```sh
  pnpm -s keyring generate | vault-write tokengate-kek-k1   # new key on stdout, its key check value on stderr
  vault-read tokengate-kek-k1 | pnpm -s keyring check     # validates a KEK or keyring value like the Worker does
  vault-read tokengate-kek-k1 | pnpm wrangler secret put TOKENGATE_KEK
  ```

- **When absent or invalid:** admin sign-in still works. Proxied requests to a service with a credential
  answer `503 not_configured` with reason `keyring_absent`, `keyring_malformed`, `active_kid_missing`,
  `key_not_32_bytes`, `both_kek_and_keyring_set` or `dev_placeholder_key`. Credential changes are refused. The dashboard shows a
  banner and `/readyz` reports `keyring: false`.
- Rotation: [operations/key-rotation.md](operations/key-rotation.md).

#### Login binding

Every key is bound to `AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD` and `AUTH_ACCESS_DEVELOPMENT`
([I-CRED-3](threat-model.md#i-cred-3), [ADR 0017](adr/0017-kek-bound-to-login-variables.md)). The
AES-256-GCM key that seals credentials is HKDF-SHA256 of the secret key, with an empty salt and info
`tokengate/v1/kek-binding`, a newline and the JSON array of the three trimmed values (`""` when unset).

- **Set the login variables before you add services.** Treat them as part of the key and keep their
  exact values in your vault next to it.
- **A change makes every stored credential impossible to decrypt.** This includes setting, removing
  or rewriting any of the three, for example `acme` to `acme.cloudflareaccess.com` or a change of
  email case. Proxied requests then answer `503 credential_unavailable`, and Settings shows the key
  check values as changed.
- **Recovery:** restore the earlier values, or enter every credential again.
- **Key check values depend on the login variables.** To compare with Settings, run `pnpm keyring`
  with the Worker's `AUTH_ACCESS_*` values in the environment. The secret still comes from stdin:

  ```sh
  vault-read tokengate-kek-k1 | AUTH_ACCESS_TEAM_DOMAIN=acme AUTH_ACCESS_AUD=<aud> pnpm -s keyring check
  ```

- Rotation and rewrap work as before, under one set of login values. The sealed format stays v1.

#### Development key

`.dev.vars.example` sets `TOKENGATE_KEK=REVWLU9OTFktS0VZLU5PVC1GT1ItUFJPRFVDVElPTiE=`, the base64 of
`DEV-ONLY-KEY-NOT-FOR-PRODUCTION!`. This key is public. The Worker accepts it only in development
mode: `AUTH_ACCESS_DEVELOPMENT` set and neither Access variable set. In any other configuration, and in
any key slot of `TOKENGATE_KEYRING`, the keyring fails with `dev_placeholder_key`: proxied requests
answer `503 not_configured` and Settings shows the error. Replace it with a key of your own
(`pnpm -s keyring generate`).

### Cloudflare Access login: `AUTH_ACCESS_*`

1. Serve the gateway on a custom domain. `/admin` never answers on `workers.dev`
   ([admin hosts](#admin-hosts)).
2. In Zero Trust, create a self-hosted Access application for that hostname, limited to the `/admin`
   path. Do not put `/proxy` behind Access: CI jobs call it without an Access session. See
   [operations/cloudflare-zone-settings.md](operations/cloudflare-zone-settings.md).
3. Set `AUTH_ACCESS_TEAM_DOMAIN` and `AUTH_ACCESS_AUD` (the application's AUD tag). Delete
   `AUTH_ACCESS_DEVELOPMENT` if it is set: with both, no login works.

> **Warning:** Set these variables before you add services, and keep their exact values. The keyring
> is bound to them ([login binding](#login-binding)). A later change, also from `acme` to
> `acme.cloudflareaccess.com`, makes every stored credential impossible to decrypt.

- The gateway keeps no session of its own. On every `/admin` request it verifies the
  `Cf-Access-Jwt-Assertion` header against the team's keys, issuer and AUD. A request without a valid
  token gets `401`, also if it reaches the Worker around Access.
- Service-token JWTs (no email) are refused.
- Access decides who can authenticate and how long the Access session lasts. The Access policy is the
  list of people who can reach the admin UI: the first person becomes owner, and everyone else joins
  on their first request (audit action `user.join`) with the role and status for new users. These
  join defaults are not variables: owners set them on the Users page ("New users"; by default an
  active viewer; any role except `owner`; status `active`, `pending` or `suspended`). With
  `pending`, nobody new gets in until an owner approves them. Viewers see every page, but no page
  shows a secret. An owner can change roles later, or invite an email with another role from the
  start.
- "Sign out" in the admin UI opens `/cdn-cgi/access/logout`, which ends the Access session for the
  hostname. To end a user's sessions on every device, revoke them in Zero Trust.
- Users are linked to `<team domain>|<sub>`. A different team is a different identity: after a team
  change, each user needs "Reset login" and a new sign-in. Every credential must also be entered again
  ([login binding](#login-binding)).
- Errors: only one of the pair set; an invalid team domain or AUD; `AUTH_ACCESS_DEVELOPMENT` also set.

### Local development login: `AUTH_ACCESS_DEVELOPMENT`

With `AUTH_ACCESS_DEVELOPMENT` set, every admin request is signed in as that email, without any check.
Use it only with `pnpm dev`. `.dev.vars.example` sets it to `dev@example.com`. The login provider id
is `dev` and the configuration feature is `login.dev`.

- It applies only to requests whose hostname is `localhost`, `127.0.0.1` or `[::1]`. The gateway
  checks this on every request. No request through Cloudflare's edge has such a hostname. On any other
  hostname, `/admin` shows the setup page with a banner that tells you to remove it in production.
- It never works together with Access. If `AUTH_ACCESS_TEAM_DOMAIN` or `AUTH_ACCESS_AUD` is also set,
  both logins are turned off (fail closed). The error names `AUTH_ACCESS_DEVELOPMENT` on the features
  `login.access` and `login.dev`, and `/admin` shows it on the setup page (`503`).
- It is part of the [login binding](#login-binding): adding, removing or changing it, also only the case
  of the email, makes every stored credential impossible to decrypt.
- The same rules apply: the first sign-in becomes owner, later ones join with the join defaults. The
  first sign-in on `http://localhost:8787/admin` stores `localhost` as the admin host in the local D1.
- Errors: an invalid email.

## Admin hosts

The hostnames that `/admin` answers on ([I-DEPLOY-1](threat-model.md#i-deploy-1),
[ADR 0016](adr/0016-admin-hosts-in-settings.md)). It is a setting in the admin UI, not a variable:
Settings > "Admin hosts". Only owners can change it (permission `settings:write`). Each change writes
a `settings.admin_hosts` audit event.

- **Initial value:** the hostname of the first sign-in, which creates the first owner
  ([I-BOOT-1](threat-model.md#i-boot-1)). The same D1 batch stores it, only if no list is set yet. The
  `user.bootstrap` audit event records it as `host`. If that hostname is not a valid entry, nothing
  is stored.
- **Before the first sign-in:** `/admin` answers on every hostname except `workers.dev`. Access still
  guards sign-in.
- **After:** `/admin` answers only on a listed hostname. Every other hostname gets `404 Not Found`.
  A hostname other than a loopback host must use https; over http it gets 404. The port is ignored.
- **Always:** `/admin` never answers on `workers.dev` or `*.workers.dev`. `/proxy/*`, `/healthz` and
  `/readyz` are never pinned. They answer on every hostname.
- **Entries:** the same format as the [upstream host allowlist](#upstream-host-allowlist): an exact
  hostname (`tokengate.example.com`) or `*.<domain>`, which matches the hosts below the domain but not
  the domain itself. `localhost`, `127.0.0.1` and `[::1]` are also valid. No scheme, port or path.
  Entries on `workers.dev` are refused.
- **Save rules:** the list cannot be empty, and it must keep the hostname you use at that moment. So an
  owner cannot lock themselves out. Put every hostname you add behind your Cloudflare Access
  application.
- **Self-exclusion:** a service base URL can never point at an admin host (wildcards included) or at the
  host the request arrived on ([I-SSRF-1](threat-model.md#i-ssrf-1)).
- **Request origin:** the admin UI has no fixed origin. The CSRF `Origin` check, invitation links and
  the proxy URL snippets use the origin of the current request. Host pinning makes this safe.
- **Stored value:** key `admin_hosts` in the `settings` table, a JSON array. A stored value that is not
  a valid list denies every host (fail closed). To recover, see
  [operations/break-glass.md](operations/break-glass.md#lost-admin-host).
- Settings > System status shows the list, or "not set yet: set on the first sign-in."

## Upstream host allowlist

The hosts that service base URLs may use. It is a setting in the admin UI, not a variable: Settings >
"Upstream hosts". Only owners can change it (permission `settings:write`). Admins cannot widen it.
Each change writes a `settings.upstream_hosts` audit event.

- **Empty (the default):** any public https host is allowed. You can load a credential for any
  upstream. IP literals, `localhost`, `*.workers.dev` and the gateway's own hosts ([admin hosts](#admin-hosts) and the request host) are always refused
  ([I-SSRF-1](threat-model.md#i-ssrf-1)).
- **Entries:** one per line, or separated by commas or spaces. `api.example.com` matches that host
  only. `*.example.com` matches any host below it (`a.example.com`, `a.b.example.com`) but not
  `example.com` itself. A wildcard needs at least two labels after `*.`: `*.com` is invalid. Entries
  are lowercased and duplicates removed. An invalid entry refuses the whole save and names the entry.
- **Where it applies:** when a service is saved, with the error "host ... is not in the upstream host
  allowlist (Settings)", and on every proxied request. The proxy reads the list in its per-request D1
  batch, so a change applies to the next request. A service outside the list answers
  `503 not_configured` (reason `base_url_invalid`). Settings names the services that point outside it.
- **Stored value:** key `allowed_upstream_hosts` in the `settings` table, a JSON array or `null`. A
  stored value that is not a valid list denies every host (fail closed).

Hosts of the service templates (`src/admin/service-templates.ts`):

| Template | Host to list |
|---|---|
| Slack Web API | `slack.com` |
| Slack incoming webhook | `hooks.slack.com` |
| Discord webhook | `discord.com` |
| OpenAI API | `api.openai.com` |
| Anthropic API | `api.anthropic.com` |
| GitHub REST API | `api.github.com` |
| GitHub release asset uploads | `uploads.github.com` |

## Bindings

| Binding | Type | Required | Purpose |
|---|---|---|---|
| `DB` | D1 (`tokengate`, `migrations/`) | Yes | Control plane: users, caller providers, services, grants, settings, audit log |
| `TELEMETRY_DB` | D1 (`tokengate-telemetry`, `migrations-telemetry/`) | Yes | Request log and hourly rollups |
| `ASSETS` | Static assets (`./public`) | Yes | Serves `/static/*` (the stylesheet) |
| `REQUEST_LOG_QUEUE` | Queue producer + consumer | Optional | Batches request-log writes |
| `REQUEST_ARCHIVE` | Pipelines stream | Optional | Archives every recorded request to R2 |
| `PROXY_RATE_LIMITER` | Rate limiting | Optional | Per-grant request ceiling |

The two databases are separate so telemetry volume can never fill the control plane.
`pnpm run deploy` applies the migrations of both, then deploys. Settings > System status shows whether
each optional binding is present.

### `REQUEST_LOG_QUEUE`

Without the queue, each request record is inserted into `TELEMETRY_DB` directly, in `waitUntil`. With
the queue, records are sent to it, and the consumer in the same Worker writes each batch in one D1 batch.

Workers Free includes 10,000 queue operations per day and keeps messages for 24 hours. One message
usually costs 3 operations (write, read, delete), and each retry adds a read. That is about 3,300 request
records per day. For more traffic, use Workers Paid
([Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)).

1. Create the queue and its dead-letter queue:

   ```sh
   pnpm wrangler queues create tokengate-request-log
   pnpm wrangler queues create tokengate-request-log-dlq
   ```

2. Uncomment the `queues` block in `wrangler.jsonc`.
3. Run `pnpm run deploy`.

| Consumer setting | Value | Why |
|---|---|---|
| `max_batch_size` | 100 | One D1 batch per queue batch |
| `max_batch_timeout` | 30 | Seconds to wait for a full batch |
| `max_retries` | 10 | Then the batch moves to the dead-letter queue |
| `max_concurrency` | 2 | D1 runs one query at a time; more consumers only add contention |
| `dead_letter_queue` | `tokengate-request-log-dlq` | Keeps batches D1 could not take; nothing consumes it |

Behavior (`src/telemetry/sinks.ts`, `src/telemetry/queue-consumer.ts`):

- If `send` to the queue fails, the record is inserted directly instead.
- Invalid messages are acknowledged and dropped. A D1 failure retries the whole batch after 30 seconds.
  Retries are safe: inserts are `INSERT OR IGNORE`.

### `REQUEST_ARCHIVE`

Archives every recorded request to R2 as Parquet through Basin Pipelines. Run
`scripts/setup-archive.sh --bucket <r2-bucket>`; it prints the binding to add:

```jsonc
"pipelines": [{ "binding": "REQUEST_ARCHIVE", "stream": "<stream-id>" }]
```

The archive receives the same records as the request log, after sampling. Setup, schema, retention and
queries: [observability.md](observability.md).

### `PROXY_RATE_LIMITER`

Caps the requests one grant can make, to limit the damage of a compromised workflow.

```jsonc
"ratelimits": [{ "name": "PROXY_RATE_LIMITER", "namespace_id": "<unique positive integer>", "simple": { "limit": 600, "period": 60 } }]
```

- The key is `grant:<grant id>`. One limit applies to every grant.
- `period` is 10 or 60 seconds. Use a `namespace_id` no other Worker uses: bindings that share it share
  counters.
- Counting is approximate and per Cloudflare location
  ([Cloudflare docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)).
- Over the limit, the caller gets `429 rate_limited` with `retry-after: 60`.
- If the binding itself fails, the request is allowed and `proxy.rate_limiter_failed` is logged. The
  limiter caps blast radius; it never authorizes.

## Runtime settings

Owners edit these under Monitoring › Data retention (`/admin/retention`), then select "Save". Every
other role sees them read-only. The page groups them as "Request records" (the first, fourth and
fifth row below), "Hourly summaries" and "Audit log". The numbers are prefilled and have suggestion
lists; the sample rate is a choice of 100 %, 50 %, 10 %, 1 % or 0 %. "Traffic summary retention" must
be at least "Request log retention", because the summaries back the Overview and "last used" for
every stored record. Each save that changes a value writes one audit event
([I-AUDIT-1](threat-model.md#i-audit-1)).

| Label | Key | Default | Min | Max |
|---|---|---|---|---|
| Request log retention (days) | `request_log_retention_days` | 14 | 1 | 3650 |
| Audit log retention (days) | `audit_log_retention_days` | 365 | 90 | 3650 |
| Traffic summary retention (days) | `rollup_retention_days` | 400 | 30 | 3650 |
| Share of allowed requests to record | `allowed_sample_rate` | 1 | 0 | 1 |
| Maximum request log rows | `request_log_max_rows` | 5,000,000 | 10,000 | 50,000,000 |

- Values outside the bounds are refused when saved. They are also clamped when read, so a direct D1
  edit cannot shorten the audit trail below 90 days.
- The hourly cron (`7 * * * *`) applies retention: it deletes request records, rollups and audit events
  older than their limits.
- `allowed_sample_rate` applies to allowed requests only. Denied and error records are always kept,
  except pre-trust failures (see [observability.md](observability.md)). With 0.1, about one allowed
  request in ten is recorded, and Overview counts are scaled up. With 0, no allowed request is recorded.
  The settings page recommends 0 on the Workers Free plan, to stay within the daily D1 write limit.

### `request_log_max_rows`

A soft cap, enforced by the hourly job (`src/telemetry/retention.ts`):

- Each run estimates the stored row count from the hourly rollups. When the estimate reaches the cap,
  it finds the exact boundary, which reads up to `request_log_max_rows` rows.
- At 03:00 UTC it always runs the exact check. This also catches rows the estimate cannot see: failed
  rollups, or a request log retention longer than the rollup retention.
- Records from the current hour and the 3 previous hours are never deleted for the cap, because the
  rollup job still recomputes those hours. The table can exceed the cap by about 4–5 hours of traffic.
- Rows of older hours that were not rolled up yet, for example after a `TELEMETRY_DB` outage or
  missed cron runs, can be deleted by the cap before the rollup catch-up reaches them. Those
  requests are then never counted in the summaries ([observability](observability.md#rollups)).
- Each run deletes at most 40 × 5,000 rows (about 200,000 per hour), shared between the age purge and
  the cap. The purge cannot keep up with sustained traffic above about 55 requests per second.
- Read cost: the estimate reads about (retention days × 24 × service/grant/outcome/status groups)
  rollup rows. The exact check reads up to min(stored rows, `request_log_max_rows`) rows: once a day
  normally, and every hour while the estimate is at or above the cap. The estimate counts sampled
  allowed requests at their weight, so with sampling it can reach the cap while the table is smaller.
  With the default 5,000,000 and sustained overflow, that is up to about 120 million rows read per day.
- On the Workers Free plan, keep the cap above the table size your traffic can reach. D1 Free allows
  100,000 rows written and 5 million rows read per day. With 14-day retention the table holds at most
  about 1.4 million rows. The daily exact check then reads at most the table size.
- If the cap is below the table size, every hourly run reads up to the cap: about 24 × cap rows per
  day. On D1 Free, a cap above about 200,000 then exceeds the daily read allowance. Check current
  [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

## `wrangler.jsonc` reference

| Key | Value | Why |
|---|---|---|
| `compatibility_flags` | `nodejs_compat` | Node.js compatibility. On by default from compatibility date 2026-08-04 ([docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)); listed for clarity |
| `compatibility_flags` | `global_fetch_strictly_public` | A same-zone upstream is fetched through Cloudflare's front door (Access, WAF), not straight from the origin ([I-SSRF-1](threat-model.md#i-ssrf-1), [docs](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)) |
| `workers_dev` | `true` | Enables the `*.workers.dev` URL for the quick start. Only `/proxy` and the health endpoints answer there; `/admin` needs a custom domain ([admin hosts](#admin-hosts)) |
| `preview_urls` | `false` | Version preview URLs would run old code against production data and secrets ([I-DEPLOY-1](threat-model.md#i-deploy-1)) |
| `observability.head_sampling_rate` | `1` | Audit events are `audit.event` log lines; sampling below 1 can drop them |
| `assets.run_worker_first` | `["/*", "!/static/*"]` | The Worker handles every path except `/static/*`, so security headers and host pinning always apply |
| `d1_databases` | `DB`, `TELEMETRY_DB` | No database IDs are committed; see [getting-started.md](getting-started.md) to create the databases |
| `triggers.crons` | `7 * * * *` | Hourly job: rollups, retention, credential expiry notices (`src/telemetry/cron.ts`) |
| `keep_vars` | `true` | Deploys keep variables set in the dashboard |

`scripts/check-config.sh` (run by `pnpm test:scripts` and CI) fails if `preview_urls` is not `false`,
`global_fetch_strictly_public` is missing, either D1 binding is missing, `head_sampling_rate` is not `1`,
`keep_vars` is not `true`, a var is blank, or the `deploy` script does not migrate `TELEMETRY_DB`.

## Fixed limits

These are constants in the code, not settings.

| Limit | Value | Source |
|---|---|---|
| Admin form body | 64 KiB; larger bodies get 413 and are not read past the limit | `src/admin/render.tsx` |
| Caller token length | 16 KiB | `src/proxy/caller-token.ts` |
| Proxied path length | 2048 characters | `src/proxy/path.ts` |
| Service timeout (time to response headers) | 1,000–900,000 ms; default 120,000 | `src/admin/ops/services.ts` |
| Caller token clock skew | 30 seconds | `src/identity/jwt.ts` |
| Pre-trust request records | 10 per minute per isolate | `src/telemetry/sinks.ts` |

## Related pages

- [getting-started.md](getting-started.md): first deployment, step by step.
- [policies.md](policies.md): caller providers, grants, conditions and rules.
- [errors.md](errors.md): gateway error codes.
- [observability.md](observability.md): request log, archive, health checks.
- [operations/cloudflare-zone-settings.md](operations/cloudflare-zone-settings.md): WAF, Bot Fight Mode, Access.
