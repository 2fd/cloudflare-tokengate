# Calling the gateway from other OIDC issuers

This page shows admins and workload owners how to connect any other OpenID Connect issuer (Buildkite, CircleCI, Kubernetes, …) with the **Generic OIDC** profile.

The generic profile knows nothing about the issuer's claims. The admin decides which claims identify a workload (anchor claims) and which claims pin the tenant.
Use the GitHub Actions or GitLab CI profile for those platforms: issuers on `token.actions.githubusercontent.com` and `gitlab.com` cannot use the generic profile.

## What the issuer must provide

The gateway accepts a token only if all of these hold (`src/identity/jwt.ts`, [I-JWT-1](../threat-model.md#i-jwt-1)):

- It is a compact JWS (three base64url parts) of at most 16 KiB.
- Its header has an `alg` that the caller provider allows and a `kid` of 1-128 characters from `A-Z a-z 0-9 . _ -`.
- It is signed with an asymmetric algorithm: `RS256`, `RS384`, `RS512`, `PS256`, `PS384`, `PS512`, `ES256`, `ES384` or `EdDSA`. `none` and HMAC algorithms are never accepted.
- `iss` equals the caller provider's **Issuer** exactly.
- `aud` contains the caller provider's **Audience**.
- It carries `sub`, `iat`, `exp` and every anchor claim.
- `iat` is no older than **Maximum token age** (default 600 s, at most 3600 s). The gateway allows 30 s of clock skew.
- The issuer publishes its keys at an `https` JWKS URI that the public internet can reach. The Worker only fetches public addresses (`global_fetch_strictly_public`).

## Set up the caller provider (admin)

1. In the admin UI, open **Caller providers** and select **Add a caller provider**.
2. Select **Generic OIDC**.
3. In **Issuer**, enter the `iss` value of the tokens exactly, for example `https://agent.buildkite.com`.
4. Leave **JWKS URI (optional)** empty to read it from `<issuer>/.well-known/openid-configuration`. The discovery document must name the same issuer. If the issuer has no discovery document, enter its JWKS URI.
5. Keep the generated **Audience**, unless the issuer cannot mint tokens for a custom audience.
6. In **Required claims** (the tenant pin), enter one exact condition per line, for example `organization_id exact 0190a1b2-…`.
7. In **Anchor claims**, enter 1 to 8 claims that identify a workload and never change, one per line (for example `pipeline_id`).
8. Under **Advanced: token checks**, select the issuer's **Signature algorithms** and set **Maximum token age (seconds)**.
9. Select **Create caller provider**.

### Tenant pin

The gateway does not know whether a generic issuer is shared by other companies.
If you leave the tenant pin empty, the form warns: "no tenant pin: every token this issuer signs for this audience reaches grant evaluation".

- Leave it empty only if the issuer signs tokens for your company alone (for example your own Kubernetes cluster).
- For a SaaS issuer shared by many customers, pin your organization's immutable ID.
- Pin conditions must be `exact` and not negated ([I-TEN-1](../threat-model.md#i-ten-1)).

### Anchor claims

Every grant for this caller provider needs an exact, non-negated condition on at least one anchor claim ([I-AUTHZ-2](../threat-model.md#i-authz-2)).
Pick numeric or UUID identifiers, not names that can be renamed and registered again.

Changing anchor claims or the tenant pin is refused while an enabled grant would no longer be valid under the new values.
The error lists those grants: edit or disable them first.
The save also carries a SQL guard on the checked grant set. If a grant is enabled or changed at the same moment, the save fails.

### Claim rules

- Claim names are literal, top-level names. `a.b` is the claim named `a.b`, never a nested lookup.
- Nested objects and arrays cannot be matched. Use top-level scalar claims.
- Strings match as-is, booleans as `true`/`false`, and safe integers as decimal text.
- A missing or non-scalar claim fails the condition, even when negated ([I-AUTHZ-4](../threat-model.md#i-authz-4)).
- The generic profile has no event guard. If the issuer reports how a job was triggered, add your own conditions on that claim.
- A branch or ref claim is only as strong as the issuer makes it. Check whether a user who can start jobs can choose its value. The gateway has no `ref_protected` check for generic issuers (see [Buildkite](#buildkite)).

Full syntax: [policies.md](../policies.md).

The request log stores only `sub`, the anchor claims and the tenant pin claims ([I-LOG-1](../threat-model.md#i-log-1)).

## Send the token

Send the token in `x-tokengate-token` (recommended), or as `Authorization: Bearer <token>`:

```bash
curl -sS --fail-with-body "$TOKENGATE_URL/proxy/<service-slug>/<path>" \
  -H "x-tokengate-token: $TOKEN"
```

See [github-actions.md](github-actions.md#3-send-the-token) for the full header order. The gateway never forwards the caller token ([I-TOK-1](../threat-model.md#i-tok-1)).

## Examples

These examples show the shape of a setup. Check claim names and values in the issuer's documentation and in a request record before you rely on them.

### Buildkite

Issuer `https://agent.buildkite.com` signs tokens for every Buildkite customer, so pin your organization.
Reference: <https://buildkite.com/docs/agent/v3/cli-oidc>.

```bash
TOKEN="$(buildkite-agent oidc request-token --audience "$TOKENGATE_AUDIENCE")"
```

| Field | Value |
|---|---|
| Issuer | `https://agent.buildkite.com` |
| Required claims | `organization_id exact <your-organization-uuid>` |
| Anchor claims | `pipeline_id` |

Grant conditions:

```text
organization_id exact <your-organization-uuid>
pipeline_id exact <pipeline-uuid>
build_source exact webhook, schedule
build_branch exact main
```

`build_branch` is not a protected-branch check. It is the branch label chosen when the build is created, and Buildkite does not check that the commit is on that branch.
Anyone who can create builds on the pipeline (UI, API or a `trigger` step of another pipeline) can get `build_branch` `main` for any commit.
Buildkite has no claim like GitHub's `ref_protected`. Treat the grant as open to everyone with build permission on the pipeline, unless all of these hold:

- `build_source` excludes `ui`, `api` and `trigger_job`, as above. `webhook` builds of branch pushes come from your source repository, so its branch protection applies.
- The pipeline does not build pull requests, or prefixes branch names of fork pull requests. Otherwise a pull request from a fork branch named `main` reports `build_branch` `main`.
- The pipeline does not build tags, or a tag ruleset stops writers from pushing a tag named `main`. A tag push build reports the tag name in `build_branch` ([Buildkite docs](https://buildkite.com/docs/pipelines/configure/environment-variables#BUILDKITE_BRANCH)).
- Only trusted users can edit the pipeline's schedules and settings.

### Kubernetes service accounts

Use a projected service account token with the gateway audience.
The cluster's service account issuer must be publicly reachable for discovery and JWKS.
Reference: <https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/#service-account-issuer-discovery>.

```yaml
volumes:
  - name: tokengate
    projected:
      sources:
        - serviceAccountToken:
            path: token
            audience: tokengate:abcdefghijklmnopqrstuvwxyz
            expirationSeconds: 600
```

The kubelet refreshes the file before it expires. Read `/var/run/secrets/tokengate/token` (your mount path) before each call.

| Field | Value |
|---|---|
| Issuer | The cluster's `--service-account-issuer` |
| Required claims | Empty only if the issuer is your own cluster |
| Anchor claims | `sub` (`system:serviceaccount:<namespace>:<name>`) |

Kubernetes puts namespace and pod details in the nested `kubernetes.io` object, which conditions cannot read. Use `sub`.

### CircleCI

CircleCI uses one issuer per organization: `https://oidc.circleci.com/org/<org-uuid>`.
Its claim names contain `/` (for example `oidc.circleci.com/project-id`). Write them literally in conditions and anchor claims.
Reference: <https://circleci.com/docs/guides/permissions-authentication/openid-connect-tokens/>.

## Troubleshooting

See [errors.md](../errors.md) for every error code.

| Symptom | Likely cause | Fix |
|---|---|---|
| Saving fails: `JWKS discovery failed: …` | No discovery document, or it names another issuer | Enter **JWKS URI (optional)** by hand, and check the issuer string. |
| `token_malformed` (401) | Algorithm not selected, or no `kid` in the token header | Select the issuer's algorithm. Issuers that omit `kid` are not supported. |
| `claims_invalid` (401) | The token lacks `sub`, `iat`, `exp` or an anchor claim | Choose anchor claims that every token carries. |
| `signature_invalid` (401) | The JWKS has no key for the token's `kid` | Check the JWKS URI. |
| `jwks_unavailable` (503) | The keys could not be fetched (timeout 3 s, private address, non-200) | Make the JWKS URI publicly reachable over https. |
| `tenant_mismatch` (401) | A pin claim is missing or has another value | Compare the pin with the token's claims. |
