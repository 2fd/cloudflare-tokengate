import { describe, expect, it } from 'vitest';
import { authoritativeEmails, normalizeEmail } from '../../../../src/admin/auth/email';

const oidc = { kind: 'oidc' as const, allowedDomains: [] as string[] };
const google = { kind: 'google' as const, allowedDomains: [] as string[] };
const googleAcme = { kind: 'google' as const, allowedDomains: ['acme.com'] };

describe('authoritativeEmails', () => {
  describe('github', () => {
    it('keeps only verified addresses, lowercased and deduplicated', () => {
      expect(
        authoritativeEmails('github', {
          emails: [
            { email: 'Dev@Acme.com', verified: true },
            { email: 'dev@acme.com', verified: true },
            { email: 'unverified@acme.com', verified: false },
            { email: 'missing-flag@acme.com' },
            { email: 'truthy@acme.com', verified: 'true' },
            { email: 42, verified: true },
          ],
        }),
      ).toEqual(['dev@acme.com']);
    });
  });

  describe('oidc', () => {
    const cases: Array<[string, Record<string, unknown>, typeof oidc | typeof google, string[]]> = [
      ['verified email', { email: 'a@corp.com', email_verified: true }, oidc, ['a@corp.com']],
      ['email_verified missing', { email: 'a@corp.com' }, oidc, []],
      ['email_verified "true" string', { email: 'a@corp.com', email_verified: 'true' }, oidc, []],
      ['email_verified false', { email: 'a@corp.com', email_verified: false }, oidc, []],
      ['no email', { email_verified: true }, oidc, []],
      [
        'domain allowed',
        { email: 'a@corp.com', email_verified: true },
        { kind: 'oidc', allowedDomains: ['corp.com'] },
        ['a@corp.com'],
      ],
      [
        'domain not allowed',
        { email: 'a@evil.com', email_verified: true },
        { kind: 'oidc', allowedDomains: ['corp.com'] },
        [],
      ],
      [
        'subdomain is not the allowed domain',
        { email: 'a@x.corp.com', email_verified: true },
        { kind: 'oidc', allowedDomains: ['corp.com'] },
        [],
      ],
    ];
    for (const [name, claims, config, expected] of cases) {
      it(name, () => {
        expect(authoritativeEmails('oidc', { claims, config })).toEqual(expected);
      });
    }
  });

  describe('I-LINK-1: Google hd rules', () => {
    const cases: Array<[string, Record<string, unknown>, typeof google, string[]]> = [
      [
        'Workspace account (hd = domain)',
        { email: 'a@acme.com', email_verified: true, hd: 'acme.com' },
        google,
        ['a@acme.com'],
      ],
      [
        'consumer gmail account',
        { email: 'a@gmail.com', email_verified: true },
        google,
        ['a@gmail.com'],
      ],
      [
        'consumer account registered with a company address (no hd)',
        { email: 'a@acme.com', email_verified: true },
        google,
        [],
      ],
      [
        'hd differs from the email domain',
        { email: 'a@acme.com', email_verified: true, hd: 'other.com' },
        google,
        [],
      ],
      [
        'allowed domains: Workspace account of that domain',
        { email: 'a@acme.com', email_verified: true, hd: 'acme.com' },
        googleAcme,
        ['a@acme.com'],
      ],
      [
        'allowed domains: consumer account with the allowed domain address',
        { email: 'a@acme.com', email_verified: true },
        googleAcme,
        [],
      ],
      [
        'allowed domains: gmail without hd',
        { email: 'a@gmail.com', email_verified: true },
        googleAcme,
        [],
      ],
      [
        'allowed domains: other Workspace',
        { email: 'a@other.com', email_verified: true, hd: 'other.com' },
        googleAcme,
        [],
      ],
      [
        'unverified Workspace email',
        { email: 'a@acme.com', email_verified: false, hd: 'acme.com' },
        googleAcme,
        [],
      ],
    ];
    for (const [name, claims, config, expected] of cases) {
      it(name, () => {
        expect(authoritativeEmails('oidc', { claims, config })).toEqual(expected);
      });
    }
  });

  describe('access', () => {
    it('uses the validated JWT email', () => {
      expect(authoritativeEmails('access', { email: 'Ops@Acme.com' })).toEqual(['ops@acme.com']);
    });
    it('rejects a missing email (service tokens)', () => {
      expect(authoritativeEmails('access', { email: undefined })).toEqual([]);
    });
  });
});

describe('normalizeEmail', () => {
  it.each([
    [' A@B.com ', 'a@b.com'],
    ['a@b', 'a@b'],
    ['a', null],
    ['@b.com', null],
    ['a@', null],
    ['a@@b.com', null],
    ['a@b@c.com', null],
    ['a b@c.com', null],
    ['a\u0000@c.com', null],
    ['', null],
    [`${'x'.repeat(250)}@b.com`, null],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
  });
});
