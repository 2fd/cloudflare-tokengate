# Calling the gateway from GitLab CI

This page shows pipeline authors how to call the gateway from GitLab CI/CD jobs, and shows admins how to set up the matching service consumer and consumer access.

A job declares an ID token in `id_tokens`. GitLab mints it when the job starts.
The job sends the token (the caller token) with each request to `/proxy/<service-slug>/<path>`.
The gateway verifies the token, evaluates the grants and adds the service credential. The job never sees the credential.

## 1. Add the service consumer (admin)

1. Get each group whose projects call the gateway, in the format the form takes, `path (ID)`:

   ```bash
   glab api groups/acme-group | jq -r '"\(.full_path) (\(.id))"'
   ```

   The command prints a line such as `acme-group (5678901)`. You can also copy the group ID from the group page (⋮ › Copy group ID).
2. In the admin UI, open **Service consumers** and open **Add a consumer**.
3. Choose **GitLab CI** and paste the lines into **Groups**, separated by commas. List every subgroup whose projects run pipelines: the token names the project's direct group.
4. Only for self-managed GitLab: open **Self-managed GitLab** and enter your instance URL, for example `https://gitlab.example.com`.
5. Select **Add consumer**.

The gateway derives the name ("GitLab (acme-group)", or "GitLab (gitlab.example.com)" for a self-managed instance), the issuer, the signing keys, the algorithm and a random audience. When a GitLab consumer for the same issuer exists, **Add consumer** adds the groups to it. Groups can be added and removed later on the consumer page; the audience and the token checks are under **Advanced trust settings**.

Rules the gateway enforces (`apps/gateway/src/policy/validate.ts`, `apps/gateway/src/identity/profiles/gitlab-ci.ts`, `apps/gateway/src/admin/ops/caller-providers.ts`):

