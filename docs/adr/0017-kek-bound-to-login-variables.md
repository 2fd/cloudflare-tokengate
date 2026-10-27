# 17. Key-encryption keys bound to the login variables

This ADR explains why every key-encryption key is bound to the admin login variables, why the development login and Access cannot be set together, and why `.dev.vars.example` ships a public development key. It is for security reviewers and platform engineers. It extends [0004](0004-envelope-encryption-bound-to-destination.md) and replaces the local development login parts of [0015](0015-cloudflare-access-only-admin-login.md) and [0016](0016-admin-hosts-in-settings.md).

Date: 2026-10-14

## Status

Accepted

## Context

The login variables decide who can administer a deployment. `AUTH_ACCESS_TEAM_DOMAIN` and `AUTH_ACCESS_AUD` select the Access team and application. `AUTH_DEV_EMAIL` signed every admin request to a loopback hostname in as one email, with no proof.

A person who can change Worker variables can change who administers the gateway, without a trace in the audit log: swap the Access application for one they control, or turn on the development login. Admins can then use every stored credential through grants and "Test credential". The stored credentials should not survive such a silent change.

Before this change, Access overrode the development login when both were set. A forgotten `AUTH_DEV_EMAIL` stayed in production, waiting for the day Access was removed.

Local development needed manual edits before the first `pnpm dev`: a generated key in `TOKENGATE_KEK` and an uncommented `AUTH_DEV_EMAIL`. The Deploy to Cloudflare button prompts for every uncommented secret in `.dev.vars.example`, so the example could not ship working values without asking for them in production too.

## Decision

- **Rename.** `AUTH_DEV_EMAIL` becomes `AUTH_ACCESS_DEVELOPMENT`, so the three login variables share one prefix. Its meaning does not change: every admin request to `localhost`, `127.0.0.1` or `[::1]` is signed in as that email, with no proof, and it is refused on any other hostname. The login provider id stays `dev`; the configuration feature stays `login.dev`.
- **Mutual exclusion.** When `AUTH_ACCESS_DEVELOPMENT` is set together with `AUTH_ACCESS_TEAM_DOMAIN` or `AUTH_ACCESS_AUD`, `parseConfig` turns off both logins (fail closed). The error names `AUTH_ACCESS_DEVELOPMENT` on the features `login.access` and `login.dev`, and `/admin` shows it on the setup page (503). When only the development login is set and the request host is not a loopback host, the setup page says that it signs in only requests to localhost and must be removed in production.
- **Login binding ([I-CRED-3](../threat-model.md#i-cred-3)).** Each key in `TOKENGATE_KEK` or `TOKENGATE_KEYRING` is no longer the AES-256-GCM key itself. The AES key is HKDF-SHA256(secret key, salt = empty, info = `tokengate/v1/kek-binding` + newline + the JSON array of the trimmed values of `AUTH_ACCESS_TEAM_DOMAIN`, `AUTH_ACCESS_AUD` and `AUTH_ACCESS_DEVELOPMENT`, `""` when unset). The values are not normalized further: `acme` and `acme.cloudflareaccess.com`, or two cases of one email, give different keys. Key check values are HMAC-SHA256 over the bound key. `apps/gateway/scripts/keyring.ts` reads the three variables from the environment to print matching values; secrets still come from stdin. The sealed format stays v1; `apps/gateway/test/vectors/sealed.json` records the binding info of each vector. Rotation and re-encryption work as before under one binding.
- **Development key.** `.dev.vars.example` sets `TOKENGATE_KEK=REVWLU9OTFktS0VZLU5PVC1GT1ItUFJPRFVDVElPTiE=` (base64 of `DEV-ONLY-KEY-NOT-FOR-PRODUCTION!`) and `AUTH_ACCESS_DEVELOPMENT=dev@example.com`. The Access variables stay commented. `pnpm run setup`, `pnpm db:migrate:local` and `pnpm dev` then work with no edits. The keyring refuses this key in any slot with `dev_placeholder_key` (proxy: `503 not_configured`) unless `AUTH_ACCESS_DEVELOPMENT` is set and no Access variable is set.

## Consequences

- A change to any login variable makes every stored credential impossible to decrypt, by design. The proxy answers `503 credential_unavailable` (`credential_binding_mismatch`), and Settings shows the key check values as changed. Recovery is to restore the earlier values or to enter every credential again. A rename of the team to an equivalent form, or a change of email case, has the same effect.
- Operators must set the login variables before they add services and treat them as part of the key: keep their exact values in the vault with the KEK. A Worker rollback that restores other login values has the same effect as a change.
- Moving an existing deployment to another Access team or application now needs every credential entered again, in addition to "Reset login" for each user.
- Key check values depend on the login variables. To compare a vault copy with Settings, run `pnpm keyring check` with the Worker's `AUTH_ACCESS_*` values in the environment.
- An attacker who can change Worker variables, but cannot read the keyring secret, can no longer take over the gateway with its stored credentials. They can still deny service. People who can deploy code or read secrets keep full trust ([threat model](../threat-model.md#scope-and-assumptions)).
- The development login and Access never run together. A forgotten `AUTH_ACCESS_DEVELOPMENT` next to Access turns off admin sign-in at once, instead of staying hidden.
- The Deploy button now prompts for `TOKENGATE_KEK` and `AUTH_ACCESS_DEVELOPMENT`. Cloudflare's documentation does not say whether it prefills example values. A deploy that keeps both defaults fails closed ([I-DEPLOY-1](../threat-model.md#i-deploy-1)): the development login signs in no request through Cloudflare's edge, so nobody can sign in, and the development key is refused as soon as an Access variable is set.
- The development key is public. Credentials stored locally with it are not protected; use test credentials in local development.

## Note (2026-10-19)

[ADR 0027](0027-two-slot-key-rotation.md) changes the keyring to two secrets with one key each and makes each key id the key check value of the bound key. The login binding is unchanged. A change of the login variables now also changes every key id, so Settings › Rotate encryption lists the earlier key ids as missing (`k1`, the id of credentials sealed before, as changed). `pnpm keyring check` reads one bare key and prints its key id.
