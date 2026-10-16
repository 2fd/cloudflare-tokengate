// Color tokens read from the served ui.css, so the foundations pages always show the values the
// product uses: `--name: light-dark(#light, #dark)` or an alias `--name: var(--other)`.
import { uiCss } from '@tokengate/ui/css';

export interface ColorToken {
  name: string;
  light?: string;
  dark?: string;
  /** Token this one is defined as (`--chart-denied: var(--bad-dot)`). */
  alias?: string;
}

function rootBlock(css: string): string {
  const start = css.indexOf(':root{');
  const end = start >= 0 ? css.indexOf('\n}', start) : -1;
  return start >= 0 && end > start ? css.slice(start, end) : '';
}

export function parseColorTokens(css: string): Map<string, ColorToken> {
  const out = new Map<string, ColorToken>();
  const block = rootBlock(css);
  for (const m of block.matchAll(
    /--([a-z0-9-]+):\s*light-dark\((#[0-9a-fA-F]{3,8}),\s*(#[0-9a-fA-F]{3,8})\)/g,
  )) {
    const name = m[1] as string;
    out.set(name, {
      name,
      light: (m[2] as string).toLowerCase(),
      dark: (m[3] as string).toLowerCase(),
    });
  }
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*var\(--([a-z0-9-]+)\)/g)) {
    const name = m[1] as string;
    if (!out.has(name)) out.set(name, { name, alias: m[2] as string });
  }
  return out;
}

export const COLOR_TOKENS = parseColorTokens(uiCss.text);

/** Light and dark values of a token, following aliases. */
export function resolveToken(name: string): { light?: string; dark?: string } {
  let token = COLOR_TOKENS.get(name);
  for (let hops = 0; token?.alias && hops < 4; hops++) token = COLOR_TOKENS.get(token.alias);
  return { light: token?.light, dark: token?.dark };
}
