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

2. Create the local configuration and the local databases:

   ```sh
   pnpm run setup
   ```

   It creates `.dev.vars` from `.dev.vars.example` (git-ignored, mode 600) with a new local
   `TOKENGATE_KEK`, `PUBLIC_URL=http://localhost:8787` and `AUTH_DEV_EMAIL` set to your
   `git config user.email` (override with `DEV_EMAIL=you@example.com pnpm run setup`). Then it applies
   both migrations to the local databases. An existing `.dev.vars` is never overwritten; to skip the
   migrations, run `pnpm run setup -- --no-migrate`. Write `pnpm run setup`: `pnpm setup` is a
   built-in pnpm command.

3. Start the Worker and open `http://localhost:8787/admin`:

   ```sh
   pnpm dev
   ```

`AUTH_DEV_EMAIL` is the local development login: every admin request is signed in as that email,
without Cloudflare Access. The gateway accepts it only while `PUBLIC_URL` is on `localhost`,
`127.0.0.1` or `[::1]`. On an empty local database, the first sign-in becomes the owner. To try
another user, change `AUTH_DEV_EMAIL` in `.dev.vars` and restart: that email joins with the join
defaults from Users > "New users". To test the real Access login, run the Worker behind a hostname
that an Access application protects. All variables are in [docs/configuration.md](docs/configuration.md).

Manual alternative to step 2: `cp .dev.vars.example .dev.vars`, put the output of
`pnpm keyring generate` in `TOKENGATE_KEK`, uncomment `PUBLIC_URL` and `AUTH_DEV_EMAIL`, then run
`pnpm db:migrate:local`.

