# Architecture decision records

This page lists the architecture decision records (ADRs) of cloudflare-tokengate. It is for security reviewers and contributors who want to know why the system is built the way it is.

Each ADR uses the format from [0001](0001-record-architecture-decisions.md): Status, Context, Decision, Consequences. The current design is described in [architecture.md](../architecture.md).

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-workload-identity-tokens-for-callers.md) | Callers authenticate with workload identity tokens | Accepted |
| [0003](0003-cloudflare-workers-and-two-d1-databases.md) | Cloudflare Workers with two D1 databases | Accepted |
| [0004](0004-envelope-encryption-bound-to-destination.md) | Envelope encryption bound to the destination, not Secrets Store | Accepted |
| [0005](0005-grant-model.md) | IssuerAccessRule model: Conditions, anchor rules, trusted events, tenant pin | Accepted |
| [0006](0006-no-policy-caching.md) | No policy caching | Accepted |
| [0007](0007-server-rendered-admin-ui-without-client-javascript.md) | Server-rendered admin UI without client JavaScript | Accepted |
| [0008](0008-login-providers-from-environment.md) | Login providers from the environment; email linking only for invited users | Superseded by [0015](0015-cloudflare-access-only-admin-login.md) |
| [0009](0009-telemetry-design.md) | Telemetry in D1, optional queue and R2 archive, no Analytics Engine | Accepted |
| [0010](0010-dependency-injection-for-tests.md) | Dependency injection for tests | Accepted |
| [0011](0011-oauth-state-in-host-cookie.md) | OAuth state in a `__Host-` cookie | Superseded by [0015](0015-cloudflare-access-only-admin-login.md) |
| [0012](0012-apache-2-0-license.md) | Apache-2.0 license | Accepted |
| [0013](0013-operator-variables-outside-wrangler-config.md) | Operator variables outside `wrangler.jsonc` | Accepted |
| [0014](0014-integrity-rules-in-sql.md) | Integrity rules and audit rows enforced in SQL | Accepted |
| [0015](0015-cloudflare-access-only-admin-login.md) | Cloudflare Access as the only admin login, without gateway sessions | Accepted |
| [0016](0016-admin-hosts-in-settings.md) | Admin hosts in Settings instead of `PUBLIC_URL` | Accepted |
| [0017](0017-kek-bound-to-login-variables.md) | Key-encryption keys bound to the login variables | Accepted |
| [0018](0018-role-split-and-field-permissions.md) | Role split (token and access duties) and field permissions | Superseded by [0023](0023-teams-replace-roles.md) |
| [0019](0019-admin-information-architecture.md) | Admin information architecture and URL scheme | Accepted |
| [0020](0020-sealed-credential-drafts.md) | Sealed credential drafts | Accepted |
| [0021](0021-structured-consumer-access-and-labels.md) | Structured issuer access rules, claim labels and risk acceptance | Accepted |
| [0022](0022-admin-ui-on-design-system-d.md) | Admin UI on design system D: sidebar shell, section order, export in the account menu, stylesheets served by the Worker | Accepted |
| [0023](0023-teams-replace-roles.md) | Teams replace roles; scoped visibility of credentials and consumers; no escalation enforced in SQL | Accepted |
| [0024](0024-secret-reveal-over-ecdh.md) | Secret reveal over ECDH and one client script | Accepted |

## Adding an ADR

1. Copy the structure of an existing ADR.
2. Use the next free number and a short kebab-case title.
3. Set the status to `Proposed` in the pull request. Change it to `Accepted` when the pull request merges.
4. If the ADR replaces an earlier one, set the earlier one's status to `Superseded by NNNN`. Do not edit its other sections.
5. Add a row to the table above.

[CONTRIBUTING.md](../../CONTRIBUTING.md) says which changes need an ADR.
