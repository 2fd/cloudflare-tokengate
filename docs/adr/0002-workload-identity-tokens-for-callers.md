# 2. Callers authenticate with workload identity tokens

This ADR explains why callers present short-lived workload identity tokens instead of static keys or `GITHUB_TOKEN`. It is for security reviewers and workflow authors.

Date: 2026-10-13

## Status

Accepted

## Context

CI jobs need upstream API credentials. The usual approach stores each API key as a CI secret. Every repository that needs a key gets a copy. Copies are long-lived, hard to rotate and give no control over which branch, tag or event may use them.

A gateway needs some way to know who is calling. The options were:

1. **Static gateway API keys per caller.** This moves the secret-sprawl problem to a new secret. It also carries no facts about the job (repository, ref, event, environment).
2. **GitHub's `GITHUB_TOKEN`.** It can only be validated online, with a GitHub API call per request. The validation reveals the repository but not the ref, event, environment or workflow. Fork `pull_request` runs also receive a read-only token for the base repository. The caller would hand a live repository credential to a third party, and the token lives for the whole job (up to 6 hours on hosted runners). It has no audience. Source: https://docs.github.com/en/actions/concepts/security/github_token
3. **Workload identity tokens (OIDC JWTs).** GitHub Actions, GitLab CI and many other platforms mint signed JWTs for a job. The claims describe the job. The token has an audience and expires in minutes. The gateway can verify it offline against the issuer's JWKS. Sources: https://docs.github.com/en/actions/reference/security/oidc and https://docs.gitlab.com/ci/secrets/id_token_authentication/

## Decision

Callers authenticate only with workload identity tokens from a configured caller provider.

- A Caller provider has an issuer, a `jwks_uri`, an audience, allowed algorithms, a maximum token age and a profile (`github-actions`, `gitlab-ci` or `generic`). See `src/identity/jwt.ts` and `src/identity/profiles/`.
- Verification checks the signature, exact issuer, audience, expiry, maximum token age and the profile's required claims ([I-JWT-1](../threat-model.md#i-jwt-1)).
- If the admin leaves the audience empty, a new caller provider gets a random audience: `tokengate:` followed by 26 random base32 characters (`src/admin/ops/caller-providers.ts`). Audiences shorter than 16 characters, GitHub owner URLs (the default GitHub audience) and well-known cloud audiences are refused (`src/policy/validate.ts`). A token minted for another relying party is therefore not accepted here.
- The maximum token age is between 60 and 900 seconds for `github-actions`, and between 60 and 3600 seconds for the other profiles (`src/policy/validate.ts`).
- There are no static caller keys, and `GITHUB_TOKEN` is not accepted.

## Consequences

- No caller-side secret exists. Nothing needs to be stored in CI or rotated per repository.
- Grants can use the token's claims: repository, ref, event, environment, workflow ([ADR 0005](0005-grant-model.md)).
- Callers must be able to mint a token. GitHub Actions needs `permissions: id-token: write`. The repository ships `actions/get-token` for this ([README](../../actions/get-token/README.md), [callers/github-actions.md](../callers/github-actions.md)).
- Tokens are short-lived. Long jobs must mint a fresh token before each call or when they get `token_expired` or `token_too_old` ([errors.md](../errors.md)).
- On shared issuers such as `https://token.actions.githubusercontent.com` and `https://gitlab.com`, anyone on the internet can mint a valid token for any audience. The audience therefore proves nothing about the tenant. A Tenant pin is required on these issuers ([I-TEN-1](../threat-model.md#i-ten-1), [ADR 0005](0005-grant-model.md)).
- The gateway depends on the issuer's JWKS endpoint. If it cannot fetch keys, callers get 503 `jwks_unavailable`. JWKS are cached per isolate, and refetches are gated ([I-JWT-2](../threat-model.md#i-jwt-2)).
