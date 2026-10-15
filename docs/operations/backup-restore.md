# Backup and restore

This page lists what to back up and how to restore a deployment: D1 Time Travel, `d1 export`, the
configuration export, and the secrets that no backup holds. It is for platform engineers and owners.

## What holds the state

| State | Where | Backed up by |
|---|---|---|
| Keyring (`TOKENGATE_KEK` or `TOKENGATE_KEYRING`) | Worker secret | Only your vault. Cloudflare cannot return a secret's value |
| Variables (`AUTH_*`) | Worker settings | Keep the exact values in your vault with the keyring: the keys are bound to them ([configuration](../configuration.md#login-binding)) |
| Users, login identities, caller providers, services, sealed credentials, grants, settings (including the upstream host allowlist and the admin hosts), audit log | `DB` (`tokengate`) | Time Travel, `d1 export` |
| Access application and policy (who can reach `/admin`) | Cloudflare One | Keep a copy in your runbook ([zone settings](cloudflare-zone-settings.md#cloudflare-access)) |
| Request log and rollups | `TELEMETRY_DB` (`tokengate-telemetry`) | Time Travel, `d1 export`; optional R2 archive |
| Code and `wrangler.jsonc` | Your clone of the repository | Git |

The sealed credentials in `DB` open only with the key id they were sealed with, and only for the
same service id, base URL and injection ([I-CRED-2](../threat-model.md#i-cred-2)), and only with the
same `AUTH_ACCESS_*` values ([I-CRED-3](../threat-model.md#i-cred-3)). A database backup without the
matching keyring and login variables restores everything except usable credentials.

## D1 Time Travel

D1 keeps point-in-time history for 30 days on Workers Paid and 7 days on Free
([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)). No setup is needed.

To restore `DB` to a point in time:

1. Pick the time just before the incident, in UTC.
2. Get the bookmark and check it:

   ```sh
   pnpm wrangler d1 time-travel info tokengate --timestamp 2026-10-12T09:00:00Z
   ```

3. Restore:

   ```sh
   pnpm wrangler d1 time-travel restore tokengate --timestamp 2026-10-12T09:00:00Z
   ```

4. Do the [checks after a restore](#checks-after-a-restore).

The restore overwrites the database in place. Every change after that time is lost, including:

- Grants, services and caller providers you disabled after that time come back enabled. Disable them
  again before you continue.
- Users you suspended come back active, users you approved or rejected come back pending, demoted users get their old role back, and identities you
  unlinked with "Reset login" are linked again. Anyone with such a user and a valid Access session
  has access again on their next request. The first [check after a restore](#checks-after-a-restore)
  suspends them again.
- Access sessions are not in D1, so a restore does not change them.
- A restore to a time before a migration also removes that migration's changes and its row in
  `d1_migrations`. The schema state then shows "behind" until you apply the migrations again.
- Audit events after that time are gone from D1. If you export `audit.event` log lines, your SIEM
  still has them ([observability](../observability.md#auditevent-log-lines-for-a-siem)).
- Credentials saved after that time revert to the earlier credential.

`TELEMETRY_DB` restores the same way (`tokengate-telemetry`). Restore it only if you need the
request log back; the control plane does not depend on it.

## `d1 export`

An export is a SQL file you keep outside Cloudflare, for longer than Time Travel. Schedule it, for
example weekly.

```sh
pnpm wrangler d1 export tokengate --remote --output "tokengate-$(date -u +%Y%m%d).sql"
```

The file holds sealed credentials, user emails, login identities and the audit log. Store it as
sensitive data, and never in the same place as the keyring: together they expose every credential.

The request log is optional to export; it can be large:

```sh
pnpm wrangler d1 export tokengate-telemetry --remote --output "tokengate-telemetry-$(date -u +%Y%m%d).sql"
```

### Restore an export into a new database

1. Create the database:

   ```sh
   pnpm wrangler d1 create tokengate-restored
   ```

2. Load the export:

   ```sh
   pnpm wrangler d1 execute tokengate-restored --remote --file tokengate-20261012.sql
   ```

3. In `wrangler.jsonc`, set `"database_name": "tokengate-restored"` on the `DB` binding.
4. Make sure the keyring holds every key id the export's credentials use. If you rotated keys since
   the export, add the old key back as a non-active key ([key rotation](key-rotation.md)).
5. Run `pnpm run deploy`. The export includes wrangler's `d1_migrations` table, so only migrations
   newer than the export are applied. Then the Worker is deployed with the new binding.
6. Do the [checks after a restore](#checks-after-a-restore).
7. After the checks pass, select "Re-encrypt credentials with the active key" in Settings if
   Credentials use an old key.

## Configuration export

The export form in the footer of every admin page (admins and owners, permission `config:export`)
downloads `tokengate-export-<date>.json`. Each download writes a `config.export` audit event.

The file is deterministic JSON (`schema_version` 2) with every caller provider, service (with its
`template_id`), grant, claim display label and user (email, role, status), keyed by name or slug.
It holds no credentials, no row ids and no secrets ([I-CRED-1](../threat-model.md#i-cred-1)); for
each credential it has only the hint and timestamps.
Runtime settings are not included.

Use it to review changes (diff two exports), to document the configuration, and as a manual rebuild
guide. There is no import: to rebuild from it, create each item again in the admin UI and enter every
Credential again. Keep caller provider audiences exactly as exported: callers request tokens for that
audience, and a different value fails with `401 audience_mismatch`.

## Rebuild in a new account

Use this when the Cloudflare account or both databases are lost.

1. Follow [getting started](../getting-started.md) to create both databases and set the secrets and
   variables. Use the same keyring from your vault.
2. If you have a `d1 export`, load it into the new `DB` database before the first deploy:
   `pnpm wrangler d1 execute tokengate --remote --file tokengate-20261012.sql`. Credentials open if
   the keyring matches ([restore an export](#restore-an-export-into-a-new-database)).
3. Run `pnpm run deploy`. If you loaded a `d1 export`, do the
   [checks after a restore](#checks-after-a-restore).
4. If you have only a configuration export, recreate the caller providers with the same issuer and
   audience, then services, then grants, and enter every credential again.
5. If the gateway URL changes, update every workflow that calls it, and the hostname of the Access
   application ([zone settings](cloudflare-zone-settings.md#cloudflare-access)). If the Access team
   changes, every user must be linked again: use "Reset login" for each user, or
   [break-glass](break-glass.md#regain-owner-access) when no owner can sign in.

## Checks after a restore

1. In Users, suspend again every user you had suspended after the restore point, and fix roles, approvals,
   login resets and the "New users" defaults changed after it. Do this after every restore of `DB` (Time Travel or export): the
   gateway re-reads the user on every admin request, so these changes apply at once. If a user may
   have taken part in an incident, also sign every admin out
   ([break-glass](break-glass.md#sign-every-admin-out)).
2. If the schema state is "behind", apply the migrations again:
   `pnpm wrangler d1 migrations apply DB --remote` ([upgrades](upgrades.md#schema-state)).
3. `/readyz` returns `200` with every check `true` ([observability](../observability.md#health-endpoints)).
4. The dashboard shows no error banner. A keyring banner means a key id is missing or changed
   ([key rotation](key-rotation.md)).
5. Settings > System status shows the database schema as "up to date".
6. Users shows the owners you expect, and no user you had suspended is active.
7. Grants, services and caller providers you disabled during an incident are still disabled.
8. Settings > "Admin hosts" and "Upstream hosts" list the hosts you expect. A restore brings back
   the lists of the restore point.
9. On a service with a credential check, "Test credential" passes.
10. A workflow call succeeds ([GitHub Actions](../callers/github-actions.md)).

## Related pages

- [key-rotation.md](key-rotation.md): which keys a restore needs.
- [upgrades.md](upgrades.md): migrations and rollbacks.
- [incident-response.md](incident-response.md): when a restore is part of an incident.
