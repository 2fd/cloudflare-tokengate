# 28. Issuer profiles are code, not schema

This ADR explains why the database no longer lists the issuer profiles or the shape of labelled IDs, and how the Vercel profile uses that. It is for security reviewers and contributors who add an issuer type.

Date: 2026-10-20

## Status

Accepted

## Context

Each issuer type has different requirements. Vercel has no event claim like `event_name`, its tokens have no `jti`, its team and project IDs are prefixed text (`team_…`, `prj_…`), and its team issuer mode puts the team slug in the issuer URL.

Two CHECK constraints of `0001_initial.sql` made every new issuer type a schema change:

- `access_rules.profile IN ('github-actions', 'gitlab-ci', 'generic')`.
- `claim_labels.claim IN (…four claims…)` and `claim_labels.value` numeric only.

SQLite cannot change a CHECK in place, so after a release each new profile would need a migration that rebuilds `access_rules`, which [CONTRIBUTING.md](../../CONTRIBUTING.md#migrations) calls non-additive.

## Decision

- **No profile list in the schema.** In `0001_initial.sql`, `profile` is any text of 1 to 64 characters. A label claim is any text of 1 to 128 characters, and a label value is 1 to 128 characters of `[0-9A-Za-z_]`.
- **The code decides.** `getProfile` fails closed on an unknown profile (a stored rule with one is skipped). The admin ops check the ID shape per profile and claim (`claimIdPattern`): digits for GitHub and GitLab, `team_…` and `prj_…` for Vercel. The policy code never reads labels.
- **Vercel profile.** It verifies tokens as `getVercelOidcToken({ audience })` of @vercel/oidc returns them:
  - Issuer: `https://oidc.vercel.com/<team slug>` (team mode, the default) or the shared `https://oidc.vercel.com` (global mode).
  - Tenant pin `owner_id`, anchor `owner_id` + `project_id`.
  - Event claim `environment`, trusted `production` and `preview`. `development` tokens go to every team member through `vercel env pull`, so `development` and Custom Environments need an explicit opt-in.
  - Required claims without `jti`.
  - Maximum token age 7200 seconds: function tokens live two hours and @vercel/oidc keeps an exchanged token until it expires.
- **Issuer type select.** The admin forms choose the issuer type with a customizable select (`appearance: base-select`) instead of radio cards, so the list can grow. Its options carry `data-o` like the cards did; the live form CSS matches `option[data-o=K]:checked` as it matches a checked input.

## Consequences

- A new profile needs no migration: add the profile file, register it, and fill the profile-specific admin code. The rest of [CONTRIBUTING.md](../../CONTRIBUTING.md#a-profile-new-ci-platform) still applies.
- The schema no longer refuses a misspelt profile. Rows are written only by the ops, which call `getProfile` first, and the proxy fails closed on an unknown profile.
- The project has no release yet, so `0001_initial.sql` is edited in place. Local databases made before this change must be recreated with `pnpm run setup`.
- A Vercel team rename changes the team mode issuer. Tokens fail closed with `issuer_unknown` until an admin updates the rule.
