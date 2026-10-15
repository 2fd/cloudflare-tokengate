# Troubleshooting

This page maps common symptoms to their cause and fix. It is for platform engineers and admins who
support workflow authors. Error codes are described in full in [errors.md](../errors.md).

## Start with the response headers

Every response the gateway produces on `/proxy/` has `x-tokengate-request-id` and
`x-tokengate-source`:

| `x-tokengate-source` | Who answered | Next step |
|---|---|---|
| `gateway` | The gateway refused or failed. The body and `x-tokengate-error` carry the code | Find the code below or in [errors.md](../errors.md) |
| `upstream` | The upstream API answered; status and body are its own | [The upstream answered with an error](#the-upstream-answered-with-an-error) |
| (missing) | Not the proxy | [The response has no `x-tokengate-request-id`](#the-response-has-no-x-tokengate-request-id) |

To see what the gateway recorded, open `<gateway>/admin/requests/<request-id>`. The page shows the
outcome, the reason, a "Next step" hint, the stored claims and, for denials, the policy trace. Records
can be missing: allowed requests may be sampled, and pre-trust failures are capped at 10 per minute
per isolate ([observability](../observability.md#request-log)).

To see the headers in a workflow, run `curl` with `-i` or `-D -`.

## The response has no `x-tokengate-request-id`

The Cloudflare edge answered before the Worker ran, or the request did not reach `/proxy/`.

| Symptom | Cause | Fix |
|---|---|---|
| HTML challenge page, or 403 with a Cloudflare error page | Bot Fight Mode, Super Bot Fight Mode or a WAF rule | Security > Analytics > Events shows the rule. See [zone settings](cloudflare-zone-settings.md#bot-fight-mode) |
| 429 with a Cloudflare page | A zone rate limiting rule | Raise its threshold ([zone settings](cloudflare-zone-settings.md#rate-limiting)) |
| Redirect to `<team>.cloudflareaccess.com` | An Access application covers `/proxy/` | Limit the application to `/admin` ([zone settings](cloudflare-zone-settings.md#cloudflare-access)) |
| 1xxx error page, DNS or TLS error | The hostname is not routed to the Worker | Check Workers & Pages > tokengate > Settings > Domains & Routes |
| `404 Not Found` as plain text on `/admin` | The hostname is on `workers.dev` or not in the admin hosts, the request uses http on a hostname that is not a loopback host, or the stored admin hosts are not valid and close `/admin` everywhere ([I-DEPLOY-1](../threat-model.md#i-deploy-1)) | Use a listed hostname over https. Users › Sign-in › "Admin hosts" lists them. If no hostname works, see [lost admin host](break-glass.md#lost-admin-host) |

## Caller errors

| Code | Usual cause | Fix |
|---|---|---|
| [`token_missing`](../errors.md#token_missing) | The call sent no token in `x-tokengate-token`, in `Authorization` (`Bearer` or `token` scheme) or, for `header` Injection, in the service's injection header | Pass the token from [`actions/get-token`](../../actions/get-token/README.md) ([GitHub Actions](../callers/github-actions.md)) |
| [`token_ambiguous`](../errors.md#token_ambiguous) | Two different tokens, for example an SDK set `Authorization` and the workflow set `x-tokengate-token` | Send one token |
| [`issuer_unknown`](../errors.md#issuer_unknown) | No enabled caller provider has the token's issuer, or it is disabled | Check caller providers; enable it or add one |
| [`audience_mismatch`](../errors.md#audience_mismatch) | The token was minted for another audience | Use the audience shown on the caller provider page |
| [`token_expired`](../errors.md#token_expired), [`token_too_old`](../errors.md#token_too_old) | The token was minted at the start of a long job | Mint a fresh token right before each call with `$(tokengate-token)` from the get-token action ([long jobs](../callers/github-actions.md#long-jobs)) |
| [`signature_invalid`](../errors.md#signature_invalid) | Wrong issuer or JWKS URL, or a token from another instance | Check the caller provider's issuer and JWKS URL |
| [`jwks_unavailable`](../errors.md#jwks_unavailable) | The issuer's JWKS could not be fetched. After a failure, each isolate retries at most once per 30 s ([I-JWT-2](../threat-model.md#i-jwt-2)) | Retry; if it persists, check the JWKS URL |
| [`tenant_mismatch`](../errors.md#tenant_mismatch) | The token is from another organization or namespace than the tenant pin | Check the caller provider's tenant pin and the owner ID ([I-TEN-1](../threat-model.md#i-ten-1)) |
| [`service_not_found`](../errors.md#service_not_found) | Wrong slug, or the service is disabled (reason `service_disabled`) | Check the slug in the URL; enable the service |
| [`path_invalid`](../errors.md#path_invalid) | Empty or dot segments, bad escapes; reason `query_invalid` for a refused query, such as a method-override parameter | Fix the URL in the caller |
| [`no_matching_grant`](../errors.md#no_matching_grant) | No grant matches the caller's claims, method and path | Read the policy trace on the request page; an admin can select "Create grant from this request" ([policies](../policies.md)) |
| [`event_not_trusted`](../errors.md#event_not_trusted) | The event (for example `pull_request_target`) is outside the trusted events | Add an exact opt-in to the grant only if the risk is acceptable ([policies](../policies.md)) |
| [`rate_limited`](../errors.md#rate_limited) | The grant reached the `PROXY_RATE_LIMITER` limit | Wait `retry-after` seconds, or raise the limit ([configuration](../configuration.md#proxy_rate_limiter)) |

## Gateway-side errors

| Code and reason | Cause | Fix |
|---|---|---|
| `credential_unavailable`, `credential_missing` | The service has no credential | Set it on the service page. If the service had one, check the base URL and injection out of band first ([why](incident-response.md#a-service-destination-was-changed-outside-the-admin-ui)) |
| `credential_unavailable`, `keyring_missing_key` | The credential was sealed with a key id that is no longer in the keyring | Add the key back ([key rotation](key-rotation.md#remove-the-old-key)) |
| `credential_unavailable` on every service with a credential, after a change of `AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD` or `AUTH_ACCESS_DEVELOPMENT` | The keyring is bound to these variables ([I-CRED-3](../threat-model.md#i-cred-3)). Any change, also `acme` to `acme.cloudflareaccess.com` or a change of email case, changes the keys. Settings shows every key check value as changed | Restore the earlier values exactly. If you cannot, enter every credential again ([login binding](../configuration.md#login-binding)) |
| `credential_unavailable`, `credential_binding_mismatch` | The key behind the key id changed, the login variables changed ([I-CRED-3](../threat-model.md#i-cred-3)), or the service row was edited in D1 ([I-CRED-2](../threat-model.md#i-cred-2)) | If the dashboard shows the changed-key banner: [recover the key](key-rotation.md#recover-from-a-replaced-key). Else treat it as tampering: [check the destination out of band](incident-response.md#a-service-destination-was-changed-outside-the-admin-ui) before you enter the credential again |
| `credential_unavailable`, `sealed_malformed`, `injection_invalid`, `credential_invalid` | Stored data is damaged or invalid, possibly by an edit in D1 | Check the base URL and injection against an out-of-band source, then enter the credential again under "Change credential or destination" ([why](incident-response.md#a-service-destination-was-changed-outside-the-admin-ui)) |
| `not_configured`, `keyring_absent`, `keyring_malformed`, `active_kid_missing`, `key_not_32_bytes`, `both_kek_and_keyring_set` | The keyring secret is missing or invalid | Settings > Encryption keys names the problem ([key rotation](key-rotation.md)) |
| `not_configured`, `dev_placeholder_key` | The keyring holds the public development key from `.dev.vars.example`, and an Access variable is set or `AUTH_ACCESS_DEVELOPMENT` is not set | Generate a key of your own and set it as `TOKENGATE_KEK` ([development key](../configuration.md#development-key)) |
| `not_configured`, `base_url_invalid` | The stored base URL no longer passes the checks, usually after the upstream host allowlist changed ([I-SSRF-1](../threat-model.md#i-ssrf-1)). Settings names the services outside the list | An owner adds the host in Settings > "Upstream hosts", or change the service's destination |
| `not_configured`, `profile_unknown` | The caller provider's profile is not known to this code version, for example after a rollback | Deploy the version that added the profile |
| `internal_error` | Unexpected failure, often D1 unavailable | Check `proxy.internal_error` log lines and `/readyz` |
| `upstream_timeout` | No response headers within the service timeout | Check the upstream; raise "Timeout (milliseconds)" on the service |
| `upstream_unreachable` | DNS, TLS or connection failure | Check the upstream status and the base URL |
| `upstream_unreachable`, `upstream_invalid_status` | The upstream answered with a status below 200 or above 599 after it received the request | The upstream may have processed the request: check its state before a retry. Check the upstream and the base URL |

## The upstream answered with an error

`x-tokengate-source: upstream` means the gateway forwarded the request with the credential, and the
status and body come from the upstream.

| Symptom | Cause | Fix |
|---|---|---|
| 401 or 403 on every call; dashboard banner "Upstream rejected the credential" | The credential was revoked, expired or lacks a scope | [Rotate the credential](credential-rotation.md) |
| 404 from the upstream | Wrong path under the base URL, or the token lacks access to the resource | Compare the path with the upstream API docs; the gateway appends the path to the base URL |
| `x-tokengate-redirect-blocked: 1` | The upstream redirected outside the base URL; the gateway dropped the `Location` ([I-REDIR-1](../threat-model.md#i-redir-1)) | Call the final URL directly, if a service covers it |
| A header is missing; `x-tokengate-redacted` lists it | The header contained the credential and was dropped ([I-RESP-1](../threat-model.md#i-resp-1)) | Expected |

## Admin UI and maintenance

| Symptom | Cause | Fix |
|---|---|---|
| "Your invitation expired. Owners can see that you tried. …" (403) | Your invitation was not used within 7 days | An owner selects "Renew invitation" in Users › People › "Needs your decision" (the attempt is listed there), then you reload |
| "Another user already has this email address with a different sign-in account. …" (403) | Access let you in and no user is linked to your Access identity, but your Access email belongs to another user: a cancelled invitation, or a user linked to another sign-in (for example another Access team, or the GitHub or OIDC login of an earlier release) | An owner checks the attempt in Users › People › "Needs your decision" and selects "Invite again as <role>" (cancelled invitation) or "Reset sign-in…" (other account), then you reload. If no owner can sign in: [break-glass](break-glass.md) |
| You can sign in but only as a viewer | Everyone that the Access policy lets in joins with the join policy (by default "Let them in as Viewer"); only the first sign-in of the deployment becomes owner | An owner changes your role in Users › People ("Change") |
| "Your account is waiting for an owner to approve it. …" (403) | The join policy is "Ask an owner first" (Users › Sign-in) | An owner selects a role under "Approve as" in Users › People › "Needs your decision", or on the Overview |
| "This account is suspended. Owners can see that you tried. …" (403) | Your user is suspended: an owner suspended or rejected you, or the join policy is "Only invited people" | An owner selects "Reactivate" on your row in Users › People. "Reset sign-in…" instead removes the linked sign-in accounts and invites the user again |
| "Set up sign-in" page (503) | `AUTH_ACCESS_TEAM_DOMAIN` and `AUTH_ACCESS_AUD` are not set, or are malformed; the page names the variable | Set the Access variables, and serve the gateway on a custom domain ([configuration](../configuration.md), [zone settings](cloudflare-zone-settings.md#cloudflare-access)) |
| "Set up sign-in" page (503) with "AUTH_ACCESS_DEVELOPMENT cannot be set together with AUTH_ACCESS_TEAM_DOMAIN or AUTH_ACCESS_AUD" | The development login and Access are both set, so both are off ([I-CFG-1](../threat-model.md#i-cfg-1)) | Delete `AUTH_ACCESS_DEVELOPMENT`. Credentials stored before it was added then open again ([login binding](../configuration.md#login-binding)) |
| "Set up sign-in" page (503) with "AUTH_ACCESS_DEVELOPMENT is set, but it signs in only requests to localhost …" | Only the development login is set, and the request is not to `localhost`, `127.0.0.1` or `[::1]` | Locally, open `http://localhost:8787/admin`. In production, delete `AUTH_ACCESS_DEVELOPMENT` and set the Access variables before you add services |
| "Cloudflare Access did not present a valid user identity for this request." (401) | The request reached the Worker without a valid `Cf-Access-Jwt-Assertion`: the Access application does not cover this path or hostname, `AUTH_ACCESS_AUD` or `AUTH_ACCESS_TEAM_DOMAIN` is wrong, the Access token expired, or an Access service token was used. The `auth.login_failed` log line has the reason | [Zone settings: Access](cloudflare-zone-settings.md#cloudflare-access). Service tokens cannot use the admin UI |
| "Cloudflare Access could not be reached to check your identity." (503) | The gateway could not fetch the team's signing keys (`/cdn-cgi/access/certs`) | Reload. If it persists, check `AUTH_ACCESS_TEAM_DOMAIN` |
| Admin UI on the workers.dev hostname answers `404` or "Set up sign-in" | `/admin` never answers on workers.dev ([I-DEPLOY-1](../threat-model.md#i-deploy-1)) | Use the custom domain ([zone settings](cloudflare-zone-settings.md#hostnames)) |
| "Keep <host> covered: it is the host you are using now, …" (400) | The removal would leave no admin host entry that matches the hostname you use. Without one, the admin UI stops answering on that hostname | Remove the entry from a hostname that stays listed, or add a covering entry first |
| "The admin hosts changed meanwhile. …" (409) | Another owner changed the admin hosts after your page loaded | The page shows the current list; add or remove the host again |
| "Sign out" does not appear | The local development login (`AUTH_ACCESS_DEVELOPMENT`) is in use; it has no sign-out | Expected in local development |
| "The form was not accepted (it expired or came from another site)." | CSRF check failed: stale page or cross-site submit ([I-CSRF-1](../threat-model.md#i-csrf-1)) | Reload the page and submit again |
| "Request body too large (limit 65536 bytes)." (413) | The form exceeds 64 KiB | Shorten the input, for example split a grant's rules |
| "Your role does not allow this action." | The role lacks the permission ([I-RBAC-1](../threat-model.md#i-rbac-1)) | Ask an owner |
| "nothing was saved: your access or your role changed while the request ran; reload the page" (409) | While the request ran, your user was suspended or its login reset, or your role lost the permission ([I-SESS-1](../threat-model.md#i-sess-1)) | Reload the page. If your role changed or you lost access, ask an owner |
| Owner cannot be suspended or demoted | Last active owner ([I-OWNER-1](../threat-model.md#i-owner-1)) | Invite and activate a second owner first |
| Dashboard: "Database ... is missing migration" | Code deployed without `pnpm run deploy` | `pnpm wrangler d1 migrations apply DB --remote` and `pnpm wrangler d1 migrations apply TELEMETRY_DB --remote` ([upgrades](upgrades.md)) |
| Dashboard: "The hourly maintenance job has not run yet." | First hour after deploy | Wait for the run at 7 minutes past the hour |
| Dashboard: "The hourly maintenance job failed at ...: `<step>`: ..." | A step (`rollup`, `purge`, `credential_expiry`, `heartbeat`) threw | Read the message and the `cron.failed` log line; `/readyz` reports `cron: false` |
| Dashboard: last success more than 2 hours ago | The cron trigger was removed, or every run fails before it records an error | Check that `triggers.crons` in `wrangler.jsonc` is `["7 * * * *"]`, run `pnpm run deploy`, and read the `cron.failed` log lines |
| Dashboard totals too low after a `TELEMETRY_DB` outage, missed cron runs or a dead-letter queue replay | The rollup catch-up is still running (at most 24 hours per run), or "Maximum request log rows" or retention deleted rows before they were rolled up | Wait for the next runs, or [recompute rollups manually](../observability.md#recompute-rollups-manually). Purged rows cannot be counted again |
| Settings: "Key ... is not the key that encrypted its credentials" | The key behind a key id changed, or the `AUTH_ACCESS_*` variables changed ([I-CRED-3](../threat-model.md#i-cred-3)) | [Recover a replaced key](key-rotation.md#recover-from-a-replaced-key), or restore the earlier login variables |
| Saving a credential fails with a credential check error | The check request failed with the new credential | Fix the credential, or select "Save the credential even though the check failed" |

## The request log is missing records

| Symptom | Cause | Fix |
|---|---|---|
| Allowed calls are missing | "Share of allowed requests to record" is below 1 | Expected; dashboard counts are scaled up |
| Anonymous or pre-trust failures are missing | Pre-trust budget of 10 per minute per isolate; `telemetry.pretrust_records_dropped` in the logs | Expected ([observability](../observability.md#pre-trust-records)) |
| Records appear up to 30 seconds late | `REQUEST_LOG_QUEUE` batches records before writing them | Expected |
| No records at all; `telemetry.sink_failed` with `request_log_insert_failed` | `TELEMETRY_DB` is unavailable, full or missing its migration | `pnpm wrangler d1 info tokengate-telemetry`; apply migrations; lower retention or "Maximum request log rows" |
| Queue bound but records never arrive | The `queues.consumers` entry is missing, or batches fail (`telemetry.queue_batch_failed`) | Check `wrangler.jsonc` and the dead-letter queue ([observability](../observability.md#optional-request-log-queue)) |
| Older records are gone | Retention or "Maximum request log rows" removed them | Expected; use the [R2 archive](../observability.md#optional-r2-archive) for long history |
| R2 archive has fewer records than the request log | The stream dropped records that do not match the schema | Check `pipelinesUserErrorsAdaptiveGroups` ([observability](../observability.md#dropped-records)) |

## Collect this before you ask for help

- The request id and the full response headers.
- The record from `/admin/requests/<request-id>`, including the policy trace. It holds only allowlisted
  claims, never tokens or credentials ([I-LOG-1](../threat-model.md#i-log-1)).
- `/readyz` output and the dashboard banners.
- The code version: `git describe --tags` in your clone.

Report suspected vulnerabilities privately ([SECURITY.md](../../SECURITY.md)), not in a public issue.
