# Configuration

This page lists every variable, secret, binding and runtime setting of cloudflare-tokengate. It is for
platform engineers who deploy and operate the gateway.

The code is the reference: variables are declared in `src/env.ts` and parsed in `src/config.ts`;
settings live in `src/db/settings.ts`.

## Where each kind of value lives

| Kind | Where you set it | Survives `pnpm run deploy` |
|---|---|---|
| Operator variable (`PUBLIC_URL`, `AUTH_*`, ...) | Cloudflare dashboard: Workers & Pages > tokengate > Settings > Variables and Secrets | Yes (`keep_vars: true`) |
| Secret (`TOKENGATE_KEK`, `*_CLIENT_SECRET`) | `pnpm wrangler secret put <NAME>` | Yes, always |
| Binding (D1, queue, pipeline, rate limiter) | `wrangler.jsonc` | Part of the deploy |
| Runtime setting (retention, sampling) | Admin UI: Settings > Data retention and sampling | Stored in D1 |

`wrangler.jsonc` sets `"keep_vars": true` and declares no `vars`. So `pnpm run deploy` and Workers Builds
keep the values you set in the dashboard. Set each variable in one place only.

If you prefer to keep configuration in git, add the variable with a non-empty value under `"vars"` in
your clone's `wrangler.jsonc`. Every deploy then overwrites the dashboard value. Never commit `""`
placeholders. An empty `PUBLIC_URL` turns off admin host pinning, and an empty `ALLOWED_UPSTREAM_HOSTS`
allows any public https upstream ([I-DEPLOY-1](threat-model.md#i-deploy-1), [I-SSRF-1](threat-model.md#i-ssrf-1)). Whitespace-only values count as
empty. `scripts/check-config.sh` rejects them, in top-level `vars` and in `env.<name>.vars` blocks.

Rolling back to an earlier Worker version (`pnpm wrangler rollback` or the dashboard) restores that
version's variables. After a rollback, check `PUBLIC_URL` and `ALLOWED_UPSTREAM_HOSTS` under Settings >
System status.

For local development (`pnpm dev`), put all variables and secrets in `.dev.vars`. Copy
`.dev.vars.example`. It lists every variable and secret with a comment, except `TOKENGATE_KEYRING`,
which it only mentions.

## How invalid configuration fails

Configuration is parsed per feature: `public_url`, `login.github`, `login.oidc`, `login.access` and
`upstream_hosts` ([I-CFG-1](threat-model.md#i-cfg-1)). A malformed feature is turned off; it never runs half
configured. Errors name the variable and never echo its value. They appear in two places:

- Settings > System status > "Configuration problems".
- The sign-in page, as error banners (login features only).

Values are trimmed. An empty or whitespace-only value counts as unset. Lists are comma-separated;
entries are trimmed and empty entries are dropped.

## Variables

| Name | Kind | Required | Format |
|---|---|---|---|
| `PUBLIC_URL` | var | Recommended; required for Access login | `https://host[:port]` origin |
| `ALLOWED_UPSTREAM_HOSTS` | var | Recommended | Comma list of hostnames, exact or `*.suffix` |
| `BOOTSTRAP_OWNER_EMAILS` | var | Until the first owner signs in | Comma list of emails |
| `TOKENGATE_KEK` | secret | One of `TOKENGATE_KEK` / `TOKENGATE_KEYRING` | Standard base64 of 32 bytes |
| `TOKENGATE_KEYRING` | secret | One of `TOKENGATE_KEK` / `TOKENGATE_KEYRING` | JSON keyring |
| `AUTH_GITHUB_CLIENT_ID` | var | For GitHub login | GitHub OAuth App client ID |
| `AUTH_GITHUB_CLIENT_SECRET` | secret | For GitHub login | GitHub OAuth App client secret |
| `AUTH_GITHUB_ALLOWED_ORGS` | var | Optional | Comma list of organization logins |
| `AUTH_OIDC_ISSUER` | var | For OIDC login | https issuer URL |
| `AUTH_OIDC_CLIENT_ID` | var | For OIDC login | Client ID |
| `AUTH_OIDC_CLIENT_SECRET` | secret | For OIDC login | Client secret |
| `AUTH_OIDC_NAME` | var | Optional | Button label text |
| `AUTH_OIDC_ALLOWED_DOMAINS` | var | Optional | Comma list of email domains |
| `AUTH_GOOGLE_CLIENT_ID` | var | For Google login | Google OAuth client ID |
| `AUTH_GOOGLE_CLIENT_SECRET` | secret | For Google login | Google OAuth client secret |
| `AUTH_ACCESS_TEAM_DOMAIN` | var | For Access login | `<team>`, `<team>.cloudflareaccess.com` or `https://<team>.cloudflareaccess.com` |
| `AUTH_ACCESS_AUD` | var | For Access login | Access application audience (AUD) tag |

At least one login provider is needed to use the admin UI. You can configure GitHub, one OIDC login
(generic or Google) and Access at the same time; the sign-in page shows one button for each.

### `PUBLIC_URL`

The canonical origin of the gateway, for example `https://tokengate.example.com`.

- **When set:** `/admin` and `/auth` answer only on this exact origin (scheme, host and port). Every
  other hostname, including `*.workers.dev`, gets `404 Not Found` ([I-DEPLOY-1](threat-model.md#i-deploy-1)). Login
  callback URLs and the snippets shown in the admin UI use this origin.
- **When unset:** `/admin` and `/auth` answer on every hostname of the Worker. Callback URLs use the
  origin of the current request.
- **When malformed:** every `/admin` and `/auth` request gets 404, and Access login is turned off. The
  operator asked for pinning, so a typo does not turn it off.
- **Rules:** https only (http only for `localhost`, `127.0.0.1`, `[::1]`); no credentials, path, query or
  fragment; no trailing dot on the host.
- `/proxy/*`, `/healthz` and `/readyz` are never pinned. They answer on every hostname.
- A service base URL can never point at this host or at the host the request arrived on
  ([I-SSRF-1](threat-model.md#i-ssrf-1)).

### `ALLOWED_UPSTREAM_HOSTS`

Upstream hosts that service base URLs may use, for example `api.github.com,slack.com,api.openai.com`.

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

To add a host, edit the variable in Workers & Pages > tokengate > Settings > Variables and Secrets
and deploy. Then create the service. Saving a service whose host is not listed fails with
"host ... is not listed in ALLOWED_UPSTREAM_HOSTS".

- `api.example.com` matches that host only. `*.example.com` matches any host below it
  (`a.example.com`, `a.b.example.com`) but not `example.com` itself. Matching is case-insensitive.
- A wildcard needs at least two labels after `*.`: `*.com` is invalid.
- **When unset:** any public https host is allowed. IP literals, `localhost`, `*.workers.dev` and the
  gateway's own host are always refused.
- **When malformed:** every host is denied. Saving a service fails. Existing services with a
  credential answer `503 not_configured` (reason `base_url_invalid`).
- The list is checked when a service is saved and again on every proxied request
  ([I-SSRF-1](threat-model.md#i-ssrf-1)). Removing a host stops its services on the next request.

### `BOOTSTRAP_OWNER_EMAILS`

Emails that may become the first owner, for example `alice@example.com`. Comparison is case-insensitive.

- The first person to sign in with a listed email becomes owner, only while no owner exists and only
  once per deployment ([I-BOOT-1](threat-model.md#i-boot-1)). The bootstrap is recorded in settings; it does not
  run again even if every owner is later removed. Recover with
  [operations/break-glass.md](operations/break-glass.md).
- The email must be one the login provider proves: a verified GitHub email, an OIDC `email` with
  `email_verified: true`, or the email of a valid Access token ([I-LINK-1](threat-model.md#i-link-1)).
- Remove the variable after the first sign-in. Settings > System status reminds you while it is set.

### Keyring: `TOKENGATE_KEK` or `TOKENGATE_KEYRING`

The key-encryption key that seals stored upstream credentials ([I-CRED-2](threat-model.md#i-cred-2)). Set exactly
one of the two.

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

- **When absent or invalid:** admin login still works. Proxied requests to a service with a credential
  answer `503 not_configured` with reason `keyring_absent`, `keyring_malformed`, `active_kid_missing`,
  `key_not_32_bytes` or `both_kek_and_keyring_set`. Credential changes are refused. The dashboard shows a
  banner and `/readyz` reports `keyring: false`.
- Rotation: [operations/key-rotation.md](operations/key-rotation.md).

### GitHub login: `AUTH_GITHUB_*`

1. Create a GitHub OAuth App. Set the authorization callback URL to `<PUBLIC_URL>/auth/github/callback`.
2. Set `AUTH_GITHUB_CLIENT_ID` and the secret `AUTH_GITHUB_CLIENT_SECRET`.
3. If only members of some organizations may sign in, set `AUTH_GITHUB_ALLOWED_ORGS` to their logins.

- With `AUTH_GITHUB_ALLOWED_ORGS`, the user's membership in one listed organization must be `active`.
  The login then also requests the `read:org` scope.
- Errors: only one of the ID/secret pair set; `AUTH_GITHUB_ALLOWED_ORGS` set without the pair; an
  invalid organization login.

### OIDC login: `AUTH_OIDC_*`

1. Register a client with your identity provider. Set the redirect URI to `<PUBLIC_URL>/auth/oidc/callback`.
2. Set `AUTH_OIDC_ISSUER`, `AUTH_OIDC_CLIENT_ID` and the secret `AUTH_OIDC_CLIENT_SECRET`.
3. Optional: set `AUTH_OIDC_NAME` (button label; default "Single sign-on") and
   `AUTH_OIDC_ALLOWED_DOMAINS`.

- `AUTH_OIDC_ISSUER` must be https without credentials, query or fragment. It must match the `issuer`
  in `<AUTH_OIDC_ISSUER>/.well-known/openid-configuration`. Both are compared as parsed URLs, so a
  trailing `/` after a bare host, an upper-case host or `:443` does not matter.
- Linked users are stored under the canonical issuer: lower-case host, no default port, no `/` after
  a bare host (`https://ACCOUNTS.google.com/` is stored as `https://accounts.google.com`). So you
  can change between these spellings, or between `AUTH_GOOGLE_*` and
  `AUTH_OIDC_ISSUER=https://accounts.google.com`, and users keep signing in. Any other change, such
  as a different path, is a different issuer: users linked before then get "not invited" until an
  owner uses "Reset login" (which invites them again) and they sign in from the invite. Users linked
  by an earlier version under the exact configured spelling keep signing in while that spelling
  stays the same.
- `AUTH_OIDC_ALLOWED_DOMAINS`: the verified email must be in a listed domain. Setting it without an
  OIDC or Google login is an error.
- Errors: a partial triple; an invalid issuer or domain; `AUTH_OIDC_*` combined with `AUTH_GOOGLE_*`
  (both are turned off).

### Google login: `AUTH_GOOGLE_*`

Google login is OIDC with issuer `https://accounts.google.com` and the label "Google".

1. Create a Google OAuth client (web application). Set the authorized redirect URI to
   `<PUBLIC_URL>/auth/oidc/callback`.
2. Set `AUTH_GOOGLE_CLIENT_ID` and the secret `AUTH_GOOGLE_CLIENT_SECRET`.
3. Optional: set `AUTH_OIDC_ALLOWED_DOMAINS` to your Workspace domains. `AUTH_OIDC_NAME` overrides the
   label.

- Do not combine with `AUTH_OIDC_ISSUER`/`AUTH_OIDC_CLIENT_*`.
- An email counts only if the `hd` claim equals its domain (Workspace account), or if it is a
  `@gmail.com` address without `hd`. With `AUTH_OIDC_ALLOWED_DOMAINS`, `hd` must be present and listed.
  A consumer Google account registered with a company address never qualifies. The same rules apply
  when `AUTH_OIDC_ISSUER` is `https://accounts.google.com`, compared as a parsed URL (a trailing `/`
  or an upper-case host also selects them).

### Cloudflare Access login: `AUTH_ACCESS_*`

1. Set `PUBLIC_URL` to a custom domain. Access login refuses `workers.dev`.
2. Create an Access application for that hostname, limited to the `/admin` and `/auth` paths.
   See [operations/cloudflare-zone-settings.md](operations/cloudflare-zone-settings.md).
3. Set `AUTH_ACCESS_TEAM_DOMAIN` and `AUTH_ACCESS_AUD` (the application's AUD tag).

- The gateway verifies the `Cf-Access-Jwt-Assertion` header against the team's keys, issuer and AUD.
  Service-token JWTs (no email) are refused.
- Errors: only one of the pair set; an invalid team domain or AUD; `PUBLIC_URL` missing, not https or on
  `workers.dev`.

## Bindings

| Binding | Type | Required | Purpose |
|---|---|---|---|
| `DB` | D1 (`tokengate`, `migrations/`) | Yes | Control plane: users, sessions, caller providers, services, grants, settings, audit log |
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

Owners edit these under Settings > Data retention and sampling, then select "Save settings". Admins and
viewers see them read-only. Each save that changes a value writes one audit event
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
  older than their limits. It also deletes sessions that ended more than one day ago.
- `allowed_sample_rate` applies to allowed requests only. Denied and error records are always kept,
  except pre-trust failures (see [observability.md](observability.md)). With 0.1, about one allowed
  request in ten is recorded, and dashboard counts are scaled up. With 0, no allowed request is recorded.
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
| `workers_dev` | `true` | Enables the `*.workers.dev` URL for the quick start. Set `PUBLIC_URL` to pin the admin UI elsewhere |
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
