import { describe, expect, it } from 'vitest';
import { RETURN_TO_MAX, sanitizeReturnTo } from '../../../../src/admin/auth/session';

describe('sanitizeReturnTo', () => {
  it.each([
    ['/admin', '/admin'],
    ['/admin/', '/admin/'],
    ['/admin/services/svc_1?x=1', '/admin/services/svc_1?x=1'],
    ['/admin/grants#frag', '/admin/grants'],
    ['/admin/a/../b', '/admin/b'],
    ['/admin/?q=a\\b', '/admin/?q=a%5Cb'],
    [null, '/admin'],
    [undefined, '/admin'],
    ['', '/admin'],
    ['admin', '/admin'],
    ['/administrator', '/admin'],
    ['/admin/../auth/logout', '/admin'],
    ['/admin/%2e%2e/proxy/x', '/admin'],
    ['//evil.test/admin', '/admin'],
    ['/\\evil.test/admin', '/admin'],
    ['https://evil.test/admin', '/admin'],
    ['https://gw.test/admin', '/admin'],
    ['javascript:alert(1)//admin', '/admin'],
    ['/\t/evil.test/admin', '/admin'],
    [`/admin/${'a'.repeat(2000)}`, '/admin'],
  ])('%j → %j', (raw, expected) => {
    expect(sanitizeReturnTo(raw)).toBe(expected);
  });
});

describe('sanitizeReturnTo is idempotent and caps the serialized and JSON forms', () => {
  it.each([
    `/admin/${'é'.repeat(80)}`,
    `/admin/${'é'.repeat(200)}`,
    `/admin/${'<'.repeat(150)}`,
    `/admin/${'😀'.repeat(50)}`,
    '/admin/a b?c=<d>&e="f"',
    `/admin/?q=${'\\'.repeat(500)}`,
    `/admin/?q=${'\\'.repeat(100)}`,
    `/admin/?q=${'"'.repeat(100)}&r= \u0000\u007f`,
    `/admin/\\${'\\'.repeat(100)}`,
    `/admin/${'a'.repeat(RETURN_TO_MAX - 7)}`,
  ])('%#', (raw) => {
    const once = sanitizeReturnTo(raw);
    expect(once.length).toBeLessThanOrEqual(RETURN_TO_MAX);
    expect(JSON.stringify(once).length).toBe(once.length + 2);
    expect(sanitizeReturnTo(once)).toBe(once);
  });

  it('refuses a path whose encoded form exceeds the cap', () => {
    expect(sanitizeReturnTo(`/admin/${'é'.repeat(100)}`)).toBe('/admin');
  });
});
