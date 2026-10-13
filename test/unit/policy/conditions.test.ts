import { describe, expect, it } from 'vitest';
import type { Claims } from '../../../src/identity/types';
import { claimText, conditionShapeError, evaluateCondition } from '../../../src/policy/conditions';
import type { Condition } from '../../../src/policy/types';
import vectors from '../../vectors/conditions.json';

const revealNone: ReadonlySet<string> = new Set();

describe('I-AUTHZ-4: condition vectors (test/vectors/conditions.json)', () => {
  for (const v of vectors.cases) {
    it(v.name, () => {
      const result = evaluateCondition(v.condition as Condition, v.claims as Claims, revealNone);
      expect(result.ok).toBe(v.ok);
    });
  }
});

describe('I-AUTHZ-4: long claim values', () => {
  const long = `refs/heads/evil${'x'.repeat(1100)}`;

  it('a negated glob fails on a value too long to match', () => {
    const c: Condition = {
      claim: 'ref',
      match: 'glob',
      values: ['refs/heads/evil*'],
      negate: true,
    };
    expect(evaluateCondition(c, { ref: long }, revealNone)).toMatchObject({ ok: false });
  });

  it('exact comparison still sees the whole value', () => {
    const c: Condition = {
      claim: 'ref',
      match: 'exact',
      values: ['refs/heads/main'],
      negate: true,
    };
    expect(evaluateCondition(c, { ref: long }, revealNone).ok).toBe(true);
  });
});

describe('claimText', () => {
  it('converts only comparable scalars', () => {
    const claims: Claims = { s: 'x', t: true, f: false, n: 7, big: 2 ** 53, frac: 0.5, nil: null };
    expect(claimText(claims, 's')).toBe('x');
    expect(claimText(claims, 't')).toBe('true');
    expect(claimText(claims, 'f')).toBe('false');
    expect(claimText(claims, 'n')).toBe('7');
    expect(claimText(claims, 'big')).toBeNull();
    expect(claimText(claims, 'frac')).toBeNull();
    expect(claimText(claims, 'nil')).toBeNull();
    expect(claimText(claims, 'missing')).toBeNull();
  });

  it('reads own properties only, including a JSON "__proto__" key', () => {
    const claims = JSON.parse('{"__proto__": "x"}') as Claims;
    expect(claimText(claims, '__proto__')).toBe('x');
    expect(claimText({}, '__proto__')).toBeNull();
    expect(claimText({}, 'toString')).toBeNull();
  });
});

describe('evaluateCondition detail', () => {
  const c: Condition = { claim: 'ref', match: 'glob', values: ['refs/heads/*'] };

  it('echoes the value of revealed claims', () => {
    const result = evaluateCondition(c, { ref: 'refs/heads/x/y' }, new Set(['ref']));
    expect(result).toEqual({ ok: false, detail: 'ref="refs/heads/x/y" vs glob ["refs/heads/*"]' });
  });

  it('never echoes the value of other claims', () => {
    const result = evaluateCondition(c, { ref: 'secret-ish' }, revealNone);
    expect(result.detail).not.toContain('secret-ish');
    expect(result.detail).toContain('(hidden)');
  });

  it('names missing and non-scalar claims without values', () => {
    expect(evaluateCondition(c, {}, revealNone).detail).toBe('ref: claim missing');
    expect(evaluateCondition(c, { ref: ['a'] }, new Set(['ref'])).detail).toBe(
      'ref: claim is not a string, boolean or safe integer',
    );
  });

  it('marks negated conditions', () => {
    const negated: Condition = { ...c, negate: true };
    const result = evaluateCondition(negated, { ref: 'refs/heads/main' }, new Set(['ref']));
    expect(result).toEqual({
      ok: false,
      detail: 'ref="refs/heads/main" vs not glob ["refs/heads/*"]',
    });
  });
});

describe('conditionShapeError', () => {
  const valid: Condition = { claim: 'ref', match: 'exact', values: ['x'] };

  it.each([
    ['not an object', 'x'],
    ['empty claim', { ...valid, claim: '' }],
    ['claim too long', { ...valid, claim: 'c'.repeat(257) }],
    ['control char in claim', { ...valid, claim: 'a\nb' }],
    ['unknown match', { ...valid, match: 'regex' }],
    ['negate not boolean', { ...valid, negate: 'yes' }],
    ['no values', { ...valid, values: [] }],
    ['too many values', { ...valid, values: Array.from({ length: 51 }, (_, i) => `v${i}`) }],
    ['empty value', { ...valid, values: [''] }],
    ['value too long', { ...valid, values: ['v'.repeat(513)] }],
    ['non-string value', { ...valid, values: [1] }],
    ['invalid glob', { ...valid, match: 'glob', values: ['*/*/*/*/*/*/*/*/*'] }],
  ])('rejects %s', (_name, condition) => {
    expect(conditionShapeError(condition)).not.toBeNull();
  });

  it('accepts a well-formed condition', () => {
    expect(conditionShapeError(valid)).toBeNull();
    expect(
      conditionShapeError({ ...valid, match: 'glob', values: ['refs/*'], negate: true }),
    ).toBeNull();
  });
});

describe('I-AUTHZ-4: negation never turns an unusable claim into a match', () => {
  const values: unknown[] = [
    'main',
    '',
    'x'.repeat(2000),
    true,
    false,
    0,
    -0,
    42,
    2 ** 53,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    null,
    undefined,
    [],
    ['main'],
    {},
    { toString: 'main' },
  ];
  const conditions: Condition[] = [
    { claim: 'c', match: 'exact', values: ['main', 'true', '42'] },
    { claim: 'c', match: 'glob', values: ['m*', '**'] },
  ];

  for (const condition of conditions) {
    for (const value of values) {
      it(`${condition.match} on ${JSON.stringify(value)?.slice(0, 20) ?? String(value)}`, () => {
        const claims: Claims = { c: value };
        const plain = evaluateCondition(condition, claims, revealNone).ok;
        const negated = evaluateCondition({ ...condition, negate: true }, claims, revealNone).ok;
        const comparable = claimText(claims, 'c') !== null;
        const globTooLong =
          condition.match === 'glob' && typeof value === 'string' && value.length > 1024;
        if (comparable && !globTooLong) {
          expect(negated).toBe(!plain);
        } else {
          expect([plain, negated]).toEqual([false, false]);
        }
      });
    }
  }

  it('a claim whose name is only inherited is missing', () => {
    const condition: Condition = {
      claim: 'constructor',
      match: 'exact',
      values: ['x'],
      negate: true,
    };
    expect(evaluateCondition(condition, {}, revealNone).ok).toBe(false);
  });
});
