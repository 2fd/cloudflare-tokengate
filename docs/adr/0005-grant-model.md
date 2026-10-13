# 5. Grant model: Conditions, anchor rules, trusted events, tenant pin

This ADR explains how tokengate decides which caller may use which service, and why the model has four parts. It is for security reviewers and admins who write grants.

Date: 2026-10-13

## Status

Accepted

## Context

A verified token proves only that the issuer signed it. Several facts make "the signature is valid" far from "this caller may use this credential":

- **Shared issuers.** Every GitHub customer's workflows get tokens from `https://token.actions.githubusercontent.com`. Every gitlab.com project gets tokens from `https://gitlab.com`. Anyone on the internet can create a repository and mint a valid token, with any audience they like.
- **Names are not identities.** Repository, organization and project names can be renamed, deleted and registered again by someone else. Numeric IDs cannot.
- **Events carry untrusted input.** A `pull_request` run executes code from the pull request. `pull_request_target` and `workflow_run` run with base-repository privileges on input from outside contributors ("pwn requests"). Source: https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/
- **Repository writers can create refs.** A Grant for `refs/heads/release/*` admits anyone who can push such a branch, unless the ref is protected.
- **Admins make mistakes.** A Condition on a misspelled or missing claim must not quietly admit everyone.

## Decision

Authorization has four parts. They are evaluated on the raw verified claims, never on display values.

1. **Tenant pin** (per caller provider). Exact, non-negated conditions that every token must satisfy, checked right after signature verification and before the gateway reveals whether the service exists ([I-TEN-1](../threat-model.md#i-ten-1)). Allowed claims: `repository_owner_id` and `enterprise_id` for `github-actions`, `namespace_id` for `gitlab-ci`, any claim for `generic`. A Tenant pin is required on shared issuers.
2. **Conditions** (per grant). Each tests one top-level claim with `exact` or `glob` match, optionally negated. A claim that is missing, or is not a string, boolean or safe integer, makes the condition false, even when negated ([I-AUTHZ-4](../threat-model.md#i-authz-4)).
3. **Anchor rules** (per profile). A Grant must pin at least one anchor rule with exact, non-negated conditions ([I-AUTHZ-2](../threat-model.md#i-authz-2)):
   - `github-actions`: `repository_owner_id` + `repository_id`, or `repository_owner_id` + `job_workflow_ref`.
   - `gitlab-ci`: `namespace_id` + `project_id`, or `namespace_id` + `ci_config_ref_uri`.
   - `generic`: each claim in the caller provider's `anchor_claims`.
   Anchors are checked when a grant is saved and again on every request. A Grant that no longer satisfies them is skipped.
4. **Trusted events** (per profile). Events outside the list need an exact, non-negated opt-in on the event claim. Globs never opt in ([I-AUTHZ-3](../threat-model.md#i-authz-3)).
   - `github-actions` (`event_name`): `push`, `workflow_dispatch`, `schedule`, `release`.
   - `gitlab-ci` (`pipeline_source`): `push`, `web`, `schedule`, `api`, `trigger`.
   - `generic`: no event guard.

A Grant also has rules: allowed methods and a path glob. A request is allowed when some enabled, unexpired grant of the caller provider for the service passes its anchors, conditions, event guard and at least one rule. Grants only allow. Nothing matches by default ([I-AUTHZ-1](../threat-model.md#i-authz-1)).

Save-time validation (`src/policy/validate.ts`) adds warnings for risky but valid grants: broad globs on ref, environment or workflow claims, refs or environments without `ref_protected exact true`, globs on the event claim, and opt-ins to untrusted events. The admin must acknowledge warnings to save.

Details and examples are in [policies.md](../policies.md).

## Consequences

- A stranger's token from a shared issuer fails the tenant pin with 401 `tenant_mismatch`. The response does not say whether the service exists. One exception is a known limitation: the injection-header token source can reveal slugs of services with `header` Injection ([threat-model.md](../threat-model.md)).
- Grants use numeric IDs, which are harder to read. The GitHub grant builder (`src/policy/presets.ts`) and "Create grant from this request" on a denied record fill them in.
- Pull request workflows need an explicit opt-in, so a first call from them is often denied with `event_not_trusted`. This is intended.
- Generic issuers need the admin to choose anchor claims. The gateway cannot know which claims are immutable for an unknown issuer.
- Changing a caller provider's anchor claims or tenant pin is refused while an enabled grant would stop validating.
- Conditions read only top-level claims. Nested claims are not supported.
