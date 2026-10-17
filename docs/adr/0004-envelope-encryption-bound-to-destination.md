# 4. Envelope encryption bound to the destination, not Secrets Store

This ADR explains how credentials are stored and why they are not kept in Cloudflare Secrets Store. It is for security reviewers and operators.

Date: 2026-10-13

## Status

Accepted

## Context

Admins create and change credentials from the admin UI at runtime. The storage must meet these needs:

- A copy of the database (backup, export, read access to D1) must not reveal credentials.
- Someone who can write to D1 but cannot deploy the Worker must not be able to send a credential to a host of their choice. For example, changing a service's `base_url` to their own server must not work.
- Rotation of the encryption key must be possible without downtime.

Alternatives considered:

- **Worker secrets per credential.** Bindings are static. Each new credential would need a new binding and a redeploy, and the UI cannot create them.
- **Cloudflare Secrets Store.** At the time of the decision it was in open beta. Bindings are static and read-only, one per secret. Writes need a Cloudflare API token with Secrets Store admin rights, which is a larger blast radius than the data. An account holds at most 100 production secrets. Source: https://developers.cloudflare.com/secrets-store/

## Decision

Credentials are sealed with envelope encryption and stored in `services.credential_sealed` (`apps/gateway/src/crypto/envelope.ts`).

- The key-encryption key (KEK) comes from a Worker secret: `TOKENGATE_KEK` (one key, kid `k1`) or `TOKENGATE_KEYRING` (several keys and an active kid). Keys are imported as non-extractable AES-256-GCM keys (`apps/gateway/src/crypto/keyring.ts`).
- Each seal uses a fresh random 256-bit data key (DEK). The credential is encrypted with AES-256-GCM under the DEK. The DEK is wrapped with AES-256-GCM under the KEK.
- Both layers use the same additional authenticated data (AAD): `tokengate/v1/service-credential`, the service id, the stored base URL and the stored canonical injection JSON, separated by newlines.
- The sealed format v1 is JSON with fields `v`, `kid`, `iv`, `wdek`, `dek_iv`, `ct`. `apps/gateway/test/vectors/sealed.json` freezes it.
- Each kid has a key check value: the first 8 bytes of HMAC-SHA256(key, `tokengate/v1/kek-check`), in hex. It identifies a key without revealing it.
- Owners can re-encrypt all credentials under the active key (Settings, `POST /admin/settings/rewrap`, `apps/gateway/src/admin/ops/keyring.ts`).
- The KEK is generated outside Cloudflare (`openssl rand -base64 32` or `pnpm keyring generate`) and kept in the company's vault.

## Consequences

- D1 read access, backups and exports reveal no credential. Exports contain no sealed values at all ([I-CRED-1](../threat-model.md#i-cred-1)).
- A change to `base_url` or injection in D1 makes decryption fail. The proxy answers 503 `credential_unavailable` ([I-CRED-2](../threat-model.md#i-cred-2)). The admin UI changes the destination only together with a newly entered credential.
- Losing the KEK loses every stored credential. There is no recovery path ([operations/key-rotation.md](../operations/key-rotation.md)).
- Anyone who can deploy code to the Worker can read every credential. Worker deployers are fully trusted ([threat-model.md](../threat-model.md)).
- Key check values are recorded per kid, not per credential. Replacing the key behind a kid is detected, but a restored old key does not reveal which newer credentials it cannot open.
- Holding the KEK in Secrets Store instead of a Worker secret stays possible as a later option ([roadmap.md](../roadmap.md)).

## Note (2026-10-17)

[ADR 0024](0024-secret-reveal-over-ecdh.md) replaces `services.credential_hint` (the last 4 characters of the secret) with `credential_length`. D1, backups, audit diffs and logs hold only the length. A person with reveal on a token sees its first 4 and last 4 characters, which the page derives at render from the opened credential. That person can also copy the secret through the one reveal endpoint, which encrypts it to a key of the browser. The envelope format is unchanged.
