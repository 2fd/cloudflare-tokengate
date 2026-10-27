# 29. Access rules are the only permission store

This ADR explains why every permission a workload gets is a row of `access_rules`, whatever it gives access to. It is for security reviewers and for contributors who add a feature that grants access. It extends [ADR 0026](0026-global-and-credential-access-rules.md).

Date: 2026-10-20

## Status

Accepted

## Context

Today a workload uses one kind of target: a credential, for Slack, OpenAI or any other upstream. Other targets can follow. A feature that grants access to a new target could store its rules in its own table, as one JSON policy per row, and edit them in a form on the target's page. That makes two permission stores with two editors and two audit vocabularies:

- The access rule pages, the lists, the Overview counts and the audit log do not show the new access.
- The second form is a weaker copy of the access rule form, without the jobs builder, the risk acceptance or the global access rule status.
- The permission to grant access moves to whoever manages the target, although granting access is the job of an access manager (ADR 0018).

Every target needs the same issuer, tenant pin, jobs, token settings, expiry and global ceiling.

## Decision

`access_rules` is the only permission store, now and for every future target.

- **One table, one target column per kind.** A row has at most one target column: none for a global access rule (`gar_…`), `credential_id` for a credential access rule (`acr_…`). A new target adds its own target column with its foreign key and id prefix.
- **A stored kind with the second target.** While the credential is the only target, `credential_id IS NULL` is the global access rule. The change that adds a second target also adds `kind`, a stored generated column computed from the target columns, and moves every query to `kind = ?`, so that a new target never reads as a global access rule. Triggers read the target columns, because a BEFORE trigger does not see generated values.
- **One policy.** A rule with a target holds every limit, like a credential access rule. The global access rules of its issuer cap it.
- **One editor.** Rules of every kind are created and edited on the access rule pages with the same ops (`ops/credential-access-rules.ts`). A target's page lists its rules and links to `/admin/credential-access-rules/new` with the target preset. It never edits a rule.
- **One permission.** Every rule with a target needs `access:write` (Access managers, Admins, Owners).
- **One audit vocabulary.** The ops write `<kind>_access_rule.create`, `.update`, `.enable`, `.disable` and `.delete` in the Access rules category.

To give access to a new target, add a target column with its foreign key, an id prefix, the cap trigger, the form branch and, for the first new target, the `kind` column. Do not add another rules table, a JSON policy column or an editor on the target's page. [AGENTS.md](../../AGENTS.md) repeats this for agents.

## Consequences

- The schema has no column that only a future target needs.
- A new target gets expiry, descriptions, claim labels, the jobs builder, risk acceptance and the global access rule status without new policy code.
- The people who manage a target cannot change who uses it. Access managers can.
