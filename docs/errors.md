# Errors

This page lists every error the gateway returns on `/proxy/*`, and the reason codes stored in the
request log. It is for workflow authors who call the gateway and for admins who answer their questions.

Each error code has its own `##` heading. Error bodies link to it
(`docs/errors.md#<code>`). The codes are defined in `apps/gateway/src/lib/errors.ts`.

## Response format

A response produced by the gateway has `x-tokengate-source: gateway` and this JSON body:

```json
{
  "message": "tokengate: token_missing: no caller token; send it in the x-tokengate-token header or as Authorization: Bearer <token> (request req_01J...)",
  "error": {
    "type": "tokengate_error",
    "code": "token_missing",
    "message": "tokengate: token_missing: no caller token; ...",
    "request_id": "req_01J...",
    "docs": "https://github.com/2fd/cloudflare-tokengate/blob/main/docs/errors.md#token_missing"
  }
}
```

Headers: `content-type: application/json`, `cache-control: no-store`, `x-tokengate-source: gateway`,
`x-tokengate-error: <code>` and `x-tokengate-request-id: <id>`.

- The top-level `message` lets SDKs that print `message` show the error.
- Most messages are fixed texts. Three codes add a hint: `issuer_unknown` (the token's `iss`),
  `audience_mismatch` (the expected audience) and `event_not_trusted` (the event). Messages never name
  issuer_access_rules, conditions or other claims.
- If the upstream API answered, the response has `x-tokengate-source: upstream`. Its status and body are
  the upstream's, even for errors such as 401 or 500.
- A response without `x-tokengate-request-id` did not come from the gateway's proxy. Usually the
  Cloudflare edge (WAF, Bot Fight Mode) answered. See
  [operations/troubleshooting.md](operations/troubleshooting.md).

When you ask an admin for help, send the request ID. The admin opens `/admin/requests/<request id>`.
The Requests list has no search by request ID. The request page shows the outcome, the reason code, its
meaning and, for most reasons, a "Next step" hint.

Some records are not stored. Failures before the token is verified and the tenant pin holds
("pre-trust") are recorded only up to 10 per minute per isolate. Allowed requests are recorded at the
configured sample rate. See [observability.md](observability.md).

| Status | Codes |
|---|---|
| 400 | [`path_invalid`](#path_invalid), [`token_ambiguous`](#token_ambiguous) |
| 401 | [`token_missing`](#token_missing), [`token_malformed`](#token_malformed), [`issuer_unknown`](#issuer_unknown), [`audience_mismatch`](#audience_mismatch), [`token_expired`](#token_expired), [`token_too_old`](#token_too_old), [`signature_invalid`](#signature_invalid), [`claims_invalid`](#claims_invalid), [`tenant_mismatch`](#tenant_mismatch) |
| 403 | [`no_matching_grant`](#no_matching_grant), [`event_not_trusted`](#event_not_trusted) |
| 404 | [`service_not_found`](#service_not_found) |
| 405 | [`method_not_allowed`](#method_not_allowed) |
| 429 | [`rate_limited`](#rate_limited) |
| 500 | [`internal_error`](#internal_error) |
| 502 | [`upstream_unreachable`](#upstream_unreachable) |
| 503 | [`credential_unavailable`](#credential_unavailable), [`jwks_unavailable`](#jwks_unavailable), [`not_configured`](#not_configured) |
| 504 | [`upstream_timeout`](#upstream_timeout) |

## method_not_allowed

**Status 405.** The HTTP method is not one the proxy forwards.

- **Cause:** a method other than `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` or `OPTIONS`.
- **Caller:** use one of these methods.
- **Admin:** pre-trust record with reason `method_not_allowed`.

## token_missing

**Status 401.** The request carries no caller token.

- **Causes:**
  - Neither `x-tokengate-token` nor `Authorization: Bearer <token>` (or `Authorization: token <token>`)
    is present. Other `Authorization` schemes, such as `Basic`, are ignored.
  - The token variable is empty in the job, for example because the job lacks `id-token: write`, and the
    HTTP client dropped the empty header. If the client sends the header with an empty value, the
    result is [`token_malformed`](#token_malformed).
- **Caller:** send the token in `x-tokengate-token`. If the service injects its credential into a custom
  header (for example `x-api-key`), you may send the token in that header instead, when the two standard
  headers are absent. See [callers/github-actions.md](callers/github-actions.md).
- **Admin:** pre-trust record with reason `token_missing`.

## token_ambiguous

**Status 400.** The request carries more than one different caller token.

- **Causes:**
  - `x-tokengate-token` and `Authorization: Bearer ...` carry different values. A common case is an SDK
    that sends a placeholder API key as `Authorization: Bearer`, while the token is in
    `x-tokengate-token`.
  - A header is repeated, or holds comma-separated values, with different tokens.
- **Caller:** send exactly one token. With an SDK, pass the caller token as the API key and drop
  `x-tokengate-token`, or send the same token in both places.
- **Admin:** pre-trust record with reason `token_ambiguous`.

## token_malformed

**Status 401.** The token is not a JWT this credential access rule can verify.

- **Causes:**
  - The value is not a compact JWS (three non-empty base64url parts), or it is longer than 16 KiB. A real
    upstream API key sent as `Authorization: Bearer` is a common case. An empty value, such as
    `Authorization: Bearer` with an empty token variable, is another.
  - The JWT header or payload cannot be decoded.
  - The `alg` is not in the credential access rule's signature algorithms, or is not asymmetric
    (`none` and `HS*` are never accepted).
  - The `kid` is missing or not 1–128 characters of `A-Z a-z 0-9 . _ -`.
- **Caller:** send the OIDC token itself, unmodified.
- **Admin:** pre-trust record. Check the credential access rule's "Signature algorithms".

## issuer_unknown

**Status 401.** No enabled credential access rule has the token's issuer.

- **Causes:**
  - No credential access rule exists for this `iss`, or it is disabled.
  - The issuer differs in spelling. Issuers are compared exactly; a trailing `/` matters.
  - The token has no `iss` claim. The message then has no hint.
- **Caller:** check the issuer in the message. It is the token's own `iss`.
- **Admin:** pre-trust record that keeps the untrusted `iss`. Add or enable the credential access rule.

## audience_mismatch

**Status 401.** The token was minted for another audience.

- **Causes:**
  - The job requested a different `aud`. GitHub's default audience is the owner URL, which the gateway
    never accepts.
  - The credential access rule's audience changed.
- **Caller:** request a token with the audience shown in the message. With the get-token action, set
  its `audience` input ([actions/get-token/README.md](../actions/get-token/README.md)).
- **Admin:** pre-trust record. The audience is on the credential access rule page.

## token_expired

**Status 401.** The token's `exp` has passed, after 30 seconds of clock tolerance.

- **Causes:** the token was minted early in a long job, or reused. GitHub tokens are valid for about
  5 minutes.
- **Caller:** mint a fresh token right before each call. In GitHub Actions, call `tokengate-token` again.
- **Admin:** pre-trust record.

## token_too_old

**Status 401.** The token was issued (`iat`) longer ago than the credential access rule's maximum token age,
even though it has not expired.

- **Causes:** a token reused within a long job. GitLab tokens live as long as the job timeout, so this
  check limits their reuse. The default maximum age is 600 seconds.
- **Caller:** mint a fresh token right before each call.
- **Admin:** pre-trust record. "Maximum token age (seconds)" is on the credential access rule form.

## signature_invalid

**Status 401.** The signature does not verify with the issuer's current keys.

- **Causes:**
  - The issuer's key set has no key with this `kid`, for example because the token comes from another
    issuer that uses the same `iss` text, or was forged.
  - The issuer has just rotated keys. The gateway fetches a key set for one JWKS URI at most once per
    30 seconds.
  - The credential access rule's JWKS URI points to the wrong key set.
  - The key is unusable, for example an RSA key shorter than 2048 bits.
- **Caller:** if the issuer just rotated keys, retry after 30 seconds. Otherwise contact the admins.
- **Admin:** pre-trust record. Check the credential access rule's issuer and JWKS URI.

## claims_invalid

**Status 401.** The token lacks a required claim, or a time claim is not valid yet.

- **Causes:**
  - A claim the profile requires is missing. GitHub Actions requires `sub`, `jti`, `iat`, `exp`,
    `repository_id`, `repository_owner_id`, `event_name` and `ref`; GitLab CI requires `sub`, `jti`,
    `iat`, `exp`, `project_id`, `namespace_id`, `pipeline_source` and `ref`; generic requires `sub`, `iat`,
    `exp` and every anchor claim. See [policies.md](policies.md#credential-access-rules-and-profiles).
  - `nbf` or `iat` is in the future by more than 30 seconds.
- **Caller:** use a token from the platform's standard OIDC mechanism.
- **Admin:** pre-trust record. For a generic credential access rule, check its anchor claims.

## jwks_unavailable

**Status 503.** The gateway could not fetch the issuer's signing keys.

- **Causes:**
  - The JWKS URI timed out (3 seconds), failed, answered a status other than 200, or returned invalid
    JSON.
  - After a failed fetch, the gateway waits 30 seconds before it fetches again for that JWKS URI.
  - The stored JWKS URI is not https.
- **Caller:** retry after a short wait.
- **Admin:** pre-trust record with outcome `error`. If it persists, check the credential access rule's JWKS URI
  and the issuer's status.

## tenant_mismatch

**Status 401.** The verified token is outside the tenant pinned on the credential access rule.

- **Causes:** the workflow runs in an organization, enterprise or GitLab group that the tenant pin does
  not list. On GitHub's and gitlab.com's shared issuers, anyone can mint a valid token; this check keeps
  them out ([I-TEN-1](threat-model.md#i-ten-1)).
- **Caller:** run the job in an allowed organization or group, or ask the admins to add it.
- **Admin:** pre-trust record. It has no claims and no user agent. It keeps the untrusted `iss`, the
  credential access rule, the method, the path (cut to 256 characters) and the client IP. Edit "Allowed organization IDs", "Enterprise ID (optional)" or "Allowed group
  (namespace) IDs" on the credential access rule.

## service_not_found

**Status 404.** No enabled service has the slug in `/proxy/<slug>/...`.

- **Causes:** a typo in the slug, or the service is disabled (reason `service_disabled`). This check runs
  only after the token and tenant pin are verified, so outsiders cannot list credentials.
- **Caller:** check the slug in the URL.
- **Admin:** the record has reason `service_not_found` or `service_disabled`.

## path_invalid

**Status 400.** The path or query string is not allowed ([I-PATH-1](threat-model.md#i-path-1)).

- **Causes in the path** (reason `path_invalid`):
  - empty (`//`, `/%2F`) or dot (`.`, `..`) segments, also when separated by `%2F`;
  - characters outside RFC 3986 path characters, or `;`, `\`, spaces and control characters;
  - the escapes `%2e`, `%5c`, `%3b`, `%25`, `%00`–`%1f`, `%7f`, a `%` without two hex digits, or escapes
    that are not valid UTF-8;
  - more than 2048 characters.
- **Causes in the query** (reason `query_invalid`):
  - a method-override parameter: `_method`, `x-http-method-override`, `x-http-method` or
    `x-method-override` (case-insensitive; names after `;` and PHP-style variants count);
  - a parameter name that cannot be decoded or contains a control character;
  - characters outside printable ASCII;
  - for credentials that inject the credential as a query parameter, that parameter name after a `;`.
- **Caller:** fix the URL. Do not send method overrides; use the real HTTP method.
- **Admin:** the record has reason `path_invalid` or `query_invalid`.

## no_matching_grant

**Status 403.** No grant allows this caller to make this request ([I-AUTHZ-1](threat-model.md#i-authz-1)).

- **Causes:** no enabled, unexpired grant matches the caller's claims, the method and the path. Typical
  cases: a different branch, tag or environment; an ID missing from the grant; a method or path not in
  the rules; a trailing `/` or `%2F` in the path (see [policies.md](policies.md#rule-syntax)).
- **Caller:** send the request ID to the admins. The message never says which check failed.
- **Admin:** the request page shows the policy evaluation: one line per grant with `condition_failed`,
  `no_rule`, `invalid_grant` or `event_not_trusted`, and the first failing check. Owners and admins can
  select "Create grant from this request".

## event_not_trusted

**Status 403.** A grant would match, but the event that started the job is not trusted, and the grant
does not opt in to it ([I-AUTHZ-3](threat-model.md#i-authz-3)).

- **Causes:** the job runs on an event such as `pull_request`, `pull_request_target`, `workflow_run` or
  GitLab `merge_request_event`. The message names the event.
- **Caller:** run the call from a trusted event (GitHub: `push`, `workflow_dispatch`, `schedule`,
  `release`; GitLab: `push`, `web`, `schedule`, `api`, `trigger`), or ask the admins for an opt-in.
- **Admin:** an opt-in is an exact condition such as `event_name exact pull_request`. Read the warnings
  in [policies.md](policies.md#trusted-events) first: several of these events run untrusted code.

## rate_limited

**Status 429.** The grant that allowed the request is over its rate limit. The response has
`retry-after: 60`.

- **Cause:** the `PROXY_RATE_LIMITER` binding counted more requests for this grant than its limit, in
  this Cloudflare location ([configuration.md](configuration.md#proxy_rate_limiter)).
- **Caller:** wait `retry-after` seconds, then retry. Reduce the request rate.
- **Admin:** record with outcome `denied` and reason `rate_limited`.

## credential_unavailable

**Status 503.** The service's credential cannot be used. The caller cannot fix this.

- **Causes** (the record has the exact reason):
  - `credential_missing`: the service has no credential yet.
  - `keyring_missing_key`: the credential was sealed with a key id that is no longer in the keyring.
  - `credential_binding_mismatch`: the credential does not open. Its base URL or injection was changed
    outside the admin UI, or the key behind its key id was replaced ([I-CRED-2](threat-model.md#i-cred-2)),
    or `AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD` or `AUTH_ACCESS_DEVELOPMENT` changed
    ([I-CRED-3](threat-model.md#i-cred-3)).
  - `sealed_malformed`: the stored value is damaged.
  - `injection_invalid`: the stored injection settings are invalid.
  - `credential_invalid`: the credential cannot be placed in the upstream request.
- **Caller:** contact the admins with the request ID.
- **Admin:** record with outcome `error`. Restore a missing or replaced key if that is the cause
  ([operations/key-rotation.md](operations/key-rotation.md)); the dashboard shows a banner for keyring
  problems. If every credential fails after a change of the `AUTH_ACCESS_*` variables, restore their
  earlier values or enter every credential again
  ([configuration.md](configuration.md#login-binding)). Otherwise treat `credential_binding_mismatch`, `sealed_malformed` and
  `keyring_missing_key` as possible tampering: the service row may have been changed in D1 to send the
  next credential you enter to another host. The service page shows an error banner, marks the stored
  base URL and injection "not confirmed", does not prefill them, and saves only after you type the
  destination host. Before you enter the credential again, check the base URL and injection against an
  out-of-band source (the provider's documentation, your configuration as code), not against the
  audit log or the stored row
  ([operations/incident-response.md](operations/incident-response.md#a-service-destination-was-changed-outside-the-admin-ui)).
  Do the same check for `credential_missing` on a service that had a credential. The upstream host allowlist
  limits where a changed row can point ([configuration.md](configuration.md#upstream-host-allowlist)).

## not_configured

**Status 503.** The gateway is not fully configured for this request.

- **Causes** (the record has the exact reason):
  - `keyring_absent`, `keyring_malformed`, `active_kid_missing`, `key_not_32_bytes`,
    `both_kek_and_keyring_set`: the `TOKENGATE_KEK` or `TOKENGATE_KEYRING` secret is missing or invalid.
  - `dev_placeholder_key`: the keyring holds the public development key from `.dev.vars.example`,
    and the Worker is not in development mode (`AUTH_ACCESS_DEVELOPMENT` set, no Access variable).
    Set a key of your own ([configuration.md](configuration.md#development-key)).
  - `base_url_invalid`: the service's base URL is no longer allowed, for example after a change to
    the upstream host allowlist (Credentials › Allowed hosts) or the admin hosts (Users › Sign-in) ([I-SSRF-1](threat-model.md#i-ssrf-1)).
  - `profile_unknown`: the credential access rule names a profile this version does not know. This check
    runs before the token is verified, so these records are pre-trust records.
- **Caller:** contact the admins with the request ID.
- **Admin:** record with outcome `error`. See [configuration.md](configuration.md) and Settings >
  System status.

## internal_error

**Status 500.** An unexpected failure, for example D1 unavailable.

- **Caller:** retry later. Retry non-idempotent requests only if the upstream tolerates duplicates.
- **Admin:** Workers Logs has a `proxy.internal_error` line with the request ID and the error name only.
  The request record may also be missing if D1 is down.

## upstream_unreachable

**Status 502.** The upstream API could not be reached.

- **Causes** (the record has the exact reason):
  - `upstream_unreachable`: DNS failure, connection refused, TLS failure, or another network error
    while sending the request.
  - `upstream_invalid_status`: the upstream answered with a status the gateway cannot forward (below
    200, for example `101`, or above 599). The upstream received the request and may have processed
    it. The record keeps the raw status in `upstream_status`, whatever integer fetch reported (for
    example `0`, `99`, `1000` or a negative value: workerd reads the status line as a 32-bit signed
    integer), on both the queue and the direct-insert path.
- **Caller:** retry later. Retry non-idempotent requests only if the upstream tolerates duplicates. For
  `upstream_invalid_status` the message says the upstream may have processed the request; check its
  state before you retry.
- **Admin:** record with outcome `error`. Workers Logs has a `proxy.upstream_failed` line with the error
  name (`InvalidStatus` for `upstream_invalid_status`). Check the upstream's status and the service's
  base URL.

## upstream_timeout

**Status 504.** The upstream API did not send response headers within the service timeout.

- **Causes:** a slow upstream. The default timeout is 120,000 ms. Only the wait for headers is timed; a
  long streamed body is not cut.
- **Caller:** retry later. The upstream may have processed the request.
- **Admin:** raise "Timeout (milliseconds)" on the service page (1,000–900,000), or check the upstream.

## Request record reason codes

Each request record has an outcome and a reason:

- `allowed`: the upstream answered (any status). The reason is empty.
- `denied`: the gateway answered with a status below 500.
- `error`: the gateway answered with a status of 500 or above.

The reason is the gateway error code, or a finer reason for some codes:

| Reason | Error code | Meaning |
|---|---|---|
| `method_not_allowed`, `token_missing`, `token_ambiguous`, `token_malformed`, `issuer_unknown`, `audience_mismatch`, `token_expired`, `token_too_old`, `signature_invalid`, `claims_invalid`, `jwks_unavailable`, `tenant_mismatch` | Same | Pre-trust failures; see each code above |
| `service_not_found` | `service_not_found` | No service has this slug |
| `service_disabled` | `service_not_found` | The service exists but is disabled |
| `path_invalid` | `path_invalid` | The path is not allowed |
| `query_invalid` | `path_invalid` | The query string is not allowed |
| `no_matching_grant` | `no_matching_grant` | No grant allows this caller to perform this request |
| `event_not_trusted` | `event_not_trusted` | The triggering event requires an explicit opt-in in the grant |
| `rate_limited` | `rate_limited` | Rate limit exceeded |
| `credential_missing` | `credential_unavailable` | The service has no credential yet |
| `credential_binding_mismatch` | `credential_unavailable` | The stored credential does not belong to this service's current destination or injection |
| `credential_invalid` | `credential_unavailable` | The stored credential cannot be attached to the upstream request |
| `keyring_missing_key` | `credential_unavailable` | The credential was encrypted with a key that is no longer in the keyring |
| `sealed_malformed` | `credential_unavailable` | The stored credential is damaged |
| `injection_invalid` | `credential_unavailable` | The service's injection settings are invalid |
| `keyring_absent` | `not_configured` | No keyring is configured (`TOKENGATE_KEK` or `TOKENGATE_KEYRING`) |
| `keyring_malformed` | `not_configured` | The keyring secret is malformed |
| `active_kid_missing` | `not_configured` | The keyring has no active key |
| `key_not_32_bytes` | `not_configured` | A keyring key is not 32 bytes |
| `both_kek_and_keyring_set` | `not_configured` | Both `TOKENGATE_KEK` and `TOKENGATE_KEYRING` are set |
| `dev_placeholder_key` | `not_configured` | The keyring holds the development key from `.dev.vars.example` |
| `base_url_invalid` | `not_configured` | The service's base URL is no longer allowed |
| `profile_unknown` | `not_configured` | The credential access rule uses an unknown profile |
| `internal_error` | `internal_error` | The gateway failed to process the request |
| `upstream_unreachable` | `upstream_unreachable` | The upstream API could not be reached |
| `upstream_invalid_status` | `upstream_unreachable` | The upstream answered with a status outside 200-599; it may have processed the request |
| `upstream_timeout` | `upstream_timeout` | The upstream API did not respond in time |

`not_configured` and `credential_unavailable` are never stored as reasons; the record always has the
finer reason. The texts come from `apps/gateway/src/admin/views/reasons.ts`; the "Next step" hints from
`apps/gateway/src/admin/routes/requests.tsx`.
