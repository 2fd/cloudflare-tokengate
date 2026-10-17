import { describe, expect, it } from 'vitest';
import { authoritativeEmails, normalizeEmail } from '../../../../src/admin/auth/email';

describe('I-LINK-1: authoritativeEmails', () => {
  describe('access', () => {
    it('uses the validated JWT email', () => {
      expect(authoritativeEmails('access', { email: 'Ops@Acme.com' })).toEqual(['ops@acme.com']);
    });
    it('rejects a missing email (credentials)', () => {
      expect(authoritativeEmails('access', { email: undefined })).toEqual([]);
    });
    it('rejects a non-string email', () => {
      expect(authoritativeEmails('access', { email: ['ops@acme.com'] })).toEqual([]);
    });
  });

  describe('dev', () => {
    it('uses the configured AUTH_ACCESS_DEVELOPMENT', () => {
      expect(authoritativeEmails('dev', { email: 'Dev@Example.com' })).toEqual(['dev@example.com']);
    });
  });

  it('an unknown login provider proves no email', () => {
    expect(authoritativeEmails('github' as 'access', { email: 'a@acme.com' })).toEqual([]);
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
