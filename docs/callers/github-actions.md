# Calling the gateway from GitHub Actions

This page shows workflow authors how to call the gateway from GitHub Actions, and shows admins how to set up the matching caller provider and grants.

A job mints a GitHub OIDC token (the caller token) and sends it with each request to `/proxy/<service-slug>/<path>`.
The gateway verifies the token, evaluates the grants, removes the caller token and adds the service credential.
The job never sees the credential.

![Sequence: the workflow job requests an OIDC token for the caller provider audience, sends it to the gateway in x-tokengate-token, the gateway verifies it, checks the tenant pin and grants, forwards the same request with the service credential, and returns the upstream response without the credential.](../diagrams/request-flow.svg)

<sub>Diagram source: [`../diagrams/src/`](../diagrams/src/) (rendered with [archify](https://github.com/tt-a1i/archify)).</sub>

## 1. Add the service consumer (admin)

1. Get each organization or user account that owns the calling repositories, in the format the form takes, `name (ID)`:

   ```bash
   gh api orgs/acme --jq '"\(.login) (\(.id))"'
   gh api users/NAME --jq '"\(.login) (\(.id))"'   # a user account
   ```

   Each command prints one line, such as `acme (1234567)`.
2. In the admin UI, open **Service consumers** and open **Add a consumer**.
3. Keep **GitHub Actions** and paste the lines into **Organizations**, separated by commas.
4. Only for GitHub Enterprise Cloud with its own OIDC issuer: open **GitHub Enterprise Cloud with its own issuer** and enter the enterprise slug (the issuer becomes `https://token.actions.githubusercontent.com/<slug>`) and, optionally, the numeric **Enterprise ID**.
5. Select **Add consumer**.

The gateway derives the rest: the name ("GitHub Actions (acme)"), the issuer, the signing keys (OIDC discovery), the algorithm (`RS256`), the maximum token age (600 seconds) and a random audience (`tokengate:` followed by 26 characters). When a GitHub Actions consumer for the same issuer exists, **Add consumer** adds the organizations to it instead. Organizations can be added and removed later on the consumer page. The issuer, audience, algorithms, maximum token age and enterprise ID are under **Advanced trust settings**.

Rules the gateway enforces (`apps/gateway/src/policy/validate.ts`, `apps/gateway/src/admin/ops/caller-providers.ts`):

- At least one organization is required: GitHub signs tokens for every GitHub user on `https://token.actions.githubusercontent.com` ([I-TEN-1](../threat-model.md#i-ten-1)), and the access form derives each repository's organization from this list.
- The tenant pin may only use `repository_owner_id` and `enterprise_id`, as numeric IDs that a rename cannot reuse.
- The audience must have at least 16 printable ASCII characters, without spaces.
- The audience cannot be a GitHub owner URL (`https://github.com/...`, the default audience of every workflow).
- The audience cannot be a cloud platform audience: `sts.amazonaws.com`, `api://AzureADTokenExchange`, or a Google `iam.googleapis.com` audience.
- Each issuer can belong to only one consumer. One consumer holds all your organizations.
- **Maximum token age** defaults to 10 minutes and offers 5, 10 or 15 minutes.

Store the gateway URL and the audience as organization variables, for example `TOKENGATE_URL` and `TOKENGATE_AUDIENCE`.
Reusable workflows that an access pins must not read the URL from variables: the caller repository supplies them (see [Central reusable workflow](#central-reusable-workflow-for-the-organization)).
The consumer page shows a ready-to-copy snippet under **Connect your jobs**, with the slugs of the tokens it can use.

## 2. Mint the token with the composite action

The repository ships the composite action [`actions/get-token`](../../actions/get-token/README.md).
It mints a token and installs the `tokengate-token` helper for later steps.

```yaml
permissions:
  id-token: write   # required to mint OIDC tokens
  contents: read

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - id: tokengate
        uses: 2fd/cloudflare-tokengate/actions/get-token@main   # pin to a full commit SHA in production
        with:
          url: ${{ vars.TOKENGATE_URL }}
          audience: ${{ vars.TOKENGATE_AUDIENCE }}

      - name: Post to Slack through the gateway
        env:
          TOKEN: ${{ steps.tokengate.outputs.token }}
          PROXY: ${{ steps.tokengate.outputs.proxy-base }}
        run: |
          curl -sS --fail-with-body "$PROXY/slack/chat.postMessage" \
            -H "x-tokengate-token: $TOKEN" \
            -H 'content-type: application/json' \
            -d '{"channel":"C0123456789","text":"Deployed"}'
```

The action ([`action.yml`](../../actions/get-token/action.yml)):

- Requires `permissions: id-token: write` on the job or workflow.
- Requires an `https://` `url` and an `audience`. It rejects inputs that contain whitespace or line breaks.
- Outputs `token`, `url` (no trailing slash) and `proxy-base` (`<url>/proxy`).
- Exports `TOKENGATE_URL` and `TOKENGATE_AUDIENCE` to later steps.
- Puts `tokengate-token` on `PATH`. Each call prints a fresh token on stdout.
- Needs `bash`, `curl` and `jq` on the runner. GitHub-hosted runners have them; check self-hosted runners.

The path after the service slug is relative to the service **Base URL**.
For the Slack template (`https://slack.com/api`), `/proxy/slack/chat.postMessage` reaches `https://slack.com/api/chat.postMessage`.

### Masking

Each `tokengate-token` call registers its output with the runner's log masker (`::add-mask::` on stderr) ([I-LOG-1](../threat-model.md#i-log-1)).
Masking covers only the exact value in step logs:

- It does not cover base64 or partial copies of the token.
- It does not cover files or artifacts.
- It does not work while `::stop-commands::` is active.

Do not log or store the token.
Do not redirect the stderr of `tokengate-token`: `2>/dev/null` drops the mask command, and `2>&1` inside `$(...)` puts the mask command into the captured value.

### Without the composite action

If you cannot use the action, request the token from the runner and mask it yourself:

```bash
token="$(curl -sS --fail-with-body --get \
  -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
  --data-urlencode "audience=${TOKENGATE_AUDIENCE}" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}" | jq -r '.value')"
echo "::add-mask::${token}"
```

In JavaScript (`actions/github-script` or `@actions/core`), use `await core.getIDToken(audience)`.

## 3. Send the token

The gateway reads the caller token from these headers, in this order (`apps/gateway/src/proxy/caller-token.ts`):

| Header | When to use |
|---|---|
| `x-tokengate-token: <token>` | Recommended. Works for every service. |
| `Authorization: Bearer <token>` or `Authorization: token <token>` | SDKs that send their API key as a bearer token (Slack, OpenAI, Octokit). |
| The service's injection header, for example `x-api-key: <token>` | Only for services with **Custom header** injection, and only when neither header above is present. The header prefix, if set, is removed first. |

If you send both `x-tokengate-token` and `Authorization: Bearer|token`, both must carry the same token. Otherwise the gateway returns `400 token_ambiguous`.
`Authorization` values with another scheme (for example `Basic`) are ignored.
The gateway never forwards any of these headers upstream ([I-TOK-1](../threat-model.md#i-tok-1), [I-INJ-1](../threat-model.md#i-inj-1)).

## Claims the gateway uses

The GitHub Actions profile (`apps/gateway/src/identity/profiles/github-actions.ts`) defines what the gateway trusts:

| Item | Value |
|---|---|
| Required claims | `sub`, `jti`, `iat`, `exp`, `repository_id`, `repository_owner_id`, `event_name`, `ref` |
| Algorithms | `RS256` by default |
| Anchor rules | `repository_owner_id` + `repository_id`, or `repository_owner_id` + `job_workflow_ref` |
| Trusted events | `push`, `workflow_dispatch`, `schedule`, `release` |
| Tenant pin claims | `repository_owner_id`, `enterprise_id` |

Every grant needs exact conditions on one anchor rule ([I-AUTHZ-2](../threat-model.md#i-authz-2)).
Any other `event_name` (`pull_request`, `pull_request_target`, `workflow_run`, `issue_comment`, Dependabot's `dynamic`, …) is refused unless the grant lists it in an exact `event_name` condition ([I-AUTHZ-3](../threat-model.md#i-authz-3)).

The request log stores only these claims: `sub`, `repository`, `repository_id`, `repository_owner`, `repository_owner_id`, `ref`, `ref_type`, `ref_protected`, `event_name`, `environment`, `base_ref`, `head_ref`, `workflow_ref`, `job_workflow_ref`, `actor`, `actor_id`, `run_id`, `run_attempt`, `sha`, `runner_environment`, `enterprise_id` ([I-LOG-1](../threat-model.md#i-log-1)).

Get a repository in the format the access form takes, `name (ID)`:

```bash
gh api repos/acme/api --jq '"\(.full_name) (\(.id))"'
```

The command prints `acme/api (89012345)`. The ID keeps working after a rename; the name is a display label, and the form derives the organization from it.

## Examples per context

Admins create these accesses with **Give a consumer access**: paste the repository, choose **When**, and enter its branch, tag or environment.
The conditions below come from `apps/gateway/src/policy/presets.ts`, with **Only protected branches and tags (recommended)** chosen.
The access page shows them under **Exact conditions**. Full semantics: [policies.md](../policies.md#structured-access-form).

### Branch

```yaml
on:
  push:
    branches: [main]
```

Access (**When**: Branch, `main`):

```text
repository_owner_id exact 1234567
repository_id exact 7654321
ref_type exact branch
ref glob refs/heads/main
event_name exact push, workflow_dispatch, schedule
ref_protected exact true
```

### Tag

```yaml
on:
  push:
    tags: ['v*']
```

Access (**When**: Tag, `v*`):

```text
repository_owner_id exact 1234567
repository_id exact 7654321
ref_type exact tag
ref glob refs/tags/v*
event_name exact push
ref_protected exact true
```

`ref_protected` is `true` for a tag only when a tag ruleset protects it. Without one, choose **Also unprotected branches and tags**, which accepts that risk, or add a tag ruleset first.

### Release

```yaml
on:
  release:
    types: [published]
```

Access (**When**: Release, `v*`): the same as the tag access, with `event_name exact release`.

### Pull request

```yaml
on:
  pull_request:
    branches: [main]
```

Access (**When**: Pull request into, `main`; this choice has no protected-refs option and carries its risk in its label):

```text
repository_owner_id exact 1234567
repository_id exact 7654321
event_name exact pull_request
base_ref glob main
```

- A `pull_request` job runs the code proposed in the pull request. Grant it only low-risk calls.
- Pull request refs (`refs/pull/N/merge`) are never protected. If you require protected refs, the grant never matches.
- Pull requests from forks get no OIDC token by default, so the action fails with `No OIDC token available`.
- `pull_request_target`, `workflow_run` and `issue_comment` run with base-repository privileges on outside input ("pwn requests"). The access form asks you to accept that risk when the rows editor opts in to them.

### Environment

```yaml
jobs:
  deploy:
    environment: production
```

Access (**When**: Environment, `production`):

```text
repository_owner_id exact 1234567
repository_id exact 7654321
environment exact production
ref_protected exact true
```

- The `environment` claim exists only when the job declares `environment:`.
- This grant does not restrict `event_name`, so only trusted events pass.
- A glob such as `prod*` triggers a warning: GitHub creates unprotected environments on first use, so any writer can pick a matching name.

### Reusable workflow pin

To allow one reusable workflow, whatever repository in the tenant calls it, leave **Repository** empty and set **More constraints › Workflow pin**. With several organizations, also choose the organization there.
The form still adds the conditions of the chosen **When** context. The anchor part of the result is:

```text
repository_owner_id exact 1234567
job_workflow_ref exact acme/infra/.github/workflows/deploy.yml@refs/heads/main
```

The pin must be exact. The form refuses wildcards.
A grant anchored on `job_workflow_ref` admits every repository in the tenant that can call that workflow ([known limitations](../threat-model.md#callers-and-tokens)).
In that token, `repository_id`, `ref`, `ref_protected`, `environment` and `event_name` describe the calling repository and its run, not the repository that holds the workflow.
An org member can create a repository with a protected `main` and a `production` environment, so these conditions do not limit which repositories call the workflow. Add `repository_id exact <id>, <id>` for that.

The pin is a name, not an immutable ID: `job_workflow_ref` is built from `OWNER/REPO`.
If `acme/infra` is renamed, transferred or deleted, anyone who can create repositories in `acme` can create a new `acme/infra`, write their own `deploy.yml` and get tokens that match the grant.

- Prefer `repository_owner_id` + `repository_id` when the workflow lives in the calling repository. Add the pin as an extra condition.
- Protect the repository that holds the workflow: limit who can administer, rename, transfer or delete it, and limit repository creation in the organization.
- Before you rename, transfer or delete that repository, disable or update every grant that pins it.
- To pin the file content, add `job_workflow_sha exact <commit SHA>`. It is the commit of the pinned ref, so you must update the grant after every commit on that ref, not only after workflow changes.
  It does not pin the repository: a recreated `acme/infra` that pushes the same commit still supplies its own `vars`, environments and runners.
  Use it together with the rules in [Central reusable workflow](#central-reusable-workflow-for-the-organization).

Every **When** context except **Any branch, tag or environment** also limits the caller's ref (for example **Branch** `main` adds `ref glob refs/heads/main`).
For an access without ref conditions, choose **Any branch, tag or environment**: it keeps only the two anchor conditions, and its label names its risk.

### Central reusable workflow for the organization

Example: every repository of `acme` may call the OpenAI Responses API, but only through the reusable workflow `acme/ai-workflows/.github/workflows/openai.yml` on `main`.

A called workflow runs in the caller's context. The caller repository supplies these values, not `acme/ai-workflows`:

- `vars.*`. Repository variables override organization variables of the same name ([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)).
- `inputs.*`, and secrets passed with `secrets: inherit` or `secrets:`.
- The `environment` that a job names, its secrets and its protection rules, and the `ref` and `ref_protected` claims.
- Self-hosted runners that the caller repository can use.

Any org member who can create a repository controls all of these.
The token minted inside the called workflow carries the pinned `job_workflow_ref`, so it matches the grant wherever it goes.
If the called workflow sends the token to a host the caller chose, the caller gets a bearer token for every rule of the grant until the token expires ([known limitations](../threat-model.md#callers-and-tokens)).
So the called workflow must decide where the token goes and which calls it makes:

1. Hardcode the gateway URL as a literal in the called workflow. Never read it from `vars`, `inputs` or `secrets`.
   The audience can stay a variable: a wrong audience only makes the gateway reject the token.
2. Hardcode a GitHub-hosted runner label in `runs-on`, and add `runner_environment exact github-hosted` to the grant. Self-hosted runners of the caller repository can read the token.
3. Give the grant only the exact method and path of each call the workflow makes. Do not let inputs choose the service, path or method.
4. Do not expose the token as a workflow output, artifact or cache entry.
5. Keep **Maximum token age (seconds)** of the caller provider short, for example 120, if your workflows call the gateway right after minting. The setting applies to every grant of the caller provider.
6. Protect `acme/ai-workflows`: the pin is a name, not an ID (see [Reusable workflow pin](#reusable-workflow-pin)).

Set up the grant:

1. If `acme/ai-workflows` is private, allow access from the other repositories: in `acme/ai-workflows`, open Settings > Actions > General > Access.
2. Give the consumer access to the OpenAI token with an empty **Repository**, **When**: **Any branch, tag or environment**, and under **More constraints** the **Workflow pin** and **Only GitHub-hosted runners**. The result:

   ```text
   repository_owner_id exact 1234567
   job_workflow_ref exact acme/ai-workflows/.github/workflows/openai.yml@refs/heads/main
   runner_environment exact github-hosted
   ```

   Rule: `POST /responses` only. No `event_name` condition means that only trusted events pass.
   Do not use **Give this caller access** for this case: it prefills the repository of the denied call (one repository only).

The reusable workflow in `acme/ai-workflows`:

```yaml
# .github/workflows/openai.yml
on:
  workflow_call:
    inputs:
      prompt:
        type: string
        required: true
jobs:
  call:
    runs-on: ubuntu-latest   # GitHub-hosted; never a label the caller can choose
    steps:
      - id: tokengate
        uses: 2fd/cloudflare-tokengate/actions/get-token@main   # pin to a full commit SHA in production
        with:
          url: https://tokengate.acme.example   # literal: vars come from the caller repository
          audience: ${{ vars.TOKENGATE_AUDIENCE }}
      - env:
          TOKEN: ${{ steps.tokengate.outputs.token }}
          PROMPT: ${{ inputs.prompt }}   # data only: passed through env, never into the URL or the command
        run: |
          jq -n --arg input "$PROMPT" '{model: "gpt-5", input: $input}' |
            curl -sS --fail-with-body "https://tokengate.acme.example/proxy/openai/responses" \
              -H "x-tokengate-token: $TOKEN" \
              -H 'content-type: application/json' \
              --data-binary @-
```

A caller in any repository of the organization:

```yaml
on:
  push:
    branches: [main]
jobs:
  summarize:
    permissions:
      id-token: write   # the called workflow cannot get more permissions than the calling job
      contents: read
    uses: acme/ai-workflows/.github/workflows/openai.yml@main
    with:
      prompt: Summarize the release notes.
```

- The calling job must grant `id-token: write`. A called workflow can only keep or reduce the permissions of the calling job ([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)).
- The ref in `uses:` must produce the pinned `job_workflow_ref`. `@main` gives `...openai.yml@refs/heads/main`. A caller that uses a tag or a commit SHA gets a different value and is denied with `no_matching_grant`.
- A job outside the reusable workflow cannot mint a token with the pinned `job_workflow_ref`, so its own calls are denied.
  This holds only while the called workflow follows the list above. Every calling repository can still make the calls that the workflow makes.
- To limit which repositories may call the workflow, add `repository_id exact <id>, <id>` to the grant.

### Give access from a denied request

1. Run the workflow once. It fails with `403 no_matching_grant`.
2. In the admin UI, open **Requests** and select the denied request. The error body contains its request ID.
3. Select **Give this caller access**.
   The form is prefilled with the caller's repository as `name (ID)`, the context (the environment when the job has one, else the branch or tag), the protected-refs choice the token reported, and the exact call as an operation, unless the path contains `*` or `%2F`.
   An untrusted event such as `workflow_run` opens the rows editor and asks you to accept that risk.
4. Review the values, widen only what you need, and select **Give access**.

## Long jobs

GitHub tokens expire after about 5 minutes. The gateway also refuses tokens older than **Maximum token age** (default 600 s).
Mint a fresh token for each call or group of calls:

```bash
curl -sS --fail-with-body "$TOKENGATE_URL/proxy/openai/models" \
  -H "x-tokengate-token: $(tokengate-token)"
```

In Node.js scripts, call the helper when you build a client:

```js
import { execFileSync } from 'node:child_process';
const token = () => execFileSync('tokengate-token', { encoding: 'utf8' }).trim();
```

## Troubleshooting

Gateway errors carry `x-tokengate-source: gateway`, `x-tokengate-error: <code>` and `x-tokengate-request-id`. See [errors.md](../errors.md) for every code.
A response without `x-tokengate-request-id` came from Cloudflare, not from the gateway. See [cloudflare-zone-settings.md](../operations/cloudflare-zone-settings.md).

| Symptom | Likely cause | Fix |
|---|---|---|
| Action fails: `No OIDC token available` | Missing `id-token: write`, or a fork pull request | Add the permission. Fork pull requests get no token by default. |
| `token_missing` (401) | No header, or an empty `$TOKEN` | Send `x-tokengate-token`. Check the step ID in `steps.<id>.outputs.token`. |
| `audience_mismatch` (401) | Wrong `audience` input | Use the audience shown on the caller provider page. The error message names the expected value. |
| `issuer_unknown` (401) | No enabled caller provider for the issuer | Ask an admin to add or enable it. |
| `tenant_mismatch` (401) | The repository owner is not in **Allowed organization IDs** | Ask an admin to add the organization ID. |
| `token_expired` or `token_too_old` (401) | Token minted too early | Call `tokengate-token` right before the request. |
| `event_not_trusted` (403) | The event is not trusted and the grant does not opt in | Ask an admin to add the event to an exact `event_name` condition, or trigger the job another way. |
| `no_matching_grant` (403) | No grant matches the claims, method and path | Ask an access manager to use **Give this caller access** on the request. |
| `service_not_found` (404) | Wrong slug, or the service is disabled | Check the slug after `/proxy/`. |
| `path_invalid` (400) | `//`, `.` or `..` segments, forbidden escapes, or a method-override query parameter | Fix the URL. |
