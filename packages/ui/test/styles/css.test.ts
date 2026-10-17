// The served stylesheet: hashed URL, cache headers, product-only content, and WCAG 2.2 AA token
// contrast in both schemes (text >= 4.5:1, control borders and the focus ring >= 3:1).
import { describe, expect, it } from 'vitest';
import { cssAsset, IMMUTABLE_CACHE, serveCss, uiCss } from '../../src/css';
import { contentHash } from '../../src/lib/hash';

describe('uiCss', () => {
  it('is the stylesheet text with a hashed URL', () => {
    expect(uiCss.text).toContain(':root{');
    expect(uiCss.hash).toMatch(/^[0-9a-f]{10}$/);
    expect(uiCss.href).toBe(`/static/ui.${uiCss.hash}.css`);
    expect(uiCss.stablePath).toBe('/static/ui.css');
  });

  it('has no sketch-only chrome, imports or remote URLs', () => {
    for (const banned of [
      'sketch',
      '.artboard',
      '.frame',
      'sk-',
      '#theme-',
      '@import',
      'http:',
      'https:',
    ]) {
      expect(uiCss.text, banned).not.toContain(banned);
    }
  });
});

describe('contentHash', () => {
  it('is stable and changes with the text', () => {
    expect(contentHash('a')).toBe(contentHash('a'));
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});

describe('serveCss', () => {
  const asset = cssAsset('x', 'body{}');

  it('serves the hashed URL as immutable CSS', async () => {
    const res = serveCss([asset], asset.href);
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(res?.headers.get('cache-control')).toBe(IMMUTABLE_CACHE);
    expect(await res?.text()).toBe('body{}');
  });

  it('revalidates the stable URL and answers 304 to its etag', () => {
    expect(serveCss([asset], '/static/x.css')?.headers.get('cache-control')).toContain(
      'must-revalidate',
    );
    expect(serveCss([asset], '/static/x.css', `"${asset.hash}"`)?.status).toBe(304);
  });

  it('returns null for an old hash or another file', () => {
    expect(serveCss([asset], '/static/x.0000000000.css')).toBeNull();
    expect(serveCss([asset], '/static/y.css')).toBeNull();
  });
});

function pairs(css: string): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>();
  for (const m of css.matchAll(
    /--([a-z0-9-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi,
  )) {
    out.set(m[1] as string, [(m[2] as string).toLowerCase(), (m[3] as string).toLowerCase()]);
  }
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('token contrast (light and dark)', () => {
  const tokens = pairs(uiCss.text);
  const TEXT: Array<[string, string]> = [
    ['text', 'page-bg'],
    ['text', 'panel-bg'],
    ['text', 'tray-bg'],
    ['text', 'nav-bg'],
    ['text-2', 'page-bg'],
    ['text-2', 'panel-bg'],
    ['text-2', 'tray-bg'],
    ['text-2', 'panel-sub'],
    ['text-3', 'page-bg'],
    ['text-3', 'panel-bg'],
    ['text-3', 'tray-bg'],
    ['accent-text', 'page-bg'],
    ['accent-text', 'panel-bg'],
    ['on-accent', 'accent'],
    ['accent-soft-text', 'accent-soft'],
    ['ok', 'ok-bg'],
    ['warn', 'warn-bg'],
    ['bad', 'bad-bg'],
    ['info', 'info-bg'],
    ['on-danger', 'danger'],
  ];
  const NON_TEXT: Array<[string, string]> = [
    ['control-border', 'page-bg'],
    ['control-border', 'panel-bg'],
    ['control-border', 'input-bg'],
    ['focus', 'page-bg'],
    ['focus', 'panel-bg'],
    // chart bars and map wires are the main graphic (WCAG 1.4.11)
    ['chart-allowed', 'panel-bg'],
    ['chart-allowed', 'tray-bg'],
  ];

  for (const [scheme, index] of [
    ['light', 0],
    ['dark', 1],
  ] as const) {
    it.each(TEXT)(`${scheme}: --%s on --%s is at least 4.5:1`, (fg, bg) => {
      const f = tokens.get(fg)?.[index];
      const b = tokens.get(bg)?.[index];
      expect(f && b, `${fg}/${bg} defined`).toBeTruthy();
      expect(contrast(f as string, b as string)).toBeGreaterThanOrEqual(4.5);
    });
    it.each(NON_TEXT)(`${scheme}: --%s on --%s is at least 3:1`, (fg, bg) => {
      const f = tokens.get(fg)?.[index];
      const b = tokens.get(bg)?.[index];
      expect(f && b, `${fg}/${bg} defined`).toBeTruthy();
      expect(contrast(f as string, b as string)).toBeGreaterThanOrEqual(3);
    });
  }
});
