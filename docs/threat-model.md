# Threat model

This page lists what cloudflare-tokengate protects, who it defends against, the invariants that hold
the design together and the limits it does not cover. It is for security reviewers, operators who
sign off on a deployment and contributors who change security-sensitive code.

Every invariant has an ID (for example I-CRED-2). Other pages cite these IDs. Each ID names the
module that enforces it and the tests whose `describe()` name starts with it.
`bash scripts/check-threat-ids.sh` fails if an ID on this page has no such test.

## Scope and assumptions

- Each company deploys its own copy to its own Cloudflare account. There is no shared service and
  no cross-company tenancy.
- The Cloudflare platform (Workers runtime, D1, secrets, TLS, the edge) is trusted.
- People who can deploy the Worker or read its secrets have full trust. They can change the code,
  read the keyring and therefore every credential. This model does not defend against them.
- Upstream APIs are trusted to enforce their own authorization for the credential they receive.
  The gateway only limits which callers may send which requests.
- Caller provider issuers (GitHub, GitLab, other OIDC issuers) are trusted to sign only true claims.
- Cloudflare Access is the only production admin login. Access, and the identity provider set up for
  it in Zero Trust, are trusted to authenticate users and to put a true `email` in the JWT. The
  Access application must cover `/admin`. A gap fails closed: the Worker verifies the Access JWT
  itself on every admin request (I-SESS-1), so a request that bypasses Access has no valid JWT and
  gets 401.

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Upstream credentials | `services.credential_sealed` in `DB`, sealed with the keyring | Direct access to upstream APIs; the main asset. |
| Keyring (`TOKENGATE_KEK` or `TOKENGATE_KEYRING`) | Worker secret; your vault | Opens every credential, together with the login variables it is bound to (I-CRED-3). Losing it loses every credential. |
| Admin Access JWTs | `Cf-Access-Jwt-Assertion` header and the `CF_Authorization` cookie, set by Access | A valid JWT acts with its user's role until it expires. The gateway stores no session of its own. |
| Policy (caller providers, services, grants, users) | `DB` | Decides who can use which credential. |
| Request records | `request_log` in `TELEMETRY_DB`; optional R2 archive | Allowlisted claims (repository, actor, ref, run), client IP, user agent. |
| Audit events | `audit_log` in `DB`; `audit.event` log lines | Evidence of every admin change. |
| Caller tokens | In transit only | A valid token passes verification until it expires. |

## Actors

