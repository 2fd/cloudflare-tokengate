# 13. Operator variables outside `wrangler.jsonc`

This ADR explains why `wrangler.jsonc` declares no variables and keeps the values set in the Cloudflare dashboard. It is for platform engineers and contributors.

Date: 2026-10-13

## Status

Accepted

## Context

Some variables are security controls:

- `PUBLIC_URL` pins `/admin` and `/auth` to one origin ([I-DEPLOY-1](../threat-model.md#i-deploy-1)).
- `ALLOWED_UPSTREAM_HOSTS` limits where services may send credentials ([I-SSRF-1](../threat-model.md#i-ssrf-1)).

When unset, each control is off. `src/config.ts` reads an empty or whitespace-only value as unset.

By default, `wrangler deploy` replaces all variables with the ones in `wrangler.jsonc`. An early version of the config committed `""` placeholders under `vars`. Every deploy then silently erased the values operators had set in the dashboard, and both controls turned off.

Separately, version preview URLs would run old code against production data and secrets.

## Decision

- `wrangler.jsonc` has no `vars` block and sets `"keep_vars": true`. Deploys, including Workers Builds, keep variables set in the dashboard.
- Operators set variables in the dashboard (Worker > Settings > Variables and Secrets). Secrets are set with `pnpm wrangler secret put <NAME>`.
- `"preview_urls": false`.
- `scripts/check-config.sh` fails in these cases. `pnpm check` and CI run it.
  - `keep_vars` is not `true`.
  - A variable in `vars` or `env.<name>.vars` is empty or blank.
  - `preview_urls` is not `false`.
  - The `global_fetch_strictly_public` compatibility flag is missing.
  - The `DB` or `TELEMETRY_DB` binding is missing.
  - `observability.head_sampling_rate` is not 1.
  - The `deploy` script in `package.json` does not apply the `TELEMETRY_DB` migrations.

## Consequences

- Deploys no longer turn off host pinning or the upstream allowlist.
- The Deploy button does not prompt for variables. Operators set them after the first deploy ([getting-started.md](../getting-started.md)).
- A fork that prefers configuration in git can add non-empty values under `vars`. Each deploy then overwrites the dashboard value, so each variable must be set in one place only.
- A Worker version includes its bindings, and variables are bindings. A rollback to an earlier version can therefore bring back older variable values. Operators check `PUBLIC_URL` and `ALLOWED_UPSTREAM_HOSTS` after a rollback ([configuration.md](../configuration.md)).
- Local development reads variables from `.dev.vars` (template: `.dev.vars.example`).
