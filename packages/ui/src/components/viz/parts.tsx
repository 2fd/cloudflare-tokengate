// Internal helpers of the viz group: number formatting. Not a component and not exported.

/** Numbers with thousands separators (`8,214`); strings pass through as already formatted. */
export function fmt(value: number | string): string {
  return typeof value === 'number' ? value.toLocaleString('en-US') : value;
}

/**
 * A share with a space before the sign, as the system writes it: one decimal (`2.9 %`), two below
 * 1 % so small shares do not read as zero (`0.15 %`). The space is non-breaking, so a number and
 * its unit never wrap apart.
 */
export function pct(part: number, total: number): string {
  if (total <= 0) return '0 %';
  const share = (part / total) * 100;
  const digits = share > 0 && share < 1 ? 2 : 1;
  const factor = 10 ** digits;
  return `${(Math.round(share * factor) / factor).toLocaleString('en-US')} %`;
}

/** `1 access`, `3 accesses`. */
export function plural(n: number, one: string, many: string): string {
  return `${fmt(n)} ${n === 1 ? one : many}`;
}

/** One decimal, as SVG coordinates are written (`109.9`). */
export function r1(value: number): number {
  return Math.round(value * 10) / 10;
}
