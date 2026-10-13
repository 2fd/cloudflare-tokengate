// The only email trust predicate (I-LINK-1). Invite linking and bootstrap use the emails
// returned here and nothing else; an email that is not authoritative is never used to grant access.
import type { OidcLogin } from '../../config';
import type { LoginProviderId } from './resolve-login';

export interface EmailEvidence {
  /** Entries of GitHub's GET /user/emails. */
  github: { emails: ReadonlyArray<{ email?: unknown; verified?: unknown }> };
  /** Validated ID token claims plus the login configuration they came from. */
  oidc: {
    claims: Readonly<Record<string, unknown>>;
    config: Pick<OidcLogin, 'kind' | 'allowedDomains'>;
  };
  /** `email` claim of a validated Cloudflare Access JWT. */
  access: { email: unknown };
}

/**
 * Lowercased emails this login proves control of:
 * - github: every address GitHub reports as `verified: true`.
 * - oidc: `email` when `email_verified === true` and its domain is allowed. For Google, `hd` must
 *   equal the email domain (Workspace account), or the address is @gmail.com with no `hd`
 *   (consumer account); with allowed domains set, `hd` must be present and listed. A consumer
 *   Google account registered with a company address therefore never qualifies.
 * - access: the email of the validated Access JWT.
 */
export function authoritativeEmails<P extends LoginProviderId>(
  loginProvider: P,
  evidence: EmailEvidence[P],
): string[] {
  switch (loginProvider) {
    case 'github': {
      const { emails } = evidence as EmailEvidence['github'];
      const verified = emails
        .filter((entry) => entry.verified === true)
        .map((entry) => normalizeEmail(entry.email))
        .filter((email) => email !== null);
      return [...new Set(verified)];
    }
    case 'oidc': {
      const { claims, config } = evidence as EmailEvidence['oidc'];
      const email = oidcEmail(claims, config);
      return email === null ? [] : [email];
    }
    case 'access': {
      const email = normalizeEmail((evidence as EmailEvidence['access']).email);
      return email === null ? [] : [email];
    }
    default:
      return [];
  }
}

function oidcEmail(
  claims: Readonly<Record<string, unknown>>,
  config: Pick<OidcLogin, 'kind' | 'allowedDomains'>,
): string | null {
  if (claims.email_verified !== true) return null;
  const email = normalizeEmail(claims.email);
  if (email === null) return null;
  const domain = emailDomain(email);
  const restricted = config.allowedDomains.length > 0;
  if (restricted && !config.allowedDomains.includes(domain)) return null;
  if (config.kind === 'google') {
    const hd = typeof claims.hd === 'string' ? claims.hd.toLowerCase() : null;
    if (hd === null) {
      if (restricted || domain !== 'gmail.com') return null;
    } else if (hd !== domain || (restricted && !config.allowedDomains.includes(hd))) {
      return null;
    }
  }
  return email;
}

const EMAIL_MAX = 254;

/** Lowercased address with exactly one `@`, non-empty parts, no whitespace or controls; else null. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  if (/[\s\x00-\x1f\x7f]/.test(email)) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) return null;
  return email;
}

function emailDomain(email: string): string {
  return email.slice(email.indexOf('@') + 1);
}
