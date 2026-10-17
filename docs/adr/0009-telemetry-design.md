# 9. Telemetry in D1, optional queue and R2 archive, no Analytics Engine

This ADR explains how tokengate records requests and admin changes. It is for operators, security reviewers and contributors.

Date: 2026-10-13

## Status

Accepted

## Context

Operators need three kinds of data:

- **Per-request records for forensics and debugging.** Which caller called what, which grant allowed it, and why a request was denied. This must be exact, queryable by request id, repository or service, and kept for a known time.
- **Aggregates for the dashboard.** Requests, errors and latency per service over the last 24 hours.
- **Long-term history** for compliance, at low cost.

Workers Analytics Engine was considered. It samples writes per index value, and its retention is fixed at 3 months. Individual rows are not guaranteed, so it is not suitable for forensics. Source: https://developers.cloudflare.com/analytics/analytics-engine/sampling/

Logs must never contain caller tokens or credentials. Anyone on the internet can send requests that fail before verification, so their records must be bounded.

## Decision

- **Request log in D1.** One request record per proxied request in `TELEMETRY_DB.request_log` (`apps/gateway/src/telemetry/record.ts`). Records contain only allowlisted claims of verified callers. The only request headers copied are `cf-connecting-ip` and, for verified callers, `user-agent` ([I-LOG-1](../threat-model.md#i-log-1), [I-LOG-2](../threat-model.md#i-log-2)).
- **Sampling.** Allowed records are kept with probability `allowed_sample_rate`, each with `weight = 1 / rate`. Denied and error records are always kept. Records without a verified caller are capped at 10 per minute per isolate.
- **Rollups.** The hourly cron recomputes `request_rollup_hourly` from the request log for the last 3 closed hours. It then catches up at most 24 older hours after the `rollup_watermark`, so hours missed during an outage are filled in. A recompute never lowers a stored row, so a retention purge cannot shrink the summaries ([observability](../observability.md#rollups)). Counts are sums of weights.
- **Retention.** Owner-editable settings with floors: request log, rollups, audit log, and a soft row cap `request_log_max_rows`.
- **Optional queue.** When `REQUEST_LOG_QUEUE` is bound, records go through a Cloudflare Queue and are written in batches. If the send fails, the record is inserted directly. Inserts are `INSERT OR IGNORE` on the request id, so redelivery is safe.
- **Optional archive.** When `REQUEST_ARCHIVE` is bound, every record is also sent to a Pipelines stream that writes to R2 (`apps/gateway/scripts/setup-archive.sh`, `pipelines/request-log.v1.schema.json`).
- **Audit log.** Every admin mutation writes one audit event to `DB.audit_log` in the same batch as the change ([I-AUDIT-1](../threat-model.md#i-audit-1)). Each committed event is also logged as one `audit.event` JSON line for Workers Logs. `head_sampling_rate` is 1, so these lines are not sampled.
- **No Analytics Engine** in this version.

Details are in [observability.md](../observability.md).

## Consequences

- A denied request can be inspected in the admin UI, with its policy trace and "Create grant from this request".
- Each recorded request is one D1 row write. On high traffic, operators lower `allowed_sample_rate` or bind the queue. Plan limits and costs are in [observability.md](../observability.md).
- `request_log_max_rows` is a soft cap. The table can exceed it by a few hours of traffic, and the purge removes at most about 200,000 rows per hourly run.
- Pre-trust records beyond the per-isolate budget are counted but not stored.
- The archive needs manual setup, because the Deploy button does not provision Pipelines. The stream drops records that do not match the schema, so the schema file is versioned.
- Audit events reach a SIEM only through Workers Logs or its exports. tokengate does not push them anywhere itself.
- An Analytics Engine sink for metrics stays a possible later addition ([roadmap.md](../roadmap.md)).

## Note (2026-10-17)

[ADR 0023](0023-teams-replace-roles.md) adds `caller_provider_id` to the key of `request_rollup_hourly` (`''` when the issuer was unknown). A viewer who sees only some consumers then gets counts without the traffic of the other consumers. Only rows without a grant multiply, because a grant already fixes its consumer. Each audit event also gains `resources`: the token and consumer ids that the event shows, which decide who can read it.
