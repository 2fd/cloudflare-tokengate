import { describe, expect, it } from 'vitest';
import type { Injection } from '../../../src/policy/types';
import {
  buildUpstreamUrl,
  canonicalizePath,
  credentialPathSegment,
  MAX_PATH_LENGTH,
  parseBaseUrl,
  removeQueryParam,
} from '../../../src/proxy/path';
import vectors from '../../vectors/paths.json';

describe('I-PATH-1: canonicalizePath vectors', () => {
  it.each(vectors.accept)('accepts $path', ({ path, matchPath }) => {
    const result = canonicalizePath(path);
    expect(result).toEqual({ ok: true, path: path === '' ? '/' : path, matchPath });
  });

  it.each(vectors.reject)('rejects $path ($reason)', ({ path }) => {
    expect(canonicalizePath(path)).toEqual({ ok: false });
  });

  it('rejects paths longer than the limit', () => {
    const ok = `/${'a'.repeat(MAX_PATH_LENGTH - 1)}`;
    expect(canonicalizePath(ok).ok).toBe(true);
    expect(canonicalizePath(`${ok}a`).ok).toBe(false);
  });

  it('rejects every raw control character', () => {
    for (let code = 0; code <= 0x1f; code++) {
      expect(canonicalizePath(`/a${String.fromCharCode(code)}b`).ok).toBe(false);
    }
    expect(canonicalizePath('/a\u007fb').ok).toBe(false);
  });
});

