import { describe, expect, it } from 'vitest';
import {
  eventSummary,
  formatConditions,
  formatRules,
  parseConditions,
  parseRules,
} from '../../../src/admin/grant-text';
import { PROFILES } from '../../../src/identity/profiles';
import type { Condition, Rule } from '../../../src/policy/types';
import { PROXY_METHODS } from '../../../src/policy/types';

function conditions(text: string): Condition[] {
  const parsed = parseConditions(text);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.conditions;
}

describe('parseConditions', () => {
  it('parses exact, glob, negation and value lists', () => {
    expect(
      conditions(
        [
          'repository_owner_id exact 4242',
          'repository_id exact 1, 2,3',
          'ref glob refs/heads/release/*',
          'not event_name exact pull_request_target',
        ].join('\n'),
      ),
    ).toEqual([
      { claim: 'repository_owner_id', match: 'exact', values: ['4242'] },
      { claim: 'repository_id', match: 'exact', values: ['1', '2', '3'] },
      { claim: 'ref', match: 'glob', values: ['refs/heads/release/*'] },
      { claim: 'event_name', match: 'exact', values: ['pull_request_target'], negate: true },
    ]);
  });

  it('ignores blank lines, comments and surrounding whitespace; match is case-insensitive', () => {
    expect(
      conditions('\n  # owner\n  sub   EXACT   repo:acme/app:ref:refs/heads/main  \r\n'),
    ).toEqual([{ claim: 'sub', match: 'exact', values: ['repo:acme/app:ref:refs/heads/main'] }]);
  });

  it('reads JSON-quoted claims and values', () => {
    expect(conditions('"my claim" exact "a, b", " padded ", "", plain')).toEqual([
      { claim: 'my claim', match: 'exact', values: ['a, b', ' padded ', '', 'plain'] },
    ]);
  });

  it('treats a bare leading "not" as negation and a quoted "not" as a claim', () => {
    expect(parseConditions('not exact v').ok).toBe(false);
    expect(conditions('"not" exact v')).toEqual([{ claim: 'not', match: 'exact', values: ['v'] }]);
    expect(conditions('not not exact v')).toEqual([
      { claim: 'not', match: 'exact', values: ['v'], negate: true },
    ]);
  });

  it('reports every bad line with its line number', () => {
    const parsed = parseConditions(
      ['ref exact main', 'ref contains main', 'ref exact', 'ref exact a,,b', 'x exact "open'].join(
        '\n',
      ),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toHaveLength(4);
    expect(parsed.errors[0]).toMatch(/^condition line 2: match must be "exact" or "glob"/);
    expect(parsed.errors[1]).toMatch(/^condition line 3: .*at least one value/);
    expect(parsed.errors[2]).toMatch(/^condition line 4: empty value/);
    expect(parsed.errors[3]).toMatch(/^condition line 5: /);
  });

  it('rejects a trailing comma and text after a quoted value', () => {
    expect(parseConditions('ref exact a,').ok).toBe(false);
    expect(parseConditions('ref exact "a" b').ok).toBe(false);
  });
});

describe('parseRules', () => {
  it('parses method lists, * and paths', () => {
    const parsed = parseRules('GET /repos/**\npost, put /chat.postMessage\n* /\n# comment');
    expect(parsed).toEqual({
      ok: true,
      rules: [
        { methods: ['GET'], path: '/repos/**' },
        { methods: ['POST', 'PUT'], path: '/chat.postMessage' },
        { methods: ['*'], path: '/' },
      ],
    });
  });

  it('requires methods and a path starting with /', () => {
    const parsed = parseRules('GET repos/x\n/only-a-path\nGET /a b');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((error) => error.slice(0, 12))).toEqual([
      'rule line 1:',
      'rule line 2:',
      'rule line 3:',
    ]);
  });
});

