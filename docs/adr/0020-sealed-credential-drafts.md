# 20. Sealed credential drafts

This ADR explains how a secret typed into a service token form survives a failed submit without the
gateway ever rendering it back. It is for contributors who change the token forms or the envelope
format, and for reviewers of [I-CRED-1](../threat-model.md#i-cred-1) and
[I-CRED-2](../threat-model.md#i-cred-2).

Date: 2026-10-15

## Status

Accepted

## Context

A token form re-renders after a failed submit: a field error, a taken slug, a host that is not
allowed, a failed credential check, or the destination host to confirm. Every other field comes
back as typed (WCAG 3.3.7), but the secret cannot: rendering it back would put it in the HTML, in
the browser's history of form state and in any proxy or screenshot of the page (I-CRED-1). Without
help the admin pastes the secret again on every failure. After a failed check that is the common
case: the admin wants to save anyway, and must find the secret again to do it.

The page may not hold the plaintext, but it may hold something only the gateway can open. The
gateway already has an envelope format with a key hierarchy and AAD binding
([ADR 0004](0004-envelope-encryption-bound-to-destination.md)). Admin responses are
`Cache-Control: no-store`.

## Decision

- **When.** A POST to create a token (`/admin/tokens`), to rotate a secret (`/admin/tokens/:id/secret`)
  or to change a destination (`/admin/tokens/:id/destination`) that carried a non-empty secret and
  is re-rendered gets a hidden field `credential_draft`. A secret that fails the local format check
  (`normalizeCredential`), or is refused by the wrong-type guard, gets none.
- **Format.** `cd1.<expires_at>.<destination fingerprint>.<base64url(sealed v1)>`. The sealed value
  is the ADR 0004 envelope under the active key with its own AAD label,
  `tokengate/v1/credential-draft`, over the user id, the login provider and subject, the target
  (`new` or the service id), the normalized base URL, `expires_at`, and the canonical injection
  (`credentialDraftAad`, no newline in any field). `expires_at` is now + 15 minutes, carried in clear
  so the AAD can be rebuilt; changing it fails authentication. The fingerprint is a truncated
  SHA-256 of the base URL and injection, both shown on the page anyway. It only tells "the
  destination changed" from "tampered or someone else's"; the AAD binds the destination itself.
- **Domain separation.** The draft label differs from the stored-credential label, so a draft never
  opens as a stored credential and a stored sealed value pasted as a draft never opens.
- **No renewal.** A draft is sealed only from plaintext that arrived in the same request. A
  re-render that used a draft echoes the same string, so its lifetime cannot be extended by
  resubmitting it.
- **On submit.** A non-empty secret wins. Otherwise the draft is opened. A destination mismatch is
  the field error "Enter the secret again: the destination changed"; an expired, tampered or other
  user's draft, or one whose key is no longer loaded, is "Enter the secret again". The hint next to
  the field says "Secret kept for 15 minutes (…WXYZ, 34 characters). Leave this field empty to use
  it, or enter another." The field is not `required` while a draft is held.
- **Never stored.** Drafts never go to D1, logs, audit diffs or the export. Without a loaded keyring
  there is no draft; secret changes are refused then anyway.
- **The destination confirmation is unchanged.** A draft never satisfies `confirm_destination`
  (I-CRED-2): the admin types the host on every submit that needs it.

## Consequences

- After a failed check the admin saves with one click ("Save without a passing check"), and a typo
  in another field costs no second paste.
- The HTML of a re-render holds ciphertext of the secret for 15 minutes. Anyone who can read that
  page cannot open it without the keyring and the admin's identity; a different signed-in user
  cannot use it.
- A key rotation that removes the active key within 15 minutes of a re-render makes that draft
  unusable; the admin pastes the secret again.
- `apps/gateway/src/admin/ops/credential-draft.ts` and `credentialDraftAad` in
  `apps/gateway/src/crypto/envelope.ts` hold the format;
  `apps/gateway/test/security/credential-draft.test.ts` pins every rule above.
