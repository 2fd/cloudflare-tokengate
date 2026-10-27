# 27. Two-slot key rotation guided by the admin UI

This ADR explains why the keyring is now two Worker secrets with one key each, why key ids are the key check values, and why re-encryption runs in the background. It is for security reviewers and platform engineers. It replaces the `TOKENGATE_KEYRING` JSON format of [0004](0004-envelope-encryption-bound-to-destination.md) and keeps the login binding of [0017](0017-kek-bound-to-login-variables.md).

Date: 2026-10-19

## Status

Accepted

## Context

A rotation needed a JSON keyring with named key ids, an `active` field and every old key until the re-encryption finished. Operators edited JSON by hand, chose key ids, kept old keys in a vault, and checked key check values with `pnpm keyring check`. Settings › Encryption keys showed the state but did not say what to do next. Setting both `TOKENGATE_KEK` and `TOKENGATE_KEYRING` was a configuration error that stopped the proxy.

Key ids were names of slots. A key moved to another slot would need another id, and every credential sealed under the old id would stop opening.

## Decision

- **Two slots, one key each.** `TOKENGATE_KEK` holds the current key. `TOKENGATE_KEYRING` holds the next key during a rotation, as standard base64 of 32 bytes like `TOKENGATE_KEK`. The JSON format is removed. Setting both is the normal state of a rotation.
- **Key ids are key check values.** A sealed credential records the key check value of the bound key that wrapped it (16 hex characters). The same key has the same id in either slot, so moving the value from `TOKENGATE_KEYRING` to `TOKENGATE_KEK` keeps every credential readable. The legacy id `k1` resolves to `TOKENGATE_KEK`; re-encryption replaces it.
- **The next key is checked before use.** `TOKENGATE_KEYRING` is used only when it is base64 of exactly 32 bytes, is not the public development key, is not printable text (a passphrase instead of random bytes) and has at least 16 distinct byte values. A value that fails is ignored: `TOKENGATE_KEK` stays active and the proxy keeps working. The admin UI says what is wrong. `TOKENGATE_KEK` keeps the earlier checks.
- **The next key seals new credentials.** While `TOKENGATE_KEYRING` passes the checks it is the active key. `TOKENGATE_KEK` still opens what it sealed. When only `TOKENGATE_KEYRING` is set and it passes the checks, it is the only key, so a hand-over in the wrong order does not stop the proxy.
- **Guided rotation.** Settings › Rotate encryption (`/admin/credentials/keys`) shows five steps and only the current one is active: add `TOKENGATE_KEYRING`; the check of its value (failed or passed); start the re-encryption (owners, `keyring:rewrap`); the re-encryption in progress; move the value to `TOKENGATE_KEK` and delete `TOKENGATE_KEYRING`. The steps follow from the loaded secrets and the stored credentials; the page has no step navigation.
- **Background re-encryption.** The start request opens and re-seals every credential that is not under the active key, in memory, and writes nothing if any of them fails (all or nothing, as before). It then records the job in settings (`keyring_rewrap`) with one audit event, and `waitUntil` writes the re-sealed values in batches with compare-and-swap, updating the job's progress and heartbeat. The page refreshes itself every 2 seconds while the job runs. A job without a heartbeat for 60 seconds is shown as stopped and can be started again; re-encryption is idempotent.

## Consequences

- The old key is not needed after the hand-over, so operators do not keep it. The new key stays in Cloudflare only unless the operator keeps a copy: losing the Worker's secrets still loses every credential.
- A value that is not random enough cannot become a key by mistake, and a bad `TOKENGATE_KEYRING` no longer stops the proxy.
- Rotation and re-encryption still work only under one set of login values (I-CRED-3). A change of the login variables changes every key id, so the credentials show as sealed with a key that is not loaded.
- `both_kek_and_keyring_set` and `active_kid_missing` are no longer produced. Request records that already hold them keep their text.
- `waitUntil` has a time limit after the response. A deployment with very many credentials may need several runs; each run continues where the last one stopped.
- `pnpm keyring check` reads one bare base64 key and prints its key id. The admin UI no longer explains key check values.
