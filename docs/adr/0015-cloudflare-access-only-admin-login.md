# 15. Cloudflare Access as the only admin login, without gateway sessions

This ADR explains how admin users sign in to the console and why the gateway keeps no sessions of its own. It is for security reviewers and platform engineers. It supersedes [0008](0008-login-providers-from-environment.md) and [0011](0011-oauth-state-in-host-cookie.md).

Date: 2026-10-14

## Status

Accepted

## Context

The first design offered three login providers: a GitHub OAuth App, any OpenID Connect issuer (with a Google preset) and Cloudflare Access ([0008](0008-login-providers-from-environment.md)). After sign-in, the gateway issued its own session: a random id in a `__Host-` cookie, its SHA-256 in a `sessions` table, idle and absolute expiry, rotation on login and revocation. The OAuth and OIDC flows also needed a pending-login cookie ([0011](0011-oauth-state-in-host-cookie.md)).

This was a large and security-sensitive surface: three provider integrations, PKCE, `state` and nonce handling, discovery caching, provider-specific email rules (GitHub verified emails, Google `hd`), session storage and revocation, and a CSRF token stored in the session.

Every deployment already runs on Cloudflare. Cloudflare Access authenticates users against the company identity provider, enforces its own policies (groups, device posture, session duration) and puts a signed JWT on every request it lets through. The gateway already verified that JWT on every request for Access sessions.

## Decision

- **Access is the only production admin login.** `AUTH_ACCESS_TEAM_DOMAIN` and `AUTH_ACCESS_AUD` configure it. It requires `PUBLIC_URL` on a custom https domain, not `workers.dev`. The GitHub, OIDC and Google login providers, their variables and the `oauth4webapi` dependency are removed. So are the `/auth/*` routes.
- **No gateway sessions.** Every `/admin` request is authenticated by its own `Cf-Access-Jwt-Assertion` header: RS256, the team's keys, the exact issuer and AUD, not expired, a `sub` and an email. Service tokens are refused. The schema has no `sessions` table; `0001_initial.sql` was changed before the first release, so no migration drops one. The identity is `(access, <team domain>|<sub>)`. It is resolved to a user on every request: a known identity signs in its active user, and an invited user is linked by the Access email ([0008](0008-login-providers-from-environment.md)).
- **First owner, then viewers.** While no owner exists, the first sign-in becomes the owner, once ([I-BOOT-1](../threat-model.md#i-boot-1)). No variable limits who that is: keep the Access policy limited to yourself until you have signed in. Every later sign-in whose email matches no user creates a user with the join defaults (audit action `user.join`): by default an active `viewer`. Owners can change the join role (`viewer` or `admin`) and status (`active`, `pending` or `suspended`) on the Users page; they are stored in the `settings` table (`join_role`, `join_status`) and audited as `user.join_defaults`. Pending users wait in "Waiting for approval" until an owner approves (→ `active`) or rejects (→ `suspended`) them. User statuses are `invited`, `pending`, `active` and `suspended` (`suspended` replaces `disabled`). Invitations remain, to give another role from the start. An email that already belongs to another user is refused (`email_taken`); it is never linked outside an invitation ([I-LINK-1](../threat-model.md#i-link-1)).
- **Write re-check by identity.** An audited admin write re-checks, in its own D1 batch, that the request's identity is still linked to the active user and that the user's role still holds the permission ([I-SESS-1](../threat-model.md#i-sess-1)). Before, the check used the session.
- **CSRF without sessions.** Unsafe requests need `Sec-Fetch-Site` (or `Origin`) from this site AND a `_csrf` form field equal to a `__Host-tokengate_csrf` cookie: 32 random bytes, `Secure`, `HttpOnly`, `SameSite=Strict` (double submit, [I-CSRF-1](../threat-model.md#i-csrf-1)).
- **Sign-out belongs to Access.** "Sign out" links to `/cdn-cgi/access/logout`.
- **Local development login.** `AUTH_DEV_EMAIL` signs every admin request in as that email, with no proof. It is accepted only when `PUBLIC_URL` is on `localhost`, `127.0.0.1` or `[::1]`. Host pinning ([I-DEPLOY-1](../threat-model.md#i-deploy-1)) then refuses every admin request whose URL is not that origin, which no request through Cloudflare's edge can have. When Access is configured, it is the only accepted login.

## Consequences

- The admin console needs a custom domain and an Access application that covers `/admin`. The `workers.dev` quick start deploys the proxy, but nobody can sign in to the console until both are set up. `/proxy` must stay outside the Access application.
- Gaps in the Access application fail closed: the Worker verifies the JWT itself, so a request that bypasses Access gets 401.
- Users linked through GitHub or OIDC keep `github` or `oidc` identities that nothing accepts any more. An owner must use "Reset login" for each of them. If no owner can sign in, use [break-glass](../operations/break-glass.md).
- A suspension, role change or login reset applies to the user's next request. The "End sessions" action is removed. To end someone's Access session, revoke it in Zero Trust.
- The gateway writes no `user.login` audit rows. Access logs sign-ins. `users.last_login_at` and `user_identities.last_used_at` record the last use of the console, written at most once per 5 minutes per user.
- The Access JWT is a bearer credential until it expires. The gateway cannot revoke it. The Access session duration sets the exposure.
- The Access policy is the list of people who can reach the admin UI: each of them becomes a user with the join defaults. With the default (active viewer) they can read it at once; with the join status `pending` they wait for an owner. Until the first owner signs in, the first person through Access becomes the owner, so the policy must name only the operator until then.
- The trust in email linking moves to Access and the identity provider behind it. The provider-specific email rules of 0008 (GitHub verified emails, Google `hd`, `AUTH_OIDC_ALLOWED_DOMAINS`) no longer exist; restrict the Access policy instead.
- A D1 restore can no longer bring back ended sessions, but it still brings back users, roles and identity links as they were at the restore point.
