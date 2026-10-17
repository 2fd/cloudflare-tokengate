# Contributing to cloudflare-tokengate

This page explains how to set up, test and change the code, and how changes get reviewed and released. It is for contributors.

Read [docs/architecture.md](docs/architecture.md) for the module map and [docs/threat-model.md](docs/threat-model.md) for the invariants (`I-…` IDs) that the code and the tests enforce.

- To report a vulnerability, do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- For a new feature or a design change, open an issue before you write code. Check [docs/roadmap.md](docs/roadmap.md) first: it lists non-goals.

## Set up

Prerequisites:

- Node.js 22.18 or later (`engines` in `package.json`; `pnpm keyring` needs its TypeScript type stripping). CI uses Node 24.
- pnpm, at the version in `packageManager` (`package.json`). On Node 22 and 24, `corepack enable` installs it. Other options: [pnpm installation](https://pnpm.io/installation).
- `bash` and `jq`, for `pnpm test:scripts`.

Steps:

1. Clone the repository and install dependencies:

   ```sh
   git clone https://github.com/2fd/cloudflare-tokengate.git
   cd cloudflare-tokengate
   pnpm install
   ```

2. Create the local configuration:

   ```sh
   pnpm run setup
   ```

   It copies `apps/gateway/.dev.vars.example` to `apps/gateway/.dev.vars` (git-ignored),
   overwriting an existing `apps/gateway/.dev.vars`. Then it deletes the local databases
   (`apps/gateway/.wrangler/state/v3/d1`) and creates new ones with every migration applied. Run
   it again whenever you want a clean local state.
   Write `pnpm run setup`: `pnpm setup` is a built-in pnpm command. The copy works as is: it sets
   the public development key in `TOKENGATE_KEK` and `AUTH_ACCESS_DEVELOPMENT=dev@example.com`. You do
   not need to edit it.

3. Start the Worker and open `http://localhost:8787/admin`:

   ```sh
   pnpm dev
   ```

   The same server has the design system docs at `http://localhost:8787/docs`. `pnpm dev` runs
   `apps/gateway/src/dev.ts`, which serves `/docs` on `localhost`, `127.0.0.1` and `[::1]` only.
   Deploys never include the docs ([I-DEPLOY-2](docs/threat-model.md#i-deploy-2)).

`AUTH_ACCESS_DEVELOPMENT` is the local development login: every admin request is signed in as that
email, without Cloudflare Access. The gateway accepts it only on requests to `localhost`, `127.0.0.1`
or `[::1]`. On an empty local database, the first sign-in becomes the owner, and its hostname
(`localhost`) becomes the admin host in the local database. To try another user, change
`AUTH_ACCESS_DEVELOPMENT` in `apps/gateway/.dev.vars` and restart: that email joins with the join
defaults from Users > "New users".

The keyring is bound to the `AUTH_ACCESS_*` values
([I-CRED-3](docs/threat-model.md#i-cred-3)). When you change `AUTH_ACCESS_DEVELOPMENT`, the
credentials stored in the local database no longer open: enter them again, or change the value back.

To test the real Access login, run the Worker behind a hostname that an Access application protects.
Set `AUTH_ACCESS_TEAM_DOMAIN` and `AUTH_ACCESS_AUD`, delete `AUTH_ACCESS_DEVELOPMENT`, and replace
`TOKENGATE_KEK` with a key from `pnpm keyring generate`. With an Access variable set, the gateway
refuses the development key (`dev_placeholder_key`), and with both logins set, no login works. All
variables are in [docs/configuration.md](docs/configuration.md).

You do not need a Cloudflare account or Cloudflare Access to run the tests: they sign Access tokens with a fake team key (`apps/gateway/test/helpers/login-providers.ts`).

## Repository layout

The repository is a [pnpm workspace](https://pnpm.io/workspaces) (`pnpm-workspace.yaml`):
deployable Workers live in `apps/`, shared libraries in `packages/`. Run every command in this
page from the repository root; the root `package.json` scripts delegate to the packages.

```text
apps/
  gateway/                 @tokengate/gateway: the Worker (proxy, admin UI, cron, queue consumer).
    src/                   Worker code. Module map: docs/architecture.md. src/index.ts is the
                           deployed entry; src/dev.ts (`pnpm dev`) adds /docs on localhost.
    test/                  Vitest suites (unit, integration, security), vectors, helpers.
    migrations/            DB (control plane) migrations.
    migrations-telemetry/  TELEMETRY_DB migrations.
    public/                Static assets (/static/*).
    scripts/               Worker scripts: keyring, config guardrails, archive setup.
    wrangler.jsonc         Worker configuration.
    .dev.vars.example      Local variables; `pnpm run setup` copies it to .dev.vars.
packages/
  ui/                      @tokengate/ui: design system D. src/styles/ui.css and Hono JSX
                           components (no client JS). Conventions: packages/ui/README.md.
  docs/                    @tokengate/docs: the design system docs, a Hono app for /docs. Not a
                           Worker: the gateway serves it in local development only (I-DEPLOY-2).
                           Pages come from src/registry.
actions/get-token/         Composite GitHub Action for callers, and its shell test.
pipelines/                 Request archive stream schema.
docs/                      Operator and contributor documentation, ADRs, diagrams.
scripts/                   Repository checks: links, threat-model IDs.
```

- Linting and formatting (`oxlint`, `oxfmt`) run once over the whole repository from the root.
  `typecheck`, `test` and `types` run in every package that defines them (`pnpm -r`).
- Local state belongs to the package: `apps/gateway/.dev.vars` and `apps/gateway/.wrangler/`.
- `pnpm wrangler <args>` runs the gateway's Wrangler inside `apps/gateway`, so relative paths in
  its arguments (for example `--file`) resolve from there.
- To run a script of one package only: `pnpm --filter @tokengate/gateway <script>`, or run it in
  the package directory.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm check` | Everything CI runs on the code: `lint`, `typecheck`, `test`, `test:scripts`. Run it before you push. |
| `pnpm lint` | `oxlint` (type-aware), then `oxfmt --check .` (format and import order). |
| `pnpm format` | `oxfmt .` |
| `pnpm typecheck` | In `apps/gateway`: `wrangler types --check`, then `tsc --noEmit` for `src/` and `test/`, then for `scripts/`. In `packages/ui` and `packages/docs`: `tsc --noEmit`. |
| `pnpm types` | Regenerates `apps/gateway/worker-configuration.d.ts`. Run it after you change bindings or module rules in `apps/gateway/wrangler.jsonc`. |
| `pnpm test` | In `apps/gateway`: Vitest inside workerd (`@cloudflare/vitest-plugin`) with local D1 databases. In `packages/ui` and `packages/docs`: Vitest in Node (components render to strings; docs routes through `app.request()`). |
| `pnpm test:watch` | Vitest in watch mode. |
| `pnpm test:scripts` | Shell checks: `scripts/check-threat-ids.sh`, `actions/get-token/test.sh`, `scripts/check-links.mjs`, then `apps/gateway/scripts/check-config.sh`, `apps/gateway/test/security/check-config-test.sh` and `apps/gateway/scripts/check-bundle.sh` (builds the production and dev bundles with `wrangler deploy --dry-run` and fails if the production one contains the docs). |
| `pnpm run setup` | Copies `apps/gateway/.dev.vars.example` to `apps/gateway/.dev.vars` (overwriting it), deletes the local D1 databases and recreates them with every migration applied. |
| `pnpm dev` | `wrangler dev src/dev.ts` in `apps/gateway`, with `apps/gateway/.dev.vars`, on http://localhost:8787. It is the production Worker plus the design system docs at http://localhost:8787/docs (loopback hostnames only). It does not fetch the real `Request.cf` object: requests get Miniflare's placeholder (colo `DFW`). |
| `pnpm db:migrate:local` | Applies `apps/gateway/migrations/` to `DB` and `apps/gateway/migrations-telemetry/` to `TELEMETRY_DB`, locally. |
| `pnpm keyring generate` / `pnpm keyring check` | Generates a key, or validates a `TOKENGATE_KEK` or `TOKENGATE_KEYRING` value read from stdin. See [docs/operations/key-rotation.md](docs/operations/key-rotation.md). |
| `pnpm run deploy` | Applies both remote migrations, then `wrangler deploy` with `wrangler.jsonc` `main` (`src/index.ts`), which has no `/docs` (404 in production). Operators use it; contributors rarely need it. |
| `pnpm wrangler <args>` | Wrangler in `apps/gateway`, for example `pnpm wrangler secret put TOKENGATE_KEK`. |

To run one file or one `describe`:

```sh
pnpm test test/unit/policy/glob.test.ts   # file filters are relative to apps/gateway
pnpm test -t "I-TEN-1"
```

CI (`.github/workflows/ci.yml`) runs `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:scripts`, and zizmor on the workflow files. CodeQL, dependency review and OpenSSF Scorecard run in their own workflows.

## Tests

All Vitest tests run inside workerd. `apps/gateway/test/helpers/apply-migrations.ts` applies both schemas before the tests, so tests use real D1.

| Directory | Contents |
| --- | --- |
| `apps/gateway/test/unit/` | One module at a time. The tree follows `apps/gateway/src/` (`apps/gateway/test/unit/policy/glob.test.ts` tests `apps/gateway/src/policy/glob.ts`). |
| `apps/gateway/test/integration/` | The real app from `createApp()` (`apps/gateway/src/app.ts`), driven over HTTP with injected dependencies. |
| `apps/gateway/test/security/` | One threat-model invariant per `describe`, adversarial inputs, and the config guardrails shell test. |
| `apps/gateway/test/vectors/` | Language-neutral JSON tables (a `description` and arrays of cases) for claim conditions, globs, paths and the sealed credential format. |
| `apps/gateway/test/helpers/` | Test issuer and JWKS (`jwt.ts`), test app (`app.ts`), proxy fixture with a fake upstream (`proxy-fixtures.ts`), signed-in admin browsers (`admin-auth.ts`), fake Cloudflare Access team (`login-providers.ts`). |
| `apps/gateway/test/fixtures/admin-forms.ts` | A seeded admin "world" and one valid form submission per mutating admin route. |

Conventions:

- **Name invariants in `describe`.** A security test starts its `describe` name with the invariant ID: `describe('I-TEN-1: tenant pin is exact and fails closed', …)`. `scripts/check-threat-ids.sh` fails if any ID in [docs/threat-model.md](docs/threat-model.md) has no `describe` under `apps/gateway/test/`.
- **Inject, do not mock.** Code with side effects takes `Deps` (`apps/gateway/src/deps.ts`): `fetch`, `now`, `random`, `waitUntil`. Tests pass fakes. The suite has no `vi.mock` and no global `fetch` stub. `vi.spyOn(console, …)` only captures or silences log lines. Fake `Date` timers appear only where jose reads the system clock itself (`apps/gateway/test/security/jwt.test.ts`, `apps/gateway/test/unit/identity/jwt.test.ts`).
- **No network.** Issuer JWKS, Access certs and upstreams are served through the injected `fetch`.
- **Vectors are contracts.** Add a case when you find an edge case. Change an existing case only when you change the semantics on purpose, and say so in the PR and in CHANGELOG.md. `apps/gateway/test/vectors/sealed.json` freezes sealed credential format v1: if it changes, stored credentials no longer open.
- **Shell tests run outside Vitest.** workerd cannot spawn `bash`, so `apps/gateway/test/security/check-config-test.sh` and `actions/get-token/test.sh` run through `pnpm test:scripts`.
- **Tests that pin tables.** `apps/gateway/test/unit/schema-head.test.ts`, `apps/gateway/test/unit/admin/auth/rbac.test.ts`, `apps/gateway/test/security/rbac-routes.test.ts` and `apps/gateway/test/security/audit-coverage-routes.test.ts` fail when you add a migration, a route or a mutating route without updating the matching table. This is intended.

## Code style

Oxfmt formats (`.oxfmtrc.json`): 2-space indent, single quotes, semicolons, trailing commas (none in JSON), 100 columns, sorted imports. Oxlint lints (`.oxlintrc.json`) with type information (`oxlint-tsgolint`). Lint rules to know:

- `no-console`: only `console.error`, `console.warn` and `console.info` are allowed. Never log credentials, caller tokens or claim values outside the log allowlist ([I-LOG-1](docs/threat-model.md#i-log-1)).
- `no-floating-promises`: background work goes through `deps.waitUntil`.
- `react/no-danger`: the admin UI renders server-side with `hono/jsx` and has no client-side JavaScript. The CSP (`apps/gateway/src/http/security.ts`) sets `default-src 'none'` and no `script-src`, so the browser runs no script.

TypeScript is `strict` with `noUncheckedIndexedAccess`.

### Comments

Comments are concise and say what the code guarantees and why. They are part of the review.

- Each module starts with a short header, usually one to three lines: what the module does and which invariants it enforces, with IDs. Example from `apps/gateway/src/proxy/inject.ts`:

  ```ts
  // Attaches the service credential to the outbound request headers (I-INJ-1) and lists the
  // encodings in which the credential could be echoed back, for response redaction (I-CRED-1).
  // `query` and `path` injection are applied to the URL by apps/gateway/src/proxy/path.ts.
  ```

- Inline comments only for constraints that the code cannot show. If a comment encodes an external fact (platform behavior, RFC, upstream API quirk), add the source URL.
- No narration of what the next line does, no history ("changed from …"), no apologies or excuses, no `TODO` without an issue link.
- When code changes, update or delete its comments in the same commit.

## Security-sensitive code

[.github/CODEOWNERS](.github/CODEOWNERS) lists these paths explicitly. GitHub requests a review from the code owner (`@2fd`) on every PR that touches them:

| Path | Why |
| --- | --- |
| `apps/gateway/src/crypto/` | Envelope encryption, keyring, AAD binding ([I-CRED-2](docs/threat-model.md#i-cred-2)). |
| `apps/gateway/src/identity/` | JWT verification and profiles ([I-JWT-1](docs/threat-model.md#i-jwt-1), [I-JWT-2](docs/threat-model.md#i-jwt-2), [I-TEN-1](docs/threat-model.md#i-ten-1)). |
| `apps/gateway/src/policy/` | Conditions, globs, rules, anchor claims, trusted events ([I-AUTHZ-1](docs/threat-model.md#i-authz-1) to [I-AUTHZ-4](docs/threat-model.md#i-authz-4)). |
| `apps/gateway/src/proxy/` | The request pipeline, injection, header and response filtering ([I-TOK-1](docs/threat-model.md#i-tok-1), [I-INJ-1](docs/threat-model.md#i-inj-1), [I-RESP-1](docs/threat-model.md#i-resp-1), [I-SSRF-1](docs/threat-model.md#i-ssrf-1), …). |
| `apps/gateway/src/admin/auth/` | Per-request Access identity, CSRF, RBAC, email linking, bootstrap ([I-SESS-1](docs/threat-model.md#i-sess-1), [I-CSRF-1](docs/threat-model.md#i-csrf-1), [I-LINK-1](docs/threat-model.md#i-link-1), [I-BOOT-1](docs/threat-model.md#i-boot-1), [I-RBAC-1](docs/threat-model.md#i-rbac-1)). |
| `apps/gateway/src/http/` | Security headers and host pinning ([I-DEPLOY-1](docs/threat-model.md#i-deploy-1)). |
| `apps/gateway/migrations/`, `apps/gateway/migrations-telemetry/` | Schema, including SQL-enforced invariants. |
| `apps/gateway/wrangler.jsonc` | `main`, compatibility flags, `preview_urls`, `keep_vars` ([I-DEPLOY-1](docs/threat-model.md#i-deploy-1), [I-DEPLOY-2](docs/threat-model.md#i-deploy-2), [I-SSRF-1](docs/threat-model.md#i-ssrf-1)). |
| `apps/gateway/src/dev.ts` | The local entry that adds the dev-only docs on loopback hostnames ([I-DEPLOY-2](docs/threat-model.md#i-deploy-2)). |
| `.github/workflows/` | CI supply chain. |

A change in these paths needs:

1. A test that fails without the change. For a security property, put it under `apps/gateway/test/security/` with the invariant ID in the `describe` name.
2. An update to [docs/threat-model.md](docs/threat-model.md) if an invariant, its enforcement point or a known limitation changes.
3. Fail-closed behavior: unknown, missing or unparsable input denies. Look at `getProfile` (`apps/gateway/src/identity/profiles/index.ts`) and the `invalid` Injection kind in `apps/gateway/src/db/rows.ts` for the pattern.

For GitHub Actions workflows: pin every `uses:` to a full commit SHA with a `# vX.Y.Z` comment, set `persist-credentials: false` on checkout, and give each job the least `permissions` it needs. zizmor runs in CI.

## How to add things

### A Profile (new CI platform)

A Profile is code-reviewed knowledge about one issuer type. Open an issue first.

1. Add the ID to `ProfileId` in `apps/gateway/src/identity/types.ts`.
2. Create `apps/gateway/src/identity/profiles/<id>.ts` that implements `IssuerProfile`: `id`, `label`, `defaults`, `eventClaim`, `trustedEvents`, `tenantClaims`, `sharedIssuers`, `anchorRules`, `verifyRequiredClaims`, `logClaimAllowlist`, `display`. Cite the platform's claim documentation in comments.
3. Register it in `PROFILES` in `apps/gateway/src/identity/profiles/index.ts`.
4. Run `pnpm typecheck`. It lists every `Record<ProfileId, …>` table to fill, for example in `apps/gateway/src/admin/routes/consumers.tsx`.
5. Update the profile-specific code that the type checker does not flag: `CI_ISSUER_HOSTS` and `grantWarnings` in `apps/gateway/src/policy/validate.ts`, the error text in `apps/gateway/src/admin/ops/caller-providers.ts`, `PROFILE_ORDER` in `apps/gateway/src/admin/routes/consumers.tsx`, and `PREFILL_EXTRA_CLAIMS` in `apps/gateway/src/admin/routes/access.tsx`.
6. The `caller_providers.profile` column has a `CHECK` constraint with the allowed IDs (`apps/gateway/migrations/0001_initial.sql`). SQLite cannot change a `CHECK` constraint in place, so this needs a migration that rebuilds the table. That is not additive (see [Migrations](#migrations)): agree on the approach in the issue and write an ADR.
7. Add tests in `apps/gateway/test/unit/identity/profiles.test.ts` and security tests for the tenant pin and anchor claims.
8. Add `docs/callers/<platform>.md`, and update [docs/policies.md](docs/policies.md) and the profile entry in [docs/concepts.md](docs/concepts.md#profile).

### An injection kind

1. Add the variant to `Injection` in `apps/gateway/src/policy/types.ts`.
2. Validate it in `apps/gateway/src/policy/validate.ts`. The canonical JSON it produces is stored and bound into the credential AAD ([I-CRED-2](docs/threat-model.md#i-cred-2)).
3. Header kinds: handle it in `injectedHeaderName` and `injectCredentialHeaders` in `apps/gateway/src/proxy/inject.ts`. URL kinds: handle it in `apps/gateway/src/proxy/path.ts` and in the URL rewriting of `apps/gateway/src/proxy/forward.ts`. All kinds: list the echo encodings in `secretVariants` in `apps/gateway/src/proxy/inject.ts` ([I-CRED-1](docs/threat-model.md#i-cred-1), [I-RESP-1](docs/threat-model.md#i-resp-1)).
4. Check the Caller token fallback in `apps/gateway/src/proxy/caller-token.ts`: a caller copy of the injected header or parameter must never reach the upstream ([I-INJ-1](docs/threat-model.md#i-inj-1)).
5. Add the form option, parsing and display in `apps/gateway/src/admin/routes/tokens.tsx`.
6. Add unit tests (`apps/gateway/test/unit/proxy/inject.test.ts`, path vectors in `apps/gateway/test/vectors/paths.json` for URL kinds) and extend the [I-INJ-1](docs/threat-model.md#i-inj-1) and [I-CRED-1](docs/threat-model.md#i-cred-1) security tests.
7. Document it in the injection entry of [docs/concepts.md](docs/concepts.md#injection) and in the [I-RESP-1](docs/threat-model.md#i-resp-1) redaction list of [docs/threat-model.md](docs/threat-model.md). If an upstream uses it, update the matching `docs/upstreams/*.md` page.

### A Service template

1. Add an entry to `SERVICE_TEMPLATES` in `apps/gateway/src/admin/service-templates.ts`. Keep its `operation_presets` narrow: each is a named set of rules that consumer access offers as a checkbox, and `{repo}` in a path stands for the repository.
2. Add the template ID to the pinned list in `apps/gateway/test/unit/admin/ops/service-templates.test.ts`. The same file checks every template against the validation the form uses.
3. Add or update a page under `docs/upstreams/` with SDK base-URL snippets.

### An admin page or route

1. Create `apps/gateway/src/admin/routes/<page>.tsx` with a `register…Routes(app)` function. Render with `renderPage` from `apps/gateway/src/admin/render.tsx` and the components in `apps/gateway/src/admin/views/components.tsx`. No client-side JavaScript.
2. Register it in `apps/gateway/src/admin/routes/index.ts`.
3. Add every `METHOD /path` to `ROUTE_PERMISSIONS` in `apps/gateway/src/admin/auth/rbac.ts`. The middleware denies any `/admin` route that is not in the table ([I-RBAC-1](docs/threat-model.md#i-rbac-1)). Put it in the block of its section (`// == monitoring ==`, `// == users ==`, `// == tokens ==`, `// == consumers ==` or `// == global ==`), and add a field permission when a form field needs more than the route permission. Update the pinned table in `apps/gateway/test/unit/admin/auth/rbac.test.ts`.
4. A route that changes state is a `POST` with `mutates: true`. Its form includes `<Csrf token=… />` ([I-CSRF-1](docs/threat-model.md#i-csrf-1)). It calls an op in `apps/gateway/src/admin/ops/` that commits through `commitAudited` (`apps/gateway/src/admin/ops/shared.ts`): the change and exactly one audit row in one `db.batch` ([I-AUDIT-1](docs/threat-model.md#i-audit-1)).
5. Add a submission for each new mutating route to `MUTATION_FIXTURES` in `apps/gateway/test/fixtures/admin-forms.ts`. Add an id to the section map of `readPath` in the same file for a new `GET` route with a parameter.
6. If the page needs a navigation entry, add a tab to its section in `SECTIONS` in `apps/gateway/src/admin/views/layout.tsx`, and a path to `apps/gateway/src/admin/paths.ts`.
7. Never show secret material on any page: Viewers can read every page.

### A gateway error code

Error codes in `GATEWAY_ERRORS` (`apps/gateway/src/lib/errors.ts`) are a public contract. Every error body links to `docs/errors.md#<code>`.

1. Do not rename or remove a code. If the meaning changes, add a new one.
2. Add the code, its HTTP status and its default message to `GATEWAY_ERRORS`.
3. Add a `## <code>` section to [docs/errors.md](docs/errors.md) in the same PR.
4. List the code in CHANGELOG.md.

## Migrations

`DB` uses `apps/gateway/migrations/` and `TELEMETRY_DB` uses `apps/gateway/migrations-telemetry/`. `pnpm run deploy` applies both before it deploys the code.

1. Never edit a released migration. Add a new numbered file:

   ```sh
   pnpm wrangler d1 migrations create DB <short_name>
   pnpm wrangler d1 migrations create TELEMETRY_DB <short_name>
   ```

2. Set the new file name in `SCHEMA_HEAD` in `apps/gateway/src/generated/schema-head.ts`. `apps/gateway/test/unit/schema-head.test.ts` fails until you do.
3. Make the migration additive: new tables, new columns that are nullable or have a default, new indexes. Do not drop, rename or retype anything that a released version reads.
4. List the migration under "Upgrade notes" in CHANGELOG.md.

Why additive: `wrangler rollback` restores old code but not the schema. The old code must keep working on the newer schema. The schema guard (`apps/gateway/src/db/migrations.ts`) reports this state as `ahead`: `/readyz` stays ready and the dashboard shows a banner. A schema that is `behind` makes `/readyz` fail. Operator steps are in [docs/operations/upgrades.md](docs/operations/upgrades.md).

If a change cannot be additive, open an issue first, write an ADR, and give exact operator steps in the Upgrade notes.

## Architecture decisions

A design change needs an ADR in [docs/adr/](docs/adr/). Examples: a new trust assumption, a new storage or binding, a change to the sealed credential format, the policy model or the login model, or a new dependency on the request path.

1. Copy the format of [docs/adr/0001-record-architecture-decisions.md](docs/adr/0001-record-architecture-decisions.md): Status, Context, Decision, Consequences.
2. Use the next free number: `docs/adr/NNNN-short-title.md`.
3. Set the status to `Proposed` in the PR. Change it to `Accepted` when the PR merges.
4. Add a row to the table in [docs/adr/README.md](docs/adr/README.md).
5. Do not rewrite an accepted ADR. Write a new one and set the old one's status to `Superseded by NNNN`.

## Documentation

Documentation is reviewed like code, and a passing test suite does not replace it.

- A change to behavior, configuration, an error code, a UI label or an invariant updates the docs in the same PR.
- Every fact in the docs must be true of the current code. Write short sentences in the active voice, use the glossary terms in [docs/concepts.md](docs/concepts.md) exactly, and link every security claim to its invariant ID in [docs/threat-model.md](docs/threat-model.md).
- A change to something a diagram shows updates its specification in [docs/diagrams/src/](docs/diagrams/src/) and the rendered SVG ([docs/diagrams/README.md](docs/diagrams/README.md)).
- `pnpm` and `pnpm wrangler` only in examples. Placeholders for secrets (`<your-kek>`, `xoxb-REDACTED`), never real values.

## Dependencies

- Add a runtime dependency only when it is necessary. The Worker has two: `hono` and `jose`.
- `pnpm-workspace.yaml` allows install scripts only for `esbuild` and `workerd`. A new dependency that needs an install script must be justified in the PR.
- Dependency review fails a PR on a moderate or higher advisory, or on a license outside the allow list in `.github/workflows/dependency-review.yml`.
- Dependabot opens weekly update PRs for npm and GitHub Actions.

## Pull requests

1. Branch from `main`. Keep each PR to one change.
2. Fill in the checklist in [.github/pull_request_template.md](.github/pull_request_template.md).
3. Run `pnpm check`.
4. Add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for any change that users or operators can see.
5. Sign off every commit (see below).

### Developer Certificate of Origin

Every commit needs a `Signed-off-by` trailer. With it, you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/): you have the right to submit the change under the project license (Apache-2.0, [LICENSE](LICENSE)).

```sh
git commit -s -m "policy: reject empty glob values"
```

If you forgot the sign-off, add it to every commit on your branch:

```sh
git rebase --signoff main
git push --force-with-lease
```

## Release process

The project follows [Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version can contain breaking changes; the Upgrade notes in CHANGELOG.md list them. Releases are made by maintainers.

1. Confirm that CI passes on `main`.
2. In CHANGELOG.md, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add a new empty `## [Unreleased]`, and update the links at the end of the file.
3. Set `"version"` in `apps/gateway/package.json` to `X.Y.Z` (the admin UI shows it).
4. Open a PR with these two changes and merge it.
5. Tag the merge commit and push the tag:

   ```sh
   git tag -s vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

6. Create the GitHub release from the tag. Use the CHANGELOG section as the release notes:

   ```sh
   gh release create vX.Y.Z --title vX.Y.Z --notes-file <notes-file>
   ```

Operators upgrade by pulling the release into their clone. Workflows reference the composite action at a tag or commit SHA (`2fd/cloudflare-tokengate/actions/get-token@<sha>`); see [actions/get-token/README.md](actions/get-token/README.md).
