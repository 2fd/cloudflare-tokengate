# Observability

This page explains what the gateway records and how to watch it: the request log, rollups, the
Monitoring pages of the admin UI (Overview, Requests, Audit log, Data retention), health endpoints, the audit log, log lines for a SIEM and the optional R2 archive. It is for
platform engineers who operate a deployment.

![Request records: each proxy request writes one record, either directly to request_log in TELEMETRY_DB or through the optional REQUEST_LOG_QUEUE (batched insert); optionally the record also goes to a Pipelines stream that writes Parquet files to an R2 archive for DuckDB or Basin SQL. An hourly cron turns request_log into hourly rollups, which feed the Overview.](diagrams/telemetry.svg)

<sub>Diagram source: [`diagrams/src/`](diagrams/src/) (rendered with [archify](https://github.com/tt-a1i/archify)).</sub>

![Audit trail: every admin change writes its audit_log row in the same D1 batch, and after commit emits an audit.event log line to Workers Logs, which an OTel export can forward to a SIEM.](diagrams/audit-trail.svg)

<sub>Diagram source: [`diagrams/src/`](diagrams/src/) (rendered with [archify](https://github.com/tt-a1i/archify)).</sub>

## Request log

Every request to `/proxy/<slug>/...` produces at most one request record in `request_log`
(`TELEMETRY_DB`). The record is written in `waitUntil` and never delays or changes the response
(`apps/gateway/src/proxy/handler.ts`, step 16).

| Outcome | Meaning | Recorded |
|---|---|---|
| `allowed` | The upstream answered, with any status | With probability `allowed_sample_rate`; stored with `weight` = 1 / rate |
| `denied` | The gateway answered 4xx | Always, except pre-trust records over budget |
| `error` | The gateway answered 5xx | Always, except pre-trust records over budget |

### Fields

The columns are defined in `apps/gateway/migrations-telemetry/0001_initial.sql` and built only in
`apps/gateway/src/telemetry/record.ts`. Text columns are cut to fixed lengths (`RECORD_TEXT_LIMITS`).

| Field | Content |
|---|---|
| `id` | Request id `req_<ULID>`, also returned in `x-tokengate-request-id`. Time-ordered |
| `ts` | Request start, ms since the Unix epoch |
| `outcome`, `reason` | See above. `reason` is the error code or a finer reason code; `null` when the upstream answered ([reason codes](errors.md#request-record-reason-codes)) |
| `status`, `upstream_status` | Status returned to the caller; status from the upstream (`null` when not forwarded). `upstream_status` is the raw value fetch reported, any 32-bit signed integer (also outside 100 to 999, 0 or negative) for `upstream_invalid_status` |
| `method`, `path` | HTTP method; path after `/proxy/<slug>` as received (not decoded), without the query |
| `service_slug`, `service_id`, `caller_provider_id`, `grant_id` | What the pipeline resolved. `service_slug` is the slug from the URL, even for unknown services |
| `claims_verified` | `1` when the caller token was verified and the tenant pin held, else `0` |
| `caller_subject`, `caller_repository` | Display values from the verified claims |
| `caller_claims` | JSON of the profile's allowlisted claims (for example `repository`, `ref`, `run_id`, `sha` for GitHub Actions) |
| `jti` | The token's `jti` claim |
| `untrusted_iss` | The unverified `iss`, only on pre-trust records |
| `eval_trace` | Policy trace (JSON, at most 2 KB), only for requests denied by authorization |
| `duration_ms`, `upstream_ms` | Time to response headers: total, and upstream only |
| `weight` | 1 / sample rate for allowed records, 1 otherwise |
| `ip`, `user_agent`, `colo` | `cf-connecting-ip`, `user-agent` (verified callers only), Cloudflare location |

A Request record never holds a caller token, a credential or any request header except `user-agent`
([I-LOG-1](threat-model.md#i-log-1)). Claims are copied only from a verified, tenant-pinned token
([I-LOG-2](threat-model.md#i-log-2)).

### Pre-trust records

A pre-trust record is a failure before the caller is verified and the tenant pin holds: for
example `token_missing`, `issuer_unknown`, `signature_invalid` or `tenant_mismatch`. Anyone on the
internet can produce them, so they are limited (`apps/gateway/src/telemetry/sinks.ts`, `apps/gateway/src/telemetry/record.ts`):

- At most 10 records per minute per isolate. Records over the budget are dropped and counted. One
  `telemetry.pretrust_records_dropped` warning per minute reports the count.
- `claims_verified` is `0` and every caller field is empty.
- `path` is cut to 256 characters, `untrusted_iss` to 128, and `user_agent` is not stored.

The request log is therefore not a complete record of anonymous probing
([known limitations](threat-model.md#availability-and-traffic)).

### Retention, sampling and size

Owners change these under Monitoring › Data retention (`/admin/retention`); every other role sees
the values. Defaults, bounds and the exact behavior of `request_log_max_rows` are in
[configuration.md](configuration.md#runtime-settings).

- The hourly job deletes records older than "Request log retention (days)" (default 14), oldest
  first.
- "Maximum request log rows" (default 5,000,000) is a soft cap. The table can exceed it by about 4–5
  hours of traffic. Each run deletes at most about 200,000 rows, so the purge cannot keep up with
  sustained recorded traffic above about 55 requests per second. Above that rate, lower "Share of
  allowed requests to record".
- A D1 database holds at most 10 GB on Workers Paid
  ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). Measure the current size with
  `pnpm wrangler d1 info tokengate-telemetry`. The control plane is a separate database, so a full
  telemetry database does not stop admin changes or the proxy.

### Requests page

Monitoring › Requests (`/admin/requests`) lists records newest first, 50 per page, with Newest,
Newer and Older links.

- **Find a request:** the Overview, Requests, Audit log and Data retention pages have this box.
  Paste the `x-tokengate-request-id` value, or the whole log line that holds it, in any case. The
  page opens that record, or says it does not exist (records are kept for "Request log retention
  (days)").
- **Tabs:** Time range (1 hour, 24 hours, 7 days, 30 days, All) and Outcome (All, Allowed, Denied,
  Errors). "Errors" are gateway errors plus allowed requests the upstream answered with 5xx, the
  same count as the Overview. A time range starts at the start of an hour (UTC), so the page states
  the actual start ("since …").
- **Filter form:** it shows when a filter is active or the page has more than 10 rows. Token,
  Service consumer and Reason are lists; Repository is the only typed
  filter (exact `owner/name`). Its suggestions are the repository labels stored on consumers and
  accesses, never values from the request log. "Refused before a token was chosen" and "No
  consumer" select the records without a token or consumer.
- **Cells are filters:** select a token, repository, consumer, access or reason in a row to filter
  by it. Each active filter is a chip; select it to remove that filter.
- **Index use:** the token, the repository or the consumer access alone, and the Denied and Errors
  tabs alone, use indexes and search the whole log (the Denied and Errors tabs use the partial
  index `request_log_problems`). Other filters and combinations search 10,000 requests at a time, so
  one page reads at most about 20,000 rows; "Search older" searches the next 10,000.
- **A record:** the page says what to do for its reason, with at most two links (for example "Give
  access from this request" or "Set the secret again"), each shown only to the roles that can do
  it. It always re-runs authorization against the current consumer accesses with the stored claims
  only ("Check against current access"); claims that were not stored fail closed, and nothing is
  changed. A disabled consumer or token, or a tenant pin that fails, refuses the request before any
  access applies, so the check then says "Would still be refused" even when an access matches.
- "Give access from this request" is offered for a denied, verified record with reason
  `no_matching_grant` or `event_not_trusted`, to access managers, admins and owners, until the
  re-check says the request would now be allowed. Records of tokens that were not verified never
  prefill a form ([I-LOG-2](threat-model.md#i-log-2)).

There is no filter for `jti` or `run_id`. Use SQL instead
([incident response](operations/incident-response.md#investigate-the-request-log)).

## Rollups

The hourly job (`apps/gateway/src/telemetry/cron.ts`, cron `7 * * * *`, UTC) aggregates `request_log` into
`request_rollup_hourly` (`apps/gateway/src/telemetry/rollup.ts`):

1. It recomputes the last 3 closed hours. This counts queue deliveries that arrive up to about 2
   hours late.
2. It catches up older hours. The settings key `rollup_watermark` (in `DB`) holds the newest hour
   whose records are all counted. After a complete run it is the hour before the 3 recomputed
   hours, because records for those hours can still arrive and only the job counts them. Each run
   recomputes at most 24 hours after the watermark, oldest first, and then moves the watermark over
   the hours it finished. Hours missed while the job failed (for example a `TELEMETRY_DB` outage)
   or while the cron trigger did not fire are filled in on the next successful runs.
3. The queue consumer rolls up the hours of records that arrive after the job's 3-hour window, for
   example a [dead-letter queue replay](#optional-request-log-queue).

A recompute never lowers a stored rollup. It replaces a row only when the request log now holds
more requests for it, and it keeps rows the request log no longer has. A retention purge therefore
cannot shrink the summaries. Re-running a recompute is idempotent.

- One row per hour, service, grant, outcome and status class (`floor(status / 100)`).
- Counts are sums of `weight`, so they estimate real traffic when sampling is on.
- `upstream_auth_fail` counts allowed requests the upstream answered with 401 or 403.
- Each row has a histogram of `duration_ms` in buckets ≤ 50, ≤ 100, ≤ 250, ≤ 500, ≤ 1000,
  ≤ 2500, ≤ 5000 and > 5000 ms (`LATENCY_BUCKETS` in `apps/gateway/src/db/rollups.ts`). The Overview uses only
  the rows of allowed requests for p50 and p95.
- Rollups are kept for "Traffic summary retention (days)" (default 400).

Limits:

- Only rows still in `request_log` can be counted. If "Maximum request log rows" or "Request log
  retention (days)" deletes rows of an hour before that hour is rolled up, those requests are
  missing from the summaries. The cap never deletes rows of the current hour or of the last 3 closed
  hours.
- Late records for an hour that a purge already thinned are counted only where the recompute then
  holds more requests than the stored row. Otherwise the stored row stays and the late records are
  not added.
- After a long outage, each run closes about 23 hours of the gap (24 caught up, 1 new hour).
  Until the gap is closed, the Overview undercounts the missing hours.
- If the queue consumer cannot roll up a late batch, it retries the whole batch (log line
  `telemetry.late_rollup_failed`). The records are already stored, so the retry does not duplicate
  them.

### Recompute rollups manually

To recompute every hour that is still in the request log, delete the watermark. The next runs
recompute from the oldest stored record, 24 hours per run:

```sh
pnpm wrangler d1 execute DB --remote --command "DELETE FROM settings WHERE key = 'rollup_watermark'"
```

To recompute from a given hour instead, set the watermark to the hour before it, in milliseconds
since the epoch (UTC), for example 2026-10-12 23:00 for a recompute from 2026-10-13 00:00:

```sh
pnpm wrangler d1 execute DB --remote --command "INSERT OR REPLACE INTO settings (key, value, updated_at, updated_by) VALUES ('rollup_watermark', '1791846000000', 0, NULL)"
```

Stored rollups are never lowered by either method. A manual recompute adds requests that are still
in the request log but missing from the summaries.

## Overview

Monitoring › Overview (`/admin`, `apps/gateway/src/telemetry/dashboard.ts`) answers "is everything OK?" on one
page. Nothing refreshes by itself: the page says when it was built and has a Refresh link.

- **Range:** 24 hours, 7 days or 30 days (`?range=24h|7d|30d`). The page states the start. Buckets
  are UTC-aligned: 24 one-hour, 28 six-hour or 30 one-day bars, the last one partial ("so far")
  (`apps/gateway/src/telemetry/ranges.ts`). Requests uses the same rule, so a count and the list it links to
  cover the same window.
- **Data:** stored rollups for the closed hours, plus a live aggregate of the request log for each
  hour not rolled up yet (the current hour, and the previous hour until the job has succeeded in the
  current hour).
- **Health:** every alert (below), then "All checks": the two database schemas, the hourly job
  (last success, last error, next run), encryption keys, sign-in, admin hosts, the optional
  bindings and configuration problems by variable name, never by value.
- **Get started:** the four first steps (add a service token, add a service consumer, give a
  consumer access, make the first call), shown until all four are done. Each step links to its
  form, or says whom to ask.
- **Traffic:** Requests, Allowed, Denied, Errors (count and share), p50 and p95, each count a link
  to the matching Requests list; then a bar chart with a "Show the numbers" table. **Errors** are
  gateway errors plus allowed requests the upstream answered with 5xx, the same as the Requests
  Errors tab. p50 and p95 are interpolated from the latency buckets of allowed requests; a value in
  the last bucket is shown as a lower bound.
- **Tokens in use:** one row per token with its status, the consumer accesses that can use it
  ("Used by"), its requests, denied and errors in the range, p95 and last use. Tokens with a
  problem come first; tokens without traffic or problems are folded under "N idle tokens".
  "Refused before a token was chosen" counts requests to unknown slugs and earlier failures.
- **Top denials:** the 10 largest groups of denied requests in the range, by consumer, token,
  reason and repository (or the unverified issuer), from the newest 2,000 denials. The action is
  "Create access" (a verified `no_matching_grant` or `event_not_trusted` group, for access
  managers, admins and owners), "Add a service consumer" (`issuer_unknown`), or "See requests".
- **Recent changes:** the last 5 audit events.

When `allowed_sample_rate` is below 1 the page says counts are estimates; at 0 it says allowed
requests and "last used" are not recorded.

### Health and alerts

Alerts are a static list (no `role=alert`): errors, then warnings, then notes. One item per kind
names every affected object. Each item links to the objects it concerns for every role; the fix
link is shown only to the roles that can make the fix, and everyone else is told whom to ask. Owners
can approve pending people and re-encrypt secrets from the item itself. Schema and hourly-job alerts
link to their row of "All checks" (`/admin#check-schema`, `#check-telemetry-schema`,
`#check-maintenance`), which is open while a check fails. Every page except the
Overview also shows a one-line health strip for errors that are cheap to check (keys not loaded,
missing migrations, configuration problems). The texts below are abbreviated.

| Level | Condition | What to do |
|---|---|---|
| error | "Encryption keys are not loaded (`<error>`)" | Set or fix `TOKENGATE_KEK` / `TOKENGATE_KEYRING` ([key rotation](operations/key-rotation.md)) |
| error | Tokens use a key the keyring no longer has | Add the key back ([key rotation](operations/key-rotation.md#remove-the-old-key)) |
| error | A key id now holds a different key (key check value changed) | [Recover a replaced key](operations/key-rotation.md#recover-from-a-replaced-key) |
| error | Stored secrets are damaged (not valid sealed values) | Check the base URL out of band, then set the secret again |
| error / warning | A secret has expired / expires within 14 days | [Rotate the secret](operations/credential-rotation.md) |
| warning | A token with consumer accesses has no secret | Add the secret on the token page |
| warning | The upstream rejected a token | At least 5 and at least 50% of forwarded requests got 401/403 in the last 15 minutes. [Rotate the secret](operations/credential-rotation.md) |
| warning | Tokens point at hosts that Allowed hosts refuses | Change the token or Service tokens › Allowed hosts |
| error | "Database `<binding>` is missing migration ..." | `pnpm wrangler d1 migrations apply <binding> --remote` ([upgrades](operations/upgrades.md)) |
| warning | Database has migrations newer than this deployment | Expected after a rollback ([upgrades](operations/upgrades.md#roll-back)) |
| warning | Could not read the applied migrations | Check the D1 binding |
| error | Configuration problem (variable name and message) | [configuration.md](configuration.md) |
| error | The hourly job failed | Read the message; see [troubleshooting](operations/troubleshooting.md#admin-ui-and-maintenance) |
| warning | The hourly job last succeeded more than 2 hours ago | Same |
| info | The hourly job has not run yet | Normal for up to an hour after the first deploy |
| warning | A consumer access expires within 14 days | Extend it on the access page |
| warning | People need a decision (pending approval or a refused sign-in) | Users › People |
| info | Secrets use a key other than the active key | Re-encrypt them ([key rotation](operations/key-rotation.md)) |
| info | There is only one active owner | Invite a second owner ([break-glass](operations/break-glass.md)) |

### Data retention

Monitoring › Data retention (`/admin/retention`) groups the runtime settings: "Request records"
(retention, the share of allowed requests to record, the row cap), "Hourly summaries" (summary
retention) and "Audit log" (audit retention). It shows an upper estimate of the stored records and
the records kept a day in the last 7 days, and suggests a row cap from that rate. The sample rate is
a choice of 100 %, 50 %, 10 %, 1 % or 0 %; a stored value that is not one of these is kept as its
own "(current)" choice. Summary retention cannot be shorter than request record retention. Only
owners can save; a save writes one `settings.update` audit row, and a save without changes writes
none.

## Health endpoints

Both endpoints are unauthenticated, are not pinned to the admin hosts, and send `cache-control:
no-store` (`apps/gateway/src/health.ts`).

**`GET /healthz`** returns `200 {"ok":true}`. It does no I/O. Use it for liveness only.

**`GET /readyz`** returns `200` when every check is `true`, else `503`:

```json
{ "ok": true, "checks": { "db": true, "telemetry_db": true, "keyring": true, "cron": true, "schema": true } }
```

| Check | True when |
|---|---|
| `db`, `telemetry_db` | `SELECT 1` succeeds on `DB` / `TELEMETRY_DB` |
| `keyring` | The keyring loads; every key id used by a stored credential is present with an unchanged key check value; no stored credential is malformed |
| `cron` | The last run did not fail, and the last success is at most 2 hours old. Also true before the first run, unless that run failed |
| `schema` | Both databases have this build's newest migration (a newer one is also accepted) |

- The answer has booleans only: no key ids, counts or error text.
- Each isolate caches the answer for 10 seconds, so `/readyz` cannot be used to load D1.
- A `503` does not stop the proxy. Point your uptime monitor at `/readyz` and alert on non-200.

## Audit log

Every admin change writes exactly one row to `audit_log` (`DB`) in the same D1 batch as the change
([I-AUDIT-1](threat-model.md#i-audit-1)). A first sign-in that links a login or creates the first owner, and
the hourly job, also write rows. Other admin requests write none: the gateway keeps no sessions. Secrets are
replaced with `[redacted]` in diffs ([I-CRED-1](threat-model.md#i-cred-1)). Saving a form without
changes writes nothing.

Monitoring › Audit log (`/admin/audit`) lists events newest first. The tabs filter by time range
(24 hours, 7 days, 30 days, 90 days, All) and category (Tokens, Consumers, Access, Users, Sign-ins,
System); the lists (shown when a filter is active or the page has more than 10 events) filter
by object (`?target=<id>`, `settings` or `keyring`) and by who made the
change (`?actor=<user id>`, an email, or `system`). Every object page has a History link to its
events. Each event shows the changed fields as a Before and After table. Retention is "Audit log
retention (days)": default 365, never less than 90.

| Area | Actions |
|---|---|
| Caller providers | `caller_provider.create`, `.update`, `.enable`, `.disable`, `.delete` |
| Services | `service.create`, `.update`, `.enable`, `.disable`, `.delete`, `service.credential.set`, `service.credential.test` |
| Grants | `grant.create`, `.duplicate`, `.update`, `.enable`, `.disable`, `.delete` |
| Users | `user.invite`, `.resend_invite`, `.update` (also approve and reject), `.reset_login`, `.link`, `.bootstrap`, `.join`, `.join_defaults` |
| System | `settings.update`, `settings.upstream_hosts`, `settings.admin_hosts`, `keyring.rewrap`, `config.export`, `credential.expiring` (hourly job, actor `system`) |

Changes made directly in D1 (`wrangler d1 execute`) are not audited.

### `audit.event` log lines for a SIEM

After the batch commits, each audit event is also written to the Worker log as one JSON line
(`emitAuditLine` in `apps/gateway/src/db/audit.ts`):

```json
{"type":"audit.event","id":"aud_...","ts":1791876649000,"actor_type":"user","actor_id":"usr_...","actor_email":"admin@example.com","action":"grant.disable","target_type":"grant","target_id":"grt_...","summary":"...","diff":{"before":{"enabled":true},"after":{"enabled":false}},"ip":"203.0.113.7","user_agent":"..."}
```

- `wrangler.jsonc` sets `observability.head_sampling_rate` to `1`, and `apps/gateway/scripts/check-config.sh`
  enforces it: a lower rate can drop audit lines.
- The D1 table is the source of truth. A line can be missing if the isolate stops between commit
  and log; the row is not.
- Workers Logs keeps logs for 7 days on Workers Paid (3 on Free). For longer retention, export the
  logs to your SIEM.

To read audit lines live:

```sh
pnpm wrangler tail --format json | jq -c '.logs[].message[0] | fromjson? | select(.type == "audit.event")'
```

### Other log lines

Every line is one JSON object with a `type`. None contains a token, a credential or error text from
a sink ([I-LOG-1](threat-model.md#i-log-1)).

| `type` | Level | Meaning |
|---|---|---|
| `proxy.internal_error` | error | Unexpected failure in the pipeline; only the error name is logged |
| `proxy.upstream_failed` | warn | Upstream fetch failed (`code`: `upstream_timeout` or `upstream_unreachable`; `error`: the error name), or the upstream answered with a status outside 200 to 599 (`code`: `upstream_unreachable`, `error`: `InvalidStatus`) |
| `proxy.rate_limiter_failed` | error | `PROXY_RATE_LIMITER` threw; the request was allowed |
| `proxy.record_failed` | error | The request record could not be built |
| `telemetry.sink_failed` | error | `code`: `request_log_queue_send_failed`, `request_log_insert_failed` or `request_archive_send_failed` |
| `telemetry.pretrust_records_dropped` | warn | Pre-trust records dropped in the last minute (`count`) |
| `telemetry.invalid_queue_message` | error | A queue message was not a valid request record; dropped |
| `telemetry.queue_batch_failed` | error | The consumer could not write a batch; retried in 30 s |
| `telemetry.late_rollup_failed` | error | The consumer stored a batch but could not roll up its late hours (`hours`); retried in 30 s |
| `cron.done` / `cron.failed` | info / error | Hourly job summary or failed steps |
| `auth.login_failed` | warn | An admin request had no valid Cloudflare Access token (`error`: `missing`, `invalid`, `no_email` or `certs_unavailable`) |
| `auth.login_denied` | warn | A valid Access identity was refused (`provider`, `reason`: `email_taken`, `pending` or `suspended`) |
| `service.credential.test_result` | info | Result of "Test credential": `audit_id` (the `service.credential.test` audit event written before the check was sent), `service_id`, `status`, `passed`, `error` |

### Workers Logs and OpenTelemetry

`wrangler.jsonc` enables Workers Logs (`observability.enabled: true`). Query the logs in the
Cloudflare dashboard under the Worker's Observability tab, filtered by `type`.

To ship logs to a SIEM, add an OpenTelemetry destination in the Cloudflare dashboard, then list it
in `observability.logs.destinations` in `apps/gateway/wrangler.jsonc`
([OpenTelemetry export](https://developers.cloudflare.com/workers/observability/opentelemetry-export/)).
Keep `head_sampling_rate` at `1`. Workers Logs billing moves to Cloudflare Observability pricing on
2026-12-01 ([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)).

## Optional: request-log queue

`REQUEST_LOG_QUEUE` batches request-log writes: the consumer writes up to 100 records in one D1
batch, which lowers D1 query contention at high request rates. It does not lower D1 rows written, and
it adds queue operations to the bill ([cost](operations/cost.md)). Records reach D1 up to 30 seconds
later, so the Overview's live hour lags. Setup and consumer settings:
[configuration.md](configuration.md#request_log_queue).

Batches that fail 10 times go to `tokengate-request-log-dlq`, which nothing consumes. To replay them,
add a second entry to `queues.consumers` for `tokengate-request-log-dlq` with the same settings and
run `pnpm run deploy`. The Worker's queue handler writes any batch it receives, and inserts are
`INSERT OR IGNORE`, so a replay cannot duplicate records. Replayed records are usually older than
the hourly job's 3-hour window, so the consumer also rolls up their hours, and the Overview counts
them ([rollups](#rollups)). Remove the entry afterwards.

## Optional: R2 archive

`REQUEST_ARCHIVE` sends every stored request record, without `eval_trace`, to a Basin Pipelines
stream that writes zstd Parquet files to R2. It receives the same records as the request log, after
sampling and the pre-trust budget. Basin Pipelines requires Workers Paid.

### Set up

1. Log in: `pnpm wrangler login`.
2. Run the setup script. It creates the bucket if missing, the stream `<name>_v1`, the R2 sink
   `<name>_r2` and the pipeline `<name>`:

   ```sh
   bash apps/gateway/scripts/setup-archive.sh --bucket <r2-bucket> --retention-days 90
   ```

   Options: `--prefix` (default `requests`), `--name` (default `tokengate_requests`).
3. Get the stream id: `pnpm wrangler basin pipelines streams get tokengate_requests_v1`.
4. Add the binding to `apps/gateway/wrangler.jsonc`:

   ```jsonc
   "pipelines": [{ "binding": "REQUEST_ARCHIVE", "stream": "<stream-id>" }]
   ```

5. Run `pnpm run deploy`.
6. Add the lifecycle rule the script printed. It deletes files older than the retention:

   ```sh
   pnpm wrangler r2 bucket lifecycle add <r2-bucket> expire-tokengate_requests requests/ --expire-days 90
   ```

7. Check Monitoring › Overview › Health › All checks: "REQUEST_ARCHIVE" shows "Bound.".

Files are written every 300 seconds under `<prefix>/year=YYYY/month=MM/day=DD/`. Lifecycle rules
count days from each file's creation and delete within about a day after expiry
([R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)).

### Schema

The stream schema is `pipelines/request-log.v1.schema.json`: the request-log columns except
`eval_trace`, plus `schema_version` (`1`). `apps/gateway/src/telemetry/archive.ts` copies only these fields. A
stream schema and pipeline SQL cannot be changed after creation. A new schema version means a new
stream (for example `tokengate_requests_v2`) and a new binding.

### Dropped records

The stream accepts records that do not match the schema and then drops them without an error to the
Worker ([manage streams](https://developers.cloudflare.com/basin-pipelines/streams/manage-streams/)).
Send failures appear as `telemetry.sink_failed` with `code` `request_archive_send_failed`. Schema
drops appear only in the GraphQL Analytics API dataset `pipelinesUserErrorsAdaptiveGroups`
([metrics](https://developers.cloudflare.com/basin-pipelines/observability/metrics/)). The API token
needs Account Analytics Read:

```sh
curl -sS https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer $CF_ANALYTICS_TOKEN" \
  --data '{"query":"query { viewer { accounts(filter: {accountTag: \"<account-id>\"}) { pipelinesUserErrorsAdaptiveGroups(limit: 50, filter: {datetime_geq: \"2026-10-12T00:00:00Z\"}) { count dimensions { errorFamily errorType } } } } }"}'
```

Error types include `missing_field`, `type_mismatch`, `parse_failure` and `null_value`.
`pipelinesOperatorAdaptiveGroups` (`recordsIn`, `decodeErrors`) and `pipelinesSinkAdaptiveGroups`
(`recordsWritten`, `filesWritten`) show the volume.

### Query with DuckDB

Create an R2 API token with Object Read for the bucket, then:

```sql
INSTALL httpfs; LOAD httpfs;
CREATE SECRET (TYPE R2, KEY_ID '<r2-access-key-id>', SECRET '<r2-secret-access-key>', ACCOUNT_ID '<account-id>');

SELECT to_timestamp(ts / 1000) AS time, outcome, reason, status, upstream_status, method,
       service_slug, path, caller_repository, jti,
       json_extract_string(caller_claims, '$.run_id') AS run_id
FROM read_parquet('r2://<r2-bucket>/requests/year=2026/month=10/*/*.parquet', hive_partitioning = true)
WHERE caller_repository = 'octo-org/app'
ORDER BY ts DESC
LIMIT 100;
```

To count requests, use `SUM(weight)`, not `COUNT(*)`: sampled allowed records carry
`weight` = 1 / sample rate.

## Cost

Estimated monthly totals on Workers Paid, at list prices as of 2026-10-13, without optional bindings.
"Sample" is "Share of allowed requests to record". The assumptions (5 ms CPU per request, 8 D1 rows
written per stored record, 14-day retention) and the per-item breakdown are in
[cost.md](operations/cost.md).

| Traffic | Sample 1 | Sample 0.1 | Sample 0.01 |
|---|---|---|---|
| 1 request per second | $5.00 | | |
| 10 requests per second | $174.56 | $15.32 | |
| 100 requests per second | not sustainable (purge limit) | $407.84 | $248.60 |

D1 rows written and Workers Logs dominate at higher rates. "Share of allowed requests to record" is
the main control.

## Related pages

- [configuration.md](configuration.md): settings, bindings and `wrangler.jsonc`.
- [errors.md](errors.md): error codes and request record reason codes.
- [operations/troubleshooting.md](operations/troubleshooting.md): symptoms and fixes.
- [operations/incident-response.md](operations/incident-response.md): investigate with the request log.
