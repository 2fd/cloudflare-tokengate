#!/usr/bin/env bash
# I-DEPLOY-2: the deployed bundle has no design system docs. Builds the production bundle the way
# `pnpm run deploy` does (wrangler.jsonc "main", src/index.ts), one bundle per `env.<name>` block
# and the dev bundle (src/dev.ts) with `wrangler deploy --dry-run` (offline, no account), then
# checks that the docs markers are in the dev bundle (so the markers are meaningful) and in none of
# the production files. It also checks that each production bundle holds the ui stylesheet.
# Usage: apps/gateway/scripts/check-bundle.sh
set -euo pipefail
cd "$(dirname "$0")/.."

work="$(mktemp -d "${TMPDIR:-/tmp}/check-bundle.XXXXXX")"
trap 'rm -rf "$work"' EXIT

fail() { echo "check-bundle: $1" >&2; exit 1; }

build() { # build <outdir> [wrangler args...]
  local out="$1"; shift
  pnpm exec wrangler deploy --dry-run --outdir "$out" "$@" >"$work/wrangler.log" 2>&1 ||
    { cat "$work/wrangler.log" >&2; fail "wrangler deploy --dry-run $* failed"; }
}

# Every deployable bundle: the top-level config and each `env.<name>` block (`wrangler deploy --env`),
# which can override "main". Same minimal JSONC stripping as check-config.sh.
envs="$(sed -E 's#^[[:space:]]*//.*$##; s#[[:space:]]//[^"]*$##' wrangler.jsonc | jq -r '.env // {} | keys[]')"
build "$work/prod"
for env in $envs; do build "$work/prod-env-$env" --env "$env"; done
build "$work/dev" src/dev.ts

# Strings only the docs package contains: its app factory, its stylesheet route and page titles.
markers=('createDocsApp' '/docs/static' 'tokengate design system')

for dir in "$work"/prod "$work"/prod-env-*; do
  [[ -d "$dir" ]] || continue
  [[ -f "$dir/index.js" ]] || fail "${dir##*/}: the production bundle has no index.js (is wrangler.jsonc \"main\" still src/index.ts?)"
done
[[ -f "$work/dev/dev.js" ]] || fail 'the dev bundle has no dev.js'
compgen -G "$work/dev/*docs.css" >/dev/null || fail 'the dev bundle has no docs.css module (marker check is stale)'
if compgen -G "$work/prod*/*docs.css" >/dev/null; then
  fail 'the production bundle contains the docs stylesheet'
fi
# The admin pages link the ui stylesheet, bundled as a Text module: a broken import of
# @tokengate/ui/css fails here, not at the first page load.
for dir in "$work"/prod "$work"/prod-env-*; do
  [[ -d "$dir" ]] || continue
  compgen -G "$dir/*ui.css" >/dev/null || fail "${dir##*/}: the production bundle has no ui.css module"
done
for marker in "${markers[@]}"; do
  grep -qF -- "$marker" "$work/dev/dev.js" || fail "marker \"$marker\" is not in the dev bundle (marker check is stale)"
  if grep -rqF -- "$marker" "$work"/prod*; then
    fail "the production bundle contains \"$marker\": something reachable from src/index.ts imports @tokengate/docs"
  fi
done

echo "check-bundle: ok (production bundle has no docs)"
