// Sealed credential drafts (ADR 0020): a secret typed into a form that is re-rendered (an error, a
// failed check) comes back sealed, so the admin does not paste it again. A draft opens only for the
// same user and login, the same target, the same destination (I-CRED-2) and within 15 minutes; it
// uses its own AAD label, so it can never open as a stored credential or the reverse. Plaintext is
// never rendered, stored, logged or put in an audit diff (I-CRED-1): only the sealed string is.
//
//   cd1.<expires_at ms>.<destination fingerprint>.<base64url(sealed v1 JSON)>
//
// The fingerprint (a truncated SHA-256 of the base URL and injection, both shown on the page
// anyway) only tells "the destination changed" from "tampered or not yours"; the AAD binds both.
import { credentialDraftAad, openCredential, sealCredential } from '../../crypto/envelope';
import { loadKeyring } from '../../crypto/keyring';
import type { Deps } from '../../deps';
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from '../../lib/encoding';

/** How long a draft opens after the re-render that sealed it. Never renewed. */
export const CREDENTIAL_DRAFT_TTL_MS = 15 * 60 * 1000;

/** Longest draft string accepted (a sealed 8 KiB secret is about 11.5 KB of base64url). */
const DRAFT_MAX_LENGTH = 16 * 1024;

const DRAFT_PATTERN = /^cd1\.([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/;

/** Who the draft is for and where its secret may go. */
export interface CredentialDraftContext {
  userId: string;
  loginProvider: string;
  subject: string;
  /** `new` while creating a token, else the service id. */
  target: string;
  /** Normalized base URL (validateBaseUrl). */
  baseUrl: string;
  /** Canonical injection JSON (normalizeInjection). */
  injectionJson: string;
}

export type OpenDraftResult =
  | { ok: true; credential: string }
  /**
   * `mismatch`: sealed for another destination; `expired`: older than the TTL; `invalid`:
   * malformed, tampered, another user's or target's; `unavailable`: no keyring or its key is gone.
   */
  | { ok: false; reason: 'expired' | 'mismatch' | 'invalid' | 'unavailable' };

/** `cd1.…` for `plaintext`, or null when no keyring is loaded (secrets cannot be saved then). */
export async function sealCredentialDraft(
  deps: Pick<Deps, 'env' | 'now' | 'random'>,
  context: CredentialDraftContext,
  plaintext: string,
): Promise<string | null> {
  const loaded = await loadKeyring(deps.env);
  if (!loaded.ok) return null;
  const expiresAt = deps.now() + CREDENTIAL_DRAFT_TTL_MS;
  const sealed = await sealCredential(
    loaded.keyring,
    plaintext,
    credentialDraftAad(binding(context, expiresAt)),
    deps.random,
  );
  const fingerprint = await destinationFingerprint(context);
  return `cd1.${expiresAt}.${fingerprint}.${toBase64Url(utf8(sealed))}`;
}

export async function openCredentialDraft(
  deps: Pick<Deps, 'env' | 'now'>,
  context: CredentialDraftContext,
  draft: string,
): Promise<OpenDraftResult> {
  if (typeof draft !== 'string' || draft.length > DRAFT_MAX_LENGTH) {
    return { ok: false, reason: 'invalid' };
  }
  const match = DRAFT_PATTERN.exec(draft);
  if (!match) return { ok: false, reason: 'invalid' };
  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt)) return { ok: false, reason: 'invalid' };
  if (deps.now() >= expiresAt) return { ok: false, reason: 'expired' };
  if (match[2] !== (await destinationFingerprint(context))) {
    return { ok: false, reason: 'mismatch' };
  }
  let sealed: string;
  try {
    sealed = fromUtf8(fromBase64Url(match[3] ?? ''));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const loaded = await loadKeyring(deps.env);
  if (!loaded.ok) return { ok: false, reason: 'unavailable' };
  const opened = await openCredential(
    loaded.keyring,
    sealed,
    credentialDraftAad(binding(context, expiresAt)),
  );
  if (opened.ok) return { ok: true, credential: opened.plaintext };
  return { ok: false, reason: opened.error === 'keyring_missing_key' ? 'unavailable' : 'invalid' };
}

/** The ms expiry carried in a draft string, or null when it is not one. Display only. */
export function draftExpiresAt(draft: string): number | null {
  const match = DRAFT_PATTERN.exec(draft);
  return match ? Number(match[1]) : null;
}

function binding(context: CredentialDraftContext, expiresAt: number) {
  return {
    userId: context.userId,
    loginProvider: context.loginProvider,
    subject: context.subject,
    target: context.target,
    baseUrl: context.baseUrl,
    injectionJson: context.injectionJson,
    expiresAt,
  };
}

async function destinationFingerprint(context: CredentialDraftContext): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    utf8(`${context.baseUrl}\n${context.injectionJson}`),
  );
  return toBase64Url(new Uint8Array(digest)).slice(0, 16);
}
