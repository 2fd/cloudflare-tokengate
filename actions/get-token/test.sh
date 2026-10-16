#!/usr/bin/env bash
# I-LOG-1: behaviour test for actions/get-token (runs the real step script with a stubbed curl).
# Vitest runs inside workerd and cannot spawn bash, so CI runs this file directly.
# Usage: bash actions/get-token/test.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/get-token.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# The mint step's `run: |` block, de-indented: everything after the run line up to EOF.
sed -n '/^      run: |/,$p' "$root/actions/get-token/action.yml" | sed '1d; s/^        //' >"$work/mint.sh"
grep -q "<<'HELPER'" "$work/mint.sh" || { echo "could not extract the mint step" >&2; exit 1; }

# Stub curl: returns whatever JSON is in $FAKE_RESPONSE.
mkdir -p "$work/stub"
printf '#!/usr/bin/env bash\nprintf "%%s" "$FAKE_RESPONSE"\n' >"$work/stub/curl"
chmod +x "$work/stub/curl"

failures=0
fails() { ! "$@"; }
check() { # check <description> <command...>
  if "${@:2}"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi
}

run_mint() { # run_mint <url> <audience> <response>; leaves out/err/env/output files in $work
  : >"$work/env"; : >"$work/output"; : >"$work/path"
  rm -rf "$work/runner"; mkdir -p "$work/runner"
  env -i PATH="$work/stub:$PATH" HOME="$work" RUNNER_TEMP="$work/runner" \
    GITHUB_ENV="$work/env" GITHUB_OUTPUT="$work/output" GITHUB_PATH="$work/path" \
    ACTIONS_ID_TOKEN_REQUEST_URL=https://oidc.test/token ACTIONS_ID_TOKEN_REQUEST_TOKEN=req \
    TOKENGATE_URL_INPUT="$1" TOKENGATE_AUDIENCE_INPUT="$2" FAKE_RESPONSE="$3" \
    bash "$work/mint.sh" >"$work/out" 2>"$work/err"
}

helper() { # helper <response>: runs the installed tokengate-token like a later step would
  env -i PATH="$work/stub:$PATH" TOKENGATE_AUDIENCE=aud ACTIONS_ID_TOKEN_REQUEST_URL=https://oidc.test/token \
    ACTIONS_ID_TOKEN_REQUEST_TOKEN=req FAKE_RESPONSE="$1" \
    "$work/runner/tokengate-bin/tokengate-token" >"$work/out" 2>"$work/err"
}

jwt='eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvOngifQ.c2lnbmF0dXJl'
jwt2='eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvOnkifQ.b3RoZXJzaWc'

check 'mint step succeeds with valid inputs' run_mint https://gw.example.com/ aud "{\"value\":\"$jwt\"}"
check 'mint step masks the first token' grep -qxF "::add-mask::$jwt" "$work/err"
check 'mint step outputs the token and trimmed url' \
  grep -qxF "token=$jwt" "$work/output"
check 'mint step exports TOKENGATE_URL without trailing slash' grep -qxF 'TOKENGATE_URL=https://gw.example.com' "$work/env"

check 'helper succeeds' helper "{\"value\":\"$jwt2\"}"
check 'helper prints only the token on stdout' [ "$(cat "$work/out")" = "$jwt2" ]
check 'helper masks every fresh token via stderr' grep -qxF "::add-mask::$jwt2" "$work/err"

injected="$(jq -cn --arg v "$jwt"$'\n'"::add-mask::x"$'\n'"::warning::pwned" '{value: $v}')"
check 'helper rejects a non-JWS value' fails helper "$injected"
check 'rejected value is not echoed as workflow commands' fails grep -q '::warning::pwned' "$work/err"
check 'helper prints nothing for a rejected value' [ ! -s "$work/out" ]

check 'mint step rejects a url containing a newline' \
  fails run_mint $'https://gw.example.com\nBASH_ENV=/tmp/x' aud "{\"value\":\"$jwt\"}"
check 'nothing is written to GITHUB_ENV on rejection' [ ! -s "$work/env" ]
check 'mint step rejects an audience containing a newline' \
  fails run_mint https://gw.example.com $'aud\nBASH_ENV=/tmp/x' "{\"value\":\"$jwt\"}"
check 'mint step rejects a non-https url' fails run_mint http://gw.example.com aud "{\"value\":\"$jwt\"}"

[[ $failures -eq 0 ]] || { echo "$failures check(s) failed" >&2; exit 1; }
echo "get-token action: all checks passed"
