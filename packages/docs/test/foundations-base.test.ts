// The base foundations pages: every color token of ui.css is on the color page, and every
// contrast pair it shows meets WCAG 2.2 AA in both schemes.
import { describe, expect, it } from 'vitest';
import { GROUPS } from '../src/foundations/color';
import { CONTRAST_PAIRS, contrastRatio, measure } from '../src/foundations/contrast';
import { COLOR_TOKENS } from '../src/tokens';

describe('color foundations', () => {
  it('lists every color token of ui.css', () => {
    const listed = new Set(GROUPS.flatMap((group) => group.rows.map((row) => row.token)));
    const missing = [...COLOR_TOKENS.keys()].filter((name) => !listed.has(name));
    expect(missing).toEqual([]);
  });

  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#fff', '#fff')).toBe(1);
  });

  it.each(CONTRAST_PAIRS.map((pair) => [`${pair.fg} on ${pair.bg}`, pair] as const))(
    '%s passes in light and dark',
    (_name, pair) => {
      const result = measure(pair);
      expect(result.light, 'light').toBeGreaterThanOrEqual(pair.min);
      expect(result.dark, 'dark').toBeGreaterThanOrEqual(pair.min);
      expect(result.pass).toBe(true);
    },
  );
});
