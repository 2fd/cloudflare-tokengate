#!/usr/bin/env bash
# Deployment guardrails that tests cannot see because they live in wrangler.jsonc (I-DEPLOY-1,
# I-DEPLOY-2, I-SSRF-1).
# Usage: apps/gateway/scripts/check-config.sh [path/to/wrangler.jsonc]   (default: its wrangler.jsonc)
set -euo pipefail
config_file="$(realpath "${1:-$(dirname "$0")/../wrangler.jsonc}")"
cd "$(dirname "$0")/.."

# Minimal JSONC to JSON for jq: blanks full-line // comments and strips trailing // comments that
# contain no double quote. No /* */ comments or trailing commas.
config="$(sed -E 's#^[[:space:]]*//.*$##; s#[[:space:]]//[^"]*$##' "$config_file")"

fail() { echo "check-config: $1" >&2; exit 1; }

# Wrangler honours "main" inside an environment block too (`wrangler deploy --env <name>`), so every
# entry point must be src/index.ts. An environment without "main" inherits the top-level one.
jq -e '[.main] + [(.env // {} | .[] | .main // empty)] | all(. == "src/index.ts")' <<<"$config" >/dev/null ||
  fail 'wrangler.jsonc "main" (top-level and in every env block) must be src/index.ts (src/dev.ts adds the dev-only docs, I-DEPLOY-2)'
[[ "$(jq -r '.preview_urls' <<<"$config")" == "false" ]] ||
  fail 'wrangler.jsonc must set "preview_urls": false (version URLs would run old code against production data)'
jq -e '.compatibility_flags | index("global_fetch_strictly_public")' <<<"$config" >/dev/null ||
  fail 'wrangler.jsonc must enable the "global_fetch_strictly_public" compatibility flag'
jq -e '[.d1_databases[].binding] | (index("DB") and index("TELEMETRY_DB"))' <<<"$config" >/dev/null ||
  fail 'wrangler.jsonc must bind both DB and TELEMETRY_DB'
[[ "$(jq -r '.observability.head_sampling_rate' <<<"$config")" == "1" ]] ||
  fail 'observability.head_sampling_rate must be 1: audit events are log lines and must not be sampled'
# Without keep_vars, every deploy deletes vars set in the dashboard (I-DEPLOY-1, I-SSRF-1).
[[ "$(jq -r '.keep_vars' <<<"$config")" == "true" ]] ||
  fail 'wrangler.jsonc must set "keep_vars": true so deploys keep vars set in the dashboard'
# A blank var is still uploaded and overwrites the dashboard value; config.ts reads blank as unset,
# so a blank AUTH_ACCESS_AUD turns off admin sign-in.
# Checks top-level and per-environment (`env.<name>.vars`) blocks.
empty="$(jq -r '
  [(.vars // {}), (.env // {} | .[] | .vars // {})] | .[] | to_entries[]
  | select((.value | type) == "string" and (.value | test("^\\s*$"))) | .key' <<<"$config")"
[[ -z "$empty" ]] ||
  fail "wrangler.jsonc must not declare empty or blank vars (they overwrite dashboard values on deploy): ${empty//$'\n'/, }"
grep -q 'migrations apply TELEMETRY_DB' package.json ||
  fail 'the deploy script must apply TELEMETRY_DB migrations'

echo "check-config: ok"
