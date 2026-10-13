import { describe, expect, it } from 'vitest';
import type { Injection } from '../../../src/policy/types';
import {
  findSecretRanges,
  injectCredentialHeaders,
  injectedHeaderName,
  secretVariants,
} from '../../../src/proxy/inject';

function injected(injection: Injection, secret: string): Record<string, string> {
  const headers = new Headers();
  injectCredentialHeaders(headers, injection, secret);
  return Object.fromEntries(headers);
}

describe('I-INJ-1: injectCredentialHeaders', () => {
  it('bearer sets Authorization: Bearer', () => {
    expect(injected({ kind: 'bearer' }, 'xoxb-1')).toEqual({ authorization: 'Bearer xoxb-1' });
  });

  it('header sets the named header with an optional prefix', () => {
    expect(injected({ kind: 'header', name: 'x-api-key' }, 'sk-1')).toEqual({
      'x-api-key': 'sk-1',
    });
    expect(injected({ kind: 'header', name: 'X-Auth', prefix: 'Token ' }, 'abc')).toEqual({
      'x-auth': 'Token abc',
    });
  });

  it('basic encodes username:secret, or a user:pass secret as-is', () => {
    expect(injected({ kind: 'basic', username: 'api' }, 'p@ss')).toEqual({
      authorization: `Basic ${btoa('api:p@ss')}`,
    });
    expect(injected({ kind: 'basic' }, 'user:pass')).toEqual({
      authorization: `Basic ${btoa('user:pass')}`,
    });
  });

  it('basic encodes non-ASCII usernames as UTF-8 (RFC 7617)', () => {
    const value = injected({ kind: 'basic', username: 'é' }, 'x').authorization;
    expect(value).toBe('Basic w6k6eA==');
  });

  it('replaces an existing value instead of appending', () => {
    const headers = new Headers({ authorization: 'Bearer caller' });
    injectCredentialHeaders(headers, { kind: 'bearer' }, 'server');
    expect(headers.get('authorization')).toBe('Bearer server');
  });

  it('does nothing for query and path injection', () => {
    expect(injected({ kind: 'query', param: 'key' }, 's')).toEqual({});
    expect(injected({ kind: 'path' }, 's')).toEqual({});
  });

  it('throws a fixed message without the value for unusable credentials', () => {
    for (const secret of ['', 'a\r\nx-evil: 1', 'tab\there', 'ünï']) {
      expect(() => injected({ kind: 'header', name: 'x-api-key' }, secret)).toThrowError(
        /^tokengate: service credential is not a valid header value$/,
      );
    }
  });

  it('names the injected header', () => {
    expect(injectedHeaderName({ kind: 'bearer' })).toBe('authorization');
    expect(injectedHeaderName({ kind: 'basic' })).toBe('authorization');
    expect(injectedHeaderName({ kind: 'header', name: 'X-Api-Key' })).toBe('x-api-key');
    expect(injectedHeaderName({ kind: 'query', param: 'k' })).toBeNull();
    expect(injectedHeaderName({ kind: 'path' })).toBeNull();
  });
});

describe('I-CRED-1: secretVariants', () => {
  it('includes raw and URL-encoded forms', () => {
    const variants = secretVariants({ kind: 'bearer' }, 'a/b+c!d');
    expect(variants).toContain('a/b+c!d');
    expect(variants).toContain('a%2Fb%2Bc!d');
    expect(variants).toContain('a%2fb%2bc!d');
    expect(variants).toContain('a%2Fb%2Bc%21d');
  });

  it('includes the base64 user-pass for basic', () => {
    const variants = secretVariants({ kind: 'basic', username: 'u' }, 'pw');
    expect(variants).toContain(btoa('u:pw').replace(/=+$/, ''));
  });

  it('includes the secret part of a "user:pass" credential when no username is configured', () => {
    expect(secretVariants({ kind: 'basic' }, 'user:p/w')).toEqual(
      expect.arrayContaining(['user:p/w', 'p/w', 'p%2Fw']),
    );
    expect(secretVariants({ kind: 'basic' }, 'sk_live_1:')).toContain('sk_live_1');
    expect(secretVariants({ kind: 'basic', username: 'u' }, 'a:b')).not.toContain('b');
  });

  it('returns no variants for an empty secret', () => {
    expect(secretVariants({ kind: 'bearer' }, '')).toEqual([]);
  });

  it('adds each path-secret segment of 16+ characters, not short identifiers', () => {
    const variants = secretVariants({ kind: 'path' }, 'T0001/B0002/abcdefghijklmnopqrstuvwx');
    expect(variants).toContain('abcdefghijklmnopqrstuvwx');
    expect(variants).not.toContain('T0001');
    expect(variants).not.toContain('B0002');
    expect(secretVariants({ kind: 'bearer' }, 'a/abcdefghijklmnopqrstuvwx')).not.toContain(
      'abcdefghijklmnopqrstuvwx',
    );
  });

  it('includes base64 and base64url cores that match at every byte alignment', () => {
    const secret = 'sk-live~0123456789?>?>?>';
    const variants = secretVariants({ kind: 'bearer' }, secret);
    for (const prefix of ['', 'B', 'Be', 'Bearer ']) {
      const b64 = btoa(prefix + secret);
      const url = b64.replaceAll('+', '-').replaceAll('/', '_');
      expect(findSecretRanges(`x ${b64} y`, variants), prefix).not.toEqual([]);
      expect(findSecretRanges(`x ${url} y`, variants), prefix).not.toEqual([]);
    }
  });

  it('skips base64 cores of short secrets', () => {
    expect(secretVariants({ kind: 'bearer' }, 'abc')).toEqual(['abc']);
  });
});

describe('I-RESP-1: findSecretRanges', () => {
  const variants = secretVariants({ kind: 'bearer' }, "tok{abc}'x=0123456789");

  it('matches raw and any mix of percent-encoding, in either hex case', () => {
    for (const text of [
      "a tok{abc}'x=0123456789 b",
      'a tok%7Babc%7D%27x%3D0123456789 b',
      'a tok%7babc}%27x=%30123456789 b',
    ]) {
      expect(findSecretRanges(text, variants), text).toEqual([[2, text.length - 2]]);
    }
  });

  it('ignores malformed escapes and unrelated text', () => {
    expect(findSecretRanges('%zz %4 tok{abc} 100%', variants)).toEqual([]);
  });

  it('merges overlapping and adjacent matches', () => {
    expect(findSecretRanges('aaaa', ['aa', 'aaa'])).toEqual([[0, 4]]);
  });
});

describe('I-INJ-1: unknown injection kinds fail closed', () => {
  it('throws instead of setting a header for a kind it does not know', () => {
    const headers = new Headers();
    const invalid = { kind: 'invalid' } as unknown as Parameters<typeof injectCredentialHeaders>[1];
    expect(() => injectCredentialHeaders(headers, invalid, 'secret-value')).toThrow(
      'unknown injection kind',
    );
    expect([...headers.keys()]).toEqual([]);
  });
});
