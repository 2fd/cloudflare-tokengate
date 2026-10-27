# 31. Callers name a credential type; the most specific access rule picks the credential

This ADR explains why `/proxy/<slug>/` names a credential type instead of one credential, and how the gateway picks the credential when several of one type can serve a request. It is for security reviewers and for workflow authors. It changes the proxy part of [ADR 0026](0026-global-and-credential-access-rules.md).

Date: 2026-10-27

## Status

Accepted

## Context

Until now the slug was unique: `/proxy/slack-2/` named exactly one credential. A deployment with two Slack bots had the slugs `slack` and `slack-2`, and every workflow had to know which bot it used. That knowledge belongs to the access rules, not to the caller:

- The access rules already decide which workload may use which credential. A URL that also names the credential repeats that decision, and the two can disagree.
- To move a workload to another bot, someone had to change the workflow as well as the access rules.
- The caller learns the inventory of credentials (`slack`, `slack-2`, …) that it does not need.

The protection that matters is the destination: a secret must never reach another API. The secret is already sealed with its base URL and injection in the AAD ([ADR 0004](0004-envelope-encryption-bound-to-destination.md)).

## Decision

**A slug names a credential type.** A type is one destination: a base URL and an injection. Every credential that calls the Slack Web API with a bearer token has the type `slack`. Callers use `/proxy/<type>/<path>` and never name one credential.

- **One destination per type, one type per destination.** The credentials of a slug share the base URL and the injection, and the credentials of a destination share the slug. The triggers `credentials_type_insert` and `credentials_type_update` enforce both (`credential_type_mismatch`); the create and Change destination ops check the same first (`typeConflict` in `apps/gateway/src/admin/ops/credentials.ts`). A secret therefore only reaches the API of its type. The caller-token fallback from the injection header and the rewrite of upstream redirects mean the same whichever credential is chosen.
- **The slug never changes** (`credentials_slug_fixed`). A credential alone in its type can still change its destination; a credential that shares its type cannot.
- **At most 8 credentials per type** (`credentials_type_cap`). With at most 100 access rules per credential, the proxy reads at most 800 candidate rows for a type in its one batch ([ADR 0006](0006-no-policy-caching.md)).
- **New credentials join their type.** A credential made from a template, or a custom credential whose destination already has a type, takes the slug of that type. Otherwise the slug defaults to the API host's name, with `-2`, `-3`, … when that slug is taken by another destination.

**The most specific credential access rule that matches picks the credential.** The proxy evaluates the enabled credential access rules of every enabled credential of the type that trust the token's issuer, in this order (`bySpecificity` in `apps/gateway/src/policy/access-rules.ts`):

1. More identity conditions first: the rule's conditions plus its tenant pin.
2. At the same count, more conditions that are `exact` and not negated first.
3. At the same specificity, the oldest rule first (`created_at`, then `id`).

Operations (methods and paths) do not count: a candidate that reaches the comparison already allows the request. The first rule that passes token verification, the tenant gate, its own policy and the global access rules of its issuer decides. Its credential is injected, even when rules of other credentials match too. A disabled credential is never a candidate. The gateway does not retry with another credential when the upstream refuses the request: the upstream may already have acted on it.

A type whose credentials are all disabled answers like a disabled credential did: `404 service_not_found` with reason `service_disabled`, only after the tenant gate held ([I-TEN-1](../threat-model.md#i-ten-1)). A type written around the triggers, with credentials of different destinations, fails closed with `not_configured` (reason `credential_type_mismatch`), also only after the tenant gate.

The configuration export (schema version 6) gives each credential its `id`, and each credential access rule names its credential by `id`, because a slug no longer names one credential.

## Consequences

- A workflow calls `/proxy/slack/…` whatever bot it may use. To move workloads to another bot, change the access rules only.
- Which secret a request uses can change when an access rule is added, edited or deleted, including a rule of another credential of the type. The request record keeps `service_id` and `credential_access_rule_id`, so each call shows which credential and rule were used.
- Two rules of different credentials with the same specificity resolve by age. To prefer one bot for a group of workloads, give its rule one more identity condition (for example `ref` or `environment`).
- The order also applies inside one credential: the request record and the rate limiter key name the most specific matching rule, no longer the oldest.
- Two custom credentials for the same API with different injections are two types with two slugs.
- Tests and fixtures that create several credentials must give each slug its own destination.
