# 18. Role split and field permissions

This ADR explains why the admin roles separate token duties from access duties, how a form field can need its own permission, and who can download the configuration export. It is for security reviewers and operators who assign roles. It extends the RBAC table of [I-RBAC-1](../threat-model.md#i-rbac-1) and the commit re-check of [I-SESS-1](../threat-model.md#i-sess-1).

Date: 2026-10-14

## Status

Superseded by [0023](0023-teams-replace-roles.md)

## Context

There were three roles. `viewer` reads, `owner` does everything, and `admin` holds one write permission, `config:write`, for services, credentials, caller providers, grants and the export.

Two different jobs share that permission. One job decides which credentials and destinations exist: it enters, rotates and tests secrets. The other job decides which workloads may use them: it creates caller providers and grants. With one permission, whoever enters a credential can also give their own repository access to it, and whoever writes grants must also be trusted with credential entry. Teams that split these jobs between a platform team and an application team could not express that.

Some forms also do two things in one submit. The redesigned service form can allow the destination host in the upstream host allowlist, which is an owner setting. Deleting a service can delete its grants with it, which is an access change. A route-level permission alone cannot say that only part of a form needs more.

The export holds every user's email and both halves of the policy. It contains no secrets (I-CRED-1), but it is a complete map of who can use what.

## Decision

- **Seven permissions.** `read`, `tokens:write` (services: create, edit, credentials, test, toggle, delete), `access:write` (caller providers and grants), `config:export`, `users:write`, `settings:write` and `keyring:rewrap`. `config:write` is removed.
- **Five roles,** in privilege order:

  | Role | Permissions |
  |---|---|
  | `viewer` | `read` |
  | `token_manager` | `read`, `tokens:write` |
  | `access_manager` | `read`, `access:write` |
  | `admin` | `read`, `tokens:write`, `access:write`, `config:export` |
  | `owner` | all seven |

  `admin` keeps everything it could do before. The new roles are subsets of it.
- **Field permissions.** A route in the RBAC table may list form fields with a further permission (`fieldPermissions`). When the form submits such a field with a non-empty value, the role must also hold that permission. Otherwise the middleware answers 403 "Your role does not allow this action." before the handler runs. Allowing an upstream host from a service form (`allow_host`) needs `settings:write`. Deleting a service together with its grants (`with_accesses`) needs `access:write`.
- **Re-check at commit.** `ActorAuthority.permission` becomes `permissions`: the route's permission plus every field permission the request used. The actor check in each audited batch accepts only roles in `rolesWithAll(permissions)`, the intersection of the roles that hold each one. A demotion that commits while a request is in flight, to either half of the split, stops its write. An authority with no permissions matches no role.
- **Export.** `config:export` is held by admins and owners only.
- **Access to any service.** An access manager can create a grant for any service, in any state. The grant form shows a service's name, slug, host, injection kind and whether a credential is set, never the credential hint. Token managers cannot create, change or delete grants; to stop use of a credential, they disable the service.
- **Join roles.** New users can join with any role except `owner` (I-LINK-1).
- **Schema.** `users.role` accepts the five values. The CHECK constraint is in `apps/gateway/migrations/0001_initial.sql`; the project has no release yet, so the initial migration holds it instead of a table rebuild. The last-owner triggers (I-OWNER-1) are unchanged.

## Consequences

- Threat statement: `access:write` lets its holder make any credential usable by any workload the caller provider's pin admits, including a caller provider for an issuer or organization the holder controls. It is the power to USE every credential through the gateway, never to EXTRACT one (I-CRED-1, I-CRED-2). `tokens:write` decides which credentials and destinations exist. The split stops a token manager from granting themselves access, and keeps credential entry away from access managers. It is not a containment boundary against a malicious access manager.
- A token manager can still USE a stored credential through "Test credential". That use is audited before the credential is sent (I-SESS-1).
- Code that checks a write must name the half it needs. Pages show write controls by the permission of each action, not by one "can configure" flag.
- Old code runs on the new schema during a deploy: it never writes the new roles, and `can()` refuses roles it does not know. Rolling back after someone has the new roles leaves them with no permission until the new code is back.
- The migration rebuilds two tables. Operators take a backup first, and the CHANGELOG upgrade notes say so.
- Adding a field permission is a change to the RBAC table, pinned by `apps/gateway/test/unit/admin/auth/rbac.test.ts`, and the role split is tested on the real app by `apps/gateway/test/security/role-split.test.ts`.

## Note (2026-10-17)

[ADR 0023](0023-teams-replace-roles.md) supersedes this ADR. The five roles become five built-in teams with the same powers. `tokens:write` becomes `tokens:create` plus delete on all tokens, and `access:write` becomes `consumers:create` plus delete on all consumers. `with_accesses` no longer has a field permission: the op needs edit on every affected consumer, so token managers are still refused. `apps/gateway/test/security/role-split.test.ts` becomes `team-split.test.ts`.

Correction: the Consequences item "The migration rebuilds two tables" is wrong. The Schema item is correct: the project had no release, so the initial migration held the change and no table was rebuilt.
