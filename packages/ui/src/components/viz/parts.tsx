// Internal helpers of the viz group: logo tiles, number formatting and the shield mark. Not a
// component: only the types are re-exported from the barrel, so pages can type their data.
import { Logo, type LogoBrand } from '../base/Logo';

/** Brand tiles of ui.css (`.lg-<brand>`): the base group's `LogoBrand`. `oidc` draws a key. */
export type VizBrand = LogoBrand;

/** A logo tile in a viz component. Decorative: the name next to it carries the meaning. */
export interface VizLogo {
  brand: VizBrand;
  /** Letters on the tile; defaults to the brand's (`S`, `GH`, `</>`). Ignored for `oidc`. */
  text?: string;
  /** Disabled or idle object: gray, 40% opacity (`.dis`). */
  disabled?: boolean;
}

/** A `.logo` tile (the base group's `Logo`), hidden from assistive tech. */
export function LogoTile(props: { logo: VizLogo; size?: 'xs' | 'sm' | 'lg'; disabled?: boolean }) {
  const { logo } = props;
  const disabled = logo.disabled || props.disabled;
  return logo.text === undefined || logo.brand === 'oidc' ? (
    <Logo brand={logo.brand} size={props.size} disabled={disabled} />
  ) : (
    <Logo brand={logo.brand} size={props.size} disabled={disabled}>
      {logo.text}
    </Logo>
  );
}

/** The tokengate shield (`.mark`), decorative. */
export function ShieldMark() {
  return (
    <span class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
        <circle cx="12" cy="11" r="2" />
      </svg>
    </span>
  );
}

/** Numbers with thousands separators (`8,214`); strings pass through as already formatted. */
export function fmt(value: number | string): string {
  return typeof value === 'number' ? value.toLocaleString('en-US') : value;
}

/**
 * A share with a space before the sign, as the system writes it: one decimal (`2.9 %`), two below
 * 1 % so small shares do not read as zero (`0.15 %`).
 */
export function pct(part: number, total: number): string {
  if (total <= 0) return '0 %';
  const share = (part / total) * 100;
  const digits = share > 0 && share < 1 ? 2 : 1;
  const factor = 10 ** digits;
  return `${(Math.round(share * factor) / factor).toLocaleString('en-US')} %`;
}

/** `1 access`, `3 accesses`. */
export function plural(n: number, one: string, many: string): string {
  return `${fmt(n)} ${n === 1 ? one : many}`;
}

/** One decimal, as SVG coordinates are written (`109.9`). */
export function r1(value: number): number {
  return Math.round(value * 10) / 10;
}
