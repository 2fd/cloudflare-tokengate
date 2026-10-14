# cloudflare-tokengate

A self-hosted credential broker on Cloudflare Workers: CI jobs prove who they are with a short-lived workload identity token, and the gateway calls upstream APIs for them with credentials the jobs never see.

This page is for anyone who evaluates, deploys or audits tokengate. Full documentation starts at [docs/index.md](docs/index.md).

![Sequence: the CI job gets a short-lived OIDC token from its issuer, calls tokengate at /proxy/<slug>/<path>; tokengate reads the service and grants from D1 in one batch, verifies the token against the issuer JWKS, forwards the call to the upstream API with the credential injected and the caller token removed, returns the filtered response, and writes a request record to TELEMETRY_DB after responding.](docs/diagrams/request-flow.svg)

<sub>Diagram source: [`docs/diagrams/src/`](docs/diagrams/src/) (rendered with [archify](https://github.com/tt-a1i/archify)).</sub>

## What it is

- A reverse proxy that you deploy to your own Cloudflare account. Each company runs its own deployment.
- A place to store upstream API keys encrypted. A key goes in through the admin UI and never comes out.
- A policy engine. A grant decides which CI workloads (organization, repository, branch, tag, pull request, release, environment) may call which API paths and methods.
- An admin UI behind Cloudflare Access. The gateway verifies the Access token on every admin request and keeps no sessions of its own.

## What it is not

- Not a hosted service. There is no shared instance and no multi-tenant mode.
- Not a secrets manager for callers. Callers never receive the credential; the gateway attaches it to the outbound request.
- Not a general-purpose reverse proxy. It forwards HTTP requests to fixed upstream base URLs only. It does not support WebSockets.
- Not a response filter. Upstream response bodies pass through unchanged (see [known limitations](docs/threat-model.md#known-limitations)).

Non-goals and future work are listed in [docs/roadmap.md](docs/roadmap.md).

## Features

- **Workload identity instead of static keys.** Callers send a GitHub Actions OIDC token, a GitLab CI `id_token`, or a token from any OIDC issuer. The gateway checks signature, issuer, audience, age and required claims.
- **Granular grants.** Conditions on verified claims select the caller: organization, repository, branch, tag, pull request, release or environment. Rules select the allowed methods and path globs. GitHub presets build the conditions for branch, tag, release, pull request and environment cases.
- **Revocation on the next request.** Disabling a grant, a service or a caller provider takes effect on the next request. Policy is read from D1 on every request; there is no policy cache.
- **Encrypted credentials.** AES-256-GCM envelope encryption under a key-encryption key that you generate and keep outside Cloudflare. The ciphertext is bound to the service and its destination.
- **Request log.** Every proxied call can produce a request record with the outcome, the reason, the verified caller and the policy evaluation. Hourly rollups feed the dashboard. An optional archive writes every record to R2 through Basin Pipelines.
- **Audit log.** Every admin change writes one audit event, also emitted as an `audit.event` log line for your SIEM.
- **Admin UI behind Cloudflare Access.** Server-rendered pages without client-side JavaScript. Roles `owner`, `admin` and `viewer`, given by invitation. Denied requests offer a "Create grant from this request" button.
- **Self-hosted.** Apache-2.0. Runs on Workers and two D1 databases in your account.

## Quick start

The steps below are a summary. [docs/getting-started.md](docs/getting-started.md) has every step, the production setup on a custom domain and the caveats.

### Option A: Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/2fd/cloudflare-tokengate)

1. Before you click, generate the key-encryption key outside Cloudflare and store it in your company vault: `openssl rand -base64 32`.
2. Click the button. Paste the key when the form asks for `TOKENGATE_KEK`.
3. In the build settings, check that the deploy command runs the `deploy` script: `pnpm run deploy`. Cloudflare pre-fills it from `package.json`. This script applies the database migrations before it deploys.
4. After the first deploy, continue with [getting-started.md, step 7](docs/getting-started.md#7-attach-a-custom-domain).

The button copies this repository into a new repository in your account. It is not a fork, so you pull updates yourself ([docs/operations/upgrades.md](docs/operations/upgrades.md)).

### Option B: Manual deploy

Prerequisites: Node.js 22.18 or later, pnpm, a Cloudflare account (Workers Paid recommended), a domain in that account and Cloudflare Zero Trust for admin sign-in.

```sh
git clone https://github.com/2fd/cloudflare-tokengate.git
cd cloudflare-tokengate
pnpm install
pnpm wrangler login
pnpm wrangler d1 create tokengate --location wnam   # or weur, eeur, apac, oc, enam
pnpm wrangler d1 create tokengate-telemetry --location wnam
pnpm run deploy
openssl rand -base64 32   # store this value in your vault first
pnpm wrangler secret put TOKENGATE_KEK
```

Then attach a custom domain, put `/admin` behind a Cloudflare Access application, set the operator variables, sign in as the first owner, add a caller provider and add a service. [docs/getting-started.md](docs/getting-started.md) shows each step.

### Run it locally

```sh
pnpm install
pnpm run setup   # creates .dev.vars (local key, PUBLIC_URL, AUTH_DEV_EMAIL) and the local databases
pnpm dev         # http://localhost:8787/admin, signed in as your git email
```

Details: [CONTRIBUTING.md](CONTRIBUTING.md#set-up).

### Call it from GitHub Actions

```yaml
on: workflow_dispatch
permissions:
  id-token: write
  contents: read
jobs:
  call:
    runs-on: ubuntu-latest
    steps:
      - id: tokengate
        uses: 2fd/cloudflare-tokengate/actions/get-token@main   # pin to a full commit SHA in production
        with:
          url: ${{ vars.TOKENGATE_URL }}
          audience: ${{ vars.TOKENGATE_AUDIENCE }}
      - env:
          TOKEN: ${{ steps.tokengate.outputs.token }}
          PROXY: ${{ steps.tokengate.outputs.proxy-base }}
        run: |
          curl -sS --fail-with-body "$PROXY/github/repos/$GITHUB_REPOSITORY" \
            -H "x-tokengate-token: $TOKEN"
```

The first run fails with `403 no_matching_grant`. Open the denied request in the admin UI, click "Create grant from this request", review and save. The next run succeeds. See [actions/get-token](actions/get-token/README.md) for the action's inputs and outputs.

## Security model

The full model, with the test that enforces each invariant, is in [docs/threat-model.md](docs/threat-model.md).

- The gateway trusts a token only after it verifies the signature, the exact issuer, the audience, the algorithm allowlist, the maximum age and the required claims ([I-JWT-1](docs/threat-model.md#i-jwt-1)).
- Shared issuers (`token.actions.githubusercontent.com`, `gitlab.com`) sign tokens for anyone. A caller provider for them must pin your tenant, for example your GitHub organization ID. Tokens outside the pin get `401` before the gateway reveals whether the service exists ([I-TEN-1](docs/threat-model.md#i-ten-1)).
- Access is denied by default. A request needs an enabled grant whose conditions and rules match ([I-AUTHZ-1](docs/threat-model.md#i-authz-1)). Every grant must pin identity claims exactly: the numeric organization and repository IDs, or an exact workflow pin, which follows repository names ([I-AUTHZ-2](docs/threat-model.md#i-authz-2), [policies](docs/policies.md#anchor-rules)). Events such as `pull_request_target` need an explicit opt-in ([I-AUTHZ-3](docs/threat-model.md#i-authz-3)).
- The caller token never reaches the upstream ([I-TOK-1](docs/threat-model.md#i-tok-1)). The credential never appears in gateway responses, logs, audit events, the UI or exports ([I-CRED-1](docs/threat-model.md#i-cred-1)).
- A credential only decrypts for the service, base URL and injection it was saved with ([I-CRED-2](docs/threat-model.md#i-cred-2)). Base URLs must be public `https` hosts, optionally limited to an owner-edited allowlist in Settings, checked at save time and on every request ([I-SSRF-1](docs/threat-model.md#i-ssrf-1)).
- Anyone who can deploy the Worker has full trust. Admins can let callers use a credential through grants, but cannot read it back. Losing the key-encryption key loses every stored credential. See [actors](docs/threat-model.md#actors) and [known limitations](docs/threat-model.md#known-limitations).

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Documentation

| Audience | Start here |
|---|---|
| Platform engineers deploying the gateway | [Getting started](docs/getting-started.md), [Configuration](docs/configuration.md), [Operations](docs/index.md#operate) |
| Workflow authors calling it from CI | [GitHub Actions](docs/callers/github-actions.md), [GitLab CI](docs/callers/gitlab-ci.md), [Errors](docs/errors.md) |
| Security reviewers | [Concepts](docs/concepts.md), [Policies](docs/policies.md), [Threat model](docs/threat-model.md) |
| Contributors | [Architecture](docs/architecture.md), [CONTRIBUTING.md](CONTRIBUTING.md), [ADRs](docs/adr/) |

The complete map is [docs/index.md](docs/index.md).

## Project status

Pre-1.0 (version 0.1.0). The configuration format, the database schema and the error codes can change between releases. Read the upgrade notes in [CHANGELOG.md](CHANGELOG.md) before you update.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
