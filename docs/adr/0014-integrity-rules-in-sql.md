# 14. Integrity rules and audit rows enforced in SQL

This ADR explains why rules that must hold under concurrency are written as SQL guards and triggers. It is for contributors and security reviewers.

Date: 2026-10-13

## Status

Accepted

## Context

D1 has no interactive transactions. A Worker cannot read a row, decide, and write while holding a lock. A statement batch is atomic: if one statement fails, the whole batch rolls back. Source: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch

Several rules must hold even when two admins act at the same moment, or when someone edits D1 by hand:

- There is always at least one active owner.
- Bootstrap creates at most one owner.
- An invite links at most once.
- A change and its audit event are both written, or neither is.
- A Grant is saved against the caller provider version it was validated with.

A JavaScript check followed by a write would leave a race between the two.

## Decision

- **Triggers** `users_last_owner_update` and `users_last_owner_delete` abort any change that removes the last active owner ([I-OWNER-1](../threat-model.md#i-owner-1)).
- **Guarded statements.** Bootstrap, invite linking and session creation use `INSERT … SELECT … WHERE` or `UPDATE … WHERE` with the full precondition in SQL (`apps/gateway/src/db/users.ts`, `apps/gateway/src/db/sessions.ts`). A concurrent or replayed attempt changes nothing ([I-BOOT-1](../threat-model.md#i-boot-1), [I-LINK-1](../threat-model.md#i-link-1)).
- **Versions.** Updates to caller providers, services and grants set `updated_at = MAX(now, updated_at + 1)`, so `updated_at` works as a version. Their writes are guarded on the version the op read (`apps/gateway/src/db/caller-providers.ts`, `apps/gateway/src/db/services.ts`, `apps/gateway/src/db/grants.ts`).
- **Audit in the same batch.** Each admin op adds its audit event to the same `db.batch()` as the change. The audit statement repeats the change's guard, so it is written only if the change is ([I-AUDIT-1](../threat-model.md#i-audit-1), `apps/gateway/src/admin/ops/shared.ts`, `apps/gateway/src/db/audit.ts`).
- **Compare-and-swap** for re-encryption: each credential is replaced only if it still holds the value that was opened.

> Note (2026-10-14): since [0015](0015-cloudflare-access-only-admin-login.md) there is no session creation and no `apps/gateway/src/db/sessions.ts`. The admin write re-check uses `liveIdentityGuard` in `apps/gateway/src/db/users.ts`.

## Consequences

- Concurrent admin actions cannot leave zero owners, two bootstrap owners or an unaudited change. In an admin op, a lost race is reported as a conflict.
- The last-owner rule also holds for manual SQL run with `wrangler d1 execute`, unless the trigger itself is dropped.
- The SQL is more complex than plain inserts and updates. Tests cover the guards, for example `apps/gateway/test/security/bootstrap.test.ts` and `apps/gateway/test/security/audit-coverage-ops.test.ts`.
- Anyone with D1 write access can still change data directly. Such changes bypass the admin UI and its audit log. Credentials stay protected by their AAD binding ([ADR 0004](0004-envelope-encryption-bound-to-destination.md)).

## Note (2026-10-17)

[ADR 0023](0023-teams-replace-roles.md) adds triggers to `apps/gateway/migrations/0001_initial.sql`:

- A built-in team, its permissions and its scope cannot change (`builtin_team`). Membership rows, permission rows and the keys of scope rows are never updated, and a user id never changes (`immutable_row`).
- A team never has an all-scope and list rows for the same kind (`scope_mixed`).
- An active owner is an active member of the Owners team. `team_members_last_owner_delete`, `users_last_owner_status` and `users_last_owner_delete` replace `users_last_owner_update` and `users_last_owner_delete` (I-OWNER-1).
- The default team for new people is join-safe in both directions and cannot be deleted (`join_team_unsafe`, `default_team`).

The actor check in each audited batch now re-evaluates the claims of the request in SQL (memberships, permissions, levels, reveal and dominance), not a role.
