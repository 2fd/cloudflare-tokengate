# 26. Global and credential access rules in one table

This ADR explains how tokengate decides which caller may use which credential after boundaries and issuer access rules were removed. It is for security reviewers and for contributors who change the policy, the proxy or the access rule pages. It supersedes [ADR 0025](0025-credential-access-boundaries.md) and the entity part of [ADR 0005](0005-grant-model.md). It changes [I-AUTHZ-1](../threat-model.md#i-authz-1), [I-AUTHZ-2](../threat-model.md#i-authz-2), [I-JWT-1](../threat-model.md#i-jwt-1), [I-TEN-1](../threat-model.md#i-ten-1), [I-RBAC-1](../threat-model.md#i-rbac-1) and [I-AUDIT-1](../threat-model.md#i-audit-1), and adds [I-AUTHZ-5](../threat-model.md#i-authz-5).

Date: 2026-10-18

## Status

Accepted

## Context

ADR 0025 used two rule kinds for each credential: a credential access rule (a boundary) and issuer access rules (grants) inside it. A boundary did not let a workload in by itself, and every grant had to stay within its boundary. Administrators had no single place to limit every credential that trusts one issuer.

The decision of 2026-10-17 replaces both kinds with a credential access rule and a global access rule.

## Decision

One table, `access_rules`, stores both kinds. A row with a `credential_id` is a credential access rule (id `acr_…`). It applies to exactly one credential and holds its own token verification settings. A row without a `credential_id` is a global access rule (id `gar_…`). It is a ceiling on every credential access rule of one issuer, and it never lets a workload in by itself.

A request is allowed when one enabled, unexpired credential access rule of the requested credential matches it, and either the caller's issuer has no global access rule at all, or one enabled, unexpired global access rule of that issuer also holds for it. Disabled or expired global access rules count as existing. On a global access rule, a NULL limit means no limit, and an empty or malformed value matches nothing. Global access rules match credential access rules by the stored `issuer_key` only.

Credential access rules need the `access:write` permission (Access managers, Admins, Owners). Global access rules need `access_rules:global` (Admins, Owners). Every signed-in person can read global access rules.
