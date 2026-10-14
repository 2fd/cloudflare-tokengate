# Upgrades

This page explains how to bring a new release into your deployment, how database migrations are
handled, and what a rollback can and cannot undo. It is for platform engineers who operate a
deployment.

Your deployment runs from your own clone (or the copy the Deploy button created), not from a fork.
GitHub does not offer upstream updates for it, so you pull releases yourself.

## Before you upgrade

1. Read the release's "Upgrade notes" in [CHANGELOG.md](../../CHANGELOG.md). Before 1.0.0, a minor
   version can contain breaking changes; they are listed there.
2. Check that `/readyz` returns `200` and the dashboard shows no error banner. Fix problems first, so
   you can tell them apart from upgrade problems.
3. Note the current Worker version, for a rollback: `pnpm wrangler deployments list`.
4. Take a backup of `DB` if the release has a migration:
   `pnpm wrangler d1 export tokengate --remote --output tokengate-pre-upgrade.sql`
   ([backup and restore](backup-restore.md)).

## Pull the release into your clone

1. Add the upstream repository once:

   ```sh
   git remote add upstream https://github.com/2fd/cloudflare-tokengate.git
   ```

2. Fetch releases:

   ```sh
   git fetch upstream --tags
   ```

3. Merge the release tag (for example `v0.2.0`). Release tags are signed; check the signature with
   `git tag -v v0.2.0` if you have the maintainers' key.

   ```sh
   git merge v0.2.0
   ```

   If git refuses because the histories are unrelated (a copy made by the Deploy button can lack the
   upstream history), merge once with `git merge --allow-unrelated-histories v0.2.0` and take the
   upstream version of every file except your own changes.
4. Resolve conflicts in `wrangler.jsonc`. Keep your additions (`routes`, `workers_dev`, optional
   bindings, `database_name`) and keep upstream's values for everything else. `keep_vars` must stay
   `true` and no variable may be blank: `scripts/check-config.sh` fails otherwise
   ([I-DEPLOY-1](../threat-model.md#i-deploy-1)).
5. Install dependencies: `pnpm install --frozen-lockfile`.
6. Run the checks: `pnpm check` (lint, typecheck, tests, `scripts/check-config.sh` and the threat-model
   coverage check).

## Deploy

1. Run `pnpm run deploy`. It runs, in this order:
   1. `wrangler d1 migrations apply DB --remote`
   2. `wrangler d1 migrations apply TELEMETRY_DB --remote`
   3. `wrangler deploy`

   If you deploy with Workers Builds, push the merge to the branch it builds from. Its deploy command
   must be `pnpm run deploy`; a plain `wrangler deploy` skips the migrations.
2. Check `/readyz`: `checks.schema` is `true`.
3. Check Settings > System status > Database schema: both databases are "up to date".
4. Check the dashboard for new banners.
5. Make one workflow call through the gateway and check it in Admin > Requests.

Deploys keep the variables set in the dashboard (`keep_vars: true`) and always keep secrets.

## Migration policy

Each database has its own directory: `migrations/` for `DB`, `migrations-telemetry/` for
`TELEMETRY_DB`. The newest file of each is compiled into the code as `SCHEMA_HEAD`
(`src/generated/schema-head.ts`).

- Released migrations are never edited. Each change is a new numbered file.
- Migrations are additive: new tables, new nullable columns or columns with a default, new indexes.
  Nothing that the previous minor release reads is dropped, renamed or retyped.
- A column or table that the code stops using is dropped one minor release later at the earliest,
  not in the same release (`migrations/0001_initial.sql` header).
- A change that cannot be additive needs an ADR and exact operator steps in the "Upgrade notes".
- The CHANGELOG lists every migration under "Upgrade notes".

Migrations run before the new code is deployed. Because they are additive, the old code keeps working
on the new schema during that window. Details for contributors: [CONTRIBUTING.md](../../CONTRIBUTING.md#migrations).

### Schema state

The running code compares each database's applied migrations (wrangler's `d1_migrations` table) with
`SCHEMA_HEAD` (`src/db/migrations.ts`). Settings and the dashboard show the result:

| State | Shown as | Meaning | Action |
|---|---|---|---|
| ok | "up to date" | The newest migration of this build is applied | None |
| behind | Error banner "Database `<binding>` is missing migration ..." | The code expects a migration that is not applied | `pnpm wrangler d1 migrations apply <binding> --remote` |
| ahead | Warning banner "has migrations newer than this deployment (rolled back?)" | A newer release's migration is applied | Expected after a rollback |
| unknown | "could not be read" | The migrations table could not be read | Check the D1 binding |

`/readyz` reports `schema: false` only for behind and unknown. A behind state is re-checked every
minute, so applying the migration clears it without a redeploy.

## Roll back

A rollback deploys an earlier Worker version. Find the version id with `pnpm wrangler versions list`,
then:

```sh
pnpm wrangler rollback <version-id> --message "rollback after v0.2.0"
```

You can also use the dashboard: Workers & Pages > tokengate > Deployments.

What a rollback does not undo:

- **Databases.** D1 migrations and data stay as they are. The dashboard shows the "newer than this
  deployment" warning; `/readyz` stays `200`. The migration policy keeps this safe for a rollback of
  one minor release. Rolling back further can reach code that reads a column a later release dropped.
  Restoring D1 with Time Travel to undo a migration also discards every change made since; do it only
  as a last resort ([backup and restore](backup-restore.md#d1-time-travel)).
- **Audit.** A rollback writes no audit event. Record it in your own change log.

What a rollback does bring back:

- **Variables.** A version includes its variables. A rollback restores the values that version had.
  After a rollback, check `PUBLIC_URL` in Settings > System status. The upstream host allowlist is in D1
  and does not change ([configuration](../configuration.md#variables)).
- **Secrets.** A version includes its secrets. If they changed since that version, wrangler lists them
  and asks for confirmation. Do not confirm a rollback that restores an old `TOKENGATE_KEK` or
  `TOKENGATE_KEYRING` after a [key rotation](key-rotation.md#rollbacks-and-secrets): Credentials sealed
  with the newer key would fail with `503 credential_unavailable`.

## Related pages

- [CHANGELOG.md](../../CHANGELOG.md): release notes and upgrade notes.
- [backup-restore.md](backup-restore.md): backups before an upgrade.
- [troubleshooting.md](troubleshooting.md): problems after a deploy.