You do not need a Cloudflare account or Cloudflare Access to run the tests: they sign Access tokens with a fake team key (`test/helpers/login-providers.ts`).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm check` | Everything CI runs on the code: `lint`, `typecheck`, `test`, `test:scripts`. Run it before you push. |
| `pnpm lint` | `biome check .`: lint, format check and import order. |
| `pnpm format` | `biome format --write .` |
| `pnpm typecheck` | `wrangler types --check`, then `tsc --noEmit` for `src/` and `test/`, then for `scripts/`. |
| `pnpm types` | Regenerates `worker-configuration.d.ts`. Run it after you change bindings in `wrangler.jsonc`. |
| `pnpm test` | Vitest inside workerd (`@cloudflare/vitest-plugin`) with local D1 databases. |
| `pnpm test:watch` | Vitest in watch mode. |
| `pnpm test:scripts` | Shell checks: `scripts/check-config.sh`, `scripts/check-threat-ids.sh`, `test/security/check-config-test.sh`, `test/security/get-token-action.sh`, `scripts/check-links.mjs`. |
| `pnpm run setup` | Creates `.dev.vars` for local development (never overwrites it) and applies the local migrations. `-- --no-migrate` skips the migrations. |
| `pnpm dev` | `wrangler dev` with `.dev.vars`. |
| `pnpm db:migrate:local` | Applies `migrations/` to `DB` and `migrations-telemetry/` to `TELEMETRY_DB`, locally. |
| `pnpm keyring generate` / `pnpm keyring check` | Generates a key, or validates a `TOKENGATE_KEK` or `TOKENGATE_KEYRING` value read from stdin. See [docs/operations/key-rotation.md](docs/operations/key-rotation.md). |
| `pnpm run deploy` | Applies both remote migrations, then `wrangler deploy`. Operators use it; contributors rarely need it. |

To run one file or one `describe`:

```sh
pnpm test test/unit/policy/glob.test.ts
pnpm test -t "I-TEN-1"
```

CI (`.github/workflows/ci.yml`) runs `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:scripts`, and zizmor on the workflow files. CodeQL, dependency review and OpenSSF Scorecard run in their own workflows.

## Tests

All Vitest tests run inside workerd. `test/helpers/apply-migrations.ts` applies both schemas before the tests, so tests use real D1.

| Directory | Contents |
| --- | --- |
| `test/unit/` | One module at a time. The tree follows `src/` (`test/unit/policy/glob.test.ts` tests `src/policy/glob.ts`). |
| `test/integration/` | The real app from `createApp()` (`src/app.ts`), driven over HTTP with injected dependencies. |
| `test/security/` | One threat-model invariant per `describe`, adversarial inputs, and the two shell tests. |
| `test/vectors/` | Language-neutral JSON tables (a `description` and arrays of cases) for claim conditions, globs, paths and the sealed credential format. |
| `test/helpers/` | Test issuer and JWKS (`jwt.ts`), test app (`app.ts`), proxy fixture with a fake upstream (`proxy-fixtures.ts`), signed-in admin browsers (`admin-auth.ts`), fake Cloudflare Access team (`login-providers.ts`). |
| `test/fixtures/admin-forms.ts` | A seeded admin "world" and one valid form submission per mutating admin route. |

Conventions:

- **Name invariants in `describe`.** A security test starts its `describe` name with the invariant ID: `describe('I-TEN-1: tenant pin is exact and fails closed', …)`. `scripts/check-threat-ids.sh` fails if any ID in [docs/threat-model.md](docs/threat-model.md) has no `describe` under `test/`.
- **Inject, do not mock.** Code with side effects takes `Deps` (`src/deps.ts`): `fetch`, `now`, `random`, `waitUntil`. Tests pass fakes. The suite has no `vi.mock` and no global `fetch` stub. `vi.spyOn(console, …)` only captures or silences log lines. Fake `Date` timers appear only where jose reads the system clock itself (`test/security/jwt.test.ts`, `test/unit/identity/jwt.test.ts`).
- **No network.** Issuer JWKS, Access certs and upstreams are served through the injected `fetch`.
- **Vectors are contracts.** Add a case when you find an edge case. Change an existing case only when you change the semantics on purpose, and say so in the PR and in CHANGELOG.md. `test/vectors/sealed.json` freezes sealed credential format v1: if it changes, stored credentials no longer open.
- **Shell tests run outside Vitest.** workerd cannot spawn `bash`, so `test/security/*.sh` run through `pnpm test:scripts`.
- **Tests that pin tables.** `test/unit/schema-head.test.ts`, `test/unit/admin/auth/rbac.test.ts`, `test/security/rbac-routes.test.ts` and `test/security/audit-coverage-routes.test.ts` fail when you add a migration, a route or a mutating route without updating the matching table. This is intended.

## Code style

Biome formats and lints (`biome.json`): 2-space indent, single quotes, semicolons, trailing commas, 100 columns. Lint rules to know:

- `noConsole`: only `console.error`, `console.warn` and `console.info` are allowed. Never log credentials, caller tokens or claim values outside the log allowlist ([I-LOG-1](docs/threat-model.md#i-log-1)).
- `noFloatingPromises`: background work goes through `deps.waitUntil`.
- `noDangerouslySetInnerHtml`: the admin UI renders server-side with `hono/jsx` and has no client-side JavaScript. The CSP (`src/http/security.ts`) sets `default-src 'none'` and no `script-src`, so the browser runs no script.

TypeScript is `strict` with `noUncheckedIndexedAccess`.

### Comments

Comments are concise and say what the code guarantees and why. They are part of the review.

- Each module starts with a short header, usually one to three lines: what the module does and which invariants it enforces, with IDs. Example from `src/proxy/inject.ts`:

  ```ts
  // Attaches the service credential to the outbound request headers (I-INJ-1) and lists the
  // encodings in which the credential could be echoed back, for response redaction (I-CRED-1).
  // `query` and `path` injection are applied to the URL by src/proxy/path.ts.
  ```

- Inline comments only for constraints that the code cannot show. If a comment encodes an external fact (platform behavior, RFC, upstream API quirk), add the source URL.
- No narration of what the next line does, no history ("changed from …"), no apologies or excuses, no `TODO` without an issue link.
- When code changes, update or delete its comments in the same commit.

## Security-sensitive code

[.github/CODEOWNERS](.github/CODEOWNERS) lists these paths explicitly. GitHub requests a review from the code owner (`@2fd`) on every PR that touches them:

| Path | Why |
| --- | --- |
| `src/crypto/` | Envelope encryption, keyring, AAD binding ([I-CRED-2](docs/threat-model.md#i-cred-2)). |
| `src/identity/` | JWT verification and profiles ([I-JWT-1](docs/threat-model.md#i-jwt-1), [I-JWT-2](docs/threat-model.md#i-jwt-2), [I-TEN-1](docs/threat-model.md#i-ten-1)). |
| `src/policy/` | Conditions, globs, rules, anchor claims, trusted events ([I-AUTHZ-1](docs/threat-model.md#i-authz-1) to [I-AUTHZ-4](docs/threat-model.md#i-authz-4)). |
| `src/proxy/` | The request pipeline, injection, header and response filtering ([I-TOK-1](docs/threat-model.md#i-tok-1), [I-INJ-1](docs/threat-model.md#i-inj-1), [I-RESP-1](docs/threat-model.md#i-resp-1), [I-SSRF-1](docs/threat-model.md#i-ssrf-1), …). |
| `src/admin/auth/` | Per-request Access identity, CSRF, RBAC, email linking, bootstrap ([I-SESS-1](docs/threat-model.md#i-sess-1), [I-CSRF-1](docs/threat-model.md#i-csrf-1), [I-LINK-1](docs/threat-model.md#i-link-1), [I-BOOT-1](docs/threat-model.md#i-boot-1), [I-RBAC-1](docs/threat-model.md#i-rbac-1)). |
| `src/http/` | Security headers and host pinning ([I-DEPLOY-1](docs/threat-model.md#i-deploy-1)). |
| `migrations/`, `migrations-telemetry/` | Schema, including SQL-enforced invariants. |
| `wrangler.jsonc` | Compatibility flags, `preview_urls`, `keep_vars` ([I-DEPLOY-1](docs/threat-model.md#i-deploy-1), [I-SSRF-1](docs/threat-model.md#i-ssrf-1)). |
| `.github/workflows/` | CI supply chain. |

A change in these paths needs:

1. A test that fails without the change. For a security property, put it under `test/security/` with the invariant ID in the `describe` name.
2. An update to [docs/threat-model.md](docs/threat-model.md) if an invariant, its enforcement point or a known limitation changes.
3. Fail-closed behavior: unknown, missing or unparsable input denies. Look at `getProfile` (`src/identity/profiles/index.ts`) and the `invalid` Injection kind in `src/db/rows.ts` for the pattern.

For GitHub Actions workflows: pin every `uses:` to a full commit SHA with a `# vX.Y.Z` comment, set `persist-credentials: false` on checkout, and give each job the least `permissions` it needs. zizmor runs in CI.

## How to add things

### A Profile (new CI platform)

A Profile is code-reviewed knowledge about one issuer type. Open an issue first.

1. Add the ID to `ProfileId` in `src/identity/types.ts`.
2. Create `src/identity/profiles/<id>.ts` that implements `IssuerProfile`: `id`, `label`, `defaults`, `eventClaim`, `trustedEvents`, `tenantClaims`, `sharedIssuers`, `anchorRules`, `verifyRequiredClaims`, `logClaimAllowlist`, `display`. Cite the platform's claim documentation in comments.
3. Register it in `PROFILES` in `src/identity/profiles/index.ts`.
4. Run `pnpm typecheck`. It lists every `Record<ProfileId, …>` table to fill, for example in `src/admin/routes/caller-providers.tsx`.
5. Update the profile-specific code that the type checker does not flag: `CI_ISSUER_HOSTS` and `grantWarnings` in `src/policy/validate.ts`, the error text in `src/admin/ops/caller-providers.ts`, `PROFILE_ORDER` in `src/admin/routes/caller-providers.tsx`, and `PREFILL_EXTRA_CLAIMS` in `src/admin/routes/grants.tsx`.
6. The `caller_providers.profile` column has a `CHECK` constraint with the allowed IDs (`migrations/0001_initial.sql`). SQLite cannot change a `CHECK` constraint in place, so this needs a migration that rebuilds the table. That is not additive (see [Migrations](#migrations)): agree on the approach in the issue and write an ADR.
7. Add tests in `test/unit/identity/profiles.test.ts` and security tests for the tenant pin and anchor claims.
8. Add `docs/callers/<platform>.md`, and update [docs/policies.md](docs/policies.md) and the profile entry in [docs/concepts.md](docs/concepts.md#profile).

### An injection kind

1. Add the variant to `Injection` in `src/policy/types.ts`.
2. Validate it in `src/policy/validate.ts`. The canonical JSON it produces is stored and bound into the credential AAD ([I-CRED-2](docs/threat-model.md#i-cred-2)).
3. Header kinds: handle it in `injectedHeaderName` and `injectCredentialHeaders` in `src/proxy/inject.ts`. URL kinds: handle it in `src/proxy/path.ts` and in the URL rewriting of `src/proxy/forward.ts`. All kinds: list the echo encodings in `secretVariants` in `src/proxy/inject.ts` ([I-CRED-1](docs/threat-model.md#i-cred-1), [I-RESP-1](docs/threat-model.md#i-resp-1)).
4. Check the Caller token fallback in `src/proxy/caller-token.ts`: a caller copy of the injected header or parameter must never reach the upstream ([I-INJ-1](docs/threat-model.md#i-inj-1)).
5. Add the form option, parsing and display in `src/admin/routes/services.tsx`.
6. Add unit tests (`test/unit/proxy/inject.test.ts`, path vectors in `test/vectors/paths.json` for URL kinds) and extend the [I-INJ-1](docs/threat-model.md#i-inj-1) and [I-CRED-1](docs/threat-model.md#i-cred-1) security tests.
7. Document it in the injection entry of [docs/concepts.md](docs/concepts.md#injection) and in the [I-RESP-1](docs/threat-model.md#i-resp-1) redaction list of [docs/threat-model.md](docs/threat-model.md). If an upstream uses it, update the matching `docs/upstreams/*.md` page.

### A Service template

1. Add an entry to `SERVICE_TEMPLATES` in `src/admin/service-templates.ts`. Keep `starter_rules` narrow.
2. Add the template ID to the pinned list in `test/unit/admin/ops/service-templates.test.ts`. The same file checks every template against the validation the form uses.
3. Add or update a page under `docs/upstreams/` with SDK base-URL snippets.

### An admin page or route

1. Create `src/admin/routes/<page>.tsx` with a `register…Routes(app)` function. Render with `renderPage` from `src/admin/render.tsx` and the components in `src/admin/views/components.tsx`. No client-side JavaScript.
2. Register it in `src/admin/routes/index.ts`.
3. Add every `METHOD /path` to `ROUTE_PERMISSIONS` in `src/admin/auth/rbac.ts`. The middleware denies any `/admin` route that is not in the table ([I-RBAC-1](docs/threat-model.md#i-rbac-1)). Update the pinned table in `test/unit/admin/auth/rbac.test.ts`.
4. A route that changes state is a `POST` with `mutates: true`. Its form includes `<Csrf token=… />` ([I-CSRF-1](docs/threat-model.md#i-csrf-1)). It calls an op in `src/admin/ops/` that commits through `commitAudited` (`src/admin/ops/shared.ts`): the change and exactly one audit row in one `db.batch` ([I-AUDIT-1](docs/threat-model.md#i-audit-1)).
5. Add a submission for each new mutating route to `MUTATION_FIXTURES` in `test/fixtures/admin-forms.ts`. Add an id to `readPath` in the same file for a new `GET` route with a parameter.
6. If the page needs a navigation entry, add it to `NAV` in `src/admin/views/layout.tsx`.
7. Never show secret material on any page: Viewers can read every page.

### A gateway error code

Error codes in `GATEWAY_ERRORS` (`src/lib/errors.ts`) are a public contract. Every error body links to `docs/errors.md#<code>`.

1. Do not rename or remove a code. If the meaning changes, add a new one.
2. Add the code, its HTTP status and its default message to `GATEWAY_ERRORS`.
3. Add a `## <code>` section to [docs/errors.md](docs/errors.md) in the same PR.
4. List the code in CHANGELOG.md.

## Migrations

`DB` uses `migrations/` and `TELEMETRY_DB` uses `migrations-telemetry/`. `pnpm run deploy` applies both before it deploys the code.

1. Never edit a released migration. Add a new numbered file:

   ```sh
   pnpm wrangler d1 migrations create DB <short_name>
   pnpm wrangler d1 migrations create TELEMETRY_DB <short_name>
   ```

2. Set the new file name in `SCHEMA_HEAD` in `src/generated/schema-head.ts`. `test/unit/schema-head.test.ts` fails until you do.
3. Make the migration additive: new tables, new columns that are nullable or have a default, new indexes. Do not drop, rename or retype anything that a released version reads.
4. List the migration under "Upgrade notes" in CHANGELOG.md.

Why additive: `wrangler rollback` restores old code but not the schema. The old code must keep working on the newer schema. The schema guard (`src/db/migrations.ts`) reports this state as `ahead`: `/readyz` stays ready and the dashboard shows a banner. A schema that is `behind` makes `/readyz` fail. Operator steps are in [docs/operations/upgrades.md](docs/operations/upgrades.md).

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
3. Set `"version"` in `package.json` to `X.Y.Z`.
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
