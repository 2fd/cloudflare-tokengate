// The only email trust predicate (I-LINK-1). Invite linking and bootstrap use the emails
// returned here and nothing else; an email that is not authoritative is never used to grant access.
import type { LoginProviderId } from './resolve-login';

export interface EmailEvidence {
  /** `email` claim of a validated Cloudflare Access JWT. */
  access: { email: unknown };
  /** AUTH_DEV_EMAIL, accepted only on loopback hosts (src/admin/auth/identity.ts). */
  dev: { email: unknown };
}

/**
 * Lowercased emails this login proves control of:
 * - access: the email of the validated Access JWT. Access only issues it after the identity
 *   provider configured in Zero Trust authenticated the user.
 * - dev: the configured AUTH_DEV_EMAIL.
 */
export function authoritativeEmails<P extends LoginProviderId>(
  loginProvider: P,
  evidence: EmailEvidence[P],
): string[] {
  switch (loginProvider) {
    case 'access':
    case 'dev': {
      const email = normalizeEmail(evidence.email);
      return email === null ? [] : [email];
    }
    default:
      return [];
  }
}

const EMAIL_MAX = 254;

/** Lowercased address with exactly one `@`, non-empty parts, no whitespace or controls; else null. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX) return null;
  // oxlint-disable-next-line eslint/no-control-regex -- rejecting control characters is the point.
  if (/[\s\x00-\x1f\x7f]/.test(email)) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) return null;
  return email;
}
