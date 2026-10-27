// WCAG 2.2 contrast ratios of token pairs, computed from the values in the served ui.css, so the
// color page shows the real numbers. Same formula as the token contrast test of @tokengate/ui.
import { resolveToken } from '../tokens';

function luminance(hex: string): number {
  const full = hex.length === 4 ? `#${[1, 2, 3].map((i) => hex[i]?.repeat(2)).join('')}` : hex;
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio of two hex colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastPair {
  fg: string;
  bg: string;
  /** 4.5 for text, 3 for control borders, dots and the focus ring. */
  min: 4.5 | 3;
  use: string;
}

export interface ContrastResult extends ContrastPair {
  light?: number;
  dark?: number;
  pass: boolean;
}

export function measure(pair: ContrastPair): ContrastResult {
  const fg = resolveToken(pair.fg);
  const bg = resolveToken(pair.bg);
  const light = fg.light && bg.light ? contrastRatio(fg.light, bg.light) : undefined;
  const dark = fg.dark && bg.dark ? contrastRatio(fg.dark, bg.dark) : undefined;
  const pass = light !== undefined && dark !== undefined && light >= pair.min && dark >= pair.min;
  return { ...pair, light, dark, pass };
}

/** The pairs the components use, text first. */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { fg: 'text', bg: 'page-bg', min: 4.5, use: 'Body text, titles' },
  { fg: 'text', bg: 'panel-bg', min: 4.5, use: 'Table cells, panel content' },
  { fg: 'text', bg: 'tray-bg', min: 4.5, use: 'Tray titles' },
  { fg: 'text', bg: 'surface-2', min: 4.5, use: 'Chips' },
  { fg: 'text', bg: 'surface-3', min: 4.5, use: 'Active nav item, avatars' },
  { fg: 'text', bg: 'btn-bg', min: 4.5, use: 'Secondary button label' },
  { fg: 'text-2', bg: 'page-bg', min: 4.5, use: 'Descriptions, hints' },
  { fg: 'text-2', bg: 'panel-bg', min: 4.5, use: 'Meta lines in rows' },
  { fg: 'text-2', bg: 'tray-bg', min: 4.5, use: 'Tray descriptions' },
  { fg: 'text-2', bg: 'panel-sub', min: 4.5, use: 'Table headers' },
  { fg: 'text-2', bg: 'surface-2', min: 4.5, use: 'Badges, ID chips, chip counts' },
  { fg: 'text-2', bg: 'nav-bg', min: 4.5, use: 'Sidebar items' },
  { fg: 'text-3', bg: 'page-bg', min: 4.5, use: 'Counts, placeholders, slugs' },
  { fg: 'text-3', bg: 'panel-bg', min: 4.5, use: 'Counts in rows' },
  { fg: 'text-3', bg: 'tray-bg', min: 4.5, use: 'Counts in tray titles' },
  { fg: 'text-3', bg: 'panel-sub', min: 4.5, use: 'Code comments' },
  { fg: 'accent-text', bg: 'page-bg', min: 4.5, use: 'Links' },
  { fg: 'accent-text', bg: 'panel-bg', min: 4.5, use: 'Links in panels' },
  { fg: 'accent-text', bg: 'tray-bg', min: 4.5, use: 'Links in tray headers' },
  { fg: 'accent-text', bg: 'accent-soft', min: 4.5, use: 'Ghost button hover' },
  { fg: 'on-accent', bg: 'accent', min: 4.5, use: 'Primary button' },
  { fg: 'on-accent', bg: 'accent-hover', min: 4.5, use: 'Primary button hover' },
  {
    fg: 'accent-soft-text',
    bg: 'accent-soft',
    min: 4.5,
    use: 'Selected cards, active filter chips',
  },
  { fg: 'text', bg: 'accent-soft', min: 4.5, use: 'Checked row text' },
  { fg: 'ok', bg: 'ok-bg', min: 4.5, use: 'OK badge and callout' },
  { fg: 'warn', bg: 'warn-bg', min: 4.5, use: 'Warn badge, callout, risk tag' },
  { fg: 'bad', bg: 'bad-bg', min: 4.5, use: 'Bad badge and callout' },
  { fg: 'info', bg: 'info-bg', min: 4.5, use: 'Info badge and callout' },
  { fg: 'pending', bg: 'pending-bg', min: 4.5, use: 'Pending badge' },
  { fg: 'text', bg: 'surface-3', min: 4.5, use: 'Label badges, count pills, step numbers' },
  { fg: 'text-2', bg: 'surface-3', min: 4.5, use: 'Meta lines in a highlighted row' },
  { fg: 'text', bg: 'info-bg', min: 4.5, use: 'Callout body text' },
  { fg: 'text-2', bg: 'warn-bg', min: 4.5, use: 'Callout second line (warn)' },
  { fg: 'ok', bg: 'panel-bg', min: 4.5, use: 'Status words in cells' },
  { fg: 'warn', bg: 'panel-bg', min: 4.5, use: 'Status words in cells' },
  { fg: 'bad', bg: 'panel-bg', min: 4.5, use: 'Status words; danger button' },
  { fg: 'on-danger', bg: 'danger', min: 4.5, use: 'Solid danger button' },
  { fg: 'control-border', bg: 'page-bg', min: 3, use: 'Input and button borders' },
  { fg: 'control-border', bg: 'panel-bg', min: 3, use: 'Borders in panels' },
  { fg: 'control-border', bg: 'tray-bg', min: 3, use: 'Borders in tray headers' },
  { fg: 'control-border', bg: 'input-bg', min: 3, use: 'Input borders' },
  { fg: 'focus', bg: 'page-bg', min: 3, use: 'Focus ring' },
  { fg: 'focus', bg: 'panel-bg', min: 3, use: 'Focus ring in panels' },
  { fg: 'focus', bg: 'tray-bg', min: 3, use: 'Focus ring in tray headers' },
  { fg: 'ok-dot', bg: 'panel-bg', min: 3, use: 'Status dots' },
  { fg: 'warn-dot', bg: 'panel-bg', min: 3, use: 'Status dots, expiring wires' },
  { fg: 'bad-dot', bg: 'panel-bg', min: 3, use: 'Status dots that need action' },
  { fg: 'bad-muted', bg: 'panel-bg', min: 3, use: 'Denied chart bars and swatch' },
  { fg: 'bad-muted', bg: 'tray-bg', min: 3, use: 'Denied legend swatch in a tray footer' },
  { fg: 'info', bg: 'panel-bg', min: 3, use: 'Info dots' },
  { fg: 'pending', bg: 'panel-bg', min: 3, use: 'Pending dots' },
  { fg: 'focus', bg: 'nav-bg', min: 3, use: 'Focus ring in the sidebar' },
];
