// The forms sections of ui.css: every class the forms components render exists, the live-form
// :has() contract covers fields 1-8 x options 1-12, and the color pairs the forms use pass AA.
import { describe, expect, it } from 'vitest';
import { uiCss } from '../../src/css';

const css = uiCss.text;

describe('forms classes', () => {
  it.each([
    '.fields',
    '.field',
    '.opt',
    '.hint',
    '.field-error',
    '.input',
    '.select',
    '.w-date',
    '.suggest',
    '.field-inline',
    '.fixedbar',
    '.inherit',
    '.rcs',
    '.rc',
    '.rc-b',
    '.rc-t',
    '.rc-d',
    '.sel',
    '.rlist',
    '.row-pick',
    '.or',
    '.picks',
    '.pick',
    '.ops',
    '.op',
    '.check',
    '.subbox',
    'details.more',
    '.more-b',
    '.riskacc',
    '.submit-row',
    '.errsum',
    '.stepper',
    '.fstep',
    '.fstep-n',
    '.fstep-b',
    '.fstep-t',
    '.cat-list',
    '.cat-group',
    'details.type-card',
    '.type-body',
    '.tcards',
    '.tcard',
    '.lform',
    '.count-scope',
    '.opsn',
    '.lsum',
    '.lsum-row',
    '.lsum-wire',
    '.lsum-foot',
    '.if-risk',
    '.if-norisk',
    '.risktag',
    '.callout.bad',
  ])('%s is styled', (selector) => {
    expect(css).toContain(selector);
  });

  it('link cards without a logo use two columns', () => {
    expect(css).toContain('.tcard:not(:has(>.logo)){grid-template-columns:minmax(0,1fr) auto}');
  });
});

describe('live form contract', () => {
  const slots = [1, 2, 3, 4, 5, 6, 7, 8];
  const options = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  // Option K is a checked input inside the label `[data-o=K]`, or the selected `option[data-o=K]` of
  // a select (a rich Select in a live Field).
  it.each(slots)('field %i: phrases, reveals and the empty phrase', (n) => {
    for (const k of options) {
      const chosen = `:is([data-o="${k}"] input,option[data-o="${k}"]):checked`;
      expect(css).toContain(`.lform:has(.sf${n} ${chosen}) .sv${n}>[data-o="${k}"]`);
      expect(css).toContain(`.lform:has(.sf${n} ${chosen}) .rv${n}[data-o="${k}"]`);
    }
    expect(css).toContain(
      `.lform:not(:has(.sf${n} :is(input,option[data-o]):checked)) .sv${n}>[data-o="0"]`,
    );
  });

  it('risk options show the acceptance block and swap the risk phrases', () => {
    expect(css).toContain('.lform:has([data-risk] input:checked) .riskacc{display:grid}');
    expect(css).toContain('.lform:has([data-risk] input:checked) .if-risk{display:inline}');
    expect(css).toContain('.lform:has([data-risk] input:checked) .if-norisk{display:none}');
  });

  it('a server-computed acceptance block shows without a risky option', () => {
    const hide = css.indexOf('.lform .riskacc,.lform .if-risk{display:none}');
    const always = css.indexOf('.lform .riskacc.always{display:grid}');
    expect(hide).toBeGreaterThan(-1);
    expect(always).toBeGreaterThan(hide);
  });
});

function tokens(): Map<string, [string, string]> {
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

describe('forms color pairs (light and dark)', () => {
  const t = tokens();
  // text >= 4.5:1
  const TEXT: Array<[string, string, string]> = [
    ['text-2', 'surface-2', 'hints in a SubBox, Inherit'],
    ['text', 'surface-2', 'fields in a SubBox, read-only input'],
    ['text-3', 'input-bg', 'placeholder'],
    ['bad', 'panel-bg', 'inline error'],
    ['bad', 'bad-bg', 'ErrorSummary links'],
    ['warn', 'warn-bg', 'risk acceptance title, checked risky card'],
    ['accent-soft-text', 'accent-soft', 'Selected, open type card'],
    ['accent-text', 'panel-bg', 'More summary, suggestions'],
    ['text', 'accent-soft', 'checked row'],
    ['text-2', 'accent-soft', 'checked row meta'],
    ['text-2', 'warn-bg', 'risky card description, risk hint'],
  ];
  // borders and indicators >= 3:1
  const NON_TEXT: Array<[string, string, string]> = [
    ['accent', 'panel-bg', 'checked card border'],
    ['accent', 'page-bg', 'open type card ring'],
    ['warn-dot', 'panel-bg', 'checked risky card border'],
    ['bad', 'input-bg', 'invalid input border'],
  ];
  for (const [scheme, i] of [
    ['light', 0],
    ['dark', 1],
  ] as const) {
    it.each(TEXT)(`${scheme}: --%s on --%s (%s) is at least 4.5:1`, (fg, bg) => {
      expect(contrast(t.get(fg)?.[i] as string, t.get(bg)?.[i] as string)).toBeGreaterThanOrEqual(
        4.5,
      );
    });
    it.each(NON_TEXT)(`${scheme}: --%s on --%s (%s) is at least 3:1`, (fg, bg) => {
      expect(contrast(t.get(fg)?.[i] as string, t.get(bg)?.[i] as string)).toBeGreaterThanOrEqual(
        3,
      );
    });
  }
});
