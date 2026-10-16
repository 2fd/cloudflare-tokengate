#!/usr/bin/env bash
# I-DEPLOY-1 / I-SSRF-1: scripts/check-config.sh rejects configs whose deploy would wipe or blank
# operator vars set in the dashboard. Vitest runs inside workerd and cannot spawn bash, so CI runs
# this file directly. Usage: bash apps/gateway/test/security/check-config-test.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/check-config.XXXXXX")"
trap 'rm -rf "$work"' EXIT

failures=0
check() { # check <description> accept|reject <jq filter applied to the repo's wrangler.jsonc>
  sed -E 's#^[[:space:]]*//.*$##; s#[[:space:]]//[^"]*$##' "$root/wrangler.jsonc" | jq "$3" >"$work/wrangler.jsonc"
  local got=reject
  bash "$root/scripts/check-config.sh" "$work/wrangler.jsonc" >/dev/null 2>&1 && got=accept
  if [[ "$got" == "$2" ]]; then echo "ok   - $1"; else echo "FAIL - $1 (got $got)"; failures=$((failures + 1)); fi
}

check 'accepts the committed config' accept '.'
check 'rejects a config without keep_vars' reject 'del(.keep_vars)'
check 'rejects keep_vars: false' reject '.keep_vars = false'
check 'rejects an empty var' reject '.vars = {AUTH_ACCESS_AUD: ""}'
check 'rejects a whitespace-only var' reject '.vars = {ALLOWED_UPSTREAM_HOSTS: "  "}'
check 'rejects an empty var in an environment block' reject '.env = {staging: {vars: {AUTH_ACCESS_AUD: ""}}}'
check 'accepts a non-empty var committed in a fork' accept '.vars = {ALLOWED_UPSTREAM_HOSTS: "api.openai.com"}'

[[ $failures -eq 0 ]] || { echo "$failures check(s) failed" >&2; exit 1; }
echo "check-config: all checks passed"