- At least one group is required: gitlab.com signs tokens for every user ([I-TEN-1](../threat-model.md#i-ten-1)), and the access form derives each project's group from this list.
- The tenant pin may only use `namespace_id`, as numeric IDs.
- `namespace_id` is the group that directly contains the project. A project in a subgroup carries the subgroup ID, not the top-level group ID. List every subgroup that runs pipelines.
- Issuers on `gitlab.com` must use the GitLab CI profile. Self-managed instances should use it too: the generic profile has no event guard.
- **Maximum token age** defaults to 10 minutes and offers up to 60 minutes.

The gateway reads the JWKS URI from `<issuer>/.well-known/openid-configuration` when you save.
A self-managed instance must be reachable from the public internet: the Worker only fetches public addresses (`global_fetch_strictly_public`).

## 2. Request the token in the job

```yaml
notify:
  id_tokens:
    TOKENGATE_TOKEN:
      aud: tokengate:abcdefghijklmnopqrstuvwxyz   # the consumer audience
  script:
    - >
      curl -sS --fail-with-body "$TOKENGATE_URL/proxy/slack/chat.postMessage"
      -H "x-tokengate-token: $TOKENGATE_TOKEN"
      -H 'content-type: application/json'
      -d '{"channel":"C0123456789","text":"Deployed"}'
```

- Store `TOKENGATE_URL` as a CI/CD variable. The audience is not a secret.
- Do not `echo` the token or write it to artifacts.
- The consumer page shows a ready-to-copy snippet under **Connect your jobs**, with the slugs of the tokens it can use.

Send the token in `x-tokengate-token` (recommended), or as `Authorization: Bearer <token>`.
For services with **Custom header** injection, the injection header also works when neither header above is present.
See [github-actions.md](github-actions.md#3-send-the-token) for the full order. The gateway never forwards these headers ([I-TOK-1](../threat-model.md#i-tok-1)).

## Claims the gateway uses

| Item | Value |
|---|---|
| Required claims | `sub`, `jti`, `iat`, `exp`, `project_id`, `namespace_id`, `pipeline_source`, `ref` |
| Algorithms | `RS256` by default |
| Anchor rules | `namespace_id` + `project_id`, or `namespace_id` + `ci_config_ref_uri` |
| Trusted events (`pipeline_source`) | `push`, `web`, `schedule`, `api`, `trigger` |
| Tenant pin claims | `namespace_id` |

- Every grant needs exact conditions on one anchor rule ([I-AUTHZ-2](../threat-model.md#i-authz-2)).
- Any other `pipeline_source` needs an exact opt-in in the grant ([I-AUTHZ-3](../threat-model.md#i-authz-3)). Examples: `merge_request_event`, `external_pull_request_event`, `chat`, `webide`, `parent_pipeline`, `pipeline`.
- `parent_pipeline` and `pipeline` need an opt-in too. Child and downstream pipelines report them whatever started the upstream pipeline, including fork merge request pipelines. If you opt in, also require `ref_protected exact true`; merge request refs are never protected. The access form asks you to accept that risk when this condition is missing.

The request log stores only these claims: `sub`, `project_id`, `project_path`, `namespace_id`, `namespace_path`, `ref`, `ref_type`, `ref_path`, `ref_protected`, `pipeline_source`, `environment`, `environment_protected`, `deployment_tier`, `ci_config_ref_uri`, `ci_config_sha`, `pipeline_id`, `job_id`, `user_id`, `user_login`, `sha`, `runner_environment`. `user_email` is never stored ([I-LOG-1](../threat-model.md#i-log-1)).

Get a project in the format the access form takes: `glab api projects/acme-group%2Fapp | jq -r '"\(.path_with_namespace) (\(.id))"'`, which prints `acme-group/app (4567890)`. The project ID is also on the project page (⋮ › Copy project ID).

## Examples per context

Admins create these accesses with **Give a consumer access**: paste the project, choose **When** (Environment, Branch, Tag, Any protected branch or tag, or Any branch, tag or environment) and enter its name. The conditions below are what the form builds; the access page shows them under **Exact conditions**. Contexts the form does not offer, such as a `pipeline_source` opt-in, use **Write conditions by hand**. Semantics: [policies.md](../policies.md#structured-access-form).

In GitLab tokens, `ref` is the plain branch or tag name (`main`, `v1.2.0`). `ref_path` carries the full form (`refs/heads/main`).

### Branch

```text
namespace_id exact 1234567
project_id exact 7654321
ref_type exact branch
ref exact main
ref_protected exact true
pipeline_source exact push, web, schedule
```

### Tag (releases)

GitLab has no release pipeline source. Release jobs run in tag pipelines.

```text
namespace_id exact 1234567
project_id exact 7654321
ref_type exact tag
ref glob v*
ref_protected exact true
pipeline_source exact push
```

Protect the tags (**Settings > Repository > Protected tags**), or `ref_protected` is `false`.

### Merge request

```text
namespace_id exact 1234567
project_id exact 7654321
pipeline_source exact merge_request_event
```

- A merge request pipeline runs the proposed code. Grant it only low-risk calls.
- In merge request pipelines, GitLab sets `project_id` to the source project of the merge request. For a fork, that is the fork, so a grant anchored on your `project_id` does not match.

### Environment

```yaml
deploy:
  environment: production
  id_tokens:
    TOKENGATE_TOKEN:
      aud: tokengate:abcdefghijklmnopqrstuvwxyz
```

```text
namespace_id exact 1234567
project_id exact 7654321
environment exact production
environment_protected exact true
ref_protected exact true
```

The `environment` claims exist only when the job declares `environment:`.

### Pinned CI configuration

To allow one CI configuration file at one ref, anchor on `ci_config_ref_uri` instead of `project_id`:

```text
namespace_id exact 1234567
ci_config_ref_uri exact gitlab.com/acme/app//.gitlab-ci.yml@refs/heads/main
```

Copy the exact value from a request record: open **Requests**, select a request from that pipeline and read its claims.

The pin is a name, not an immutable ID: `ci_config_ref_uri` is built from the project path.
If `acme/app` is renamed, transferred or deleted, anyone who can create projects in `acme` can create a new `acme/app` with their own `.gitlab-ci.yml` and get tokens that match the grant.
A project that loads its CI configuration from another project reports that other project's path in `ci_config_ref_uri`, so the pin then admits every project in the namespace that uses the file ([known limitations](../threat-model.md#callers-and-tokens)).

- Prefer `namespace_id` + `project_id`. Add the pin as an extra condition.
- Limit who can rename, transfer or delete the project, and who can create projects in the namespace.
- Before you rename, transfer or delete the project, disable or update every grant that pins it.
- To pin the file content, add `ci_config_sha exact <commit SHA>`. It is the commit of the pinned ref, so you must update the grant after every commit on that ref.
  It does not pin the project: a recreated `acme/app` that pushes the same commit still supplies its own variables and runners.

A job that runs a pinned configuration takes its CI/CD variables and runners from the project that runs the pipeline, not from `acme/app`.
Project, group and pipeline variables override `variables:` in the YAML ([GitLab docs](https://docs.gitlab.com/ci/variables/#cicd-variable-precedence)).
If the configuration reads `$TOKENGATE_URL`, that project can send the token to its own host and replay it for every rule of the grant until it expires ([known limitations](../threat-model.md#callers-and-tokens)).

- Write the gateway URL as a literal in the `script` of the pinned configuration.
- Limit the runners in the grant: `runner_environment exact gitlab-hosted` on GitLab.com, or `runner_id exact <id>, <id>` for your instance runners. Project runners of the running project can read the token.
- Allow only the exact calls that the configuration makes.

### Give access from a denied request

1. Run the job once. It fails with `403 no_matching_grant`.
2. In the admin UI, open **Requests**, select the denied request and select **Give this caller access**.
3. Review the prefilled form: the project as `path (ID)`, the context (environment, branch or tag), the protected-refs choice, and the exact call as an operation (unless the path contains `*` or `%2F`). An untrusted pipeline source opens the rows editor and asks you to accept that risk.
4. Select **Give access**.

## Long jobs

GitLab mints `id_tokens` once, when the job starts. A job cannot mint a new token while it runs.
The gateway refuses tokens older than **Maximum token age** (default 600 s, at most 3600 s), even if GitLab's `exp` is later.

- Make the calls early in the job, or split the job so the calls run in a short job.
- If a job must call the gateway later, an admin can raise **Maximum token age (seconds)** up to 3600.
- A job that calls the gateway after 3600 s always fails with `token_too_old`.

## Troubleshooting

See [errors.md](../errors.md) for every error code. A response without `x-tokengate-request-id` came from Cloudflare, not from the gateway.

| Symptom | Likely cause | Fix |
|---|---|---|
| `token_missing` (401) | `id_tokens` not declared, or a different variable name | Declare the token in the job and use the same variable name. |
| `audience_mismatch` (401) | Wrong `aud` | Use the audience on the consumer page. |
| `issuer_unknown` (401) | The consumer **Issuer** (Advanced trust settings) differs from the token `iss` (for example a trailing `/`, or another hostname) | Set **Issuer** to the exact `iss` value, for example `https://gitlab.example.com`. |
| `tenant_mismatch` (401) | The project is in a subgroup that is not listed | Add the subgroup on the consumer page (**Add groups**). |
| `token_too_old` (401) | Call made more than **Maximum token age** after the job started | See [Long jobs](#long-jobs). |
| `event_not_trusted` (403) | `pipeline_source` is not trusted and the grant does not opt in | Add an exact `pipeline_source` condition that lists it. |
| `no_matching_grant` (403) | No grant matches | Ask an access manager to use **Give this caller access** on the request. |
| `jwks_unavailable` (503) | The gateway cannot fetch the instance's signing keys | Check that the instance is publicly reachable over https. |
