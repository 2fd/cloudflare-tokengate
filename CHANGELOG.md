# Changelog

This file lists every change that users and operators can see, per release. It is for operators who upgrade a deployment and for workflow authors.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). The project uses [Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version can contain breaking changes; "Upgrade notes" lists them. The release process is in [CONTRIBUTING.md](CONTRIBUTING.md#release-process).

## [Unreleased]

First public release (0.1.0).

### Added

- **Credential proxy.** `/proxy/<slug>/…` accepts `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS`. The caller sends a workload identity token in `x-tokengate-token` or `Authorization: Bearer`. For `header` Injection, it can also send the token in the injected header. The gateway verifies it, checks grants, removes the token and injects the stored credential. Responses stream back. See [docs/architecture.md](docs/architecture.md).
- **Caller providers** with three profiles: `github-actions`, `gitlab-ci` and `generic` (other OIDC issuers). Each caller provider has its own audience and maximum token age, and an optional tenant pin (required on shared issuers). `generic` Caller providers also list their anchor claims. See [docs/callers/github-actions.md](docs/callers/github-actions.md), [docs/callers/gitlab-ci.md](docs/callers/gitlab-ci.md) and [docs/callers/generic-oidc.md](docs/callers/generic-oidc.md).
- **Grants** with claim conditions (`exact` and `glob`, optional negation) and rules (HTTP methods plus a path glob). Each grant can have an expiry. Trusted events per profile; any other event needs an explicit opt-in in the grant. GitHub presets for branch, tag, release, pull request and environment. See [docs/policies.md](docs/policies.md).
- **Injection kinds:** `bearer`, `header` (name and optional prefix), `basic`, `query` and `path`.
- **Service templates** for the Slack Web API, Slack incoming webhooks, Discord webhooks, OpenAI, Anthropic, the GitHub REST API and GitHub uploads. An optional verify check tests a credential when it is saved or tested. See [docs/upstreams/](docs/upstreams/).
- **Envelope encryption** of credentials with AES-256-GCM and a keyring (`TOKENGATE_KEK` or `TOKENGATE_KEYRING`). Key rotation with key check values and a rewrap action in Settings. `pnpm keyring generate` and `pnpm keyring check` generate and validate keys outside Cloudflare. See [docs/operations/key-rotation.md](docs/operations/key-rotation.md).
- **Admin UI** at `/admin`, server-rendered without client-side JavaScript: Dashboard, services, caller providers, grants, Requests, Audit log, users, Settings. "Create grant from this request" prefills a grant from a denied request record.
- **Admin sign-in through Cloudflare Access only.** The Worker verifies the Access JWT on every `/admin` request; it keeps no sessions of its own. "Sign out" goes to the Access logout endpoint. Users have the role `owner`, `admin` or `viewer`. The first person to sign in becomes owner (`BOOTSTRAP_OWNER_EMAILS` optionally limits who); everyone else that Access lets in joins as a viewer, and an owner can promote them or invite an email with another role. For local development, `AUTH_DEV_EMAIL` signs in as one email, and only on a loopback `PUBLIC_URL`. See [ADR 0015](docs/adr/0015-cloudflare-access-only-admin-login.md).
- **Request log** in a separate D1 database (`TELEMETRY_DB`), with hourly rollups, retention settings, a sample rate for allowed requests and a row cap. Optional Queue for batched writes (`REQUEST_LOG_QUEUE`) and optional archive to R2 through Basin Pipelines (`REQUEST_ARCHIVE`, `scripts/setup-archive.sh`, `pipelines/request-log.v1.schema.json`). See [docs/observability.md](docs/observability.md).
- **Audit log** of every admin change, invite link, first-owner bootstrap and viewer join, also emitted as an `audit.event` log line for a SIEM.
- **Health endpoints:** `/healthz` (liveness, no I/O) and `/readyz` (readiness, booleans only).
- **Configuration export** (`POST /admin/export`) as deterministic JSON without secrets.
- **Optional per-Grant rate limit** through the `PROXY_RATE_LIMITER` binding.
- **Composite GitHub Action** `actions/get-token` that mints the OIDC token and installs the `tokengate-token` helper. See [actions/get-token/README.md](actions/get-token/README.md).
- **Deploy to Cloudflare** support: binding descriptions in `package.json`, `.dev.vars.example`, and `pnpm run deploy`, which applies both migrations before it deploys.

### Security

Each item links to its invariant in [docs/threat-model.md](docs/threat-model.md).

- The Caller token never reaches the upstream. Only one compact JWS of at most 16 KiB is accepted; different tokens in different headers are rejected ([I-TOK-1](docs/threat-model.md#i-tok-1), [I-TOK-2](docs/threat-model.md#i-tok-2)).
- Tokens verify only with the exact issuer, an allowed algorithm, the caller provider's audience and a fresh `iat`. JWKS refetches are rate-gated per `jwks_uri` ([I-JWT-1](docs/threat-model.md#i-jwt-1), [I-JWT-2](docs/threat-model.md#i-jwt-2)).
- Shared issuers (`token.actions.githubusercontent.com`, `gitlab.com`) need a tenant pin on one of the profile's tenant claims (`repository_owner_id` or `enterprise_id` for GitHub, `namespace_id` for GitLab) ([I-TEN-1](docs/threat-model.md#i-ten-1)).
- Every grant must satisfy the profile's anchor rules: exact, non-negated conditions on immutable IDs or on a path-based workflow pin (`job_workflow_ref`, `ci_config_ref_uri`). This is checked at save time and at request time. A Grant that no longer satisfies them is skipped ([I-AUTHZ-2](docs/threat-model.md#i-authz-2)).
- A missing, null or non-scalar claim makes a condition false, also when it is negated ([I-AUTHZ-4](docs/threat-model.md#i-authz-4)).
- GitLab `parent_pipeline` and `pipeline` are not trusted events. A Grant must opt in to them with an exact, non-negated condition, and the UI warns when it does not also require `ref_protected` ([I-AUTHZ-3](docs/threat-model.md#i-authz-3)).
- A request without a matching grant is denied, and revocation takes effect on the next request. Rules match the path with `%2F` read both as a separator and as data. `/x/*` and `/x/**` never authorize `/x/`. Method-override query parameters (`_method`, `x-http-method-override`, `x-http-method`, `x-method-override`) are refused with `path_invalid` ([I-AUTHZ-1](docs/threat-model.md#i-authz-1)).
- The upstream URL stays on the service's base origin and base path ([I-PATH-1](docs/threat-model.md#i-path-1)).
- Caller copies of the injected header or query parameter are removed. The credential appears only in the outbound request ([I-INJ-1](docs/threat-model.md#i-inj-1)).
- Credentials are bound by AAD to the service ID, base URL and injection. They never appear in responses, logs, audit rows or the export ([I-CRED-1](docs/threat-model.md#i-cred-1), [I-CRED-2](docs/threat-model.md#i-cred-2)).
- Redirects are returned, never followed. A `Location` under the base URL is rewritten to the gateway, one on another origin passes through, and any other is dropped. `Link` keeps only the values that rewrite to the gateway ([I-REDIR-1](docs/threat-model.md#i-redir-1)).
- Upstream response headers are filtered. A header that echoes the credential is dropped and named in `x-tokengate-redacted` ([I-RESP-1](docs/threat-model.md#i-resp-1)). Response bodies pass through unchanged.
- Base URLs are https only, checked against `ALLOWED_UPSTREAM_HOSTS` (when set) when a service is saved and on every request. `global_fetch_strictly_public` is enabled ([I-SSRF-1](docs/threat-model.md#i-ssrf-1)).
- Request records keep only claims on the profile's allowlist ([I-LOG-1](docs/threat-model.md#i-log-1)). Unverified claims are never stored ([I-LOG-2](docs/threat-model.md#i-log-2)). `tokengate-token` masks every token it prints ([I-LOG-1](docs/threat-model.md#i-log-1)).
- Every admin request is authenticated by its own Cloudflare Access JWT (team certs, exact issuer, application AUD). A disable, role change or login reset applies to the user's next request, and admin writes re-check the acting identity and role when they commit ([I-SESS-1](docs/threat-model.md#i-sess-1)).
- Unsafe admin requests need `Sec-Fetch-Site` `same-origin` or `none` (without that header, an exact `Origin`) and a `_csrf` field equal to the `__Host-tokengate_csrf` cookie (double submit). Admin form bodies are capped at 64 KiB ([I-CSRF-1](docs/threat-model.md#i-csrf-1)).
- Email linking applies only to invited users and uses only the email of a valid Access JWT; an email that belongs to another user is refused ([I-LINK-1](docs/threat-model.md#i-link-1)). Bootstrap creates at most one owner, once ([I-BOOT-1](docs/threat-model.md#i-boot-1)).
- Every admin route has an RBAC entry ([I-RBAC-1](docs/threat-model.md#i-rbac-1)). Every admin change writes exactly one audit event in the same batch ([I-AUDIT-1](docs/threat-model.md#i-audit-1)). The last active owner cannot be demoted, disabled or deleted ([I-OWNER-1](docs/threat-model.md#i-owner-1)).
- With `PUBLIC_URL` set, `/admin` answers only on that origin. `wrangler.jsonc` sets `preview_urls: false` and `keep_vars: true`, and `scripts/check-config.sh` enforces both ([I-DEPLOY-1](docs/threat-model.md#i-deploy-1)).
- A malformed configuration variable turns off the affected feature and is reported by name; no feature runs half-configured ([I-CFG-1](docs/threat-model.md#i-cfg-1)).

### Upgrade notes

- This is the first release. There is no upgrade path from earlier development snapshots: deploy it into new D1 databases.
- Schema heads: `migrations/0001_initial.sql` (`DB`) and `migrations-telemetry/0001_initial.sql` (`TELEMETRY_DB`). `pnpm run deploy` applies both.
- The admin UI needs `PUBLIC_URL` on a custom domain behind an Access application. On a `workers.dev` hostname only `/proxy` and the health endpoints work.
- `wrangler.jsonc` declares no `vars`. Set operator variables in the Cloudflare dashboard; deploys keep them. See [docs/configuration.md](docs/configuration.md).

[Unreleased]: https://github.com/2fd/cloudflare-tokengate/commits/main
