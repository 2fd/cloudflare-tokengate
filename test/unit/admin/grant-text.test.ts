import { describe, expect, it } from 'vitest';
import {
  eventSummary,
  formatConditions,
  formatRules,
  formatValueList,
  parseValueList,
} from '../../../src/admin/grant-text';
import { PROFILES } from '../../../src/identity/profiles';

describe('parseValueList', () => {
  it('splits bare values on commas and trims them', () => {
    expect(parseValueList(' 89012345, 89012346 ,x')).toEqual({
      ok: true,
      values: ['89012345', '89012346', 'x'],
    });
    expect(parseValueList('   ')).toEqual({ ok: true, values: [] });
  });

  it('reads JSON-quoted values, which may hold commas, quotes or nothing', () => {
    expect(parseValueList('"a,b", "", " padded ", plain, "q\\"uote"')).toEqual({
      ok: true,
      values: ['a,b', '', ' padded ', 'plain', 'q"uote'],
    });
  });

  it('explains how to fix a malformed list', () => {
    for (const text of ['a,,b', 'a,', '"open', '"a" b']) {
      const parsed = parseValueList(text);
      expect(parsed.ok, text).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/^(Remove|A quoted|Put a comma)/);
    }
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

describe('round trip', () => {
  it('parseValueList(formatValueList(x)) returns x for arbitrary values', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = prng(seed);
      const input = Array.from({ length: 1 + Math.floor(next() * 4) }, () => randomText(next, 10));
      const text = formatValueList(input);
      expect(parseValueList(text), `seed ${seed}: ${text}`).toEqual({ ok: true, values: input });
    }
  });

  it('formats conditions with the same value lists', () => {
    expect(
      formatConditions([{ claim: 'x', match: 'exact', values: ['a,b', 'c'] }]).endsWith(
        formatValueList(['a,b', 'c']),
      ),
    ).toBe(true);
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
