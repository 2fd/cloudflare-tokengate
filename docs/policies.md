# Policies

This page explains how the gateway decides whether a caller may make a request: caller providers,
tenant pins, grants, conditions and rules. It is for admins who write grants and for security reviewers.

The code is the reference: `src/policy/` (evaluation and validation), `src/identity/profiles/` (what each
platform is trusted for), `src/policy/presets.ts` and `src/admin/consumer-access.ts` (the structured access
form) and `src/admin/grant-text.ts` (the text format of the "Exact conditions" view and of value lists).

## How a request is authorized

Every proxied request goes through these checks, in this order (`src/proxy/handler.ts`):

1. The token's `iss` selects an enabled caller provider. The token is not trusted yet.
2. The token is verified: signature, issuer, audience, algorithm, age and required claims
   ([I-JWT-1](threat-model.md#i-jwt-1)).
3. The caller provider's tenant pin must hold ([I-TEN-1](threat-model.md#i-ten-1)). Until it holds, nothing
   about the caller is stored, and the caller cannot learn whether the service exists.
4. The service must exist and be enabled.
5. The path is canonicalized ([I-PATH-1](threat-model.md#i-path-1)).
6. The service's grants for this caller provider are evaluated in creation order. The first grant that
   matches allows the request. If none matches, the request is denied ([I-AUTHZ-1](threat-model.md#i-authz-1)).

Grants are allow-only. There is no deny rule, so the order of grants changes only which grant the
request log names. Nothing is cached: enabling, disabling, editing, deleting or expiring a grant,
service or caller provider takes effect on the next request.

A grant matches when all of these hold:

![Grant evaluation: for each candidate grant (enabled, not expired, in created_at order) check the anchor rule, all conditions, the event guard and that some rule matches the method and path; the first grant that passes every check allows the request. Any failed check moves to the next grant; when no grant is left the answer is 403.](diagrams/grant-evaluation.svg)

<sub>Diagram source: [`diagrams/src/`](diagrams/src/) (rendered with [archify](https://github.com/tt-a1i/archify)).</sub>

If a grant fails only on the event guard, the caller gets `403 event_not_trusted`. Otherwise a denied
request gets `403 no_matching_grant`. The request log stores a trace with one line per grant: `matched`,
`invalid_grant`, `condition_failed`, `event_not_trusted` or `no_rule`, plus the first failing check. See
[errors.md](errors.md#no_matching_grant).

## Caller providers and profiles

A caller provider trusts one token issuer. Its profile holds what the code knows about that platform.

| Profile | Default issuer | Event claim | Trusted events | Tenant pin claims | Anchor rules |
|---|---|---|---|---|---|
| `github-actions` | `https://token.actions.githubusercontent.com` | `event_name` | `push`, `workflow_dispatch`, `schedule`, `release` | `repository_owner_id`, `enterprise_id` | `repository_owner_id` + `repository_id`, or `repository_owner_id` + `job_workflow_ref` |
| `gitlab-ci` | `https://gitlab.com` | `pipeline_source` | `push`, `web`, `schedule`, `api`, `trigger` | `namespace_id` | `namespace_id` + `project_id`, or `namespace_id` + `ci_config_ref_uri` |
| `generic` | none | none | none (no event guard) | any claim | any one of the caller provider's anchor claims |

Other fixed rules:

- The profile cannot change after the caller provider is created.
- An issuer on `token.actions.githubusercontent.com` or `gitlab.com` must use the matching profile.
  Under `generic`, neither the tenant pin rules nor the event guard would apply.
- The token must carry these claims, or it is refused with `claims_invalid`:
  - `github-actions`: `sub`, `jti`, `iat`, `exp`, `repository_id`, `repository_owner_id`, `event_name`, `ref`.
  - `gitlab-ci`: `sub`, `jti`, `iat`, `exp`, `project_id`, `namespace_id`, `pipeline_source`, `ref`.
  - `generic`: `sub`, `iat`, `exp` and every anchor claim.
- Maximum token age: default 600 seconds; at least 60; at most 900 for `github-actions` and 3600 for
  the others.

Claim references: [GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc),
[GitLab ID token claims](https://docs.gitlab.com/ci/secrets/id_token_authentication/). Per-platform setup:
[callers/github-actions.md](callers/github-actions.md), [callers/gitlab-ci.md](callers/gitlab-ci.md),
[callers/generic-oidc.md](callers/generic-oidc.md).

## Tenant pin

The tenant pin limits a caller provider to your organization. It is checked before any grant
([I-TEN-1](threat-model.md#i-ten-1)). A token that fails it gets `401 tenant_mismatch`.

- In the admin UI it is the consumer's "Organizations" (GitHub), "Groups" (GitLab) or "Tenant pin"
  (generic) on the consumer page:
  - GitHub Actions: organizations as `name (ID)` (`repository_owner_id`), and the "Enterprise ID" under
    Advanced trust settings (`enterprise_id`).
  - GitLab CI: groups as `path (ID)` (`namespace_id`).
  - Generic: claim and value rows ("Change the pin"); a value field takes alternatives separated by
    commas.
- Each pin condition is `exact` and not negated. All pin conditions must hold.
- A pin is required for the shared issuers `https://token.actions.githubusercontent.com` and
  `https://gitlab.com`, whatever the profile: anyone on those platforms can mint a token. An empty pin on a
  shared issuer fails closed at request time too.
- A `generic` caller provider without a pin is allowed, with a warning. Leave it empty only if the issuer
  signs tokens for your company alone.
- The admin UI requires at least one organization or group for every GitHub and GitLab consumer, also
  for GitHub Enterprise issuers and self-managed GitLab, and accepts only numeric IDs in their pins. An
  organization or group that enabled accesses use cannot be removed: the consumer page names them.
- Use numeric IDs. Names such as `repository_owner` can be renamed and registered again by someone else.
- A grant cannot list a value outside the pin for a pinned claim, for example an organization ID from
  another organization. Saving such a grant fails.

Changing a caller provider's anchor claims or tenant pin is refused while an enabled grant would no longer
be valid under the new values. The error lists those grants; edit or disable them first. The check is
enforced in SQL, so a grant enabled at the same moment makes the change fail with a conflict.

## Grants

A grant connects one caller provider to one service. It has:

- **Conditions** (all must match): tests on the verified token claims.
- **Rules** (any may match): the methods and paths it allows on the service.
- **Expires (UTC, optional)**: after this time the grant stops matching.
- An enabled flag. A disabled grant never matches.

Limits: 1–32 conditions and 1–50 rules per grant.

### Condition syntax

The access form builds conditions for you ([Structured access form](#structured-access-form)). The
rows editor ("Write conditions by hand", and every generic consumer) has one row per condition: the
claim, "is exactly" (`exact`) or "matches pattern" (`glob`), "Not", and the values. The access page
shows the stored conditions in this text format under "Exact conditions", and this page uses it in
examples:

```text
[not] <claim> exact|glob <value>[, <value>...]
```

```text
repository_owner_id exact 1234567
repository_id exact 89012345, 89012346
ref glob refs/heads/release/*
not environment exact sandbox
```

- `exact`: the claim equals one of the values.
- `glob`: the claim matches one of the patterns (see [Globs](#globs)).
- `not`: the claim is present, comparable, and matches none of the values.
- The values of one condition are alternatives (OR). Conditions combine with AND.
- Claim names and values are case-sensitive.
- In a values field, values are separated by commas and trimmed. Write a value as a JSON string if it
  contains a comma, starts or ends with a space, or starts with `"`: `"refs/heads/a,b"`. The text format
  also writes values that start with `#` as JSON strings.
- Limits: claim name 1–256 characters; 1–50 values per condition; each value 1–512 characters.

### Condition semantics

These rules are in `src/policy/conditions.ts` ([I-AUTHZ-4](threat-model.md#i-authz-4)):

- **Literal claim names.** `claim` is a top-level claim name. `a.b` is the claim named `a.b`; there is no
  nested lookup.
- **Scalar values only.** Strings compare as they are. Booleans compare as `true` or `false`. Safe
  integers compare as decimal text, so `repository_id exact 123` matches the number `123` and the string
  `"123"`.
- **Fail closed.** A missing claim, `null`, an array, an object or a number that is not a safe integer
  makes the condition false, also when it is negated. `not environment exact sandbox` does not match a
  token without an `environment` claim.
- `not` is not a deny rule. It only makes this grant stricter; another grant can still allow the request.
- A glob condition on a claim value longer than 1024 characters is false.

### Globs

Rule paths and `glob` conditions use the same matcher (`src/policy/glob.ts`):

| Pattern | Matches |
|---|---|
| `*` | Zero or more characters, except `/` |
| `**` (or a longer run of `*`) | Zero or more characters, including `/` |
| Any other character | Itself, case-sensitive |

- The pattern must match the whole value. There is no `?`, `[...]` or escape character, so a rule
  cannot match a literal `*`.
- Limits: pattern 1–512 characters, at most 8 wildcards. The matcher does not backtrack. Its time is
  proportional to value length × pattern length, and both are bounded.

### Rule syntax

The access form calls rules "Allowed operations". It offers the named operations of the token's
template (for example "Post messages: POST /chat.postMessage") and the operation sets that other
accesses of the token use, as checkboxes. "Other operations" has one row per rule: the methods ("All
methods" is `*`) and the path. The access page lists the stored rules as:

```text
<METHOD[,METHOD...]|*> /path-glob
```

```text
POST /chat.postMessage
GET,HEAD /repos/acme/app/**
* /v1/**
```

- A template operation with `{repo}` in its path, such as "Read repository contents:
  `GET /repos/{repo}/**`", is saved with the repository name of the access: `GET /repos/acme/api/**`.
  The saved rule is the literal path; renaming the repository later does not change it.
- A token with `path` injection (a webhook URL) allows exactly `POST /`; the form shows no other choice.
- Methods are `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS`. `*` means all seven.
  Each method must be listed: `GET` does not allow `HEAD`.
- The path is relative to the service base URL. It starts with `/` and is printable ASCII without spaces.
  For `/proxy/github/repos/acme/app`, the path is `/repos/acme/app`.
- The query string is not matched. The proxy refuses (`400 path_invalid`) any query with a method-override
  parameter: `_method`, `x-http-method-override`, `x-http-method` or `x-method-override`.

Path matching details ([I-AUTHZ-1](threat-model.md#i-authz-1)):

- **Trailing slash.** A rule matches a path that ends in `/` only if the rule ends in a literal `/`, or
  if it also matches the same path without the trailing `/`. So `/x/*` and `/x/**` never allow `/x/`,
  which many upstreams treat as `/x`.
- **`%2F`.** A rule must match the path both with `%2F` read as `/` and with `%2F` kept as data. Only `**`
  matches across `%2F`. `/repos/o/r/contents/*` does not match `/repos/o/r/contents/dir%2Ffile`; use
  `/repos/o/r/contents/**`. For APIs that use `%2F` inside identifiers (for example GitLab namespaced
  project IDs), use `**` or numeric IDs at that position.
- `/proxy/<slug>` without a path is the path `/`.

## Anchor rules

Every grant must have exact, non-negated conditions on all claims of at least one anchor rule of its
profile (see the table above) ([I-AUTHZ-2](threat-model.md#i-authz-2)). Anchors are immutable IDs or an exact
workflow pin, so a grant always names specific repositories, projects or workflows.

Workflow pins (`job_workflow_ref`, `ci_config_ref_uri`) are names, not immutable IDs: they are built from
the repository or project path. If the repository or project that holds the pinned file is renamed,
transferred or deleted, anyone who can create one with the same path in the tenant takes over every grant
pinned to it. Prefer `repository_id` or `project_id` when you can, protect the pinned repository or project,
and disable or update its grants before you rename, transfer or delete it. `job_workflow_sha` or
`ci_config_sha` as an extra exact condition pins the file content, at the cost of updating the grant after
every commit on the pinned ref. It does not pin the repository or project: a recreated one that pushes the
same commit still supplies its own variables, environments and runners. See
[GitHub](callers/github-actions.md#reusable-workflow-pin) and
[GitLab](callers/gitlab-ci.md#pinned-ci-configuration).

- For `github-actions`: `repository_owner_id` plus `repository_id`, or `repository_owner_id` plus a
  `job_workflow_ref` pin.
- For `gitlab-ci`: `namespace_id` plus `project_id`, or `namespace_id` plus `ci_config_ref_uri`.
- For `generic`: an exact condition on any one of the caller provider's "Anchor claims" (1–8 claims set
  on the caller provider).

The anchor check runs when the grant is saved and again on every request. A stored grant that no longer
satisfies an anchor rule is skipped with the trace result `invalid_grant`.

## Trusted events

For profiles with an event claim, each token names the event that started the job. Trusted events come
from the repository itself. Other events need an explicit opt-in ([I-AUTHZ-3](threat-model.md#i-authz-3)).

- If the token's event is trusted, the event guard passes.
- Otherwise the grant must have an `exact`, non-negated condition on the event claim that lists the
  event, for example `event_name exact pull_request`.
- A `glob` condition never opts in, even `event_name glob *`.
- A token without the event claim fails the guard.

Untrusted events include, for GitHub, `pull_request`, `pull_request_target`, `workflow_run`,
`issue_comment` and Dependabot's `dynamic`; for GitLab, `merge_request_event`,
`external_pull_request_event`, `chat`, `webide`, `parent_pipeline` and `pipeline`.

GitLab `parent_pipeline` and `pipeline`: child and downstream pipelines report them whatever started the
upstream pipeline, including fork merge request pipelines. If you opt in, also require
`ref_protected exact true`; merge request refs are never protected. A `pipeline` (multi-project downstream)
opt-in with `ref_protected exact true` still admits downstream pipelines on protected branches whose
variables come from the upstream pipeline. This is the same trust level as `trigger` and `api`.

The access page shows the result in its summary, for example
"Events accepted (event_name): push (trusted), pull_request (opted in)". An exact event condition also
excludes trusted events it does not list.

## Structured access form

For GitHub Actions and GitLab CI consumers, the form "Give a consumer access" builds the conditions
from a few choices (`src/admin/consumer-access.ts`, `src/policy/presets.ts`). The result is an ordinary
condition set, validated like any other ([I-AUTHZ-2](threat-model.md#i-authz-2)). "Write conditions by
hand" converts the input to rows without losing it. An access is edited with the form it was made with
when its conditions rebuild exactly; otherwise the edit form opens the rows editor.

| Input | Generated condition |
|---|---|
| Repository `acme/api (89012345)` | `repository_id exact 89012345`, and `repository_owner_id exact <ID of acme>` from the consumer's organizations |
| Project `acme-group/app (4567890)` (GitLab) | `project_id exact 4567890`, and `namespace_id exact <ID of acme-group>` |
| Only protected branches and tags (default) | `ref_protected exact true` |
| More constraints › Workflow pin | `job_workflow_ref exact <owner/repo/path@ref>` (GitLab: `ci_config_ref_uri`) |
| More constraints › Only GitHub-hosted runners | `runner_environment exact github-hosted` |

The organization (GitHub: the first path segment) or group (GitLab: every segment but the last) of the
repository must be one of the consumer's. Its name is matched against the display labels of the
consumer's organizations, without regard to case. For a new organization the form asks for its ID and
adds it to the consumer in the same submit.

"When" adds the context. `<name>` is the input of the chosen card, without `refs/heads/` or
`refs/tags/`. A branch, tag or PR base can end in `*` (`release/*`) but cannot start with `*` or contain
`**`; an environment name cannot contain `*`. Use the rows editor for wider patterns.

| When (GitHub) | Generated conditions |
|---|---|
| Environment | `environment exact <name>` |
| Branch | `ref_type exact branch`<br>`ref glob refs/heads/<name>`<br>`event_name exact push, workflow_dispatch, schedule` |
| Tag | `ref_type exact tag`<br>`ref glob refs/tags/<name>`<br>`event_name exact push` |
| Any protected branch or tag | `ref_protected exact true` |
| Release | `ref_type exact tag`<br>`ref glob refs/tags/<name>`<br>`event_name exact release` |
| Pull request into | `event_name exact pull_request`<br>`base_ref glob <name>` |
| Any branch, tag or environment | none: only the repository and its owner |

| When (GitLab) | Generated conditions |
|---|---|
| Environment | `environment exact <name>` |
| Branch | `ref_type exact branch`<br>`ref glob <name>` |
| Tag | `ref_type exact tag`<br>`ref glob <name>` |
| Any protected branch or tag | `ref_protected exact true` |
| Any branch, tag or environment | none |

GitLab contexts add no `pipeline_source` condition, so only trusted pipeline sources match
([Trusted events](#trusted-events)).

Example: Branch `main`, repository `acme/api (89012345)` of organization `acme (1234567)`, protected
refs:

```text
repository_owner_id exact 1234567
repository_id exact 89012345
ref_type exact branch
ref glob refs/heads/main
event_name exact push, workflow_dispatch, schedule
ref_protected exact true
```

### Risks and their acceptance

A choice that carries a risk says so in its label, after "Risk:". Choosing it is the acceptance: the
access saves in one submit, and the audit row records the accepted risk codes and the warnings
([I-AUTHZ-3](threat-model.md#i-authz-3), [ADR 0021](adr/0021-structured-consumer-access-and-labels.md)).

| Choice | Risk code | Risk |
|---|---|---|
| Also unprotected branches and tags | `unprotected_ref` | anyone who can push a branch gets the token |
| Pull request into | `pull_request` | `pull_request` jobs run the code proposed in the pull request |
| Any branch, tag or environment | `any_ref` | anyone with write access to the repository gets the token |

The server computes the accepted codes from the submitted choice of the chosen consumer branch, never
from a list the browser sends. A choice in another, hidden branch covers nothing. The admin UI also
finds these risks in the conditions themselves: rows that constrain no ref, environment, protection
or event carry `any_ref`, and rows on a ref or environment without `ref_protected exact true` carry
`unprotected_ref`. Without the structured choice, they need the box below, and the access page lists
them under "Accepted risks". The default context is never a risky one.

Every other warning (the codes `broad_glob`, `event_glob`, `pwn_request`, `inherited_trust_event`,
`untrusted_event` and `path_injection_non_post` of [Warnings](#warnings)) needs the box "I have read
these risks and want to save this access anyway". The box is bound to a digest of exactly the risks
shown: if an edit changes them, the form asks again. The box shows on the first render when prefilled
values (a copy, a request record) or the rows editor already carry risks.

## Warnings

Every warning has a stable code (`warningDetails` in `src/policy/validate.ts`). How each one is
accepted is in [Risks and their acceptance](#risks-and-their-acceptance). The access page recomputes
"Accepted risks" from the stored conditions.

| Code | Warning (shortened) | Why |
|---|---|---|
| `broad_glob` | A `glob` on `ref`, `ref_path`, `base_ref`, `environment`, `job_workflow_ref`, `workflow_ref` or `ci_config_ref_uri` starts with `*` or contains `**` | Anyone who can push a branch, tag, environment or workflow with a matching name is admitted |
| `unprotected_ref` | The access matches on `ref`, `ref_path` or `environment` without `ref_protected exact true` (GitHub and GitLab) | Repository writers can create matching refs |
| `event_glob` | The event claim uses a glob | Globs never allow untrusted events; list events with `exact` |
| `pwn_request` | `workflow_run`, `issue_comment` or `pull_request_target` is opted in | These run with base-repository privileges on input from outside contributors ("pwn request"; see [GitHub Security Lab](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/)) |
| `inherited_trust_event` | GitLab `parent_pipeline` or `pipeline` is opted in without `ref_protected exact true` | Merge request pipelines, including fork merge requests, can start them |
| `pull_request` | GitHub `pull_request` is opted in | `pull_request` jobs run the code proposed in the pull request |
| `untrusted_event` | Another untrusted event is opted in | The access accepts an event that is refused by default |
| `path_injection_non_post` | The token uses `path` injection and the access allows a method other than `POST` | Webhook APIs such as Discord return the credential in the response body for `GET` and `PATCH` on the webhook URL, and response bodies are not redacted |
| `any_ref` | (structured form only) Any branch, tag or environment | Anyone with write access to the repository gets the token |

About `ref_protected`: GitHub reports a ref as protected only when branch protections or rulesets are
configured for it (see `GITHUB_REF_PROTECTED` in
[GitHub variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)). Tags are often not
protected. For tag and release accesses with protected refs, add a tag ruleset, or the access never
matches. Pull request refs (`refs/pull/N/merge`) are never protected, so the pull request context has no
protected-refs choice.

## Give access from a denied request

On a request record denied with `no_matching_grant` or `event_not_trusted`, access managers, admins and
owners see "Give this caller access" when the token was verified ([I-LOG-2](threat-model.md#i-log-2)).
The form refuses to prefill if the consumer or the token no longer exists.

- GitHub and GitLab: the repository (`<repository> (<repository_id>)`, GitLab `project_path` and
  `project_id`), the context (environment when the token has one, else branch or tag from `ref`; the
  pull request context for `pull_request`) and the protected-refs choice from the token's
  `ref_protected`.
- Another untrusted event (for example `workflow_run`) opens the rows editor with exact copies of the
  anchor claims plus `ref`, the event claim and `environment`, and asks to accept its risk on the first
  render.
- The operation is the template operation or operation set that contains the exact call, else the exact
  call as a custom rule, for example `POST /chat.postMessage`. If the path contains `*` or `%2F`, no
  operation is prefilled; add it by hand.
- The repository name becomes a display label only when you save. Nothing from the request log is ever
  offered as a suggestion.
- Review the values before saving. Widen only what callers need.

## Examples

Deploy workflow on the protected `main` branch posts to Slack:

```text
repository_owner_id exact 1234567
repository_id exact 89012345
ref_type exact branch
ref exact refs/heads/main
event_name exact push, workflow_dispatch
ref_protected exact true
```

```text
POST /chat.postMessage
```

To allow pushes only, write `event_name exact push`. To also allow jobs that deploy to the
`production` environment, create a second grant on the same caller provider and service. Grants
combine with OR; conditions in one grant combine with AND:

```text
repository_owner_id exact 1234567
repository_id exact 89012345
environment exact production
ref_protected exact true
```

Protect the environment in the repository settings (required reviewers or deployment branch rules).
The grant trusts those settings.

Only one reusable workflow, from any repository of the organization, may call the OpenAI Responses API.
The grant has no `repository_id`, so every repository of the organization that calls this workflow
matches. There is no `event_name` condition, so only trusted events pass. The rule allows only the call the
workflow makes (`POST /responses`):

```text
repository_owner_id exact 1234567
job_workflow_ref exact acme/ai-workflows/.github/workflows/openai.yml@refs/heads/main
runner_environment exact github-hosted
```

The calling repository supplies the called workflow's `vars`, `inputs`, inherited secrets, environment
and self-hosted runners. The workflow must hardcode the gateway URL and must not let those values choose
where the token goes or which calls it makes. Otherwise the caller gets a bearer token for every rule of
the grant ([known limitations](threat-model.md#callers-and-tokens)).
[callers/github-actions.md](callers/github-actions.md#central-reusable-workflow-for-the-organization)
shows the matching workflows.

Only one reusable workflow, from a fixed set of repositories, may deploy to production:

```text
repository_owner_id exact 1234567
job_workflow_ref exact acme/infra/.github/workflows/deploy.yml@refs/heads/main
repository_id exact 89012345, 89012346
environment exact production
ref_protected exact true
```

`repository_id`, `environment` and `ref_protected` describe the calling repository. Without
`repository_id`, any org member can create a repository with a protected `main` and a `production`
environment and match this grant.

GitLab: pipelines on protected branches of one project. GitLab's `ref` is the branch name and
`ref_path` is the full ref.

```text
namespace_id exact 4567
project_id exact 891011
ref_type exact branch
ref exact main
ref_protected exact true
pipeline_source exact push, web, schedule
```

Generic issuer whose caller provider has the anchor claim `project_id` (the claim names depend on the
issuer; pick a claim that never changes for the workload, not a per-run ID):

```text
project_id exact 0189f3c2-6a4e-4b8e-9d0a-3f1c2b7e5a10
```

## Pitfalls

- **Names instead of IDs.** Do not anchor on `repository`, `repository_owner`, `project_path` or
  `namespace_path`: they can be renamed and registered again by someone else. Workflow pins
  (`job_workflow_ref`, `ci_config_ref_uri`) are names too (see [Anchor rules](#anchor-rules)).
- **Caller-controlled values in reusable workflows.** A reusable workflow reads `vars`, `inputs`,
  inherited secrets and environments from the calling repository. If they choose the gateway URL, the
  caller can capture a token that matches the grant. Hardcode the URL and allow only the calls the workflow
  makes. A GitLab configuration pinned with `ci_config_ref_uri` has the same problem: CI/CD variables come
  from the project that runs the pipeline ([GitLab CI](callers/gitlab-ci.md#pinned-ci-configuration)).
- **Branch claims from generic issuers.** The gateway has no `ref_protected` check for generic issuers.
  Some issuers let anyone who starts a build choose the branch label, for example Buildkite's
  `build_branch`, which also carries the tag name in tag builds
  ([generic OIDC](callers/generic-oidc.md#buildkite)).
- **Matching `sub`.** Its format varies with the platform and its settings. Match individual claims.
- **Wide refs without protection.** `ref glob refs/heads/**` admits any branch any writer pushes.
- **Same-repository pull requests.** A `pull_request` job runs the branch author's workflow file.
  Treat a pull request grant as granting access to every writer of the repository.
- **POST is not weaker on every upstream.** Rules match the HTTP request line only; the gateway does
  not inspect request bodies. On upstreams that honour a form-body `_method` (Rails Rack::MethodOverride,
  Symfony/Laravel, Spring HiddenHttpMethodFilter, ASP.NET Core form override), a grant that allows `POST`
  on a path also allows any method the upstream accepts through body override on that path.
- **Response bodies pass through.** If an upstream endpoint returns the credential in its body, every
  caller whose grant reaches that endpoint receives it, and it keeps working after the grant is revoked.
  For webhook services with `path` injection (Slack, Discord), allow only `POST /`. See
  [threat-model.md](threat-model.md#credentials-and-responses).
- **GitLab merge request pipelines.** In merge request pipelines, `project_id` and `project_path` can
  describe the source project. Opt in to `merge_request_event` only with care.
- **Several exact conditions on one claim.** They combine with AND, so only values listed in all of them
  can match.

## Related pages

- [concepts.md](concepts.md): glossary.
- [errors.md](errors.md): what callers see when a check fails.
- [threat-model.md](threat-model.md): invariants and known limitations.
- [configuration.md](configuration.md): the upstream host allowlist and other deployment settings.
