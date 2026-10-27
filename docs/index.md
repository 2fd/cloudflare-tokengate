# Documentation

This page maps the tokengate documentation by audience. Start with the section that matches your role. The terms used everywhere are defined in [concepts.md](concepts.md).

## Deploy

For platform engineers who deploy and configure the gateway.

| Page | Covers |
|---|---|
| [getting-started.md](getting-started.md) | First deployment on a custom domain, Cloudflare Access for the admin UI, Deploy button, first grant |
| [configuration.md](configuration.md) | Every variable, secret and binding, admin sign-in, settings and their limits, `wrangler.jsonc` notes |
| [concepts.md](concepts.md) | Glossary and how the parts relate |

## Operate

For platform engineers who run the gateway day to day.

| Page | Covers |
|---|---|
| [observability.md](observability.md) | Request log, rollups, dashboard banners, `/healthz` and `/readyz`, audit log for SIEM, R2 archive, costs |
| [operations/cost.md](operations/cost.md) | Monthly Cloudflare cost at 1, 10 and 100 requests per second, and the settings that change it |
| [operations/troubleshooting.md](operations/troubleshooting.md) | Symptom, cause and fix for common problems |
| [operations/key-rotation.md](operations/key-rotation.md) | Rotate the key-encryption key with a keyring |
| [operations/credential-rotation.md](operations/credential-rotation.md) | Replace an upstream credential without downtime |
| [operations/incident-response.md](operations/incident-response.md) | Compromised repository, workflow or credential |
| [operations/backup-restore.md](operations/backup-restore.md) | D1 Time Travel, configuration export, restore |
| [operations/upgrades.md](operations/upgrades.md) | Pull new releases into your copy, migrations, rollback |
| [operations/cloudflare-zone-settings.md](operations/cloudflare-zone-settings.md) | Bot Fight Mode, WAF skip rules, Access, custom domain, workers.dev |
| [operations/break-glass.md](operations/break-glass.md) | Recover from an owner lockout |

## Call the gateway

For workflow authors who call upstream APIs from CI.

| Page | Covers |
|---|---|
| [callers/github-actions.md](callers/github-actions.md) | The `get-token` action, audiences, claims, branch/tag/release/PR/environment examples, long jobs |
| [callers/gitlab-ci.md](callers/gitlab-ci.md) | `id_tokens`, claims, pipeline sources, examples |
| [callers/vercel.md](callers/vercel.md) | `getVercelOidcToken`, team and global issuer modes, environments |
| [callers/generic-oidc.md](callers/generic-oidc.md) | Any other OIDC issuer: anchor claims, tenant pin |
| [upstreams/slack.md](upstreams/slack.md) | Slack Web API through the gateway |
| [upstreams/openai.md](upstreams/openai.md) | OpenAI API and SDK base URLs |
| [upstreams/anthropic.md](upstreams/anthropic.md) | Anthropic API and SDK base URLs |
| [upstreams/github.md](upstreams/github.md) | GitHub REST API and release uploads |
| [upstreams/webhooks.md](upstreams/webhooks.md) | Slack and Discord incoming webhooks |
| [errors.md](errors.md) | Every gateway error code and request-record reason |
| [../actions/get-token/README.md](../actions/get-token/README.md) | Reference for the composite action |

## Review security

For security reviewers who need to know what the gateway trusts and why.

| Page | Covers |
|---|---|
| [concepts.md](concepts.md) | The trust objects: credential access rule, tenant pin, grant, anchor claims, trusted events |
| [policies.md](policies.md) | Condition and rule semantics, GitHub presets, warnings, pitfalls |
| [threat-model.md](threat-model.md) | Assets, actors, trust boundaries, invariants with their tests, known limitations |
| [architecture.md](architecture.md) | Request pipeline, data model, module map |
| [adr/](adr/) | Architecture decision records |
| [../SECURITY.md](../SECURITY.md) | Reporting vulnerabilities, operator hardening checklist |

## Contribute

For contributors who change the code or the docs.

| Page | Covers |
|---|---|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Setup, `pnpm check`, tests, comment style, security-sensitive paths, releases |
| [architecture.md](architecture.md) | Components, module map and the invariants each module enforces |
| [adr/](adr/) | Why the design is the way it is; new decisions need an ADR |
| [diagrams/](diagrams/README.md) | Diagram sources and how to change a diagram |
| [roadmap.md](roadmap.md) | Non-goals and future work |
| [../CHANGELOG.md](../CHANGELOG.md) | Changes and upgrade notes per release |
