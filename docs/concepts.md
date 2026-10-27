# Concepts

This page defines the terms that the code, the admin UI and the documentation use, and shows how they relate. It is for everyone, and in particular for security reviewers. Each term has exactly one meaning; the docs never use the bare word "provider".

## How the terms relate

![Concepts: a profile (code) defines the rules for a credential access rule; a credential access rule has many issuer_access_rules; each grant targets one service; a service has zero or one credential, encrypted by the keyring (Worker secret); Cloudflare Access signs in users; each user change writes an audit event; grant decisions are recorded as request records in TELEMETRY_DB. Credential access rules, issuer_access_rules, credentials, credentials, users and audit events live in the D1 control-plane database.](diagrams/domain-model.svg)

<sub>Diagram source: [`diagrams/src/`](diagrams/src/) (rendered with [archify](https://github.com/tt-a1i/archify)).</sub>

A request flows through these terms in a fixed order. The full pipeline is in [architecture.md](architecture.md).

1. The caller sends a token. Its issuer selects a **credential access rule**.
2. The **profile** of that credential access rule says how to verify the token.
3. The **tenant pin** decides whether the caller belongs to your company.
4. The URL slug selects a **service**.
5. The **issuer_access_rules** that connect this credential access rule and this service are evaluated. A grant matches when all its **conditions** hold and one of its **rules** allows the method and path. **Anchor claims** and **trusted events** constrain which issuer_access_rules are valid.
6. The gateway decrypts the **credential** with the **keyring**, attaches it by **injection**, and forwards the request.
7. The gateway writes a **request record**.

## Admin UI names

The admin UI uses task names for some terms. The code, the database, the audit log and the export keep the terms of the glossary. This table maps them.

| Admin UI name | Term in the code and the database | Admin UI page |
|---|---|---|
| Credential | [service](#credential), plus its credential | Credentials › Credentials (`/admin/credentials`) |
| Secret | [secret](#secret) | The credential page |
| Credential access rule | [credential access rule](#credential-access-rule) | Credentials › Access Rules › Credential access rules (`/admin/credential-access-rules`) |
| Issuer type | [profile](#profile) | The credential access rule page |
| Organization / Group | the values of the [tenant pin](#tenant-pin) | The credential access rule page |
| Issuer access rules | [issuer access rule](#issuer-access-rule) | Credentials › Access Rules › Global access rules (`/admin/global-access-rules`) |
| Constraints | the grant [conditions](#condition) | The access page |
| Allowed operations | the grant [rules](#rule) | The access page |
| Accepted risks | acknowledged grant warnings | The access page |
| Display label | a row in `claim_labels` ([display label](#display-label)) | The credential access rule and access pages |

The admin UI has three sections, in the order of its sidebar: Monitoring (Overview, Requests, Audit log, Data retention), Credentials (Credentials, Access Rules, with tabs for credential and global access rules) and Settings (People, Sign-in, Allowed hosts, Rotate encryption, Appearance). See [ADR 0019](adr/0019-admin-information-architecture.md) and [ADR 0022](adr/0022-admin-ui-on-design-system-d.md).

## Glossary

### Credential

A credential combines a stored secret with the upstream API destination and authentication settings for using it. The database table is `credentials`; some internal helpers retain the historical name `service`. It has a slug, a fixed `https` base URL, an injection, an optional credential, a timeout, an optional list of extra request headers to forward, and an optional credential check. Callers address it as `/proxy/<slug>/<path>`; the gateway appends `<path>` to the base URL and never leaves it ([I-PATH-1](threat-model.md#i-path-1)). The slug is 1 to 63 characters of `a-z`, `0-9` and `-` and cannot change. The base URL must use `https`, must not be an IP address, localhost, a `workers.dev` host or the gateway itself, and must match the upstream host allowlist when an owner has set one (Settings › Allowed hosts). The gateway checks this when the service is saved and again on every request ([I-SSRF-1](threat-model.md#i-ssrf-1)). Disabling a service refuses its requests from the next request on. IDs start with `svc_`. Admin UI: Credentials (`/admin/credentials`). Code: `apps/gateway/src/admin/ops/credentials.ts`, `apps/gateway/src/db/credentials.ts`.

### Secret

A secret is the secret of a service, for example an API key, a bot token or the token part of a webhook URL. The admin UI accepts it once and never shows it again; pages show only its length and last 4 characters. The gateway stores it encrypted with AES-256-GCM envelope encryption: a fresh data key per credential, wrapped by the active key of the keyring. Both layers are bound to the service ID, the base URL and the injection, so a credential only decrypts for the destination it was saved for. The base URL and injection of a credential made from a type are fixed. Changing them on a custom credential requires entering the credential again, and a database edit of either makes decryption fail closed ([I-CRED-2](threat-model.md#i-cred-2)). The credential never appears in gateway responses, logs, audit events, the UI or exports ([I-CRED-1](threat-model.md#i-cred-1)). Admin UI: Secret, on the credential page. Code: `apps/gateway/src/crypto/envelope.ts`.

### Injection

The injection is how the gateway attaches the credential to the outbound request. There are five kinds:

| Kind | Outbound request | Typical use |
|---|---|---|
| `bearer` | `Authorization: Bearer <credential>` | Most APIs (Slack, OpenAI, GitHub) |
| `header` | `<name>: <prefix><credential>` | `x-api-key` (Anthropic) |
| `basic` | `Authorization: Basic base64(<username>:<credential>)`; without a username, the credential is `user:password` | HTTP Basic APIs |
| `query` | `?<param>=<credential>` | Legacy APIs; not recommended |
| `path` | `<base URL>/<prefix><credential>/<path>` | Webhooks (Slack, Discord) |

The gateway removes any copy of the injected header or query parameter that the caller sends, so a caller cannot replace or observe the credential ([I-INJ-1](threat-model.md#i-inj-1)). Code: `apps/gateway/src/proxy/inject.ts`, `apps/gateway/src/proxy/path.ts`.

### Issuer

An issuer is the exact `iss` URL in a workload identity token, such as `https://token.actions.githubusercontent.com`. It is a value in an access rule, not a separate resource. It is unrelated to the login provider used by people signing in to the admin app.

### Credential access rule

A credential access rule belongs to one credential and defines which issuer and identity filters may receive access to it. Credential administrators manage these boundaries. Each rule carries the issuer verification settings (profile, JWKS URI, audience, algorithms and maximum token age), organization restrictions and any additional mandatory filters. Several boundaries may use the same issuer. Adding a boundary grants nobody access.

For example, a boundary for the production Slack credential can require GitHub organization ID `1234567` and `environment exact production`. An issuer access rule may select one repository within that organization, but cannot admit another organization or staging. Limits are checked when an access is created, edited or enabled, and again on each request. Tightening or disabling a boundary takes effect on the next request.

Admin UI: Access Rules → Credential Access Rules (`/admin/credential-access-rules`). Database: `credential_access_rules`. Issuers have no table of their own.

### Profile

A profile is code-reviewed knowledge about one issuer type. There are four: `github-actions`, `gitlab-ci`, `vercel` and `generic`. A new profile is code only: the schema stores the profile ID and claim labels without a fixed list ([ADR 0028](adr/0028-issuer-profiles-are-code.md)). A profile defines the default issuer and algorithms, the maximum token age limit, the claim that names the triggering event, the trusted events, the claims a tenant pin may use, the shared issuers, the anchor rules, the claims a token must carry, and the claims copied into request records. Admins choose a profile when they create a credential access rule and cannot change it later. Issuers on `token.actions.githubusercontent.com`, `gitlab.com` or `oidc.vercel.com` must use their platform profile. Admin UI: Issuer type. Code: `apps/gateway/src/identity/profiles/github-actions.ts`, `gitlab-ci.ts`, `vercel.ts`, `generic.ts`.

### Tenant pin

A tenant pin is a list of exact claim conditions that every token of a credential access rule must satisfy. It answers "is this caller in my company?" before any grant is read. For GitHub Actions it uses the numeric `repository_owner_id` (UI: "Allowed organization IDs") and optionally `enterprise_id`; for GitLab CI it uses `namespace_id` (UI: "Allowed group (namespace) IDs"); for `generic` it may use any claim. Shared issuers (`https://token.actions.githubusercontent.com`, `https://gitlab.com`) sign tokens for anyone on the platform, so a credential access rule for them must have a tenant pin. A token outside the pin gets `401 tenant_mismatch` before the gateway reveals whether the service exists, and none of its claims are stored ([I-TEN-1](threat-model.md#i-ten-1), [I-LOG-2](threat-model.md#i-log-2)).

### Caller

A caller is a workload, for example a CI job, that presents a verified token. The gateway does not store callers. A caller exists only in request records, as the allowlisted claims of its token.

### Issuer access rule

An issuer access rule grants workloads access to one credential for specified methods and paths. It references a credential access rule for that same credential and selects identity filters within its limits. Access managers can create these rules, but cannot expand the credential's boundary. A rule may be disabled or expire.

Every mandatory filter must be preserved or demonstrably narrowed. Exact values may narrow a glob; arbitrary glob-to-glob containment is not inferred. Keep the boundary's glob unchanged and add more filters when needed. If a boundary is later tightened so an existing access rule is no longer contained, that access rule stops authorizing requests until corrected.

Admin UI: Access Rules → Issuer Access Rules (`/admin/issuer-access-rules`). Database: `issuer_access_rules`. Authorization remains allow-only: no matching rule means denial.

### Condition

A condition is a test on one verified claim of the token. The admin UI writes one condition per line:

```text
[not] <claim> exact|glob <value>[, <value>...]
```

`<claim>` is a literal top-level claim name: `a.b` is the claim named `a.b`, not a nested field. The values are alternatives (OR); all conditions of a grant must hold (AND). A condition compares strings, booleans (as `true` or `false`) and safe integers. A missing, null, array, object or unsafe-number claim never matches, even with `not` ([I-AUTHZ-4](threat-model.md#i-authz-4)). Admin UI: Constraints. Code: `apps/gateway/src/policy/conditions.ts`, `apps/gateway/src/admin/grant-text.ts`.

### Rule

A rule is one allowed operation: a set of methods and a path glob relative to the service base URL. The admin UI writes one rule per line:

```text
<METHOD[,METHOD...]|*> /path-glob
```

The methods are `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS`; `*` means all of them. A grant matches a request when one of its rules matches. Glob semantics (`*`, `**`, trailing `/`, `%2F`) are in [policies.md](policies.md). Admin UI: Allowed operations; a service template offers named sets of rules as operation presets, for example "Post messages: POST /chat.postMessage". Code: `apps/gateway/src/policy/glob.ts`, `apps/gateway/src/policy/evaluate.ts`.

### Anchor claim

An anchor claim is an identity claim that a grant must pin exactly, usually an immutable ID. Each profile has anchor rules; a grant must have an `exact`, non-negated condition on every claim of at least one rule ([I-AUTHZ-2](threat-model.md#i-authz-2)):

| Profile | Anchor rules (one must be satisfied) |
|---|---|
| `github-actions` | `repository_owner_id` + `repository_id`, or `repository_owner_id` + `job_workflow_ref` |
| `gitlab-ci` | `namespace_id` + `project_id`, or `namespace_id` + `ci_config_ref_uri` |
| `vercel` | `owner_id` + `project_id` |
| `generic` | any one of the credential access rule's anchor claims |

IDs are used because names can be renamed and registered again by someone else: numeric for GitHub and GitLab, prefixed for Vercel (`team_…`, `prj_…`). The workflow pins `job_workflow_ref` and `ci_config_ref_uri` are the exception: they are path-based, follow repository and project names, and admit every repository or project that runs the pinned file ([policies.md](policies.md#anchor-rules)). The gateway checks anchors when a grant is saved and again on every request; a grant that no longer satisfies them is skipped.

### Trusted events

Trusted events are triggering events whose workflow file and ref come from the repository itself. A grant matches other events only when it lists them with an `exact`, non-negated condition on the event claim; a glob never opts in ([I-AUTHZ-3](threat-model.md#i-authz-3)). Otherwise the request gets `403 event_not_trusted`.

| Profile | Event claim | Trusted events |
|---|---|---|
| `github-actions` | `event_name` | `push`, `workflow_dispatch`, `schedule`, `release` |
| `gitlab-ci` | `pipeline_source` | `push`, `web`, `schedule`, `api`, `trigger` |
| `vercel` | `environment` | `production`, `preview` |
| `generic` | none | no event check |

Events such as `pull_request_target`, `workflow_run` or GitLab `merge_request_event` can run code from outside contributors. Vercel `development` tokens go to every team member through `vercel env pull`. [policies.md](policies.md) explains when an opt-in is safe.

### User

A user is a person who signs in to the admin UI. A user has a role and a status:

| Status | Meaning |
|---|---|
| `invited` | An owner invited the email; nobody signed in with it yet. |
| `pending` | The person signed in for the first time while new users join as pending. An owner must approve (→ `active`) or reject (→ `suspended`) them. |
| `active` | Can use the admin UI with their role. |
| `suspended` | Refused on every request. An owner can make them active again. |

There are five roles. Token duties and access duties are separate roles ([ADR 0018](adr/0018-role-split-and-field-permissions.md)):

| Role | Permissions | Can |
|---|---|---|
| `viewer` | `read` | Read every page. No page shows secret material. |
| `token_manager` | `read`, `tokens:write` | Also create, change, disable and delete credentials; enter, rotate and test credentials. Cannot give any caller access to a service. |
| `access_manager` | `read`, `access:write` | Also create, change and delete credential access rules and issuer_access_rules, for any service. Never sees a credential. |
| `admin` | `read`, `tokens:write`, `access:write`, `config:export` | Token manager and access manager together, plus the configuration export. |
| `owner` | The admin's, plus `users:write`, `settings:write`, `keyring:rewrap` | Also invite, approve and reject users, change roles and statuses, reset logins, set the role and status of new users, change settings (including the upstream host allowlist), re-encrypt credentials. |

Some form fields need a further permission, on top of the route's: allowing a new upstream host while saving a service needs `settings:write`, and deleting a service together with its issuer_access_rules needs `access:write`. Every admin route has an entry in the permission table, and unknown routes are denied ([I-RBAC-1](threat-model.md#i-rbac-1)). The database refuses to remove the last active owner ([I-OWNER-1](threat-model.md#i-owner-1)). IDs start with `usr_`. Admin UI: Settings › Members (`/admin/users`). Code: `apps/gateway/src/admin/auth/rbac.ts`.

### Team

A team (an admin team) is a named set of users that holds global permissions and a scope of credentials and consumers. Its members get these powers. Teams replace the roles ([ADR 0023](adr/0023-teams-replace-roles.md)). A team is **not** the Cloudflare Access *team domain*: the docs always write "Access team domain" for that one, and the variable stays `AUTH_ACCESS_TEAM_DOMAIN`. "Team" alone always means an admin team. A user can be in several teams; the effective permissions are the union of the teams. A holder of `users:write` creates custom teams, sets their powers and adds people, but never more power than they hold themselves (I-RBAC-2). Teams are not tenants: slugs, names, issuers, settings and the keyring stay deployment-wide. IDs start with `tea_`. Admin UI: Settings › Teams (`/admin/users/teams`).

### Built-in team

A built-in team is one of five seeded teams with fixed IDs, in privilege order: Owners (`tea_owner`), Admins (`tea_admin`), Token managers (`tea_token_manager`), Access managers (`tea_access_manager`) and Viewers (`tea_viewer`). They are the former roles, with access to all tokens and all consumers. Their permissions and scope cannot change (I-RBAC-3); their membership can, which is how a person becomes an owner. The admin UI shows a "Built-in" badge next to them, and a custom team cannot have a name close to theirs.

### Membership

A membership is a row (team, user). Only the memberships of an active user count. A pending user holds no membership: approval puts them in one team. Nobody adds themselves to a team or removes themselves from one. The Owners team always keeps at least one active member ([I-OWNER-1](threat-model.md#i-owner-1)).

### Global permission

A global permission is a power that is not tied to one token or consumer: `tokens:create`, `consumers:create`, `config:export`, `users:write`, `settings:write` and `keyring:rewrap`. `read` is not stored: it means "member of at least one team". An active user in no team sees only the "No team yet" page.

### Level

A level is what a team may do with one token or consumer: `1` view, `2` edit, `3` delete. Each level includes the lower ones. Creating is a global permission of the kind, not a level. A issuer access rules (grant) has no level of its own: changing it needs edit on its consumer and view on its token.

### Scope

A scope is the set of tokens, or of consumers, that a team can reach, with a level. For each kind a team has exactly one mode: *none*, *all* (one level that covers current and future items) or *list* (one row per item, each with its own level). A team never mixes *all* and *list* for one kind. To see every token but change only some, a person joins two teams, for example Viewers and Payments.

### Visible

A token or consumer is visible to a person when one of their teams can at least view it. Anything else is hidden everywhere in the admin UI: lists, details, the access map, requests, the audit log, the Overview, the export and the sidebar counts. Its URL answers 404, the same page as for an ID that does not exist (I-SCOPE-1). A issuer access rules is visible when its consumer and its token are both visible. A request record is visible when its consumer is visible and its token is unset or visible.

### Global viewer

A global viewer is a person who can view all tokens and all consumers through an all-scope. Only global viewers see records from before a caller was trusted, deployment-wide totals and the traffic of deleted tokens. Every built-in team is a global viewer.

### Reveal

Reveal (admin UI: "Copy secret") is a flag on a team's access to a token. It includes view. It allows `POST /admin/credentials/:id/reveal`, which sends the credential to the browser encrypted to a key of the browser, after an audit row, at most 20 times per hour per person. The browser copies it to the clipboard and never shows it. Among the built-in teams only Owners hold reveal. A person with reveal can always extract the credential: "copy only" is a UI choice, not a control ([ADR 0024](adr/0024-secret-reveal-over-ecdh.md)). Not the same as the `Reveal` component of `@tokengate/ui`, which shows a branch of a form without JavaScript.

### Default team

The default team is the team that new people join on their first sign-in when the join status is `active` (settings key `join_team`). By default it is Viewers. It must be join-safe: not Owners, and no `users:write`, `settings:write`, `keyring:rewrap` or reveal ([I-LINK-1](threat-model.md#i-link-1)). The default team cannot be deleted. Admin UI: Settings › Members › "Default access…".

### Receiving team

The receiving team is the team that gets access to a token or consumer when someone creates it. The create form offers the creator's teams that hold the matching create permission. The team gets the level delete, without reveal, in the same database batch as the new item, so the creator can always see what they created (I-SCOPE-2).

### Secret ends

The secret ends are the first 4 and the last 4 characters of a credential. The credential page shows them only to a person with reveal on that token, and only when the secret part (without a username or prefix) has at least 20 characters. They are derived when the page renders and never stored: the database holds only the length of the credential. Everyone else sees a mask and the length.

### Login provider

Users sign in through Cloudflare Access (login provider `access`), configured with Worker variables, not in the database ([configuration.md](configuration.md), [ADR 0015](adr/0015-cloudflare-access-only-admin-login.md)). The gateway keeps no session: it verifies the Access token on every admin request. The token proves a stable subject (`<team domain>|<sub>`) and an email address. On a new login, the gateway links an existing user only when that user is invited, the invitation is not expired, and the email in the token matches ([I-LINK-1](threat-model.md#i-link-1)). Otherwise the first person to sign in becomes the owner, at most once ([I-BOOT-1](threat-model.md#i-boot-1)). Everyone after that joins with the role and status that owners set for new users in Settings › Members › "Default access…": by default an active `viewer`; the role can be any role except `owner`, and the status `pending` (wait for approval) or `suspended`. So the Access policy decides who can reach the admin UI, and the join status decides whether they get in at once. An email that already belongs to another user is refused. Admin UI: Settings › Members (`/admin/users`) shows the login provider, and its "Default access…" button sets the policy for new people. For local development only, `AUTH_ACCESS_DEVELOPMENT` (login provider `dev`) signs every request to `localhost` in as one email. It never works together with Access: with both set, no login works ([I-CFG-1](threat-model.md#i-cfg-1)). Code: `apps/gateway/src/admin/auth/`.

### Request record

A request record is one row in `request_log` in `TELEMETRY_DB` for a call to `/proxy/...`. It holds the outcome (`allowed`, `denied` or `error`), the reason code, the HTTP status, the service, the credential access rule, the matched grant, the allowlisted claims of the verified caller and the policy evaluation trace. Denied and error records of verified callers are always kept. Allowed records are sampled by the setting "Share of allowed requests to record". Rejections that happen before the token is verified and the tenant pin holds are recorded at a limited rate and without claims. Raw tokens and credentials never reach a record, and only the profile's allowlisted claims are stored ([I-LOG-1](threat-model.md#i-log-1), [I-LOG-2](threat-model.md#i-log-2)). Records are kept 14 days by default (Monitoring › Data retention) and summarized in hourly rollups. Admin UI: Monitoring › Requests. IDs start with `req_`; the same ID is in the `x-tokengate-request-id` response header. Details: [observability.md](observability.md).

### Audit event

An audit event is one row in `audit_log` in `DB` for every admin change, and for the first sign-in that links a login to a user. It records who acted, what changed (a before and after diff without secrets), when, and from which IP address. It is written in the same database batch as the change, so a change without its audit event cannot happen ([I-AUDIT-1](threat-model.md#i-audit-1)). Each audit event is also emitted as a log line with `"type":"audit.event"` for your SIEM. Audit events are kept 365 days by default (minimum 90). IDs start with `aud_`. Admin UI: Monitoring › Audit log.

### Keyring

The keyring holds the key-encryption keys (KEKs) that protect credentials. It comes from two Worker secrets with one base64 32-byte key each: `TOKENGATE_KEK` holds the current key, and `TOKENGATE_KEYRING` holds the next key during a rotation. While `TOKENGATE_KEYRING` holds a valid random key, it seals new credentials and `TOKENGATE_KEK` still opens the older ones; an invalid `TOKENGATE_KEYRING` is ignored. A key ID is the key check value of the key, so a key keeps its ID when it moves between the two secrets; credentials sealed before [ADR 0027](adr/0027-two-slot-key-rotation.md) use the key ID `k1`, which names `TOKENGATE_KEK`. If the keyring is missing or invalid, requests that a grant allows get `503 not_configured` and credential changes are refused; admin sign-in still works ([I-CFG-1](threat-model.md#i-cfg-1)). Generate keys outside Cloudflare: Worker secrets cannot be read back, and losing the KEK loses every credential. Each key is bound to the login variables `AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD` and `AUTH_ACCESS_DEVELOPMENT`: a change to any of them makes every stored credential impossible to decrypt ([I-CRED-3](threat-model.md#i-cred-3)). The public development key in `.dev.vars.example` works only for local development (`dev_placeholder_key`). Rotation: [operations/key-rotation.md](operations/key-rotation.md). Admin UI: Settings › Rotate encryption (`/admin/credentials/keys`), which guides the rotation in five steps. Code: `apps/gateway/src/crypto/keyring.ts`.

### Display label

A display label is a human name for one numeric claim ID of one credential access rule, for example `repository_id` 987654321 → `acme/api`. The admin UI shows and accepts IDs as `name (ID)`, for example `acme/api (987654321)`. Labels are stored in the `claim_labels` table and are written only when an admin saves a credential access rule or an access. They are for display and for form input only: policy evaluation never reads them, and the saved conditions always keep the numeric ID, so changing a label never changes what a saved grant allows. One exception at save time: an operation preset whose path contains the repository (for example `GET /repos/{repo}/**`) is saved with the label text in the path, as a literal rule that the access page shows. Code: `apps/gateway/src/db/claim-labels.ts`.
