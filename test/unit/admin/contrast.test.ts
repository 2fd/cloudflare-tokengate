// The design tokens in public/static/app.css meet WCAG 2.2 AA in both colour schemes: every text
// pair at least 4.5:1 (1.4.3), control borders and the focus ring at least 3:1 against what they
// sit on (1.4.11), and dark mode redefines every token (a missing one would fall back to the light
// value on a dark background). The stylesheet is read through the assets binding, as served.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const css = await (await env.ASSETS.fetch('https://gw.test/static/app.css')).text();

function tokens(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) {
    out.set(match[1] as string, (match[2] as string).toLowerCase());
  }
  return out;
}

/** The body of the first `selector {` block at or after `from`, braces balanced. */
function blockAfter(source: string, opener: RegExp): string {
  const match = opener.exec(source);
  if (!match) throw new Error(`no block ${opener}`);
  let depth = 0;
  const start = match.index + match[0].length;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      if (depth === 0) return source.slice(start, i);
      depth--;
    }
  }
  throw new Error('unbalanced braces');
}

const light = tokens(blockAfter(css, /^:root\s*\{/m));
const dark = tokens(
  blockAfter(blockAfter(css, /@media \(prefers-color-scheme: dark\)\s*\{/), /:root\s*\{/),
);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Text and the backgrounds it is drawn on (badges, notices, alerts, the health strip, buttons). */
const TEXT_PAIRS: Array<[string, string]> = [
  ['--fg', '--bg'],
  ['--fg', '--panel'],
  ['--fg', '--info-bg'],
  ['--fg', '--ok-bg'],
  ['--fg', '--warn-bg'],
  ['--fg', '--bad-bg'],
  ['--muted', '--bg'],
  ['--muted', '--panel'],
  ['--muted', '--info-bg'],
  ['--muted', '--ok-bg'],
  ['--muted', '--warn-bg'],
  ['--muted', '--bad-bg'],
  ['--accent', '--bg'],
  ['--accent', '--panel'],
  ['--accent', '--info-bg'],
  ['--accent', '--ok-bg'],
  ['--accent', '--warn-bg'],
  ['--accent', '--bad-bg'],
  ['--on-accent', '--accent'],
  ['--ok', '--ok-bg'],
  ['--ok', '--panel'],
  ['--warn', '--warn-bg'],
  ['--warn', '--panel'],
  ['--bad', '--bad-bg'],
  ['--bad', '--panel'],
  ['--bad', '--bg'],
];

/** Non-text: control boundaries and the focus ring (offset 2px, so over bg or panel). */
const UI_PAIRS: Array<[string, string]> = [
  ['--control-border', '--panel'],
  ['--control-border', '--bg'],
  ['--focus', '--panel'],
  ['--focus', '--bg'],
];

describe('design tokens (WCAG 1.4.3 and 1.4.11)', () => {
  it('parses the light and dark token sets', () => {
    expect(light.size).toBeGreaterThanOrEqual(16);
    expect(css).toMatch(/:root\s*\{\s*color-scheme: light dark;/);
  });

  it('redefines every token in dark mode', () => {
    expect([...dark.keys()].sort()).toEqual([...light.keys()].sort());
  });

  for (const [scheme, set] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it.each(TEXT_PAIRS)(`${scheme}: text %s on %s is at least 4.5:1`, (fg, bg) => {
      expect(contrast(set.get(fg) ?? '', set.get(bg) ?? '')).toBeGreaterThanOrEqual(4.5);
    });

    it.each(UI_PAIRS)(`${scheme}: %s on %s is at least 3:1`, (fg, bg) => {
      expect(contrast(set.get(fg) ?? '', set.get(bg) ?? '')).toBeGreaterThanOrEqual(3);
    });
  }

  it('computes the WCAG ratio (black on white is 21:1)', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });
});
