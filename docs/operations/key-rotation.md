# Key rotation

This page explains how to rotate the key-encryption key (KEK) that protects stored credentials, and
how to recover when a key is replaced or lost. It is for owners and platform engineers.

## How the keyring works

Each credential is sealed with a fresh data key, and that data key is wrapped with a KEK from the
Keyring (`apps/gateway/src/crypto/envelope.ts`). The sealed value records the key id (`kid`) that wrapped it. Both
layers are bound to the service id, base URL and injection ([I-CRED-2](../threat-model.md#i-cred-2)).

The keyring comes from exactly one of two Worker secrets (`apps/gateway/src/crypto/keyring.ts`):

| Secret | Format | Key ids |
|---|---|---|
| `TOKENGATE_KEK` | Standard base64 of 32 random bytes | Always `k1` |
| `TOKENGATE_KEYRING` | JSON `{"active":"k2","keys":{"k1":"<base64>","k2":"<base64>"}}` | Your choice; `active` seals new credentials |

- Key ids match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}# Key rotation

This page explains how to rotate the key-encryption key (KEK) that protects stored credentials, and
how to recover when a key is replaced or lost. It is for owners and platform engineers.

## How the keyring works

Each credential is sealed with a fresh data key, and that data key is wrapped with a KEK from the
Keyring (`apps/gateway/src/crypto/envelope.ts`). The sealed value records the key id (`kid`) that wrapped it. Both
layers are bound to the service id, base URL and injection ([I-CRED-2](../threat-model.md#i-cred-2)).

The keyring comes from exactly one of two Worker secrets (`apps/gateway/src/crypto/keyring.ts`):

| Secret | Format | Key ids |
|---|---|---|
| `TOKENGATE_KEK` | Standard base64 of 32 random bytes | Always `k1` |
| `TOKENGATE_KEYRING` | JSON `{"active":"k2","keys":{"k1":"<base64>","k2":"<base64>"}}` | Your choice; `active` seals new credentials |

. Every key is 32 bytes.
- If both secrets are set, the keyring fails with `both_kek_and_keyring_set`. The proxy then answers
  `503 not_configured` for every service, and credential changes are refused.
- The public development key from `.dev.vars.example` is refused in any key slot with
  `dev_placeholder_key`, unless `AUTH_ACCESS_DEVELOPMENT` is set and no Access variable is set
  ([development key](../configuration.md#development-key)). The result is the same `503 not_configured`.
- Every key is bound to the login variables `AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD` and
  `AUTH_ACCESS_DEVELOPMENT` ([I-CRED-3](../threat-model.md#i-cred-3)). The AES key is HKDF-SHA256 of
  the secret key with these values. A change to any of them makes every stored credential impossible
  to open ([recover](#recover-from-a-change-of-the-login-variables)). Rotation and re-encryption work
  only under one set of login values: do not change them in the same step.
- Cloudflare cannot return a secret's value. Keep every key in your own vault. If you lose a key,
  you lose every credential sealed with it ([known limitations](../threat-model.md#credentials-and-responses)).

### Key check values

A key check value (KCV) identifies a key without revealing it: the first 8 bytes of
HMAC-SHA256(bound key, `tokengate/v1/kek-check`), in hex. The bound key depends on the login
variables, so the same secret key has a different KCV under different `AUTH_ACCESS_*` values.

- Service tokens › Encryption keys (`/admin/tokens/keys`) lists each key id in the table "Keys in
  the keyring" with its "Key check value", its status (`active`, `loaded`, `missing` or
  `changed`), and how many "Secrets sealed with it" (a link to those tokens). Above it, a status
  sentence such as "Active key k2. 2 keys loaded. Every stored secret opens."; below it, the
  problems with their fix and the affected tokens.
- `pnpm -s keyring check` prints the same values for a secret read from stdin
  (`apps/gateway/scripts/keyring.ts`). It uses the Worker's parser, so it reports the same errors. It reads
  `AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD` and `AUTH_ACCESS_DEVELOPMENT` from the environment.
  Set them to the Worker's exact values, else the printed KCVs do not match the Encryption keys page.
  `pnpm -s keyring generate` prints the KCV for the same environment.
- The gateway records a KCV for each key id the first time a credential is sealed with it
  (`keyring_kcv` in `settings`). It never silently replaces that value while other credentials use
  the key id. If the key behind a key id changes, `/readyz` reports `keyring: false` and every
  admin page shows the problem in the health strip.

## Before you start

- You are an owner. Only owners can re-encrypt (the "Re-encrypt secrets" section of Service tokens › Encryption keys).
- You can run `pnpm wrangler` against the account (`pnpm wrangler login`), from a clone of the
  repository with `pnpm install` done, on Node.js 22.18 or later (`pnpm keyring` needs type stripping).
- You have `jq`.
- In the commands below, `vault-read <item>` and `vault-write <item>` stand for your vault's CLI (for
  example `op read op://<vault>/<item>/password`). Keys travel through pipes and environment
  variables only; they are never written to disk or passed as command arguments.
- Export the Worker's login variables in the shell, with the exact values from the dashboard. The key
  check values depend on them. Do not export a variable that the Worker does not set:

  ```sh
  export AUTH_ACCESS_TEAM_DOMAIN=<team> AUTH_ACCESS_AUD=<aud>
  ```

Each `wrangler secret` command deploys a new Worker version at once. New isolates use the new
Keyring. A request that is already running finishes with the old one.

## Rotate from `TOKENGATE_KEK` to a keyring

Use this the first time. The current `TOKENGATE_KEK` becomes key id `k1`; the new key becomes `k2`.

1. Open Service tokens › Encryption keys and note the check value of `k1`.
2. Check that your vault copy is the deployed key. The printed `kid k1 kcv` must equal the value from
   step 1:

   ```sh
   vault-read tokengate-kek-k1 | pnpm -s keyring check
   ```

   If the values differ, first check the exported `AUTH_ACCESS_*` values against the dashboard. If
   they match, stop: the vault copy is not the deployed key. Find the right key first.
3. Generate the new key and store it in the vault. The key goes to stdout, its KCV to stderr:

   ```sh
   pnpm -s keyring generate | vault-write tokengate-kek-k2
   ```

4. Build the keyring and check it. The output must show `active k2` and both key ids:

   ```sh
   K1="$(vault-read tokengate-kek-k1)" K2="$(vault-read tokengate-kek-k2)" \
     jq -cn '{active: "k2", keys: {k1: $ENV.K1, k2: $ENV.K2}}' | pnpm -s keyring check
   ```

5. Set `TOKENGATE_KEYRING` and delete `TOKENGATE_KEK` in one request. Setting them in two steps
   would leave a window with both secrets set, or with neither:

   ```sh
   K1="$(vault-read tokengate-kek-k1)" K2="$(vault-read tokengate-kek-k2)" \
     jq -cn '{TOKENGATE_KEYRING: ({active: "k2", keys: {k1: $ENV.K1, k2: $ENV.K2}} | tojson), TOKENGATE_KEK: null}' \
     | pnpm wrangler secret bulk
   ```

6. Reload Service tokens › Encryption keys. Check that `k1` and `k2` are listed with the check values from
   step 4, and that `k2` is marked "active".
7. Check `/readyz`: `checks.keyring` is `true`.
8. Under "Re-encrypt secrets", select **Re-encrypt N secrets…** and confirm in the dialog. The
   notice says "Secrets re-encrypted with the active key." (The Overview offers the same action
   inline.)
9. If the notice says some secrets changed while it ran, run it again.
10. Check that the page says "Every stored secret uses the active key." and that `k1` shows 0
    "Credentials encrypted with it".
11. [Remove the old key](#remove-the-old-key).

Re-encryption opens each credential and seals it again under the active key, with the same binding
([I-CRED-2](../threat-model.md#i-cred-2)). The plaintext stays in memory. It writes one
`keyring.rewrap` audit event ([I-AUDIT-1](../threat-model.md#i-audit-1)). If any credential cannot be
opened, nothing is written and the page lists the affected services.

## Rotate a keyring

The same steps, with `TOKENGATE_KEYRING` only. Example: from active `k2` to a new `k3`.

1. Check the vault copy of the current key against Service tokens › Encryption keys:

   ```sh
   vault-read tokengate-kek-k2 | pnpm -s keyring check
   ```

2. Generate the new key: `pnpm -s keyring generate | vault-write tokengate-kek-k3`.
3. Set the new keyring with both keys and `k3` active:

   ```sh
   K2="$(vault-read tokengate-kek-k2)" K3="$(vault-read tokengate-kek-k3)" \
     jq -cn '{active: "k3", keys: {k2: $ENV.K2, k3: $ENV.K3}}' | pnpm wrangler secret put TOKENGATE_KEYRING
   ```

4. Do steps 6 to 11 of the previous procedure, with `k3` as the active key and `k2` as the old key.

Never reuse a key id for different key material. The gateway then reports the key id as changed.

## Remove the old key

Remove a key only when no credential uses it. A Credential sealed with a key id that is not in the
Keyring cannot be opened: its service answers `503 credential_unavailable` (reason
`keyring_missing_key`), and the dashboard shows an error banner.

1. Check that the old key id shows 0 "Secrets sealed with it" in Service tokens › Encryption keys.
2. Set the keyring without the old key:

   ```sh
   K2="$(vault-read tokengate-kek-k2)" jq -cn '{active: "k2", keys: {k2: $ENV.K2}}' \
     | pnpm wrangler secret put TOKENGATE_KEYRING
   ```

3. Check `/readyz`: `checks.keyring` is `true`.
4. Keep the old key in the vault for as long as a backup can contain credentials sealed with it:
   D1 Time Travel goes back 30 days on Workers Paid, and any `d1 export` file you keep. To restore
   such a backup, add the old key back to the keyring as a non-active key, then re-encrypt
   ([backup and restore](backup-restore.md)).

## Recover from a replaced key

Symptom: an error banner says "Key id(s) ... now hold a different key than the one stored
credentials were sealed with", `/readyz` reports `keyring: false`, and affected services answer
`503 credential_unavailable` (reason `credential_binding_mismatch`). Typical cause: someone set a new
value with `wrangler secret put TOKENGATE_KEK`, so key id `k1` now names different key material.

To enter again a secret that no longer opens, the token page opens **Change destination**, asks for
the base URL and injection again (it does not prefill them, because a token row changed in D1 looks
the same) and for the destination host under "Confirm destination host". Take all three from an out-of-band source
([incident response](incident-response.md#a-service-destination-was-changed-outside-the-admin-ui)).

Saving or entering a credential again does not clear the alert while other credentials still use the
key id. Choose one recovery:

**Option A: restore the original key** (preferred).

1. Put the original key back:

   ```sh
   vault-read tokengate-kek-k1 | pnpm wrangler secret put TOKENGATE_KEK
   ```

2. Check that the check value on the Encryption keys page matches the one `pnpm -s keyring check` prints for it.
3. If someone saved credentials while the new key was in place, enter those credentials again. Key
   check values are per key id, not per credential: the alert clears, but credentials sealed with
   the replacement key fail with `credential_unavailable` ([known limitations](../threat-model.md#credentials-and-responses)).

**Option B: accept the new key.** Use this only if the original key is lost.

1. Enter every secret the old key sealed again, on each token page under **Change destination**
   (the Problems list of the Encryption keys page links each affected token).
2. In Service tokens › Encryption keys, select **Re-encrypt…** and confirm: the dialog states that
   confirming accepts the new key value. It opens every secret under the changed key id. If all of
   them open, it records the new check value and the alert clears; the notice says "New key
   confirmed: every secret opens with it." Otherwise nothing is written, and the page lists the
   tokens whose secret still needs the old key.

## Recover from a change of the login variables

Symptom: after a change of `AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD` or `AUTH_ACCESS_DEVELOPMENT`,
every service with a credential answers `503 credential_unavailable` (reason
`credential_binding_mismatch`), and the Encryption keys page shows each key id that has secrets as `changed`. The secret keys did not
change; the keys bound to the login variables did ([I-CRED-3](../threat-model.md#i-cred-3)). A change
of form only, such as `acme` to `acme.cloudflareaccess.com` or another email case, has the same effect.

**Option A: restore the earlier values** (preferred). Set each variable back to its exact earlier
value, or delete it if it was not set. Then check that `pnpm -s keyring check`, with the earlier
values exported, prints the check values that the Encryption keys page shows.

**Option B: keep the new values.** Enter every secret again, then re-encrypt and accept the new key
value, as in [Option B of a replaced key](#recover-from-a-replaced-key).

## If a key is lost

Without the key, the credentials it sealed cannot be recovered, also not from D1 Time Travel or an
export.

1. Generate a new key: `pnpm -s keyring generate | vault-write tokengate-kek-k2`. If `k2` is already
   in use, pick the next unused key id.
2. Set it under a new key id, so it does not collide with the recorded check value of the lost key.
   For a Worker that has `TOKENGATE_KEK`:

   ```sh
   K2="$(vault-read tokengate-kek-k2)" \
     jq -cn '{TOKENGATE_KEYRING: ({active: "k2", keys: {k2: $ENV.K2}} | tojson), TOKENGATE_KEK: null}' \
     | pnpm wrangler secret bulk
   ```

   If the Worker already uses `TOKENGATE_KEYRING`, pipe the new keyring JSON to
   `pnpm wrangler secret put TOKENGATE_KEYRING` instead, and keep every key you still have.

3. Get a new credential from each upstream and enter it on each service page. Enter the base URL,
   injection and destination host too, as in [Recover from a replaced key](#recover-from-a-replaced-key). Until then, the
   dashboard lists the missing key id and those services answer `503 credential_unavailable`.
4. Check that the error banner is gone and `/readyz` reports `keyring: true`.

## If a key leaked

A leaked KEK alone does not expose credentials. Combined with a copy of the `services` table (a D1
export, a Time Travel restore, D1 read access), it does.

1. Rotate the key with the procedure above, including [removing the old key](#remove-the-old-key).
2. Rotate every upstream credential sealed with the leaked key ([credential rotation](credential-rotation.md)):
   old backups still hold those credentials sealed with the leaked key.
3. Follow [incident response](incident-response.md).

## Rollbacks and secrets

A Worker version includes its secrets. `wrangler rollback` to a version from before a key change
restores that version's keyring and variables; wrangler asks you to confirm when secrets differ. Do
not confirm a rollback that brings back a removed or replaced key, or other `AUTH_ACCESS_*` values
([I-CRED-3](../threat-model.md#i-cred-3)). See [upgrades](upgrades.md#roll-back).

## Related pages

- [configuration.md](../configuration.md#keyring-tokengate_kek-or-tokengate_keyring): Keyring
  secrets and errors.
- [backup-restore.md](backup-restore.md): which key a restore needs.
- [troubleshooting.md](troubleshooting.md): `credential_unavailable` and `not_configured`.
