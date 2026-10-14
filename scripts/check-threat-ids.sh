#!/usr/bin/env bash
# Every threat-model invariant ID (I-XXX-N) must be named by at least one describe() block under
# the test directory (default: test/). IDs come from docs/threat-model.md when it exists, else
# from the list below. Prints the missing IDs and exits 1 if there are any.
#
#   scripts/check-threat-ids.sh                 # describe() anywhere under test/
#   scripts/check-threat-ids.sh test/security   # describe() under test/security/ only
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="${1:-test}"
case "$test_dir" in /*) ;; *) test_dir="$root/$test_dir" ;; esac
threat_model="$root/docs/threat-model.md"

EMBEDDED_IDS='
I-TOK-1 I-TOK-2 I-JWT-1 I-JWT-2 I-TEN-1 I-AUTHZ-1 I-AUTHZ-2 I-AUTHZ-3 I-AUTHZ-4 I-PATH-1
I-INJ-1 I-CRED-1 I-CRED-2 I-CRED-3 I-REDIR-1 I-RESP-1 I-SSRF-1 I-LOG-1 I-LOG-2 I-SESS-1 I-CSRF-1
I-LINK-1 I-BOOT-1 I-RBAC-1 I-AUDIT-1 I-OWNER-1 I-CFG-1 I-DEPLOY-1
'

if [[ -f "$threat_model" ]]; then
  source_name="docs/threat-model.md"
  ids="$(grep -oE 'I-[A-Z]+-[0-9]+' "$threat_model" | sort -u)"
else
  source_name="embedded list"
  ids="$(tr -s '[:space:]' '\n' <<<"$EMBEDDED_IDS" | grep -E '^I-[A-Z]+-[0-9]+$' | sort -u)"
fi
if [[ -z "$ids" ]]; then
  echo "check-threat-ids: no invariant IDs found in $source_name" >&2
  exit 1
fi
if [[ ! -d "$test_dir" ]]; then
  echo "check-threat-ids: test directory not found: $test_dir" >&2
  exit 1
fi

# Names of describe() and describe.skip/only(...) blocks. Files are flattened first so a name on
# the line after `describe(` still matches. describe.each(table)(name) is not recognized.
covered="$(
  find "$test_dir" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \) -print0 |
    while IFS= read -r -d '' file; do
      tr '\n' ' ' <"$file" |
        grep -oE "describe(\.[a-z]+)*\([[:space:]]*['\"\`][^'\"\`]*" || true
    done |
    grep -oE 'I-[A-Z]+-[0-9]+' | sort -u || true
)"

missing="$(comm -23 <(echo "$ids") <(echo "$covered"))"
total="$(wc -l <<<"$ids" | tr -d ' ')"

if [[ -n "$missing" ]]; then
  count="$(wc -l <<<"$missing" | tr -d ' ')"
  echo "check-threat-ids: $count of $total invariant IDs ($source_name) have no describe() under ${test_dir#"$root"/}:"
  sed 's/^/  /' <<<"$missing"
  exit 1
fi
echo "check-threat-ids: all $total invariant IDs ($source_name) are named by a describe() under ${test_dir#"$root"/}"
