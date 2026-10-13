import { describe, expect, it } from 'vitest';
import {
  GLOB_MAX_PATTERN_LENGTH,
  GLOB_MAX_VALUE_LENGTH,
  globError,
  globMatch,
} from '../../../src/policy/glob';
import vectors from '../../vectors/glob.json';

describe('glob vectors (test/vectors/glob.json)', () => {
  for (const v of vectors.matches) {
    it(`${JSON.stringify(v.pattern)} ${v.match ? 'matches' : 'does not match'} ${JSON.stringify(v.value.slice(0, 40))}`, () => {
      expect(globError(v.pattern)).toBeNull();
      expect(globMatch(v.pattern, v.value)).toBe(v.match);
    });
  }
  for (const v of vectors.invalid) {
    it(`rejects ${JSON.stringify(v.pattern)} (${v.note})`, () => {
      expect(globError(v.pattern)).not.toBeNull();
      expect(globMatch(v.pattern, v.pattern)).toBe(false);
    });
  }
  for (const v of vectors.valid) {
    it(`accepts ${JSON.stringify(v.pattern)} (${v.note})`, () => {
      expect(globError(v.pattern)).toBeNull();
    });
  }
});

describe('glob limits', () => {
  it('rejects patterns longer than the limit', () => {
    expect(globError('/'.repeat(GLOB_MAX_PATTERN_LENGTH))).toBeNull();
    expect(globError('/'.repeat(GLOB_MAX_PATTERN_LENGTH + 1))).not.toBeNull();
  });

  it('never matches values longer than the limit, even with **', () => {
    expect(globMatch('**', 'a'.repeat(GLOB_MAX_VALUE_LENGTH))).toBe(true);
    expect(globMatch('**', 'a'.repeat(GLOB_MAX_VALUE_LENGTH + 1))).toBe(false);
  });

  // A backtracking matcher explores ~C(1024, 8) splits here and would hit the test timeout.
  it('finishes on adversarial inputs at the size limits', () => {
    const pattern = `${'**a'.repeat(8)}b`.padEnd(GLOB_MAX_PATTERN_LENGTH, 'c');
    const value = 'a/'.repeat(GLOB_MAX_VALUE_LENGTH / 2);
    for (let i = 0; i < 20; i++) expect(globMatch(pattern, value)).toBe(false);
  });
});

/** Reference semantics from docs/policies.md as a RegExp. Fine in a test; the matcher itself avoids RegExp. */
function referenceMatch(pattern: string, value: string): boolean {
  let source = '';
  for (const piece of pattern.match(/\*+|[^*]/g) ?? []) {
    if (piece === '*') source += '[^/]*';
    else if (piece.startsWith('*')) source += '[\\s\\S]*';
    else source += piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(value);
}

/** Deterministic linear congruential generator, so failures are reproducible. */
function generator(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % n;
  };
}

describe('glob agrees with the reference semantics', () => {
  it('on 20000 random short patterns and values', () => {
    const next = generator(7);
    const word = (alphabet: string, max: number) =>
      Array.from({ length: next(max + 1) }, () => alphabet[next(alphabet.length)]).join('');
    const mismatches: string[] = [];
    for (let i = 0; i < 20000; i++) {
      const pattern = word('ab/*', 8) || '*';
      const value = word('ab/', 8);
      if (globMatch(pattern, value) !== referenceMatch(pattern, value)) {
        mismatches.push(`${JSON.stringify(pattern)} vs ${JSON.stringify(value)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('compares UTF-16 code units, so astral characters are literal and * spans them', () => {
    expect(globMatch('/😀/*', '/😀/x')).toBe(true);
    expect(globMatch('/*/x', '/😀/x')).toBe(true);
    expect(globMatch('/😀', '/😁')).toBe(false);
  });
});
