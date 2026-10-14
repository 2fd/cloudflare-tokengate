import { describe, expect, it } from 'vitest';
import {
  csrfCheck,
  csrfTokenMatches,
  isUnsafeMethod,
  requestFromSameSite,
} from '../../../../src/admin/auth/csrf';

const ORIGIN = 'https://gw.test';

describe('requestFromSameSite', () => {
  it.each([
    [{ 'sec-fetch-site': 'same-origin' }, true],
    [{ 'sec-fetch-site': 'none' }, true],
    [{ 'sec-fetch-site': 'same-site' }, false],
    [{ 'sec-fetch-site': 'cross-site' }, false],
    [{ 'sec-fetch-site': 'cross-site', origin: ORIGIN }, false],
    [{ origin: ORIGIN }, true],
    [{ origin: 'https://evil.test' }, false],
    [{ origin: 'null' }, false],
    [{ origin: `${ORIGIN}.evil.test` }, false],
    [{ origin: 'http://gw.test' }, false],
    [{}, false],
  ])('%j → %s', (headers, expected) => {
    expect(requestFromSameSite(new Headers(headers), ORIGIN)).toBe(expected);
  });
});

describe('csrfTokenMatches', () => {
  it.each([
    ['token-a', 'token-a', true],
    ['token-a', 'token-b', false],
    ['token-a', 'token-a-longer', false],
    ['', '', false],
    ['token-a', null, false],
    [undefined, 'token-a', false],
    [['token-a'], 'token-a', false],
  ])('%j vs %j → %s', async (submitted, expected, result) => {
    expect(await csrfTokenMatches(submitted, expected)).toBe(result);
  });
});

describe('csrfCheck', () => {
  it('requires both layers', async () => {
    const sameSite = new Headers({ 'sec-fetch-site': 'same-origin' });
    const crossSite = new Headers({ 'sec-fetch-site': 'cross-site' });
    const base = { canonicalOrigin: ORIGIN, cookieToken: 't' };
    expect(await csrfCheck({ ...base, headers: sameSite, submittedToken: 't' })).toBe(true);
    expect(await csrfCheck({ ...base, headers: sameSite, submittedToken: 'x' })).toBe(false);
    expect(await csrfCheck({ ...base, headers: crossSite, submittedToken: 't' })).toBe(false);
  });

  it('fails without the cookie, even when the field is empty too', async () => {
    const sameSite = new Headers({ 'sec-fetch-site': 'same-origin' });
    const base = { canonicalOrigin: ORIGIN, headers: sameSite, cookieToken: null };
    expect(await csrfCheck({ ...base, submittedToken: 't' })).toBe(false);
    expect(await csrfCheck({ ...base, submittedToken: '' })).toBe(false);
  });
});

describe('isUnsafeMethod', () => {
  it.each([
    ['GET', false],
    ['head', false],
    ['OPTIONS', false],
    ['POST', true],
    ['PUT', true],
    ['DELETE', true],
    ['PATCH', true],
  ])('%s → %s', (method, expected) => {
    expect(isUnsafeMethod(method)).toBe(expected);
  });
});
