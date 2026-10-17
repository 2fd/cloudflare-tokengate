# 23. Teams replace roles; scoped visibility

This ADR explains how admin teams replace the five roles of [ADR 0018](0018-role-split-and-field-permissions.md), how a team gets access to only some service tokens and consumers, and how the gateway stops people from giving power that they do not hold. It is for security reviewers, for operators who put people in teams, and for contributors who change admin routes, ops or queries. It supersedes [ADR 0018](0018-role-split-and-field-permissions.md). It changes [I-RBAC-1](../threat-model.md#i-rbac-1), [I-SESS-1](../threat-model.md#i-sess-1), [I-OWNER-1](../threat-model.md#i-owner-1), [I-LINK-1](../threat-model.md#i-link-1), [I-BOOT-1](../threat-model.md#i-boot-1) and [I-AUDIT-1](../threat-model.md#i-audit-1), and adds I-RBAC-2, I-RBAC-3, I-SCOPE-1 and I-SCOPE-2.

Date: 2026-10-17

## Status

Accepted

## Context

A role applies to the whole deployment. A token manager changes every service token, and an access manager gives any consumer access to any token. A company where a platform group and a payments group share one gateway cannot give the payments group only its own tokens and consumers.

The requested change:

- A team is a named group of users. Each team has its own permissions, and its members get them.
- The five roles become five built-in teams. Nobody can change the permissions of a built-in team. Its membership can change: that is how a person becomes an owner.
- Teams have their own pages to create teams, set their permissions and add people.
- The "default role" for new people becomes a "default team".
- A team can get access to all service tokens and consumers, or to a list of them, at a level: view, edit, create or delete.
- A person can be in several teams. The effective permissions are the union of the teams.
- A token or consumer that a person cannot view is hidden everywhere in the admin UI. Its URL answers 404, not 403.
- To create or change a consumer access (grant), a person needs edit on the consumer. They can choose any token they can view.

Some constraints shape the design:

- D1 has no interactive transactions. Rules that must hold under concurrency are SQL guards and triggers ([ADR 0014](0014-integrity-rules-in-sql.md)).
- Every audited write re-checks the actor's authority in its own batch (I-SESS-1). A demotion that commits while a request runs must stop the write.
- View on a token plus edit on a consumer is the power to *use* that token: the person can write a grant that lets a workload they control call it.
- "Team" already has a meaning in Cloudflare Access: the *team domain* (`AUTH_ACCESS_TEAM_DOMAIN`). The two must not be confused.

## Decision

### Model

- **Team.** A named set of users with global permissions and resource scopes. "Team" alone always means an admin team. The docs write "Access team domain" for the Cloudflare one, and the code keeps `AUTH_ACCESS_TEAM_DOMAIN`. Team ids start with `tea_`.
- **Membership.** A row (team, user). Only the memberships of an **active** user count. A **pending** user holds no membership: the statement that adds a member refuses a pending user, and approval is the only way in.
- **Global permissions.** Six: `tokens:create`, `consumers:create`, `config:export`, `users:write`, `settings:write` and `keyring:rewrap`. `read` is not stored. It means "member of at least one team". An active user in no team sees only the "No team yet" page.
- **Levels.** Per resource, `1` view, `2` edit, `3` delete. Each level includes the lower levels. "Create" is the global permission of the kind, not a level.
- **Reveal.** A flag per token that includes view. It allows "Copy secret" and shows the first and last 4 characters of the secret ([ADR 0024](0024-secret-reveal-over-ecdh.md)).
- **Scope.** Per team and per kind (tokens, consumers), exactly one mode:
  - *none*;
  - *all*: one level on the team row that covers current and future resources;
  - *list*: one row per resource, each with its own level (and reveal, for tokens).

  A team never mixes *all* and *list* for one kind. To see every token but change only some, a person joins two teams, for example Viewers and Payments.
- **Effective permissions.** The union over the user's teams. Per resource, the level is the highest of the all-scope and list rows. Reveal is held when any team holds it.
- **Global viewer.** A user with an all-scope of at least view on tokens and on consumers. Every built-in team is a global viewer.
- **Built-in teams.** Five teams with fixed ids, in privilege order. They are the former roles with all-scope:

  | Team | Global permissions | Tokens (all) | Reveal | Consumers (all) |
  |---|---|---|---|---|
  | Owners (`tea_owner`) | all six | delete | yes | delete |
  | Admins (`tea_admin`) | `tokens:create`, `consumers:create`, `config:export` | delete | no | delete |
  | Token managers (`tea_token_manager`) | `tokens:create` | delete | no | view |
  | Access managers (`tea_access_manager`) | `consumers:create` | view | no | delete |
  | Viewers (`tea_viewer`) | none | view | no | view |

  The former `tokens:write` is `tokens:create` plus delete on all tokens. The former `access:write` is the same for consumers. Only Owners hold reveal, so every other built-in team still cannot EXTRACT a credential.
- **Custom teams.** A holder of `users:write` creates them. A new team is empty. A team name must not be close to a built-in name: the ops normalize it (NFKC, white space), refuse control, format and symbol characters, refuse Latin mixed with Greek or Cyrillic, and compare a folded form with the built-in names. Built-in teams show a "Built-in" badge everywhere.
- **Schema.** The tables `teams`, `team_members`, `team_permissions`, `team_tokens` and `team_consumers` are in `apps/gateway/migrations/0001_initial.sql`, and `users.role` is removed. The project has no release yet, so the initial migration is edited in place. The scope rows reference `services` and `caller_providers` with `ON DELETE CASCADE`.

### Authorization on each request

- **Loading.** After the login resolves, the middleware loads the user's teams, permissions and scope rows in one D1 batch of four reads. Nothing is cached ([ADR 0006](0006-no-policy-caching.md)).
- **Route table.** Each admin route has a global permission and optional resource rules (`apps/gateway/src/admin/auth/rbac.ts`). The middleware resolves the rules from path parameters and form fields before the handler runs:
  - A missing id and a hidden id get the same 404 page. Its text depends only on the kind.
  - A visible resource without the needed level gets 403 "Your teams do not allow this action." with the teams that can do it and people to ask.
  - A form field that names a resource is checked like a path id. An empty field adds no check. A create value (for example `consumer_id=new`) needs the create permission of the kind. Any other value gives 400.
  - A user in no team gets the 403 "No team yet" page, which names people who manage people.
- **Consumer access.** To create, change, copy, turn on or off, or delete a grant, a person needs **edit on its consumer and view on its token**. The grant ops always add both claims for the ids they write, whatever the route rule says. The route rules are a pre-check, not the authority.
- **Claims at commit.** Each check that allowed the request is a *claim*: `read`, `perm`, `member`, `token`, `consumer`, `token_reveal`, `token_all`, `consumer_all`, `token_all_reveal`, `dominates_team`, `dominates_user`, `not_member` and `not_self`. The actor check is the first statement of each audited batch (`apps/gateway/src/db/authority.ts`). It re-evaluates every claim against the state before the batch's own writes. It fails closed:
  - each claim test is `(…) IS NOT 1`, so NULL counts as "not held";
  - shape checks run first: a missing id, team or user, or a level that is not the integer 1, 2 or 3, aborts the batch;
  - an unknown claim kind aborts the batch;
  - an empty claims list never commits.

  A membership removal, a team delete, a permission or level removal, a cleared reveal flag, a suspension or a login reset that commits while a request runs stops the write. The response is 409: nothing was saved, reload the page.
- **Cascades.** Deleting a token whose grants lead to a consumer that the person cannot see is refused, and so is the opposite case. The refusal names nothing and counts nothing. "Delete with its accesses" needs edit on every affected consumer, so token managers are still refused.
- **Receiving team.** A create form names the team that gets access to the new token or consumer. It must be one of the creator's teams that holds the matching `*:create`. The same batch writes the scope row (level delete, without reveal) with a conditional insert that reads the team's mode at commit: a team in *all* mode gets no row, because its all-scope already covers the resource. Without a receiving team, the creator must hold all-scope view on that kind at commit. A merge into an existing consumer writes no scope row. A merge into a consumer that the person cannot edit is refused and names nothing.

### Visibility (I-SCOPE-1, I-SCOPE-2)

- **Hidden everywhere.** A resource that the person cannot view is absent from lists, details, the access map and matrix, the request log, the audit log, the Overview, the export, the sidebar counts and the alerts.
- **Requests and rollups.** One rule applies to every request record and rollup row: a global viewer sees it; anyone else sees it when its consumer is set and visible, and its token is unset or visible. Records before trust (unknown issuer) and deployment-wide totals (data retention, traffic of deleted tokens, setup steps) are for global viewers only.
- **Rollup key.** `request_rollup_hourly` gains `caller_provider_id` in its key. Without it, a row for "no grant" would mix traffic of consumers that the viewer cannot see.
- **Audit log.** `audit_log.resources` lists the token and consumer ids that a row shows. A person who cannot see one of them does not see the row. Rows with deployment-wide counts (`config.export`, `keyring.rewrap`) carry `["*"]`, which hides them from everyone who is not a global viewer. For restricted viewers, the page scans a window of 2000 rows found without the filter, and a filter on a target they cannot see returns the empty page at once.
- **Export.** Schema 3 adds `"scope": "all"` or `"partial"`, the teams of each user, and the teams with their visible rows.
- **Team pages.** Everyone in a team can read the teams and their members. A team page does not list rows on resources the reader cannot see. It says "This team also has access to items your teams cannot see.", with no count.
- **Same result for built-in teams.** Every filter adds nothing when the viewer has all-scope. A user in a built-in team gets the same SQL and the same pages as the former role.

### No escalation (I-RBAC-2)

- **Management.** Creating, changing and deleting teams and adding or removing members needs `users:write`.
- **Dominance.** Actor A *dominates* team T when A holds every global permission of T, an all-scope at least as high as T's for each kind, all-scope reveal if T has it, and every list row of T (level and reveal). When T is Owners, A must also be in Owners. A team with a row on a resource that A cannot see is not dominated by A. A dominates user U when A dominates every team of U.
- **Rules.** The op checks each rule in JavaScript for a clear 403. The commit check repeats it in SQL.

  | Action | Claims, on top of `users:write` |
  |---|---|
  | Create a team | none (it starts empty) |
  | Rename T or change its description | `dominates_team(T)` |
  | Add or remove a global permission P of T | `dominates_team(T)` and `perm P` |
  | Change an all-scope of T | `dominates_team(T)` and the all-scope at the higher of the old and new level (and all-scope reveal when reveal changes) |
  | Change a list row of T on resource R | `dominates_team(T)` and R at the higher of the old and new level (and reveal on R when reveal changes) |
  | Any *raise* of T (a change above that adds a power) | also `not_member(T)` |
  | Delete T | `dominates_team(T)` |
  | Add U to T, invite U into T, invite U again, approve U into T | `dominates_team(T)` and `not_self(U)` |
  | Remove U from T | `dominates_team(T)` and `not_self(U)` |
  | Change the state of U (status, reset login, delete, resend invite, dismiss a refused sign-in) | `dominates_user(U)` and `not_self(U)` |
  | Set the default team to T | `dominates_team(T)` |

- **Managers.** Any `users:write` holder can give `users:write` to a team that they dominate, and can add people to such a team. Owners are not the only people who can make managers. Only the Owners team itself needs an Owners member.
- **Self.** Nobody adds themselves to a team, removes themselves from a team or changes their own state.
- **Own team.** A member of T can lower T, rename it and add or remove other members. A member cannot raise T. Otherwise a person who is in Admins for a short time could copy Admins' powers into their own team and keep them.
- **People.** Adding a person to a team needs dominance over the team only, not over the person. A change to the state of a person needs dominance over every team of that person, so a manager who is not an owner cannot suspend, reset or delete an owner.
- **Default team.** The settings key `join_team` replaces `join_role`. The default team must be *join-safe*: not Owners, no `users:write`, `settings:write` or `keyring:rewrap`, and no reveal. Triggers enforce this in both directions. Who sets it must dominate it. A change that gives the default team a create permission, a level above view or `config:export` needs a confirmation. When the setting is absent or not valid, it reads as Viewers.

### Integrity in SQL (I-RBAC-3, I-OWNER-1, I-LINK-1)

Triggers in `0001_initial.sql` ([ADR 0014](0014-integrity-rules-in-sql.md)):

- A built-in team row, its permissions and its scope cannot be inserted, changed or deleted (`builtin_team`).
- Membership rows, permission rows and the keys of scope rows are never updated, only inserted or deleted (`immutable_row`). A user id never changes.
- A team cannot have an all-scope and list rows for the same kind (`scope_mixed`).
- The last active Owners member cannot leave Owners, be made not active or be deleted (`last_owner`). These triggers replace `users_last_owner_update` and `users_last_owner_delete`.
- The default team is join-safe in both directions, and cannot be deleted (`join_team_unsafe`, `default_team`).

The join writes the user and the default-team membership in one guarded batch. The guard repeats the settings values that the code read, so the audit row always names the team that was written. The first owner is an active Owners member, written in the same guarded batch (I-BOOT-1).

### Teams are not tenants

Teams decide who sees and changes what in the admin UI. They do not split the deployment. These stay deployment-wide:

- the uniqueness of token slugs and names, consumer names and issuers, and one consumer per issuer;
- settings, the keyring, the upstream host allowlist and the admin hosts;
- the deployment health alerts (keyring, schema, configuration, cron, one owner only).

## Consequences

- **Threat statement.** View on a token plus edit on a consumer is the power to USE that token. Access managers had this power over every token ([ADR 0018](0018-role-split-and-field-permissions.md)). Now each person has it only over the tokens they can view.
- **Powers combine across teams.** Dominance is checked per team, not per person. A manager who dominates two teams can put one person in both and so give the union. For example, token view from one team plus consumer edit from another is the power to use that token. This is accepted.
- **Residual risk: a manager's second account.** A `users:write` holder can invite a second address of their own into a team that they dominate, also a team that holds `users:write`. That account stays after the manager is removed. Mitigations: every invite and membership change has an audit row, the People page shows who invited whom, and `not_self` still stops direct self-changes.
- **Residual risk: existence leaks.** Global uniqueness tells a person that a hidden slug, name or issuer exists ("This slug is taken." with a free suggestion, and the merge refusal). A cascade refusal tells that *something* hidden is connected, without a name or a count. Deployment-wide alerts (keyring, schema, configuration, cron) are shown to every viewer.
- **Residual risk: global powers.** `keyring:rewrap` and `settings:write` act on tokens that their holder may not see. Only Owners hold them among the built-in teams, and a join-safe default team never holds them.
- **History after a delete.** A restricted viewer loses the audit rows of a resource after it is deleted, because its id no longer resolves to a visible resource. Global viewers keep them. The Overview "recent changes" may show fewer than five rows for a narrow scope.
- **Cost.** One more D1 round trip on every admin request.
- **Upgrade.** There is no release yet, so the schema changes are in the initial migrations. Local databases must be recreated (`rm -rf .wrangler/state/v3/d1 && pnpm db:migrate:local`). `/readyz` compares migration names only, so it cannot detect this. `join_role` becomes `join_team`. The forbidden text "Your role…" becomes "Your teams…". The telemetry rollup key changes. The export schema becomes 3.
- **Tests.** A property test compares the SQL claim check with an independent JavaScript model, also for malformed claims. A route matrix covers every built-in team and personas with a partial scope, with oracles that are separate from the production table. Escalation tests cover each rule above, and the hidden-resource tests check that no name, slug, issuer or count of a hidden resource reaches any page.