describe('format', () => {
  it('writes one condition per line, quoting only when needed', () => {
    expect(
      formatConditions([
        { claim: 'repository_id', match: 'exact', values: ['1', '2'] },
        { claim: 'event_name', match: 'exact', values: ['push'], negate: true },
        { claim: 'odd claim', match: 'glob', values: ['a,b', '#x', 'ok*'] },
        { claim: 'not', match: 'exact', values: ['"q"'] },
      ]),
    ).toBe(
      [
        'repository_id exact 1, 2',
        'not event_name exact push',
        '"odd claim" glob "a,b", "#x", ok*',
        '"not" exact "\\"q\\""',
      ].join('\n'),
    );
    expect(formatRules([{ methods: ['GET', 'HEAD'], path: '/x/**' }])).toBe('GET,HEAD /x/**');
  });
});

// Deterministic PRNG (mulberry32) so failures reproduce.
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [...'abcXYZ019_-./:@*', ' ', ',', '"', '\\', '#', '\t', '\n', 'é', '\u0001'];

function randomText(next: () => number, maxLength: number, minLength = 0): string {
  const length = minLength + Math.floor(next() * (maxLength - minLength + 1));
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return out;
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T;
}

describe('round trip', () => {
  it('parseConditions(formatConditions(x)) returns x for arbitrary claims and values', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = prng(seed);
      const input: Condition[] = [];
      const count = 1 + Math.floor(next() * 5);
      for (let i = 0; i < count; i++) {
        const condition: Condition = {
          claim: next() < 0.1 ? pick(next, ['not', 'exact', '#c']) : randomText(next, 12, 1),
          match: pick(next, ['exact', 'glob'] as const),
          values: Array.from({ length: 1 + Math.floor(next() * 4) }, () => randomText(next, 10)),
        };
        if (next() < 0.3) condition.negate = true;
        input.push(condition);
      }
      const text = formatConditions(input);
      expect(text.split('\n')).toHaveLength(input.length);
      const parsed = parseConditions(text);
      expect(parsed, `seed ${seed}: ${text}`).toEqual({ ok: true, conditions: input });
    }
  });

  it('parseRules(formatRules(x)) returns x for valid rules', () => {
    const methods = [...PROXY_METHODS, '*'] as const;
    for (let seed = 1; seed <= 300; seed++) {
      const next = prng(seed);
      const input: Rule[] = Array.from({ length: 1 + Math.floor(next() * 4) }, () => ({
        methods: Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(next, methods)),
        path: `/${Array.from({ length: Math.floor(next() * 4) }, () => pick(next, ['a', '*', '**', 'x.y', '%2F', 'v1'])).join('/')}`,
      }));
      const text = formatRules(input);
      expect(parseRules(text), `seed ${seed}: ${text}`).toEqual({ ok: true, rules: input });
    }
  });
});

describe('eventSummary', () => {
  const github = PROFILES['github-actions'];

  it('accepts only trusted events when no event condition is present', () => {
    expect(eventSummary([{ claim: 'ref', match: 'exact', values: ['x'] }], github)).toEqual({
      claim: 'event_name',
      trusted: ['push', 'workflow_dispatch', 'schedule', 'release'],
      optedIn: [],
      restricted: false,
    });
  });

  it('lists opted-in untrusted events; globs and negations never opt in', () => {
    const summary = eventSummary(
      [
        { claim: 'event_name', match: 'exact', values: ['push', 'pull_request'] },
        { claim: 'event_name', match: 'glob', values: ['*'] },
        { claim: 'event_name', match: 'exact', values: ['workflow_run'], negate: true },
      ],
      github,
    );
    expect(summary).toEqual({
      claim: 'event_name',
      trusted: ['push'],
      optedIn: ['pull_request'],
      restricted: true,
    });
  });

  it('intersects several exact event conditions', () => {
    const summary = eventSummary(
      [
        { claim: 'event_name', match: 'exact', values: ['push', 'pull_request'] },
        { claim: 'event_name', match: 'exact', values: ['pull_request'] },
      ],
      github,
    );
    expect(summary?.trusted).toEqual([]);
    expect(summary?.optedIn).toEqual(['pull_request']);
  });

  it('is null for profiles without an event claim', () => {
    expect(eventSummary([], PROFILES.generic)).toBeNull();
  });
});
