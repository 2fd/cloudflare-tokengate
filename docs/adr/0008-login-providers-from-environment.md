# 8. Login providers from the environment; email linking only for invited users

This ADR explains how admin sign-in is configured and how a login is matched to a user. It is for security reviewers and platform engineers.

Date: 2026-10-13

## Status

Superseded by [0015](0015-cloudflare-access-only-admin-login.md)

## Context

Whoever controls admin sign-in controls every grant. Two risks shaped the design:

- **Login providers configurable from the UI.** If admins could add a login provider from the UI, one admin could add one they control and sign in as any user, including an owner.
- **Email-based account linking.** Many OpenID Connect issuers let users set an unverified email address, or let any tenant issue any email. Linking logins to existing accounts by email alone allows account takeover.

There must also be a safe way to create the first owner.

## Decision

- Login providers come only from Worker variables and secrets, parsed by `src/config.ts`:
  - `github`: a GitHub OAuth App (`AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET`, optional `AUTH_GITHUB_ALLOWED_ORGS`).
  - `oidc`: any OpenID Connect issuer (`AUTH_OIDC_ISSUER`, `AUTH_OIDC_CLIENT_ID`, `AUTH_OIDC_CLIENT_SECRET`), or the Google preset (`AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`). The two are mutually exclusive. Both accept the optional `AUTH_OIDC_ALLOWED_DOMAINS` and `AUTH_OIDC_NAME`.
  - `access`: Cloudflare Access (`AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD`). It requires `PUBLIC_URL` on a custom domain, not `workers.dev`.
- Each login provider is parsed on its own. A half-configured one is disabled and reported by variable name ([I-CFG-1](../threat-model.md#i-cfg-1)).
- A login identity is `(login_provider, subject)`. The subject is the GitHub numeric user id, the canonical OIDC issuer with `sub`, or the Access team domain with `sub`. The canonical issuer is the parsed URL without the `/` after a bare host, so every issuer spelling that discovery accepts gives the same subject. Identities linked by an earlier version under the configured spelling are still found under that spelling. Sign-in resolves in this order (`src/admin/auth/resolve-login.ts`):
  1. A known identity signs in its user, if the user is active.
  2. Otherwise, an invited user with an unexpired invite is linked and activated, if the login has an authoritative email for that user.
  3. Otherwise, if no owner exists and bootstrap never ran, a login with an authoritative email listed in `BOOTSTRAP_OWNER_EMAILS` becomes the first owner. This happens at most once ([I-BOOT-1](../threat-model.md#i-boot-1)).
  4. Otherwise, sign-in is refused as "not invited".
- `src/admin/auth/email.ts` is the only place that decides whether an email is authoritative:
  - `github`: every email that GitHub reports as verified.
  - `oidc`: the `email` claim when `email_verified` is true. If `AUTH_OIDC_ALLOWED_DOMAINS` is set, the domain must be in the list.
  - `oidc` with Google: also, the `hd` claim must equal the email domain. Without `hd`, only an `@gmail.com` address qualifies, and only when no domain list is set.
  - `access`: the email in a valid Access JWT.
- Active and disabled users are never linked by email ([I-LINK-1](../threat-model.md#i-link-1)).

## Consequences

- Adding or changing a login provider requires changing Worker variables or secrets. Admin UI access is not enough. D1 write access can still create users and login identities directly; see the D1 write actor in the [threat model](../threat-model.md).
- A User's access survives an email change at the login provider, because the identity is the stable subject.
- Moving a user to another login provider needs an owner to use "Reset login" and the user to sign in again from the invite.
- After the first owner signs in, `BOOTSTRAP_OWNER_EMAILS` has no effect. Operators should remove it ([getting-started.md](../getting-started.md)).
- If every owner is locked out, recovery needs direct D1 access ([operations/break-glass.md](../operations/break-glass.md)).
- Only one OpenID Connect issuer can be configured at a time.