| Actor | Can do | Main controls |
|---|---|---|
| Anyone on the internet | Mint a valid GitHub Actions or GitLab.com OIDC token for any audience from their own repository, because these issuers are shared. Send any request to `/proxy/*`, `/admin/*`, `/healthz`, `/readyz`. | Audience check (I-JWT-1), tenant pin required on shared issuers (I-TEN-1), deny by default (I-AUTHZ-1). `/admin/*` needs a valid Access JWT (I-SESS-1). |
| CI workload in your tenant | Present a token with claims that describe its repository, ref, event and workflow. Includes untrusted pull request code. | Grants pin immutable IDs or a workflow path (I-AUTHZ-2; workflow pins follow repository names, see [Callers and tokens](#callers-and-tokens)); untrusted events need an exact opt-in (I-AUTHZ-3); conditions fail closed (I-AUTHZ-4); rules limit method and path (I-AUTHZ-1, I-PATH-1). |
| Org member who can create repositories | Create a repository inside the tenant. Its tokens pass the tenant pin. | Anchor rules: a grant pins an exact `repository_id` or `job_workflow_ref` (GitLab: `project_id` or `ci_config_ref_uri`) (I-AUTHZ-2). A new repository matches no repository-pinned grant. A `job_workflow_ref` or `ci_config_ref_uri` grant admits any repository or project that runs the pinned workflow or configuration, and a renamed, transferred or deleted pinned repository can be recreated: add `repository_id` / `project_id` and hardcode the gateway URL in the pinned file ([Callers and tokens](#callers-and-tokens)). |
| Repository writer or admin | Push branches and tags, start `workflow_dispatch`, create environments, change branch protection, rulesets and environment rules. | Conditions on `ref`, `environment` and `ref_protected` are only as strong as the repository settings. Save-time warnings flag broad globs and missing `ref_protected exact true` ([policies](policies.md)). |
| Token manager (`token_manager` role) | Create, change, disable and delete services; enter, rotate and test credentials. Cannot create, change or delete caller providers or grants. | `tokens:write` decides which credentials and destinations exist. A token manager cannot give any workload access to a credential, so cannot grant themselves access; their kill switch is disabling the service (I-RBAC-1). Can USE a stored credential only through "Test credential", which is audited before the credential is sent (I-SESS-1). Cannot EXTRACT a credential (I-CRED-1, I-CRED-2). |
| Access manager (`access_manager` role) | Create, change and delete caller providers and grants, for any service in any state. | `access:write` lets its holder make any credential usable by any workload the caller provider's pin admits, including a caller provider for an issuer or organization the holder controls. It is the power to USE every credential through the gateway, never to EXTRACT one (I-CRED-1, I-CRED-2). Cannot enter, change or test a credential (I-RBAC-1). The split keeps credential entry away from access managers; it is not a containment boundary against a malicious access manager. Every change is audited (I-AUDIT-1). |
| Admin user (`admin` role) | Everything a token manager and an access manager can do, plus the configuration export. | Can USE a credential through a grant but cannot EXTRACT it from the gateway (I-CRED-1, I-CRED-2). The export holds every user's email and the full policy, never a secret. Every change is audited (I-AUDIT-1). |
| Owner user (`owner` role) | Everything an admin can do, plus users, settings (including the upstream host allowlist and the admin hosts) and keyring re-encryption. | RBAC table (I-RBAC-1); last-owner trigger (I-OWNER-1). |
| Viewer user (`viewer` role) | Read every admin page except the create forms, including request records. | No page shows secret material (I-RBAC-1, I-CRED-1). |
| Holder of D1 read access or a D1 backup | Read sealed credentials, request records, emails, audit events. | Credentials are sealed; the keyring is not in D1 (I-CRED-2). No session or bearer token is stored (I-SESS-1). |
| Holder of D1 write access | Insert or change any row. | Cannot open a credential (I-CRED-2). Can change a service's destination: the stored credential then fails closed, and the next credential entry is blocked until the admin types the destination host. The same holds for a service the writer strips of its credential or inserts ([known limitations](#admin-side)). Can create a caller provider and grant and so USE Credentials, and can make any user an owner, without an audit event. Treat D1 write as admin-equivalent ([break-glass](operations/break-glass.md) relies on it). |
| Zero Trust administrator | Change the Access application, its policies and the identity provider, so decide who gets an Access JWT. Revoke Access sessions. | Anyone the Access policy lets in joins as a `viewer`, who can read every page but change nothing and see no secret. Any other role comes only from an owner or an invitation (I-LINK-1, I-RBAC-1). Treat Zero Trust admin as able to impersonate any user whose email it controls in the identity provider. |
| Worker deployer, keyring holder | Deploy code, which can read every secret. Set secrets. Hold a copy of the keyring. | Out of scope: full trust. |

## Trust boundaries

![Trust boundaries: (1) CI job to the tokengate Worker with a caller token, (2) Worker to the upstream API with the credential, (3) admin browser to the Worker with the Access JWT and CSRF token, (4) Worker to D1 through its binding, inside your Cloudflare account, (5) Worker to identity providers and JWKS.](diagrams/trust-boundaries.svg)

<sub>Diagram source: [`diagrams/src/`](diagrams/src/) (rendered with [archify](https://github.com/tt-a1i/archify)).</sub>

1. **Caller → proxy.** Untrusted input: headers, path, query, body. The token is verified before
   any claim is trusted (I-TOK-2, I-JWT-1). The tenant pin runs before the caller learns whether the
   service exists (I-TEN-1).
2. **Proxy → upstream.** The outbound request is rebuilt from an allowlist. Only the credential
   and allowlisted headers leave the gateway (I-TOK-1, I-INJ-1). The URL stays under the service
   base URL (I-PATH-1, I-SSRF-1). Redirects are never followed (I-REDIR-1). Response headers are
   filtered (I-RESP-1). Response bodies pass through untouched (see
   [Known limitations](#known-limitations)).
3. **Browser → admin.** Server-rendered HTML without scripts. Access JWT on every request
   (I-SESS-1), CSRF (I-CSRF-1), RBAC (I-RBAC-1), host pinning (I-DEPLOY-1).
4. **Worker → D1.** D1 is the source of truth and is read on every request; there is no policy
   cache. Integrity rules that matter are enforced in SQL: last owner (I-OWNER-1), bootstrap
   (I-BOOT-1), invite linking (I-LINK-1), audit atomicity (I-AUDIT-1).
5. **Worker → IdP and JWKS.** JWKS fetches are gated per URI (I-JWT-2). Admin requests verify the
   `Cf-Access-Jwt-Assertion` header against the team keys at
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (RS256, exact issuer and AUD).

## Invariants

"Enforced in" names the modules that make the invariant true. "Tested in" lists the test files
whose `describe()` names the ID. Paths are relative to the repository root.

| ID | Invariant | Enforced in | Tested in |
|---|---|---|---|
| <a id="i-tok-1"></a>I-TOK-1 | The caller token, from any accepted header, never reaches the upstream. | `apps/gateway/src/proxy/forward.ts` (`buildUpstreamHeaders`), `apps/gateway/src/proxy/headers.ts` (`REQUEST_ALLOWLIST`, `NEVER_FORWARD`) | `apps/gateway/test/security/proxy-token.test.ts`, `apps/gateway/test/security/no-leak.test.ts`, `apps/gateway/test/unit/proxy/forward.test.ts` |
| <a id="i-tok-2"></a>I-TOK-2 | Only a compact JWS of at most 16 KiB is accepted. Different tokens in different headers are rejected (`token_ambiguous`). | `apps/gateway/src/proxy/caller-token.ts`, `apps/gateway/src/identity/jwt.ts` | `apps/gateway/test/security/proxy-token.test.ts`, `apps/gateway/test/security/jwt.test.ts`, `apps/gateway/test/unit/proxy/caller-token.test.ts` |
| <a id="i-jwt-1"></a>I-JWT-1 | Signature algorithm in the caller provider's allowlist (never `none` or HS\*), exact issuer, non-empty audience of at least 16 characters, maximum token age, required claims. Checked at save time and at request time. | `apps/gateway/src/identity/jwt.ts`, `apps/gateway/src/policy/validate.ts`, `apps/gateway/src/admin/ops/caller-providers.ts` | `apps/gateway/test/security/jwt.test.ts`, `apps/gateway/test/unit/policy/algs.test.ts`, `apps/gateway/test/unit/policy/validate.test.ts`, `apps/gateway/test/unit/admin/ops/save-time-invariants.test.ts` |
| <a id="i-jwt-2"></a>I-JWT-2 | JWKS refetch is gated: at most one fetch per `jwks_uri` per 30 s, so unknown `kid` values cannot amplify traffic. | `apps/gateway/src/identity/jwt.ts` | `apps/gateway/test/security/jwt.test.ts` |
| <a id="i-ten-1"></a>I-TEN-1 | Shared issuers (`https://token.actions.githubusercontent.com`, `https://gitlab.com`) require a tenant pin. Every pin condition must hold, else 401 `tenant_mismatch`, before the caller learns whether the service exists. | `apps/gateway/src/identity/jwt.ts` (`tenantPinHolds`), `apps/gateway/src/proxy/handler.ts` (step order), `apps/gateway/src/policy/validate.ts`, `apps/gateway/src/identity/profiles/index.ts` | `apps/gateway/test/security/proxy-tenant.test.ts`, `apps/gateway/test/security/jwt.test.ts`, `apps/gateway/test/unit/policy/validate.test.ts`, `apps/gateway/test/unit/admin/ops/save-time-invariants.test.ts` |
| <a id="i-authz-1"></a>I-AUTHZ-1 | Deny by default: no matching grant means 403. Revocation takes effect on the next request (no cache). Method-override query parameters are refused. | `apps/gateway/src/policy/evaluate.ts`, `apps/gateway/src/db/proxy-context.ts`, `apps/gateway/src/policy/glob.ts`, `apps/gateway/src/proxy/path.ts` (`hasMethodOverrideParam`) | `apps/gateway/test/security/authz-policy.test.ts`, `apps/gateway/test/security/proxy-tenant.test.ts`, `apps/gateway/test/unit/policy/evaluate.test.ts` |
| <a id="i-authz-2"></a>I-AUTHZ-2 | A Grant must satisfy an anchor rule: exact, non-negated conditions on immutable IDs, or on a workflow pin (`job_workflow_ref`, `ci_config_ref_uri`), which is path-based and follows repository names ([Callers and tokens](#callers-and-tokens)). Checked at save time, when the caller provider changes, and at request time. Display labels of numeric IDs (`claim_labels`) are never read by policy evaluation or the proxy; the admin UI uses them for display and to derive an access's owner, so a wrong label can only produce an access that never matches ([ADR 0021](adr/0021-structured-consumer-access-and-labels.md)). An organization that enabled accesses use cannot be removed from the consumer. | `apps/gateway/src/identity/profiles/*.ts` (`anchorRules`), `apps/gateway/src/policy/conditions.ts` (`satisfiesAnchorRule`), `apps/gateway/src/policy/validate.ts`, `apps/gateway/src/policy/evaluate.ts`, `apps/gateway/src/admin/ops/caller-providers.ts`, `apps/gateway/src/admin/ops/grants.ts`, `apps/gateway/src/db/claim-labels.ts` | `apps/gateway/test/security/authz-policy.test.ts`, `apps/gateway/test/security/provider-anchor-change.test.ts`, `apps/gateway/test/security/jwt.test.ts`, `apps/gateway/test/security/labels-display-only.test.ts`, `apps/gateway/test/unit/policy/validate.test.ts`, `apps/gateway/test/unit/admin/ops/save-time-invariants.test.ts` |
| <a id="i-authz-3"></a>I-AUTHZ-3 | Events outside the profile's trusted events need an exact, non-negated opt-in on the event claim. Globs never opt in. In the admin UI, an access with a risk (an untrusted event, unprotected refs, any ref, a broad glob) is saved only with that risk explicitly accepted: by the structured choice that causes it, computed on the server from the chosen branch, or by a box bound to a digest of exactly the risks shown. The accepted risk codes are in the audit row. | `apps/gateway/src/policy/evaluate.ts`, `apps/gateway/src/identity/profiles/github-actions.ts`, `apps/gateway/src/identity/profiles/gitlab-ci.ts`, `apps/gateway/src/policy/validate.ts` (`warningDetails`), `apps/gateway/src/admin/consumer-access.ts` (`coveredRiskCodes`), `apps/gateway/src/admin/routes/access.tsx` | `apps/gateway/test/security/authz-policy.test.ts`, `apps/gateway/test/security/jwt.test.ts`, `apps/gateway/test/unit/policy/evaluate.test.ts`, `apps/gateway/test/integration/admin-risk-acceptance.test.ts`, `apps/gateway/test/unit/admin/consumer-access.test.ts` |
| <a id="i-authz-4"></a>I-AUTHZ-4 | A Condition on a missing or non-scalar claim is false, also when negated. | `apps/gateway/src/policy/conditions.ts` | `apps/gateway/test/unit/policy/conditions.test.ts` (vectors in `apps/gateway/test/vectors/conditions.json`) |
| <a id="i-path-1"></a>I-PATH-1 | The upstream URL has the base URL's origin and stays under its path (plus the injection prefix). Traversal and encoded variants are rejected with 400 `path_invalid`. | `apps/gateway/src/proxy/path.ts`, `apps/gateway/src/proxy/routes.ts` | `apps/gateway/test/security/proxy-ssrf.test.ts`, `apps/gateway/test/unit/proxy/path.test.ts` (vectors in `apps/gateway/test/vectors/paths.json`), `apps/gateway/test/unit/proxy/forward.test.ts` |
| <a id="i-inj-1"></a>I-INJ-1 | Caller copies of the injected header or query parameter are removed. The credential appears only in the outbound request. Unknown injection kinds fail closed. | `apps/gateway/src/proxy/inject.ts`, `apps/gateway/src/proxy/path.ts`, `apps/gateway/src/proxy/forward.ts`, `apps/gateway/src/policy/validate.ts` (`normalizeInjection`) | `apps/gateway/test/security/proxy-token.test.ts`, `apps/gateway/test/unit/proxy/inject.test.ts`, `apps/gateway/test/unit/proxy/forward.test.ts`, `apps/gateway/test/unit/policy/validate.test.ts` |
| <a id="i-cred-1"></a>I-CRED-1 | The credential never appears in gateway responses, logs, audit diffs, the admin UI (the verify preview is masked), exports, `/readyz` or cron output. The upstream reason phrase is never forwarded. Error re-renders may carry a sealed, user- and destination-bound, non-renewable draft; never plaintext ([ADR 0020](adr/0020-sealed-credential-drafts.md)). A secret pasted into another token type's card is refused before anything is sent, and the error never quotes it. | `apps/gateway/src/proxy/inject.ts` (`secretVariants`), `apps/gateway/src/proxy/forward.ts`, `apps/gateway/src/proxy/handler.ts`, `apps/gateway/src/db/audit.ts`, `apps/gateway/src/admin/ops/services.ts`, `apps/gateway/src/admin/ops/verify.ts`, `apps/gateway/src/admin/ops/export.ts`, `apps/gateway/src/admin/ops/credential-draft.ts`, `apps/gateway/src/admin/service-templates.ts` (`secretFromTemplateInput`), `apps/gateway/src/health.ts` | `apps/gateway/test/security/no-leak.test.ts`, `apps/gateway/test/security/credential-draft.test.ts`, `apps/gateway/test/security/token-template-integrity.test.ts`, `apps/gateway/test/security/response-redaction.test.ts`, `apps/gateway/test/security/audit-coverage-ops.test.ts`, `apps/gateway/test/integration/health.test.ts`, `apps/gateway/test/unit/proxy/inject.test.ts`, `apps/gateway/test/unit/proxy/forward.test.ts`, `apps/gateway/test/unit/policy/validate.test.ts`, `apps/gateway/test/unit/telemetry/cron.test.ts`, `apps/gateway/test/unit/telemetry/dashboard.test.ts` |
| <a id="i-cred-2"></a>I-CRED-2 | The sealed credential is bound by AAD to service id, base URL and injection. Changing the base URL or injection requires entering the credential again. A D1-level edit of the base URL or injection fails closed with 503 (`credential_unavailable`, or `not_configured` when the stored base URL is not valid); admin pages treat such a base URL as outside the allowed hosts and still render, so Change destination can fix it. Entering a credential for a service whose stored credential does not open, or that has no stored credential, requires the admin to type the destination host (Change destination); the base URL suggestions of that form come only from the token types in code, never from D1. Rotating a secret (Replace secret, `POST /admin/tokens/:id/secret`) never posts a destination: it uses the stored one and is refused unless the stored credential opens under it. The form carries a digest of the destination it showed (`expected_destination`, from `destinationFingerprint`); a token repointed since the page was loaded is refused with 409 before anything is sent, and the re-render carries no draft. A sealed draft never satisfies the host confirmation and never opens for another base URL or injection (its own AAD label, `tokengate/v1/credential-draft`). | `apps/gateway/src/crypto/envelope.ts`, `apps/gateway/src/db/services.ts`, `apps/gateway/src/admin/ops/services.ts`, `apps/gateway/src/admin/ops/credential-draft.ts`, `apps/gateway/src/proxy/handler.ts` | `apps/gateway/test/security/proxy-credential-binding.test.ts`, `apps/gateway/test/security/credential-repoint.test.ts`, `apps/gateway/test/security/credential-destination-confirm.test.ts`, `apps/gateway/test/security/credential-draft.test.ts`, `apps/gateway/test/unit/crypto/envelope.test.ts` (vectors in `apps/gateway/test/vectors/sealed.json`) |
| <a id="i-cred-3"></a>I-CRED-3 | Every keyring key is bound to the login variables. The AES-256-GCM key is HKDF-SHA256 of the secret key (empty salt) with info `tokengate/v1/kek-binding` and the trimmed values of `AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD` and `AUTH_ACCESS_DEVELOPMENT`. Any change to one of them (set, remove, or write the same team or email in a different form) makes every stored credential fail closed with 503 `credential_unavailable` and changes the key check values. The public development key from `.dev.vars.example` is refused (`dev_placeholder_key`), in any key slot, unless `AUTH_ACCESS_DEVELOPMENT` is set and no Access variable is set. | `apps/gateway/src/crypto/keyring.ts` (`kekBindingInfo`, `boundKey`, `loadKeyring`), `apps/gateway/src/config.ts` (`parseConfig` mutual exclusion) | `apps/gateway/test/unit/crypto/keyring.test.ts`, `apps/gateway/test/unit/crypto/envelope.test.ts` (vectors in `apps/gateway/test/vectors/sealed.json`), `apps/gateway/test/security/deploy-config.test.ts` |
| <a id="i-redir-1"></a>I-REDIR-1 | Upstream fetches use `redirect: 'manual'`. Redirects are returned, never followed. A same-origin `Location` or `Link` under the base path is rewritten to the gateway; outside it, it is dropped. A cross-origin `Location` passes unchanged; cross-origin `Link` values are dropped. | `apps/gateway/src/proxy/forward.ts` | `apps/gateway/test/security/proxy-redirect.test.ts`, `apps/gateway/test/unit/proxy/forward.test.ts` |
| <a id="i-resp-1"></a>I-RESP-1 | Upstream response headers are filtered (`RESPONSE_DROP`). Headers that echo the credential are dropped and named in `x-tokengate-redacted`. | `apps/gateway/src/proxy/forward.ts` (`filterResponseHeaders`), `apps/gateway/src/proxy/headers.ts`, `apps/gateway/src/proxy/inject.ts` | `apps/gateway/test/security/response-redaction.test.ts`, `apps/gateway/test/security/response-redaction-url-parsing.test.ts`, `apps/gateway/test/security/proxy-redirect.test.ts`, `apps/gateway/test/unit/proxy/forward.test.ts`, `apps/gateway/test/unit/proxy/inject.test.ts` |
| <a id="i-ssrf-1"></a>I-SSRF-1 | Base URLs are https, have no credentials, query or fragment, are not IP literals, `localhost`, `*.workers.dev` or the gateway's own hosts (any admin host entry, wildcards included, and the hostname of the current request), and match the upstream host allowlist when it is set. The allowlist is a D1 setting that only owners can change (Service tokens › Allowed hosts, I-RBAC-1); empty means any public https host, and a malformed stored value denies every host. An owner may also allow a host from a token form (`allow_host`, field permission `settings:write`): the allowlist change is its own audited write, committed before the token's check sends the secret, with the same owner-only actor check at commit. Template token cards never read the destination, headers, timeout or check from the form. Checked at save time and on every proxied request, where the proxy reads the list and the admin hosts in its per-request D1 batch. `global_fetch_strictly_public` is on. | `apps/gateway/src/policy/validate.ts` (`validateBaseUrl`), `apps/gateway/src/proxy/handler.ts` (`storedBaseUrlValid`), `apps/gateway/src/config.ts` (`upstreamHostAllowed`, `hostListed`), `apps/gateway/src/db/settings.ts` (`upstreamHostsFromValue`), `apps/gateway/src/admin/ops/services.ts`, `apps/gateway/src/db/proxy-context.ts`, `apps/gateway/src/admin/ops/upstream-hosts.ts` (`updateUpstreamHosts`, `addUpstreamHost`), `apps/gateway/src/admin/routes/tokens.tsx`, `wrangler.jsonc` | `apps/gateway/test/security/proxy-ssrf.test.ts`, `apps/gateway/test/unit/policy/validate.test.ts`, `apps/gateway/test/unit/admin/ops/save-time-invariants.test.ts`, `apps/gateway/test/unit/config.test.ts`, `apps/gateway/test/integration/admin-token-hosts.test.ts`, `apps/gateway/test/integration/admin-token-allow-host.test.ts`, `apps/gateway/test/security/token-template-integrity.test.ts` |
| <a id="i-log-1"></a>I-LOG-1 | No raw token or credential reaches any sink (request log, archive, console, trace). Only the profile's allowlisted claims are stored. The get-token action masks every token it prints. | `apps/gateway/src/telemetry/record.ts`, `apps/gateway/src/telemetry/sinks.ts`, `apps/gateway/src/identity/profiles/*.ts` (`logClaimAllowlist`), `apps/gateway/src/policy/conditions.ts` (trace details), `actions/get-token/action.yml` | `apps/gateway/test/security/no-leak.test.ts`, `apps/gateway/test/security/proxy-logging.test.ts`, `apps/gateway/test/security/jwt.test.ts`, `apps/gateway/test/security/deploy-config.test.ts`, `actions/get-token/test.sh`, `apps/gateway/test/unit/policy/evaluate.test.ts` |
| <a id="i-log-2"></a>I-LOG-2 | Unverified claims are never stored. "Give this caller access" prefills the access form only from verified records, and only when the admin asks for it. The form's suggestions come from control-plane data only (labels, accesses, tenant pins, templates), never from the request log, and admin pages make no outbound lookups. | `apps/gateway/src/telemetry/record.ts`, `apps/gateway/src/admin/routes/access.tsx`, `apps/gateway/src/admin/routes/requests.tsx`, `apps/gateway/src/db/suggestions.ts` | `apps/gateway/test/security/proxy-logging.test.ts`, `apps/gateway/test/integration/admin-access.test.ts`, `apps/gateway/test/security/suggestions-sources.test.ts` |
| <a id="i-sess-1"></a>I-SESS-1 | The gateway keeps no admin sessions. Every `/admin` request is authenticated by its own Cloudflare Access JWT (RS256, exact team issuer, exact AUD, not expired, a `sub` and an email; service tokens are refused). A missing or invalid JWT gets 401 (503 when the team keys cannot be fetched) and writes nothing. The only other login is `AUTH_ACCESS_DEVELOPMENT`, for local development, accepted only on requests to a loopback hostname and never together with Access (I-CFG-1). The identity `(access, <team domain>\|<sub>)` is resolved to its user on every request, so a suspension, role change or login reset applies to the user's next request. Every audited admin write re-checks, in its own D1 batch, that the request's identity is still linked to the active user and that the user's current role still holds the route's permissions, including any field permission the request used; otherwise nothing is written. "Test credential" commits its audit row with this check before it sends the stored credential, so every use of a stored credential by an admin is audited and nothing is sent when the check fails. | `apps/gateway/src/admin/auth/identity.ts`, `apps/gateway/src/admin/auth/access.ts`, `apps/gateway/src/admin/auth/middleware.tsx`, `apps/gateway/src/db/users.ts` (`liveIdentityGuard`), `apps/gateway/src/admin/ops/shared.ts` (`commitAudited`), `apps/gateway/src/admin/ops/users.ts` | `apps/gateway/test/security/session.test.ts`, `apps/gateway/test/security/admin-actor-recheck.test.ts` |
| <a id="i-csrf-1"></a>I-CSRF-1 | Unsafe admin requests need `Sec-Fetch-Site` `same-origin`/`none` (or, without it, an `Origin` equal to the request's own origin, whose host is pinned by I-DEPLOY-1) AND a `_csrf` form field equal to the browser's `__Host-tokengate_csrf` cookie (double submit). The cookie is 32 random bytes, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, with no `Domain`, so no other site or subdomain can read or set it. A request without the cookie fails. Form bodies are capped at 64 KiB (413) before parsing. | `apps/gateway/src/admin/auth/csrf.ts`, `apps/gateway/src/admin/auth/middleware.tsx`, `apps/gateway/src/admin/render.tsx` (`ADMIN_FORM_MAX_BYTES`) | `apps/gateway/test/security/csrf.test.ts` |
| <a id="i-link-1"></a>I-LINK-1 | Email linking happens only for invited, unexpired users, with an authoritative email: the `email` of a valid Access JWT, or `AUTH_ACCESS_DEVELOPMENT` for the local development login. Users that are pending, active or suspended are never linked by email. A login whose email matches no user creates a new user with the join policy that owners set in Users › Sign-in (any role except `owner`; status `active`, `pending` or `suspended`); one whose email belongs to another user is refused (`email_taken`, or `email_taken_expired` for an expired invitation). Only `active` users get in; pending and suspended users get 403 on every request. A refused sign-in of a known user records its time and login subject on that user (`last_refused_at`, `last_refused_subject`), after the Access JWT is verified, at most once per 5 minutes; it is not audited, never changes `updated_at` and links nothing. Inviting an email again re-invites only a user who never linked an identity (invited or suspended); deleting a user is refused once they have linked one, so a later sign-in of a suspended user stays refused. Approving a pending user needs a linked identity. | `apps/gateway/src/admin/auth/email.ts`, `apps/gateway/src/admin/auth/resolve-login.ts`, `apps/gateway/src/admin/auth/middleware.tsx`, `apps/gateway/src/db/users.ts`, `apps/gateway/src/admin/ops/users.ts` | `apps/gateway/test/security/login-linking.test.ts`, `apps/gateway/test/unit/admin/auth/email.test.ts`, `apps/gateway/test/unit/admin/ops/users.test.ts`, `apps/gateway/test/integration/admin-users.test.ts` |
| <a id="i-boot-1"></a>I-BOOT-1 | Bootstrap creates at most one owner, once, in SQL-guarded statements: for the first sign-in while no owner exists, and never over an existing email. No variable limits who that is. The first owner is always an active owner, whatever the join defaults say. The same batch stores the hostname of that sign-in as the admin hosts (I-DEPLOY-1), only if none are set and the hostname is a valid entry. | `apps/gateway/src/admin/auth/resolve-login.ts`, `apps/gateway/src/db/users.ts` (`bootstrapOwnerStatements`) | `apps/gateway/test/security/bootstrap.test.ts` |
| <a id="i-rbac-1"></a>I-RBAC-1 | Every admin route is in the RBAC table with one permission. Routes outside the table are denied. Five roles hold seven permissions ([concepts](concepts.md#user), [ADR 0018](adr/0018-role-split-and-field-permissions.md)). Services and their credentials need `tokens:write`; caller providers and grants need `access:write`; no role below admin holds both, so a token manager cannot grant access and an access manager cannot enter, change or test a credential. The export needs `config:export` (admins and owners). User changes (invite, approve, reject, role, status, reset login, join defaults) need `users:write`, and settings need `settings:write`, which only owners hold. A route can also list field permissions: when the form submits such a field non-empty, the role must hold that permission too, or the request gets 403 before the handler runs (allowing an upstream host while saving a service needs `settings:write`; deleting a service together with its grants needs `access:write`). The route × role matrix is tested on the real app. | `apps/gateway/src/admin/auth/rbac.ts`, `apps/gateway/src/admin/auth/middleware.tsx` | `apps/gateway/test/security/rbac-routes.test.ts`, `apps/gateway/test/security/role-split.test.ts`, `apps/gateway/test/unit/admin/auth/rbac.test.ts`, `apps/gateway/test/integration/admin-overview.test.ts` |
| <a id="i-audit-1"></a>I-AUDIT-1 | Every admin mutation writes exactly one audit row in the same D1 batch. Failed operations write nothing. A save that also allows its upstream host is two mutations in two batches, the allowlist change first, each with its own row. A cascade delete (a service or caller provider with its grants) is one mutation with one row, whose diff holds every deleted grant. | `apps/gateway/src/admin/ops/shared.ts`, `apps/gateway/src/db/audit.ts`, `apps/gateway/src/admin/ops/*.ts`, `apps/gateway/src/telemetry/cron.ts` (`credential.expiring`) | `apps/gateway/test/security/audit-coverage-ops.test.ts`, `apps/gateway/test/security/audit-coverage-routes.test.ts`, `apps/gateway/test/unit/telemetry/cron.test.ts` |
| <a id="i-owner-1"></a>I-OWNER-1 | The last active owner cannot be demoted, suspended or deleted. SQL triggers abort the statement with `last_owner`. | `apps/gateway/migrations/0001_initial.sql` (`users_last_owner_update`, `users_last_owner_delete`), `apps/gateway/src/admin/ops/users.ts` | `apps/gateway/test/unit/admin/ops/users.test.ts` |
| <a id="i-cfg-1"></a>I-CFG-1 | Malformed configuration disables the affected feature and names the variable. No feature runs half-configured. Errors never echo values. `AUTH_ACCESS_DEVELOPMENT` applies only to a request whose hostname is `localhost`, `127.0.0.1` or `[::1]`, checked on every request. When `AUTH_ACCESS_DEVELOPMENT` is set together with `AUTH_ACCESS_TEAM_DOMAIN` or `AUTH_ACCESS_AUD`, both logins are turned off (features `login.access` and `login.dev`, variable `AUTH_ACCESS_DEVELOPMENT`). | `apps/gateway/src/config.ts` (`parseConfig`), `apps/gateway/src/crypto/keyring.ts`, `apps/gateway/src/admin/auth/identity.ts` | `apps/gateway/test/unit/config.test.ts`, `apps/gateway/test/integration/auth.test.ts` |
| <a id="i-deploy-1"></a>I-DEPLOY-1 | `preview_urls` is false. `/admin` never answers on `workers.dev` or `*.workers.dev`. On every `/admin` request the gateway reads the admin hosts (D1 setting `admin_hosts`). Before the first sign-in they are not set, and `/admin` answers on any other hostname. After it, `/admin` answers only on a listed hostname, over https unless it is a loopback host; the port is ignored. A stored value that is not a valid list closes `/admin` on every host. Only owners change the list, in Users › Sign-in (I-RBAC-1), one host per change; a change cannot empty it or leave the hostname in use unmatched (wildcards count), and is refused when the stored list changed since it was read. Deploys keep dashboard vars (`keep_vars: true`, no blank vars). `.dev.vars.example` sets only the public development key and `AUTH_ACCESS_DEVELOPMENT`, so a deploy that keeps these defaults fails closed: the development login signs in no request through Cloudflare's edge, and the key is refused when an Access variable is set (I-CRED-3). | `wrangler.jsonc`, `.dev.vars.example`, `apps/gateway/scripts/check-config.sh`, `apps/gateway/src/config.ts` (`adminHostAllowed`), `apps/gateway/src/http/security.ts`, `apps/gateway/src/db/settings.ts`, `apps/gateway/src/admin/ops/admin-hosts.ts` | `apps/gateway/test/security/security-headers.test.ts`, `apps/gateway/test/unit/config.test.ts`, `apps/gateway/test/security/bootstrap.test.ts`, `apps/gateway/test/integration/admin-sign-in.test.ts`, `apps/gateway/test/unit/admin/ops/admin-hosts.test.ts`, `apps/gateway/test/security/deploy-config.test.ts`, `apps/gateway/test/security/check-config-test.sh` |

`apps/gateway/test/security/*.sh` and `apps/gateway/scripts/check-config.sh` run in `pnpm test:scripts`, not in vitest.

### Retired invariants

- <a id="i-oauth-1"></a>The OAuth state invariant (pending GitHub and OIDC logins in a `__Host-` cookie)
  was removed with the GitHub and OIDC logins
  ([ADR 0015](adr/0015-cloudflare-access-only-admin-login.md)). Its ID is not reused.

### Exact semantics

**I-JWT-2, cold isolate.** The gate is per `jwks_uri` and per isolate. While an isolate has never
loaded keys for a `jwks_uri`, concurrent requests may each fetch, so the first burst of CI jobs does
not fail. After the first failed fetch, that isolate makes at most one fetch per 30 s for that
`jwks_uri`, even for concurrent requests. The cold-isolate exception ends at the first
failure and does not come back.

**I-AUTHZ-1, method overrides.** The proxy refuses (400 `path_invalid`, request record reason
`query_invalid`) any query with a parameter whose decoded name is `_method`,
`x-http-method-override`, `x-http-method` or `x-method-override`. The match is case-insensitive. It
includes names after `;` and PHP name normalization (leading spaces dropped, `.` and space read as
`_`, `name[...]` read as `name`). It also refuses a parameter name that cannot be decoded or that
contains a control character. This applies to every injection kind. Request headers that override
the method or URL (`x-http-method-override`, `x-original-url` and others) are in `NEVER_FORWARD`
and are filtered at request time.

**I-AUTHZ-1, trailing slash.** A Rule matches a path that ends in `/` only if the rule ends in a
literal `/`, or if it also matches the same path without the trailing `/`. So `/x/*` and `/x/**`
never authorize `/x/`. Details: [policies](policies.md).

**I-AUTHZ-2, request time.** A Grant that no longer satisfies the caller provider's anchor rules is
skipped (trace result `invalid_grant`). Changing a caller provider's anchor claims or tenant pin is
refused while an enabled grant would stop validating.

**I-RESP-1, what header redaction recognizes.** A response header is dropped when its value
contains the credential in one of these forms:

- raw;
- percent-encoded, in any mix of encoded and raw characters and either hex case (this includes the
  exact form the gateway sends for `query` Injection);
- form-encoded;
- with `\` turned into `/`, as URL parsing does in http(s) paths;
- base64 or base64url at any byte alignment (for example `base64("Bearer <credential>")`);
- for `basic`, the base64 user-pass and the secret part of a `user:pass` Credential;
- for `path` Credentials made of several segments, each segment of 16 or more characters.

A cross-origin `Location` is checked as the upstream sent it, before the gateway parses it.

## Known limitations

These are accepted behaviors, not bugs. A report that shows a way past one of the stated bounds is
a vulnerability (see [SECURITY.md](../SECURITY.md)).

### Credentials and responses

- **Response bodies are not redacted.** I-CRED-1 covers data the gateway generates. Upstream
  response bodies stream to the caller byte for byte, so streaming and compression keep working. If
  an upstream endpoint returns the credential in its body, any caller whose grant reaches that
  endpoint receives it. Example: Discord `GET` and `PATCH /api/webhooks/{id}/{token}` return the
  webhook object with its `token` field. A Credential obtained this way keeps working after the
  Grant is revoked. Scope grants so they do not reach such endpoints. For `path` Injection
  (Slack, Discord webhooks), grant only `POST /`; the grant form warns about any other method.
- **Header redaction has limits.** Other transformations are not detected: double
  percent-encoding, hex, hashing, reversed or split copies, base64 of credentials shorter than about
  12 characters. When a same-origin `Location` or `Link` is rewritten, URL parsing removes `.` and
  `..` segments; this matters only for a credential that itself contains `/./` or `/../`.
- **Admins can use credentials but not extract them from the gateway.** An admin can create a caller
  provider (including an issuer they control) and a grant, and then call the upstream with any
  Credential. The gateway never shows, exports or logs the credential (I-CRED-1), and repointing it
  needs the plaintext (I-CRED-2). What a caller can do with the upstream API, including reading
  secrets the API itself returns or minting new keys, is limited only by the grant's rules and the
  upstream.
- **Method rules apply to the request line only.** The gateway does not inspect request bodies. On
  upstreams that honor a form-body `_method` (Rails `Rack::MethodOverride`, Symfony/Laravel, Spring
  `HiddenHttpMethodFilter`, ASP.NET Core form override), a grant that allows `POST` on a path also
  allows any method the upstream accepts through body override on that path. Do not use a
  POST-only grant as a weaker permission on such upstreams.
- **KEK loss is credential loss.** No recovery exists without the keyring. Generate the key outside
  Cloudflare and keep a copy in your vault ([key rotation](operations/key-rotation.md)).
- **Key check values are per key id, not per credential.** If you replace `TOKENGATE_KEK` (kid
  `k1`), `/readyz` reports `keyring: false` and the dashboard shows a banner. If you restore the old
  key after saving credentials with the new one, the alert clears, but those newer credentials fail
  with `credential_unavailable` ([key rotation](operations/key-rotation.md)).
- **The login variables are part of the key.** A change to `AUTH_ACCESS_TEAM_DOMAIN`,
  `AUTH_ACCESS_AUD` or `AUTH_ACCESS_DEVELOPMENT` makes every stored credential fail with
  `credential_unavailable` (I-CRED-3). This also applies to a change that keeps the same meaning,
  for example `acme` to `acme.cloudflareaccess.com`. The gateway cannot tell an attack from an
  operator change. To recover, restore the earlier values or enter every credential again. Key
  check values are computed from the bound key, so they change too.

### Callers and tokens

- **Caller tokens are bearer tokens.** A token works for every request until it expires or exceeds
  the caller provider's maximum token age (default 600 s; at most 900 s for GitHub Actions and
  3600 s for other profiles). The gateway does not enforce single use of `jti`. The get-token action
  masks tokens in step logs only. Redirecting the stderr of `tokengate-token` defeats the mask
  ([GitHub Actions callers](callers/github-actions.md)).
- **Pre-trust errors reveal some configuration.** Anyone can learn which issuers are configured: an
  unknown `iss` gets `issuer_unknown`, a known one gets a later code. This needs no valid
  signature. Anyone with a validly signed token from a configured issuer also learns the expected
  audience from the `audience_mismatch` hint. Neither is a secret. Service existence stays
  hidden until the tenant pin passes (I-TEN-1), with one exception below.
- **The injection-header token source reveals header-Injection slugs.** When a request has neither
  `x-tokengate-token` nor an `Authorization` header with the `Bearer` or `token` scheme, the
  gateway reads the token from the service's injection header (`header` Injection only).
  Any value in that header changes the error from `token_missing` to another code. An
  unauthenticated caller can therefore confirm that a slug exists, is enabled and uses `header`
  Injection with a given header name.
- **Signing-key removal is not instant.** A JWKS stays cached in each isolate for up to 10 minutes.
  A key that the issuer removes keeps verifying until the isolate refetches.
- **Repository settings carry part of the policy.** Conditions on `ref`, `environment` and
  `ref_protected` trust the repository's branch protection, rulesets and environment rules. A
  workflow that references an environment that does not exist creates it without protection rules
  ([GitHub docs](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
  A Grant anchored on `job_workflow_ref` admits every repository in the tenant that can call that
  reusable workflow. In such a token, `repository_id`, `ref`, `ref_protected` and `environment`
  describe the calling repository, which any org member can create. See [policies](policies.md).
- **A reusable workflow hands its token to the caller's choices.** A called workflow reads `vars`,
  `inputs`, inherited secrets, environments and self-hosted runners from the calling repository. If
  any of them decides where the token goes, or a caller runner runs the job, the caller gets a
  bearer token that matches the `job_workflow_ref` Grant for every one of its Rules until the token
  expires. The gateway cannot tell where a token was sent before. The called workflow must hardcode
  the gateway URL and a GitHub-hosted runner, and the Grant should allow only the calls the workflow
  makes
  ([GitHub Actions callers](callers/github-actions.md#central-reusable-workflow-for-the-organization)).
  A GitLab configuration pinned with `ci_config_ref_uri` takes its CI/CD variables and runners from
  the project that runs it, with the same result
  ([GitLab CI callers](callers/gitlab-ci.md#pinned-ci-configuration)).
- **Workflow pins are names.** `job_workflow_ref` and `ci_config_ref_uri` are built from the
  repository or project path, not from an immutable ID. After the pinned repository or project is
  renamed, transferred or deleted, anyone who can create one with the same path in the tenant writes
  the pinned file and matches every Grant pinned to it. `job_workflow_sha` or `ci_config_sha` as an
  extra exact condition pins the file content, at the cost of updating the Grant after every commit
  on the pinned ref. The recreated repository or project still supplies its own variables and
  runners, as in "A reusable workflow hands its token to the caller's choices"
  ([policies](policies.md#anchor-rules)).
- **Generic issuers have no protected-ref check.** Branch claims such as Buildkite's `build_branch`
  can be chosen by whoever starts the build, and carry the tag name in tag builds. The generic
  profile has no event guard and no `ref_protected` equivalent
  ([generic OIDC](callers/generic-oidc.md#buildkite)).
- **GitLab child and downstream pipelines.** `parent_pipeline` and `pipeline` report the same source
  whatever started the upstream pipeline, including fork merge request pipelines. They need an exact
  opt-in (I-AUTHZ-3). If you opt in, also require `ref_protected exact true`; merge request refs are
  never protected. A `pipeline` opt-in with `ref_protected exact true` still admits downstream
  pipelines on protected branches whose variables come from the upstream pipeline. This is the same
  trust level as `trigger` and `api`.

### Availability and traffic

- **The rate limiter fails open and is approximate.** `PROXY_RATE_LIMITER` is optional. When bound,
  it counts per grant and per Cloudflare location. If the binding throws, the request continues: it
  caps blast radius, it does not authorize.
- **Revocation does not cut open streams.** Policy is read on every request (I-AUTHZ-1), but a
  response that is already streaming continues after you disable the grant, service or caller
  provider. The service timeout covers only the time to response headers.
- **Pre-trust logging is throttled.** Rejections before the tenant pin passes are recorded at most
  10 per minute per isolate, with `path` clipped to 256 characters and `untrusted_iss` to 128, and
  no user agent. Above the budget they are dropped, so the request log is not a complete record of
  anonymous probing.
- **Anonymous traffic is not throttled by the Worker.** Use a Cloudflare WAF rate-limiting rule for
  JWT-less `/admin/*` and token-less `/proxy/*`. Bot Fight Mode can block CI callers on datacenter IPs and
  cannot be skipped per path; disable it on the gateway zone, or use Super Bot Fight Mode with a skip
  rule for `/proxy/` ([zone settings](operations/cloudflare-zone-settings.md)).

### Platform

- **Workers adds `CF-Worker` to outbound requests.** Every upstream request carries
  `CF-Worker: <zone>`, which names the deploying zone. It cannot be removed
  ([Cloudflare HTTP request headers](https://developers.cloudflare.com/fundamentals/reference/http-request-headers/)).
- **Same-zone upstreams pass through the front door.** With `global_fetch_strictly_public`, a fetch
  to a host in your own zone goes through Cloudflare's edge, so Access and WAF rules apply to it
  ([compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)).
- **The edge can normalize URLs.** Cloudflare can normalize the request URL before the Worker sees
  it. The path checks (I-PATH-1) run on what the Worker receives and are defense in depth. If you
  change the zone's URL normalization, test path handling again.

### Admin side

- **The local development login has no proof.** With `AUTH_ACCESS_DEVELOPMENT` set, every admin
  request signs in as that email. It is accepted only on a request whose hostname is `localhost`,
  `127.0.0.1` or `[::1]`, checked on every request (I-CFG-1). No request through Cloudflare's edge has
  a loopback hostname. A Worker that calls this Worker through a
  service binding chooses the request URL and so could reach it; only account members who can
  deploy Workers can add such a binding, and they already have full trust. With an Access variable
  also set, no login works (I-CFG-1), so the development login cannot stay on next to Access. Adding
  or removing it changes the keys (I-CRED-3), so a production Worker that has stored credentials
  cannot get the development login without losing them. Never set `AUTH_ACCESS_DEVELOPMENT` in
  production; System status names the login in use.
- **Access decides who reaches the console.** Everyone the Access policy lets in becomes a user with
  the join defaults. With the default (active viewer) they can read the whole policy, the users and
  the request log (no secrets). Set the join status to `pending` to keep the console closed to new
  people until an owner approves each one, and keep the join role `viewer` unless the Access policy
  is narrow. The gateway
  trusts the Access JWT `email` to link invitations and bootstrap the first owner (I-LINK-1,
  I-BOOT-1). Until the first owner signs in, the first person through Access becomes owner, and the
  hostname of that sign-in becomes the only admin host (trust on first use, I-DEPLOY-1): keep the
  Access policy to yourself until then. Choose an identity provider
  that verifies emails, and restrict the Access policy to your organization. A user who is removed from
  the identity provider keeps a valid Access JWT until the Access session ends. To remove someone at
  once, suspend the user in Users (effective on the next request, I-SESS-1) and revoke their Access
  session in Zero Trust.
- **The Access JWT is a bearer credential.** Anyone who copies a user's `CF_Authorization` cookie
  or JWT acts as that user until it expires. The gateway cannot revoke it; Zero Trust can. Keep the
  Access session duration short.
- **A D1 restore brings back old access.** Users, roles and identity links live only in `DB`. A
  Time Travel or export restore brings back every user, role and identity link as it was at the
  restore point, including access that was removed later. After every restore of `DB`, check the
  Users page ([backup and restore](operations/backup-restore.md#checks-after-a-restore)).
- **D1 write access bypasses the admin UI.** Changes made with `wrangler d1 execute` are not
  audited. Restrict D1 access in your Cloudflare account like admin access.
- **A D1 writer can stage a service for the next credential.** When a changed base URL or
  injection makes the stored credential fail to open, or the writer clears `credential_sealed` or
  inserts a service row, the token page marks the destination "not confirmed" (or shows that no
  secret is stored), does not prefill it, and saves a secret only after the admin types the
  destination host (I-CRED-2). The confirmation is only as good as the admin's check: a writer who
  stages a plausible-looking host the admin confirms without checking still receives the secret.
  Check the base URL against the provider's documentation before you type its host, and set the
  upstream host allowlist
  ([incident response](operations/incident-response.md#a-service-destination-was-changed-outside-the-admin-ui)).
- **The upstream host allowlist and the admin hosts fail open when unset.** An empty allowlist means any
  public https upstream: any host an admin loads a credential for. That is the default. An owner can
  set the list in Service tokens › Allowed hosts; a D1 writer can change it too. Admins cannot widen it. The admin hosts are
  unset only until the first sign-in: until then `/admin` answers on every hostname except
  `workers.dev`, which is always closed. Access still guards sign-in. A D1 writer who deletes the
  `admin_hosts` row opens `/admin` on every such hostname again
  ([configuration](configuration.md#admin-hosts)).

## Changing this model

1. If you add or change a security property, add or edit its row here.
2. Name a `describe()` block in a test with the ID, for example
   `describe('I-CRED-2: ...', ...)`.
3. Run `bash scripts/check-threat-ids.sh`. It reads the IDs from this page and fails for any ID
   without a test.
4. Record the design reason in an ADR under [adr/](adr/) if the change alters a trust decision.

Related: [architecture](architecture.md), [policies](policies.md), [errors](errors.md),
[configuration](configuration.md), [observability](observability.md),
[incident response](operations/incident-response.md).
