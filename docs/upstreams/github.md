# GitHub REST API

This page shows admins how to set up GitHub API services and shows workflow authors how to call them through the gateway.

Use this when a job needs a token with more access than its own `GITHUB_TOKEN`, for example to write to another repository, without storing that token in the repository.

## Service templates

In the admin UI, open **Services**, select **Add a service** and choose a template (`src/admin/service-templates.ts`).

| Field | **GitHub REST API** | **GitHub release asset uploads** |
|---|---|---|
| Slug | `github` | `github-uploads` |
| Base URL | `https://api.github.com` | `https://uploads.github.com` |
| How the credential is sent | Bearer token | Bearer token |
| Extra headers callers may send | `x-github-api-version` | `x-github-api-version` |
| Timeout (milliseconds) | `60000` | `600000` |
| Credential check | `GET /rate_limit`, expect `200` | none |
| Suggested grant rule | `GET /repos/OWNER/REPO/**` | `POST /repos/OWNER/REPO/releases/*/assets` |
| Host for `ALLOWED_UPSTREAM_HOSTS` | `api.github.com` | `uploads.github.com` |

If `ALLOWED_UPSTREAM_HOSTS` is set, add the host to it before you create the service ([configuration](../configuration.md#allowed_upstream_hosts)). Otherwise saving the service fails.

- Prefer a fine-grained personal access token limited to the repositories and permissions the jobs need (`github_pat_REDACTED`).
- Release asset uploads use a separate host, so they need the second service. Store the same token in both.
- Set **Credential expires on (optional, UTC)** to the token's expiry. The dashboard warns 14 days before. If you leave it empty, the credential check fills it in from GitHub's `github-authentication-token-expiration` response header.
- The gateway stores static credentials only. It does not mint GitHub App installation tokens; see [roadmap.md](../roadmap.md).

Reference: <https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api>.

## Call it

The examples read the caller token in one of two ways. `$(tokengate-token)` works only in GitHub Actions jobs that ran the [get-token action](../callers/github-actions.md#2-mint-the-token-with-the-composite-action).
`TOKENGATE_TOKEN` is a variable that holds a caller token. In GitHub Actions, set it from `steps.<id>.outputs.token`. In GitLab CI, name the `id_tokens` entry `TOKENGATE_TOKEN`.

`/proxy/github/<path>` reaches `https://api.github.com/<path>`.

### curl

```bash
curl -sS --fail-with-body "$TOKENGATE_URL/proxy/github/repos/acme/app/issues" \
  -H "x-tokengate-token: $(tokengate-token)" \
  -H 'accept: application/vnd.github+json' \
  -H 'x-github-api-version: 2022-11-28' \
  -d '{"title":"Nightly build failed"}'
```

### Node.js (`@octokit/rest`)

Pass the caller token as `auth`. Octokit sends it in `Authorization`, which the gateway reads as the caller token and never forwards ([I-TOK-1](../threat-model.md#i-tok-1)).

```js
import { Octokit } from '@octokit/rest';

const octokit = new Octokit({
  auth: process.env.TOKENGATE_TOKEN,
  baseUrl: `${process.env.TOKENGATE_URL}/proxy/github`,
});
await octokit.rest.issues.create({ owner: 'acme', repo: 'app', title: 'Nightly build failed' });
```

### Python (`requests`)

```python
import os
import requests

base = f"{os.environ['TOKENGATE_URL']}/proxy/github"
response = requests.post(
    f"{base}/repos/acme/app/issues",
    headers={
        "x-tokengate-token": os.environ["TOKENGATE_TOKEN"],
        "accept": "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
    },
    json={"title": "Nightly build failed"},
    timeout=30,
)
response.raise_for_status()
```

PyGithub does not work through the gateway for most calls.
Its objects call the `url` fields of GitHub's response bodies, which point at `api.github.com`.
PyGithub refuses hosts other than its base URL host, so those calls fail with an `AssertionError`.

### Upload a release asset

The `upload_url` in GitHub's release response points at `uploads.github.com` directly; the gateway does not rewrite response bodies.
Build the gateway URL yourself:

```bash
curl -sS --fail-with-body -X POST \
  "$TOKENGATE_URL/proxy/github-uploads/repos/acme/app/releases/$RELEASE_ID/assets?name=app.tar.gz" \
  -H "x-tokengate-token: $(tokengate-token)" \
  -H 'content-type: application/gzip' \
  --data-binary @app.tar.gz
```

## Caller token header

| Client | Header |
|---|---|
| curl | `x-tokengate-token` |
| Python `requests` example | `x-tokengate-token` |
| Octokit | `Authorization: bearer` (Octokit uses this scheme for JWT-shaped tokens; `token` is accepted too) |

The gateway replaces `Authorization` with the service credential ([I-INJ-1](../threat-model.md#i-inj-1)).

## Starter rules

Rules are relative to `https://api.github.com`. Replace `OWNER/REPO` and narrow the methods:

```text
GET /repos/acme/app/**
POST /repos/acme/app/issues
POST /repos/acme/app/issues/*/comments
```

Every grant also needs conditions. See [policies.md](../policies.md).

## Gotchas

- **GraphQL has one endpoint.** A rule for `POST /graphql` allows every query and mutation the token can run; path rules cannot narrow it. If a job needs GraphQL, use a separate service with a read-only token.
- **The `gh` CLI is not supported.** It cannot use an API base URL with a path such as `/proxy/github`. Use curl or an SDK.
- **`%2F` in paths.** The contents API and Octokit encode `/` inside a file path as `%2F`. A rule must match the path with `%2F` read as `/` and with `%2F` kept, so only `**` matches it. Use `PUT /repos/acme/app/contents/**`, not `contents/*` ([I-AUTHZ-1](../threat-model.md#i-authz-1)).
- **Pagination works.** The gateway rewrites `Link` headers that point under the base URL to gateway URLs, so SDK pagination stays on the gateway ([I-REDIR-1](../threat-model.md#i-redir-1)).
- **Redirects are not followed.** Some endpoints (for example archive downloads) redirect to another host. The gateway returns the redirect unchanged and never sends the credential there ([I-REDIR-1](../threat-model.md#i-redir-1)). Do not use `curl -L` with `x-tokengate-token`: curl sends custom headers to the redirect target too.
- **Response bodies are not filtered.** Whatever GitHub returns reaches the caller, including private repository content the token can read ([threat-model.md](../threat-model.md#credentials-and-responses)).
- **Long jobs.** GitHub caller tokens expire after about 5 minutes. Create a new client with a fresh token for each group of calls. See [github-actions.md](../callers/github-actions.md#long-jobs).
- **Credential rotation.** See [credential-rotation.md](../operations/credential-rotation.md).
