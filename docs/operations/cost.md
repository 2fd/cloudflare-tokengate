# Cost

This page estimates the monthly Cloudflare bill of a deployment at 1, 10 and 100 requests per second
and names the settings that change it. It is for platform engineers who plan capacity and budget.

Prices are Cloudflare's list prices for Workers Paid as of 2026-10-13, in USD. They change; check the
linked pricing pages before you rely on a number.

## Assumptions

- A month has 30 days (2,592,000 seconds). Every request is an allowed proxied call; admin traffic,
  denials and the hourly job are negligible.
- CPU time is 5 ms per proxied request (token verification, decryption, header handling). Measure
  yours in the Worker's metrics; time spent waiting for the upstream is not CPU time.
- Each stored request record costs 8 D1 rows written: 4 on insert (the row plus 3 index entries) and
  4 when the retention job deletes it. This is an estimate from the schema
  (`apps/gateway/migrations-telemetry/0001_initial.sql`).
- A stored record takes about 1.5 KB including indexes. Retention is 14 days and "Maximum request log
  rows" is 5,000,000 (defaults).
- D1 rows read stay inside the 25 billion included per month in every column: each proxied request
  reads about 15 control-plane rows.
- Workers Logs records one event per request. Successful proxied requests write no log line of their
  own.

| Item | Included per month | Price above | Source |
|---|---|---|---|
| Workers Paid subscription | | $5 | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Worker requests | 10 million | $0.30 per million | same |
| Worker CPU time | 30 million ms | $0.02 per million ms | same |
| D1 rows written | 50 million | $1.00 per million | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 rows read | 25 billion | $0.001 per million | same |
| D1 storage | 5 GB | $0.75 per GB-month | same |
| Workers Logs events | 20 million | $0.60 per million | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| Queues operations (3 per message) | 1 million | $0.40 per million | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| Basin Pipelines transform and delivery | 50 GB each | $0.04 and $0.06 per GB (Parquet) | [Basin Pipelines pricing](https://developers.cloudflare.com/basin-pipelines/platform/pricing/) |
| R2 storage | 10 GB | $0.015 per GB-month | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |

Workers Logs billing moves to Cloudflare Observability pricing on 2026-12-01.

## Estimate

"Sample" is the setting "Share of allowed requests to record" (`allowed_sample_rate`).

| | 1 rps, sample 1 | 10 rps, sample 1 | 10 rps, sample 0.1 | 100 rps, sample 0.1 | 100 rps, sample 0.01 |
|---|---|---|---|---|---|
| Requests per month | 2.59 M | 25.9 M | 25.9 M | 259 M | 259 M |
| Stored records per month | 2.59 M | 25.9 M | 2.59 M | 25.9 M | 2.59 M |
| Workers subscription | $5.00 | $5.00 | $5.00 | $5.00 | $5.00 |
| Worker requests | $0 | $4.78 | $4.78 | $74.76 | $74.76 |
| Worker CPU | $0 | $1.99 | $1.99 | $25.32 | $25.32 |
| Workers Logs | $0 | $3.55 | $3.55 | $143.52 | $143.52 |
| D1 rows written | $0 | $157.36 | $0 | $157.36 | $0 |
| D1 storage | $0 | $1.88 | $0 | $1.88 | $0 |
| **Total** | **$5.00** | **$174.56** | **$15.32** | **$407.84** | **$248.60** |

At 100 rps with sample 1, the retention job cannot keep up: it deletes at most about 200,000 rows per
hour (about 55 records per second), so the request log grows past its cap toward the 10 GB D1
database limit. Use a sample rate that keeps stored records well below 55 per second
([configuration](../configuration.md#request_log_max_rows)).

At 10 stored records per second, the table reaches the 5,000,000-row cap before the 14-day retention,
so it holds about 6 days of records and about 7.5 GB.

### Optional bindings

| Binding | 2.59 M stored records | 25.9 M stored records |
|---|---|---|
| `REQUEST_LOG_QUEUE` | $2.71 | $30.70 |
| `REQUEST_ARCHIVE` (about 1.2 KB per record; R2 Parquet assumed at 0.3 KB per record, 90-day lifecycle) | $0 | about $0.20 (R2 storage) |

The queue does not lower D1 rows written: it batches the same inserts into fewer queries. Use it for
D1 contention at high rates, not for cost.

## What drives the bill

1. **D1 rows written** grow with stored records. "Share of allowed requests to record" is the main
   control. Denied and error records are not sampled, so a sample rate below 1 keeps every failure
   except pre-trust records over their budget.
   The trade-off: fewer allowed calls appear in Requests and in the
   [R2 archive](../observability.md#optional-r2-archive). Dashboard counts stay estimates of the real
   traffic.
2. **Workers Logs** grows with every request. `observability.head_sampling_rate` must stay `1`,
   because audit events are log lines (`apps/gateway/scripts/check-config.sh`).
3. **Worker requests and CPU** grow with traffic and are hard to reduce.
4. **D1 storage** follows "Request log retention (days)" and "Maximum request log rows". The 10 GB
   limit per database applies to `TELEMETRY_DB` ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)).

## Measure your own numbers

- Worker requests and CPU time: Workers & Pages > tokengate > Metrics.
- D1 rows read and written: the Metrics tab of each D1 database in the Cloudflare dashboard.
- Database size: `pnpm wrangler d1 info tokengate-telemetry` and `pnpm wrangler d1 info tokengate`.
- Stored records per hour:

  ```sh
  pnpm wrangler d1 execute TELEMETRY_DB --remote --command "
    SELECT datetime(hour / 1000, 'unixepoch') AS hour, SUM(requests) AS requests
    FROM request_rollup_hourly GROUP BY hour ORDER BY hour DESC LIMIT 24"
  ```

  `requests` is weighted: it estimates real traffic, not stored rows.

## Workers Free plan

The Free plan is not a supported production target. It allows 100,000 Worker requests and 100,000
D1 rows written per day, which is about 12,500 stored records per day under the assumptions above.
On Free, set "Share of allowed requests to record" to `0`, as the Settings page advises, and see
[getting-started.md](../getting-started.md#workers-free-plan).

## Related pages

- [observability.md](../observability.md): what is recorded, and where.
- [configuration.md](../configuration.md#runtime-settings): retention and sampling settings.
