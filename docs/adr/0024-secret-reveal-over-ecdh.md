# 24. Secret reveal over ECDH and one client script

This ADR explains how a person with reveal on a service token copies its secret, why the one endpoint that releases a secret encrypts it to a key of the browser, and why the admin UI now has one client script. It is for security reviewers and for contributors who change the token pages, the security headers or `/static`. It amends [ADR 0007](0007-server-rendered-admin-ui-without-client-javascript.md) (no client JavaScript) and [ADR 0022](0022-admin-ui-on-design-system-d.md) (the CSP and the files that `/static` serves). It changes [I-CRED-1](../threat-model.md#i-cred-1), [I-CSRF-1](../threat-model.md#i-csrf-1) and [I-DEPLOY-1](../threat-model.md#i-deploy-1), and adds I-CRED-4 and I-CSP-1.

Date: 2026-10-17

## Status

Accepted

## Context

The requested change:

- By default the admin UI never shows or downloads a stored secret.
- A person who may reveal a token can only copy its value to the clipboard, and see its start and end.
- Exactly one endpoint returns a secret. It uses Diffie-Hellman to transport it: the browser sends its public part, and the server answers with its own public part and the encrypted secret.

Today the token pages show the length and the last 4 characters of a secret. They are stored in `services.credential_hint`. The audit diffs carry them, and each audit row also goes to Workers Logs as an `audit.event` line. So the last 4 characters of every secret are in D1, in backups and in logs.

Writing to the clipboard needs JavaScript. The admin UI has none ([ADR 0007](0007-server-rendered-admin-ui-without-client-javascript.md)), and its CSP has no `script-src`. The `/proxy` routes share the origin of the admin UI, so `script-src 'self'` would allow any script that an upstream returns.

"Test credential" opens the secret and then commits its audit row (`testServiceCredential` in `apps/gateway/src/admin/ops/services.ts`). Its plaintext only goes upstream after the commit, but the order is not "audit first".

Who may reveal is part of the team model ([ADR 0023](0023-teams-replace-roles.md)): a reveal flag per token row, or all-scope reveal. Among the built-in teams, only Owners hold it.

## Decision

### Endpoint

- **One route.** `POST /admin/tokens/:id/reveal` (`apps/gateway/src/admin/routes/token-reveal.tsx`). Its rule needs reveal on the token. A hidden token gives 404, a token without reveal gives 403, as for every route ([ADR 0023](0023-teams-replace-roles.md)). `GET` is not registered.
- **Request.** `application/x-www-form-urlencoded`, with `_csrf`, `public_key` and `expected_credential_at` (the `credential_updated_at` that the page showed). The CSRF rules are unchanged (I-CSRF-1), so a JSON body is refused. A `Sec-Fetch-Dest` header that is present and is not `empty` gives 403, which stops a form navigation.
- **Public key.** Canonical unpadded base64url of a 65-byte uncompressed P-256 point: 87 characters, first byte `0x04`. The server imports it with WebCrypto, which refuses a point that is not on the curve. A bad key gives 422 `invalid_public_key`.
- **Freshness of the sign-in.** The op refuses a reveal when the Access JWT `iat` is missing or older than `REVEAL_MAX_AUTH_AGE_SECONDS` (900 seconds, 15 minutes, in `apps/gateway/src/admin/ops/reveal.ts`). It accepts up to 60 seconds of clock skew into the future. The refusal is 403 `reauth_required`. It comes before the audit row and before anything is opened. The development login sets `iat` to the request time.
- **Checks.** The token must have a credential (409 `no_credential`) that did not change since the page loaded (409 `changed`). The stored destination must pass the same checks as on use, and the keyring must hold the key of the sealed value (409 or 503 `credential_unavailable`). A revealed token can be disabled, but its binding must be attested.
- **Audit before open.** The op commits the audit row first, guarded on the credential it read and on the rate limit. The actor check carries the reveal claim (I-SESS-1). Only after the commit does the op open the credential. When the open fails, the response is 503 and the audit row stays as a record of the attempt.
- **Rate limit.** At most 20 reveals per user in a rolling hour. The guard counts the user's reveal audit rows in the same batch as the new row, so it is atomic. Over the limit: 429 `too_many_reveals` with `retry_after_seconds`. A mid-request loss of reveal gives 409 `access_changed`.
- **Response.** 200, `application/json`, `cache-control: no-store`, and the default CSP:

  ```json
  {"v":1,"server_public_key":"<87 b64u>","iv":"<16 b64u>","ciphertext":"<b64u>"}
  ```

  Errors of the op are JSON `{"error":"<code>"}`. Errors of the middleware are HTML pages. The script treats any answer that is not 200 JSON as a failure.

### Protocol

`apps/gateway/src/crypto/reveal.ts`, WebCrypto only:

```text
client : (cPriv, cPub) = ECDH P-256 generateKey(extractable=false); cPubRaw = 65 B (0x04‖X‖Y)
server : (sPriv, sPub) fresh per request, never stored;              sPubRaw = 65 B
Z      = ECDH(sPriv, cPub) = deriveBits(256)
salt   = cPubRaw ‖ sPubRaw                                   (130 B; binds both keys)
info   = utf8("tokengate/v1/credential-reveal\n" + serviceId + "\n" + userId)
K      = HKDF-SHA256(Z, salt, info) → AES-256-GCM key
iv     = random(12)
AAD    = info
ct     = AES-GCM(K, iv, AAD, utf8(plaintext))                 (128-bit tag appended)
```

The label differs from the stored-credential and draft labels ([ADR 0004](0004-envelope-encryption-bound-to-destination.md), [ADR 0020](0020-sealed-credential-drafts.md)). A test vector file freezes the format.

### Audit and logs

- **Audit row.** Action `service.credential.reveal`, target the service, `resources` the service id. Summary "Released the secret of `<slug>` for copying". The diff holds the key id, `credential_updated_at` and `client_key`, the first 16 hex characters of SHA-256 of the client public key. The audit page has a "Secret copies" filter.
- **Owner signal.** An info alert counts the releases of the last 24 hours ("N secrets released for copying"). Global viewers who hold `users:write` see it.
- **Refusals.** A refused reveal writes no audit row, so an attacker cannot fill the audit log. It writes one `admin.reveal_refused` log line to Workers Logs with `reason`, `actor_id`, `service_id` and `client_key`, never the public key. The op reasons are `invalid_public_key`, `reauth_required`, `no_credential`, `changed`, `credential_unavailable`, `too_many_reveals` and `access_changed`. The middleware reasons are `hidden`, `no_reveal`, `csrf` and `fetch_dest`.

### One client script

- **File.** `apps/gateway/src/admin/client/reveal.client.js`, a plain ES module with JSDoc types. The gateway owns it. `packages/ui` stays free of JavaScript.
- **Serving.** wrangler bundles it as a Text module. The Worker serves it at exactly `/static/reveal.<first 16 hex of its SHA-384>.js`, with `text/javascript`, an immutable cache, an etag and `nosniff`. Every other `/static/*.js` path is a 404. The page loads it with `<script type="module" src integrity>` (SHA-384). A unit test and `apps/gateway/scripts/check-bundle.sh` compare the hash with the pinned constant.
- **Where.** Only the token detail page, only for a person with reveal on that token, only when a credential exists and its binding is attested. The tokens list has no script.
- **CSP per response.** That page gets the default policy plus `script-src <origin>/static/reveal.<hash>.js`, `connect-src <origin>/admin/tokens/<id>/reveal`, `require-trusted-types-for 'script'` and `trusted-types 'none'`. Both sources are exact URLs, never `'self'`, because `/proxy` shares the origin. Every other response keeps the constant policy of [ADR 0007](0007-server-rendered-admin-ui-without-client-javascript.md).
- **Rules for the script.**
  - The "Copy secret" button renders `hidden`. The script shows it only when the page is a secure context and the browser has a usable clipboard API. Without one, the button stays hidden and the script sends no request. Without JavaScript, the button stays hidden.
  - No `innerHTML`, no `on*` attributes and no `eval`.
  - The plaintext never goes to the DOM, to storage or to the console. The script makes no promise to clear the clipboard.
  - When the reveal fails, the status shows the reveal error, not the clipboard error. When the reveal succeeded but the browser refused the copy, the status says so: "The secret was released (and is in the audit log), but the browser refused the copy."
  - When the sign-in is older than 15 minutes, the page renders the control disabled, with "To copy this secret, sign in again (your sign-in is older than 15 minutes)." and a link to the Access sign-out. The script shows the same text for `reauth_required`.

### Length-only storage

- `services.credential_hint` becomes `credential_length`. No character of a secret is stored outside the sealed value.
- The token detail page shows the first 4 and last 4 characters only to a person with reveal on that token, and only when the secret part has at least 20 characters. The page derives them at render from the credential that it already opens for the binding check. They are never stored.
- Everyone else sees a mask and the length. Audit diffs carry the length and the key id. Credential drafts show the length only. The export carries neither characters nor the length.

## Consequences

- **What ECDH protects.** The plaintext is not in captures of response bodies: gateway, Access and Cloudflare logs of bodies, passive TLS-terminating middleboxes that record responses, devtools network panes and HAR files, and the HTTP cache.
- **What it does not protect.**
  - A capture that holds the request headers (a HAR exported with sensitive data, a middlebox that logs requests) also holds the `CF_Authorization` cookie, the CSRF cookie and the `_csrf` field. The CSRF checks are enforced by the browser, and any other client can set `Sec-Fetch-Site` and `Origin`. Whoever holds such a capture can send a fresh reveal with their own key, up to 20 secrets per hour. The freshness gate limits this to 15 minutes after the victim's last Access sign-in. Whether Access issues a new `iat` without a new sign-in depends on the session settings of the Access application. Operators set a short Access session duration for the people who hold reveal ([configuration](../configuration.md)).
  - Active middleboxes, or anyone who can change traffic: the server key is not authenticated, so they can replace keys in both directions, and they can change the script.
  - XSS, a malicious browser extension, a compromised Worker, and the user themselves (breakpoints, clipboard history).
- **Copy only is a UI choice, not a control.** A person with reveal can always EXTRACT the secret. Every release goes through one route, is audited before the secret is opened, and is rate-limited. I-CRED-1 says this.
- **Reveal holders.** Among the built-in teams, only Owners can EXTRACT a credential. Viewers, token managers, access managers and admins still cannot. A custom team gets reveal only from a person who holds it ([ADR 0023](0023-teams-replace-roles.md)), and the default team for new people never holds it.
- **The sign-in age matters.** A person who signed in more than 15 minutes ago signs in again before a copy. When Access does not issue a new `iat` during a session, this happens once per copy session.
- **Test credential keeps its order.** It opens the secret before it commits its audit row. Its plaintext only goes upstream after the commit. A later ADR may align it with "audit first".
- **No `Permissions-Policy` header.** The clipboard keeps the browser default for the top-level page.
- **Less in D1 and logs.** A D1 reader, a backup reader or a log reader learns only the length of a secret. The stored last 4 characters are removed. There is no release yet, so the initial migration is edited in place, and local databases must be recreated.
- **One more thing to keep in step.** The hash constant, the served path, the CSP, the bundle check and the test vectors change together. The tests fail when one of them changes alone.
