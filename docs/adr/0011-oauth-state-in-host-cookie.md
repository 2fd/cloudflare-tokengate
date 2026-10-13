# 11. OAuth state in a `__Host-` cookie

This ADR explains where a pending admin login is stored between the start and the callback. It is for security reviewers.

Date: 2026-10-13

## Status

Accepted

## Context

The `github` and `oidc` Login providers use the authorization code flow with PKCE, `state` and, for OIDC, a nonce. The callback must be bound to the browser that started the login.

The first design kept the pending login in a D1 table, `oauth_states`. `GET /auth/:login_provider/start` is anonymous, so anyone on the internet could write one D1 row per request. That is a cheap way to consume D1 writes and storage.

## Decision

The pending login lives only in the browser (`src/admin/auth/oauth-state.ts`, `src/admin/auth/routes.tsx`):

- `/start` creates a random `state`, PKCE verifier and nonce. It adds `{state, code_verifier, nonce, return_to, login_provider, expires_at}` to a list of pending logins, stored as base64url JSON in the cookie `__Host-tokengate_oauth` with `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`. It writes nothing to D1.
- The list holds at most 3 entries, keyed by `state`. `/start` drops expired entries, then the oldest entries until the list has at most 3 entries and the cookie value is at most 3800 bytes. `return_to` is at most 512 characters and contains no character that JSON escapes, so 3 entries always fit and the 3-entry limit is what drops an entry. So 2 or 3 logins in different tabs of one browser do not cancel each other.
- The callback compares the query `state` with every entry (constant-time comparison). A missing or unknown `state` answers 400 and leaves the cookie unchanged, so a forged callback cannot cancel a real login. A matching entry is removed from the cookie first. Then the callback requires that the entry names the same login provider and is not expired. Otherwise it answers 400.
- `return_to` is sanitized at the start and again at the callback. Only `/admin` and paths below it are allowed. The sanitized value is at most 512 characters after URL serialization, and `\` is written as `%5C`.
- The cookie is neither encrypted nor signed.

The `oauth_states` table was removed from the schema.

## Consequences

- Anonymous `/start` requests cost no D1 writes. tokengate does not throttle them itself. Operators can add a Cloudflare WAF rate-limiting rule ([operations/cloudflare-zone-settings.md](../operations/cloudflare-zone-settings.md)).
- No server-side record makes `state` single use. Replay protection relies on the browser storing the cookie without the consumed entry after the first callback, on the 10-minute expiry, and on the login provider refusing a reused authorization code, which is bound to PKCE and the client secret ([I-OAUTH-1](../threat-model.md#i-oauth-1)).
- A page on another site can navigate the browser to `/start` 3 times. Fewer navigations never do, whatever `return_to` they carry. This pushes an earlier pending login out of the list, and that login then fails with 400. It cannot make the browser sign in to another account.
- Cookie integrity relies on the browser's `__Host-` rules: no other site or subdomain can set it, so a forged callback fails the `state` check. A user can change only their own cookie, which affects only their own login.
- The PKCE verifier in the cookie is readable only by someone who already holds the browser's cookies, including the session cookie.
- These limits are listed in [threat-model.md](../threat-model.md).
