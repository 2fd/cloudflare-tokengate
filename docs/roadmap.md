# Roadmap

This page lists what tokengate deliberately does not do, and work that may come later. It is for platform engineers deciding whether tokengate fits their needs, and for contributors looking for larger tasks.

Items under [Future work](#future-work) are candidates, not commitments. They have no dates and are in no particular order. A design change on this list needs an ADR before it is merged ([adr/README.md](adr/README.md)).

## Non-goals

These are outside the project's scope. Pull requests that add them are unlikely to be accepted.

| Non-goal | Reason |
|---|---|
| A hosted or multi-tenant service | Each company deploys its own copy in its own Cloudflare account. The trust model assumes one tenant per deployment ([threat-model.md](threat-model.md)). |
| Handing credentials to callers | The gateway injects credentials into upstream requests. It never returns them. Callers that need the raw secret should use a secrets manager instead. |
| Static caller keys or `GITHUB_TOKEN` as caller identity | Callers authenticate with workload identity tokens only ([ADR 0002](adr/0002-workload-identity-tokens-for-callers.md)). |
| Inspecting or rewriting request and response bodies | Bodies are streamed unchanged, so streaming and compression work. As a result, grant rules see only the request line, and upstream response bodies are not redacted ([threat-model.md](threat-model.md)). |
| Admin login providers configured from the UI | The admin login comes from Worker variables only ([ADR 0008](adr/0008-login-providers-from-environment.md)). |
| Admin sign-in without Cloudflare Access | The gateway does not run its own OAuth or OpenID Connect login or keep sessions. Cloudflare Access does both, and can use GitHub, Google or any OpenID Connect provider as its login method ([ADR 0015](adr/0015-cloudflare-access-only-admin-login.md)). |

## Future work

### Credentials and upstreams

- **GitHub App installation tokens.** Store a GitHub App private key instead of a static token. Mint a short-lived installation token per request, scoped to the repositories and permissions of the grant.
- **Credentials that need refreshing.** Support upstreams whose credentials expire and are renewed with a refresh token, such as OAuth refresh tokens and Slack token rotation. Today a credential is a static value. `credential_expires_at` only triggers expiry notices.
- **WebSockets.** Proxy upgraded connections. Today `upgrade` is never forwarded and is dropped from responses (`src/proxy/headers.ts`).
- **KEK in Cloudflare Secrets Store** as an alternative to the `TOKENGATE_KEK` and `TOKENGATE_KEYRING` Worker secrets ([ADR 0004](adr/0004-envelope-encryption-bound-to-destination.md)).
- **Key check value per credential.** Today key check values are recorded per kid. A per-Credential value would detect which credentials a restored old key cannot open.

### Callers and policy

- **Token exchange endpoint.** Exchange a workload identity token for a short-lived, scoped gateway token, for tools that cannot send a fresh caller token on every request.
- **Per-grant rate limits configured in the UI.** Today the optional `PROXY_RATE_LIMITER` binding applies one limit, set in `wrangler.jsonc`, to each grant separately ([configuration.md](configuration.md)).
- **Grant builder for GitLab CI.** The builder in `src/policy/presets.ts` covers GitHub Actions only. GitLab grants use the conditions editor.
- **Nested claims in conditions.** Conditions read only top-level claims ([policies.md](policies.md)).
- **Policy cache.** An opt-in cache with a bounded TTL, if D1 latency on the proxy path becomes a problem. It would delay revocation by up to the TTL, so it needs its own ADR ([ADR 0006](adr/0006-no-policy-caching.md)).

### Administration

- **Admin JSON API.** Manage services, caller providers and grants from scripts. Today the only machine-readable output is the export (`POST /admin/export`).
- **Import and plan/apply.** Keep configuration in git, preview the changes, then apply them.
- **Detection of configuration regressions.** Warn on the dashboard and fail `/readyz` when `PUBLIC_URL` or `ALLOWED_UPSTREAM_HOSTS` changes from set to unset. Today `scripts/check-config.sh` guards only the committed `wrangler.jsonc` ([ADR 0013](adr/0013-operator-variables-outside-wrangler-config.md)).
- **Configuration check during deploy.** Run `scripts/check-config.sh` in `pnpm run deploy`. It is not run there yet. The script needs `bash` and `jq`, and their presence in the Workers Builds image is not confirmed.

### Telemetry

- **Analytics Engine sink** for metrics alongside the D1 request log ([ADR 0009](adr/0009-telemetry-design.md)).
- **Exact row counts in rollups.** Today the `request_log_max_rows` check estimates the table size from weighted rollups, which overestimates when sampling is on ([observability.md](observability.md)).
- **Global limit on pre-trust records.** Today the limit is per isolate (`src/telemetry/sinks.ts`). A rate-limiting binding could make it global.

## Proposing changes

1. Open an issue that describes the problem, not only the solution.
2. If the change affects the trust model, storage, cryptography, authentication or telemetry, write an ADR ([adr/README.md](adr/README.md)).
3. Follow [CONTRIBUTING.md](../CONTRIBUTING.md).
