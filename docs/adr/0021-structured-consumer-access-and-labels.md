# 21. Structured consumer access, claim labels and risk acceptance

This ADR explains how the admin UI builds consumer access (grants) without a condition text syntax, where the display names of numeric IDs live, how a risky access is accepted, and what "copy" means. It is for security reviewers and for contributors who change the access form. It refines [I-AUTHZ-2](../threat-model.md#i-authz-2), [I-AUTHZ-3](../threat-model.md#i-authz-3) and [I-LOG-2](../threat-model.md#i-log-2).

Date: 2026-10-15

## Status

Accepted

## Context

Grants were written in a text format, one condition or rule per line, with a GitHub builder for the common case. Admins had to look up two numeric IDs per repository with a `gh` command, compose lines, and pick between a builder and the text format before they knew which they needed. Editing always used the text format. Consumers (caller providers) asked for an issuer, a JWKS URI, an audience, algorithms and a maximum token age that the gateway can derive.

Numeric IDs are the only safe anchors (names can be re-registered), but they are unreadable. The matrix of who can use which token, the chips and the derived names need a human name per ID, and the form needs it to derive the organization of a repository.

The single "I have read the warnings" box accepted every warning at once. A tick given for one risk also covered a risk chosen after it, unless the digest of the shown warnings changed.

## Decision

- **Structured form.** For GitHub Actions and GitLab CI consumers, "Give a consumer access" builds the conditions from the repository (`name (ID)`), a context (environment, branch, tag, any protected ref, release and pull request on GitHub, or any ref), a protected-refs choice, and an optional workflow pin. `src/policy/presets.ts` builds them; they are validated like any other grant. A rows editor (claim, match, not, values) is the escape hatch and the only editor for generic consumers. The text format remains as a read-only view ("Exact conditions").
- **Exact inverses.** An access opens in the structured form only when its stored conditions rebuild exactly (`githubPresetFromConditions`, `gitlabPresetFromConditions`); otherwise the rows editor opens. No form state is stored.
- **Nested branches.** A choice between several consumers or tokens is a set of radio cards. Each card reveals its own fields, prefixed with its id (`cpr_….repository`, `svc_….op`, `new.<type>.…`), because hidden inputs are submitted too. The server reads only the chosen branch. A single consumer or token is fixed text. Seven or more are a select.
- **Inline consumer.** With no consumer, or "Use a new consumer", the form holds the add-consumer fields. The access is validated against the consumer built in memory first; only then is the consumer created (or merged into the consumer of the same issuer), then the access, each with its own audit row (I-AUDIT-1). An unknown organization of the repository is added the same way (`new_owner`).
- **`claim_labels` table.** One label per (consumer, claim, ID), for `repository_owner_id`, `repository_id`, `namespace_id` and `project_id`. Labels are written in the batch of the consumer or access save that typed them and recorded in its audit diff. They survive an access delete, so recreating it is a pick, and they are deleted with the consumer. Display and form derivation only: `src/policy/*` and the proxy never read them, and IDs stay strings end to end.
- **Risk acceptance by selection.** The three structured risks are explicit choices whose labels start with "Risk:": "Also unprotected branches and tags" (`unprotected_ref`), "Pull request into" (`pull_request`) and "Any branch, tag or environment" (`any_ref`). The server computes the accepted codes from the selection of the chosen branch, never from a list the browser sends. Any other warning (validator codes `broad_glob`, `event_glob`, `pwn_request`, `inherited_trust_event`, `untrusted_event`, `path_injection_non_post`) needs the box bound to a digest of exactly the risks shown, rendered on the first render when prefilled values or the rows editor carry warnings. The accepted codes go into the audit diff.
- **Copy.** "Copy to another repository or token" creates an enabled copy in one submit (`grant.duplicate` with `source_id`) when the target token has the same operation source (the same token or the same template) and the copy carries no risk the source did not. Otherwise it opens the prefilled form, with nothing written, so the admin sees the target token's operations and every risk.
- **Suggestions.** Every datalist and default comes from control-plane data of the same consumer or token: labels, existing accesses, the tenant pin, templates and profiles. Never the request log, never an outbound lookup. A request record prefills the form only when the admin asks for it, verified (I-LOG-2).
- **Derived values.** The consumer name, issuer, JWKS URI, generic algorithms (discovery ∩ the I-JWT-1 list), audience, and the access name are derived. Every GitHub and GitLab consumer made in the UI needs at least one organization or group, with numeric IDs, so the form can always derive an access's owner.

## Consequences

- A typical access is one load and one submit with one pasted input (`acme/api (89012345)`), and no syntax to learn. Copying an access to another repository or token is one submit.
- A wrong label cannot widen an access: GitHub and GitLab sign the ID pair together, so a wrong owner derivation only makes an access that never matches. A `{repo}` operation path is the one place a label reaches a rule; the saved rule is a literal path, shown verbatim on the access page and in the audit diff.
- Accesses with conditions the structured form cannot rebuild (several repositories, extra claims, other events) are edited in the rows editor. Nothing is lost.
- The labels add one table to the export (schema 2) and to backups.
- Contributors add a new structured context by extending the builder, its inverse and the round-trip test (`test/unit/policy/presets-roundtrip.test.ts`). A new risky choice must carry its code in `coveredRiskCodes` and the "Risk:" text in its label.