/** Deterministic PRNG (mulberry32) so fuzz failures are reproducible. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('I-PATH-1: fuzzed paths never escape the base path', () => {
  const tokens = [
    '/',
    '/',
    'a',
    'b.',
    '.',
    '..',
    '%2e',
    '%2E',
    '%2f',
    '%2F',
    '%5c',
    '\\',
    '%25',
    '%',
    ';',
    '?',
    '#',
    ' ',
    '%00',
    '%0a',
    ':',
    '@',
    'http:',
    '%c0%ae',
    '%C0%AF',
    '%41',
    '~',
    '%3b',
  ];
  const random = prng(1);
  const paths = Array.from({ length: 20000 }, () => {
    const length = 1 + Math.floor(random() * 8);
    let path = '';
    for (let i = 0; i < length; i++) path += tokens[Math.floor(random() * tokens.length)];
    return path;
  });

  it('accepted paths have no dot, empty or backslash segments, even after decoding', () => {
    let accepted = 0;
    for (const path of paths) {
      const result = canonicalizePath(path);
      if (!result.ok) continue;
      accepted++;
      const decoded = decodeURIComponent(result.path);
      expect(decoded).not.toMatch(/[\\;]/);
      expect(
        [...decoded].some((c) => c < ' ' || c === '\u007f'),
        path,
      ).toBe(false);
      const segments = decoded.slice(1).split('/');
      segments.forEach((segment, i) => {
        expect(segment === '.' || segment === '..', path).toBe(false);
        if (i < segments.length - 1) expect(segment, path).not.toBe('');
      });
      expect(result.matchPath.split('/').slice(1, -1), path).not.toContain('');
    }
    expect(accepted).toBeGreaterThan(100);
  });

  it('accepted paths build a URL with the base origin and exactly base path + path', () => {
    for (const path of paths) {
      const canonical = canonicalizePath(path);
      const built = buildUpstreamUrl({
        baseUrl: 'https://api.example.com/base',
        path,
        search: '',
        injection: { kind: 'bearer' },
        secret: 's',
      });
      expect(built.ok, path).toBe(canonical.ok);
      if (!built.ok || !canonical.ok) continue;
      expect(built.url.origin).toBe('https://api.example.com');
      expect(built.url.pathname).toBe(`/base${canonical.path}`);
    }
  });
});

describe('I-PATH-1: buildUpstreamUrl vectors', () => {
  it.each(vectors.upstream)('$note', ({ baseUrl, injection, path, search, url }) => {
    const result = buildUpstreamUrl({
      baseUrl,
      path,
      search,
      injection: injection as Injection,
      secret: vectors.secret,
    });
    if (url === null) expect(result).toEqual({ ok: false });
    else expect(result.ok && result.url.href).toBe(url);
  });
});

describe('I-PATH-1: buildUpstreamUrl invariants', () => {
  const bearer: Injection = { kind: 'bearer' };

  it('never changes origin or leaves the base path for any accepted vector', () => {
    for (const { path } of vectors.accept) {
      const result = buildUpstreamUrl({
        baseUrl: 'https://api.example.com/base',
        path,
        search: '',
        injection: bearer,
        secret: 's',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.url.origin).toBe('https://api.example.com');
      expect(result.url.pathname.startsWith('/base/')).toBe(true);
    }
  });

  it('rejects every rejected vector even when called directly', () => {
    for (const { path } of vectors.reject) {
      const result = buildUpstreamUrl({
        baseUrl: 'https://api.example.com/base',
        path,
        search: '',
        injection: bearer,
        secret: 's',
      });
      expect(result).toEqual({ ok: false });
    }
  });

  it('treats a trailing slash on the base URL like none', () => {
    const result = buildUpstreamUrl({
      baseUrl: 'https://api.example.com/v1/',
      path: '/x',
      search: '',
      injection: bearer,
      secret: 's',
    });
    expect(result.ok && result.url.href).toBe('https://api.example.com/v1/x');
  });

  it('rejects base URLs that are not https, have credentials or fragments, or do not parse', () => {
    for (const baseUrl of [
      'http://api.example.com',
      'ftp://api.example.com',
      'https://u:p@api.example.com',
      'https://api.example.com/#x',
      'nope',
    ]) {
      expect(parseBaseUrl(baseUrl)).toBeNull();
      expect(
        buildUpstreamUrl({ baseUrl, path: '/x', search: '', injection: bearer, secret: 's' }),
      ).toEqual({ ok: false });
    }
  });

  it('accepts multi-segment path secrets (Slack webhooks: T0/B0/XYZ)', () => {
    const result = buildUpstreamUrl({
      baseUrl: 'https://hooks.slack.com/services',
      path: '/',
      search: '',
      injection: { kind: 'path' },
      secret: 'T000/B000/XXXX',
    });
    expect(result.ok && result.url.href).toBe('https://hooks.slack.com/services/T000/B000/XXXX');
  });

  it('rejects path-injection secrets with empty, dot or unsafe segments', () => {
    for (const secret of [
      '',
      '/a',
      'a/',
      'a//b',
      'a/../b',
      'a/./b',
      'a?b',
      'a#b',
      'a%2fb',
      'a b',
      '..',
      '.',
    ]) {
      expect(
        buildUpstreamUrl({
          baseUrl: 'https://hooks.example.com/x',
          path: '/',
          search: '',
          injection: { kind: 'path' },
          secret,
        }),
      ).toEqual({ ok: false });
    }
  });

  it('appends the secret to the last prefix segment and rejects unsafe prefixes', () => {
    expect(credentialPathSegment({ kind: 'path' }, 'tok')).toBe('/tok');
    expect(credentialPathSegment({ kind: 'path', prefix: '/bot' }, 'tok')).toBe('/bottok');
    expect(credentialPathSegment({ kind: 'path', prefix: '/v1/bot' }, 'tok')).toBe('/v1/bottok');
    expect(credentialPathSegment({ kind: 'path', prefix: '/v1/' }, 'tok')).toBe('/v1/tok');
    for (const prefix of ['/../', '//', '/a//b', '/./x', '/a b', '/a%2f', '/a?']) {
      expect(credentialPathSegment({ kind: 'path', prefix }, 'tok')).toBeNull();
    }
    expect(credentialPathSegment({ kind: 'path', prefix: 'bot' }, 'tok')).toBe('/bottok');
    expect(credentialPathSegment({ kind: 'bearer' }, 'tok')).toBe('');
  });

  it('URL-encodes the query credential', () => {
    const result = buildUpstreamUrl({
      baseUrl: 'https://api.example.com',
      path: '/x',
      search: '',
      injection: { kind: 'query', param: 'key' },
      secret: 'a+b&c=d',
    });
    expect(result.ok && result.url.search).toBe('?key=a%2Bb%26c%3Dd');
    expect(result.ok && result.url.searchParams.getAll('key')).toEqual(['a+b&c=d']);
  });

  it('keeps non-query injections from touching the caller query', () => {
    const result = buildUpstreamUrl({
      baseUrl: 'https://api.example.com',
      path: '/x',
      search: '?key=caller&b=+',
      injection: bearer,
      secret: 's',
    });
    expect(result.ok && result.url.search).toBe('?key=caller&b=+');
  });
});

describe('removeQueryParam', () => {
  it('removes plain, encoded, plus-decoded and differently cased copies', () => {
    expect(removeQueryParam('?api+key=1&x=2&api%20key=3&API_KEY=4', 'api key')).toBe(
      '?x=2&API_KEY=4',
    );
    expect(removeQueryParam('?token&token=&x', 'token')).toBe('?x');
    expect(removeQueryParam('?Token=1', 'token')).toBe('');
    expect(removeQueryParam('', 'token')).toBe('');
  });

  it('keeps the original bytes of other pairs', () => {
    expect(removeQueryParam('?a=%2F+b&&c', 'z')).toBe('?a=%2F+b&&c');
  });

  it('fails when a name cannot be decoded', () => {
    expect(removeQueryParam('?%zz=1', 'key')).toBeNull();
    expect(removeQueryParam('?k%65y%E0=1', 'key')).toBeNull();
  });

  it('fails when the parameter follows ";" inside a pair (I-INJ-1)', () => {
    expect(removeQueryParam('?a=1;key=caller', 'key')).toBeNull();
    expect(removeQueryParam('?a=1;%6Bey=caller', 'key')).toBeNull();
    expect(removeQueryParam('?key=1;a=2&b=3', 'key')).toBe('?b=3');
    expect(removeQueryParam('?a=1;b=2', 'key')).toBe('?a=1;b=2');
  });
});
