# Key rotation

This page explains how to rotate the key-encryption key (KEK) that protects stored credentials, and
how to recover when a key is replaced or lost. It is for owners and platform engineers. The admin
page Settings › Rotate encryption (`/admin/credentials/keys`) guides the same steps
([ADR 0027](../adr/0027-two-slot-key-rotation.md)).

## How the keyring works

Each credential is sealed with a fresh data key, and that data key is wrapped with a KEK from the
keyring (`apps/gateway/src/crypto/envelope.ts`). The sealed value records the key id (`kid`) that
wrapped it. Both layers are bound to the service id, base URL and injection
([I-CRED-2](../threat-model.md#i-cred-2)).

The keyring comes from two Worker secrets with one key each (`apps/gateway/src/crypto/keyring.ts`):

| Secret | Holds | Format |
|---|---|---|
| `TOKENGATE_KEK` | The current key | Standard base64 of 32 random bytes |
| `TOKENGATE_KEYRING` | The next key, only during a rotation | Standard base64 of 32 random bytes |

- A key id is the key check value of the key (16 hex characters, see below). The same key has the
  same id in either secret, so a key can move from `TOKENGATE_KEYRING` to `TOKENGATE_KEK` and every
  credential still opens. Credentials sealed before this scheme use the key id `k1`, which always
  names `TOKENGATE_KEK`. Re-encryption replaces it.
- While `TOKENGATE_KEYRING` holds a valid key, it is the active key: new credentials are sealed with
  it. `TOKENGATE_KEK` still opens the credentials it sealed.
- `TOKENGATE_KEYRING` is used only if it is base64 of exactly 32 bytes, is not the public development
  key, is not printable text (a passphrase instead of random bytes) and has at least 16 distinct byte
  values. A value that fails is ignored: `TOKENGATE_KEK` stays active, the proxy keeps working, and
  the admin page says what is wrong.
- If only `TOKENGATE_KEYRING` is set, it must pass the same checks; it is then the only key. If it
  fails, the keyring does not load (for example `key_not_random`).
- If `TOKENGATE_KEK` is missing (and `TOKENGATE_KEYRING` too) or invalid, the keyring does not load.
  The proxy answers `503 not_configured` for every service with a credential, and credential changes
  are refused.
- The public development key from `.dev.vars.example` is refused as `TOKENGATE_KEK` with
  `dev_placeholder_key`, unless `AUTH_ACCESS_DEVELOPMENT` is set and no Access variable is set
  ([development key](../configuration.md#development-key)). It is never used as `TOKENGATE_KEYRING`.
- Every key is bound to the login variables `AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD` and
  `AUTH_ACCESS_DEVELOPMENT` ([I-CRED-3](../threat-model.md#i-cred-3)). The AES key is HKDF-SHA256 of
  the secret key with these values. A change to any of them makes every stored credential impossible
  to open ([recover](#recover-from-a-change-of-the-login-variables)). Rotate only under one set of
  login values: do not change them in the same step.
- Cloudflare cannot return a secret's value. If the Worker's secrets are lost, every credential is
  lost ([known limitations](../threat-model.md#credentials-and-responses)).

### Key check values

A key check value (KCV) identifies a key without revealing it: the first 8 bytes of
HMAC-SHA256(bound key, `tokengate/v1/kek-check`), in hex. The bound key depends on the login
variables, so the same secret key has a different KCV, and so a different key id, under different
`AUTH_ACCESS_*` values.

- `pnpm -s keyring generate` prints a new key on stdout and its key id on stderr.
  `pnpm -s keyring check` reads one key from stdin, checks it like the Worker checks
  `TOKENGATE_KEYRING` and prints its key id (`apps/gateway/scripts/keyring.ts`). Both read
  `AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD` and `AUTH_ACCESS_DEVELOPMENT` from the environment. Set
  them to the Worker's exact values, else the printed key id does not match the admin page.
- For the legacy key id `k1`, the gateway records its KCV the first time a credential is sealed with
  it (`keyring_kcv` in `settings`). If the key behind `k1` changes, `/readyz` reports
  `keyring: false` and every admin page shows the problem in the health strip.

## The Rotate encryption page

Settings › Rotate encryption (`/admin/credentials/keys`) shows:

- **Keys in the keyring.** One row for each secret, `TOKENGATE_KEK` and `TOKENGATE_KEYRING`, and one
  row for each key id that stored credentials use but neither secret holds. Each row has the key id,
  a status and how many "Secrets sealed with it" (a link to those tokens). The statuses are
  **Active** (seals new credentials), **Previous** (`TOKENGATE_KEK` during a rotation: opens what it
  sealed), **Same as TOKENGATE_KEK**, **Not used** (`TOKENGATE_KEYRING` failed the checks),
  **Not set**, **Missing** (no secret holds the key id) and **Changed** (the key behind `k1` changed).
  Under the table, the re-encryption state: "Up to date", the number of secrets still under another
  key, or the progress of a running re-encryption.
- **Problems** with their fix and the affected tokens, above the table.
- **To rotate the encryption, follow these steps.** Five steps. Only the current step is active;
  the steps follow from the secrets and the stored credentials, and the page has no buttons to move
  between them.

## Before you start

- You are an owner. Only owners can re-encrypt (permission `keyring:rewrap`).
- You can edit the Worker's secrets: in the Cloudflare dashboard, or with `pnpm wrangler` against the
  account (`pnpm wrangler login`), from a clone of the repository with `pnpm install` done, on
  Node.js 22.18 or later (`pnpm keyring` needs type stripping).
- In the commands below, `vault-read <item>` and `vault-write <item>` stand for your vault's CLI (for
  example `op read op://<vault>/<item>/password`). Keys travel through pipes only; they are never
  written to disk or passed as command arguments.

Each change of a secret deploys a new Worker version at once. New isolates use the new keyring. A
request that is already running finishes with the old one.

## Rotate the key

Follow the steps on Settings › Rotate encryption. Reload the page after each change of a secret.

1. **Add the new key as `TOKENGATE_KEYRING`.** Generate a key:

   ```sh
   openssl rand -base64 32
   ```

   In the Cloudflare dashboard, open **Workers & Pages**, select the gateway's Worker, then
   **Settings › Variables and Secrets › Add**. Choose the type **Secret**, name it
   `TOKENGATE_KEYRING`, paste the key and deploy. With Wrangler (the key goes to the vault and to the
   Worker without touching the disk):

   ```sh
   pnpm -s keyring generate | vault-write tokengate-kek-next
   vault-read tokengate-kek-next | pnpm wrangler secret put TOKENGATE_KEYRING
   ```

   Keep `TOKENGATE_KEK` as it is: it opens the stored secrets until they are re-encrypted.
2. **Check the new key.** The page checks the value. If the step fails, it says why: not base64, not
   32 bytes, the public development key, or not random. Replace the value with the output of
   `openssl rand -base64 32` and deploy. Until then nothing changes. When the check passes, new
   secrets are sealed with the new key.
3. **Re-encrypt the secrets.** Select **Re-encrypt N secrets…** and confirm in the dialog. The
   gateway opens each credential that is not under the new key and seals it again in memory. If any
   of them cannot be opened, nothing is written and the page lists the affected tokens. Otherwise it
   records the job and one `keyring.rewrap` audit event ([I-AUDIT-1](../threat-model.md#i-audit-1)),
   and writes the new values in the background.
4. **Re-encryption in progress.** The page shows a progress bar and reloads every 2 seconds. Tokens
   keep working meanwhile. A credential changed while the job runs is left as it was; the page then
   returns to step 3 for the rest. A job that sends no progress for 60 seconds is shown as stopped
   in step 3: start it again, and it continues with the secrets that are left.
5. **Move the new key to `TOKENGATE_KEK`.** When every secret uses the new key, finish under the
   Worker's **Settings › Variables and Secrets**:
   1. Edit `TOKENGATE_KEK`, paste the value of `TOKENGATE_KEYRING` and deploy.
   2. Delete `TOKENGATE_KEYRING` and deploy.

   With Wrangler:

   ```sh
   vault-read tokengate-kek-next | pnpm wrangler secret put TOKENGATE_KEK
   pnpm wrangler secret delete TOKENGATE_KEYRING
   ```

   Do it in this order. Between the two changes both secrets hold the same key, and the page shows
   "Delete TOKENGATE_KEYRING". In the other order, `TOKENGATE_KEYRING` alone is the only key, which
   also works, and the page asks you to set `TOKENGATE_KEK`.

After step 5 the page is back at step 1, and `/readyz` reports `checks.keyring: true`.

Re-encryption seals each credential again under the active key, with the same binding
([I-CRED-2](../threat-model.md#i-cred-2)). The plaintext stays in memory. The job's state is the
settings row `keyring_rewrap`. `waitUntil` has a time limit after the response: with very many
credentials a job can stop before it is done, and you start it again.

## Remove the old key

Step 5 removes the old key: after it, no secret holds it, and no stored credential uses it. A
credential sealed with a key that no secret holds cannot be opened: its service answers
`503 credential_unavailable` (reason `keyring_missing_key`), and the page lists the key id as
**Missing**. To fix that, put the key back: set it as `TOKENGATE_KEK` and the current key as
`TOKENGATE_KEYRING`, then do steps 3 to 5.

The gateway does not need the old key after step 5. A backup taken before the rotation still holds
credentials sealed with it: D1 Time Travel goes back 30 days on Workers Paid, and so does any
`d1 export` file you keep. To restore such a backup with usable credentials, you need the old key
([backup and restore](backup-restore.md)). Keep it in the vault for that time, or plan to enter those
credentials again after a restore.

## Recover from a replaced key

Symptom: someone set a new value for `TOKENGATE_KEK` directly, instead of rotating. Credentials
sealed with the old key answer `503 credential_unavailable`: reason `keyring_missing_key`, and the
page lists the old key id as **Missing**. Credentials sealed before ADR 0027 (key id `k1`) instead
show **Changed**, with reason `credential_binding_mismatch`, an error banner and `/readyz`
`keyring: false`.

To enter again a secret that no longer opens, the token page opens **Change destination**, asks for
the base URL and injection again (it does not prefill them, because a token row changed in D1 looks
the same) and for the destination host under "Confirm destination host". Take all three from an
out-of-band source
([incident response](incident-response.md#a-service-destination-was-changed-outside-the-admin-ui)).

**Option A: put both keys back** (preferred). Set the original key as `TOKENGATE_KEK` and the
replacement as `TOKENGATE_KEYRING`, then do steps 3 to 5 of [Rotate the key](#rotate-the-key). Every
credential, sealed with either key, then ends up under the replacement key. If you do not have the
replacement key, set only the original key back as `TOKENGATE_KEK`, and enter again the credentials
saved while the replacement was in place.

**Option B: accept the loss.** Use this only if the original key is lost. Enter every secret the old
key sealed again, on each token page under **Change destination** (the Problems list of the page
links each affected token). For legacy `k1` credentials, when every one of them opens with the
current key, select **Accept the new key…** in step 3 and confirm: it records the new check value and
the alert clears. Otherwise nothing is written, and the page lists the tokens whose secret still
needs the old key.

## Recover from a change of the login variables

Symptom: after a change of `AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD` or `AUTH_ACCESS_DEVELOPMENT`,
every service with a credential answers `503 credential_unavailable`, and the page lists the old key
ids as **Missing** (reason `keyring_missing_key`), or `k1` as **Changed** (reason
`credential_binding_mismatch`). The secret keys did not change; the keys bound to the login
variables did, and so did their key ids ([I-CRED-3](../threat-model.md#i-cred-3)). A change of form
only, such as `acme` to `acme.cloudflareaccess.com` or another email case, has the same effect.

**Option A: restore the earlier values** (preferred). Set each variable back to its exact earlier
value, or delete it if it was not set. Then check that `pnpm -s keyring check`, with the earlier
values exported, prints the key id that the page shows for `TOKENGATE_KEK`.

**Option B: keep the new values.** Enter every secret again, as in
[Option B of a replaced key](#recover-from-a-replaced-key).

## If a key is lost

Without the key, the credentials it sealed cannot be recovered, also not from D1 Time Travel or an
export.

1. Generate a new key and set it as `TOKENGATE_KEK`:

   ```sh
   pnpm -s keyring generate | vault-write tokengate-kek
   vault-read tokengate-kek | pnpm wrangler secret put TOKENGATE_KEK
   ```

2. Get a new credential from each upstream and enter it on each service page. Enter the base URL,
   injection and destination host too, as in [Recover from a replaced key](#recover-from-a-replaced-key).
   Until then, the page lists the lost key id as **Missing** and those credentials answer
   `503 credential_unavailable`.
3. Check that the error banner is gone and `/readyz` reports `keyring: true`.

## If a key leaked

A leaked KEK alone does not expose credentials. Combined with a copy of the `credentials` table (a D1
export, a Time Travel restore, D1 read access), it does.

1. [Rotate the key](#rotate-the-key), up to and including step 5.
2. Rotate every upstream credential sealed with the leaked key ([credential rotation](credential-rotation.md)):
   old backups still hold those credentials sealed with the leaked key.
3. Follow [incident response](incident-response.md).

## Rollbacks and secrets

A Worker version includes its secrets. `wrangler rollback` to a version from before a key change
restores that version's keyring and variables; wrangler asks you to confirm when secrets differ. Do
not confirm a rollback that brings back a removed or replaced key, or other `AUTH_ACCESS_*` values
([I-CRED-3](../threat-model.md#i-cred-3)). Credentials sealed with the newer key would answer
`503 credential_unavailable`. See [upgrades](upgrades.md#roll-back).

## Related pages

- [configuration.md](../configuration.md#keyring-tokengate_kek-and-tokengate_keyring): keyring
  secrets and errors.
- [backup-restore.md](backup-restore.md): which key a restore needs.
- [troubleshooting.md](troubleshooting.md): `credential_unavailable` and `not_configured`.
