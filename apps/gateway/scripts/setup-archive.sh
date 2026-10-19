#!/usr/bin/env bash
# Creates the optional request-log archive: a Basin Pipelines stream with the request record
# schema, an R2 sink writing zstd Parquet partitioned by day, and the pipeline joining them.
# Prints the wrangler.jsonc binding and the R2 lifecycle command that enforces retention.
# Requires Workers Paid and `pnpm wrangler login`. See docs/observability.md.
# Reference: https://developers.cloudflare.com/basin-pipelines/
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: apps/gateway/scripts/setup-archive.sh --bucket <r2-bucket> [options]

  --bucket NAME          R2 bucket for archive files (created if missing)   (required)
  --retention-days N     days to keep archive files (default: 90)
  --prefix PATH          object prefix inside the bucket (default: requests)
  --name NAME            base name for stream/sink/pipeline (default: tokengate_requests_v2)
  -h, --help             show this help

The stream schema (pipelines/request-log.v2.schema.json) and the pipeline SQL cannot be changed
after creation; a new schema version means a new stream (e.g. tokengate_requests_v3).
USAGE
}

bucket=""
retention_days=90
prefix="requests"
name="tokengate_requests_v2"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket) bucket="${2:?--bucket needs a value}"; shift 2 ;;
    --retention-days) retention_days="${2:?--retention-days needs a value}"; shift 2 ;;
    --prefix) prefix="${2:?--prefix needs a value}"; shift 2 ;;
    --name) name="${2:?--name needs a value}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$bucket" ]]; then
  echo "--bucket is required" >&2
  usage >&2
  exit 2
fi
if ! [[ "$retention_days" =~ ^[1-9][0-9]*$ ]]; then
  echo "--retention-days must be a positive integer" >&2
  exit 2
fi
# Stream, sink and pipeline names are used in pipeline SQL: keep them plain identifiers.
if ! [[ "$name" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; then
  echo "--name must match ^[a-z][a-z0-9_]{0,62}$" >&2
  exit 2
fi
# https://developers.cloudflare.com/r2/buckets/create-buckets/#bucket-level-operations
if ! [[ "$bucket" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]; then
  echo "--bucket must be 3-63 characters of a-z 0-9 -, not starting or ending with -" >&2
  exit 2
fi
prefix="${prefix#/}"
prefix="${prefix%/}"
# An empty prefix would turn the printed lifecycle rule into one for "/" (matches nothing) or, if
# hand-edited, for the whole bucket.
if ! [[ "$prefix" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]]; then
  echo "--prefix must be a non-empty path of A-Z a-z 0-9 . _ - segments" >&2
  exit 2
fi

gateway_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
schema_file="$gateway_dir/../../pipelines/request-log.v2.schema.json"
stream="${name}_stream"
sink="${name}_r2"
pipeline="${name}"

run() {
  printf '+ %s\n' "$*" >&2
  "$@"
}

cd "$gateway_dir"

if ! pnpm wrangler r2 bucket info "$bucket" >/dev/null 2>&1; then
  run pnpm wrangler r2 bucket create "$bucket"
fi

run pnpm wrangler basin pipelines streams create "$stream" --schema-file "$schema_file"

run pnpm wrangler basin pipelines sinks create "$sink" \
  --type r2 \
  --bucket "$bucket" \
  --format parquet \
  --compression zstd \
  --path "$prefix" \
  --partitioning 'year=%Y/month=%m/day=%d' \
  --roll-interval 300

run pnpm wrangler basin pipelines create "$pipeline" \
  --sql "INSERT INTO $sink SELECT * FROM $stream"

cat <<EOF

Done. Next steps:

1. Find the stream id:
     pnpm wrangler basin pipelines streams get $stream

2. Add the binding to wrangler.jsonc and deploy:
     "pipelines": [{ "binding": "REQUEST_ARCHIVE", "stream": "<stream-id>" }]

3. Expire archive files after $retention_days days (R2 lifecycle rule on the prefix):
     pnpm wrangler r2 bucket lifecycle add $bucket expire-$name $prefix/ --expire-days $retention_days

Records that do not match the schema are dropped silently by the stream; watch
pipelinesUserErrorsAdaptiveGroups in the GraphQL Analytics API (docs/observability.md).
EOF
