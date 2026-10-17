import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { LogoTile, type LogoSpec } from './Logo';

export interface LogoStackProps {
  /**
   * Logos of the overlapping 24px tiles, in order: a brand, or `{ brand, text?, disabled? }`
   * (`disabled` dims the tile of a disabled consumer). Decorative: the text carries the meaning.
   */
  brands: readonly LogoSpec[];
  /**
   * The count in words ("2 consumers"). Required unless the stack is decorative next to a name
   * (an `Entity` `logoSlot`): without it the whole stack is `aria-hidden`.
   */
  children?: Child;
  class?: string;
}

/** Overlapping logo tiles and a count (`.lstack`): "Used by" cells, "4 tokens". */
export function LogoStack({ brands, children, class: className }: LogoStackProps) {
  const tiles = brands.map((logo) => <LogoTile logo={logo} size="sm" />);
  if (children === undefined) {
    return (
      <span class={cx('lstack', className)} aria-hidden="true">
        <span class="tiles">{tiles}</span>
      </span>
    );
  }
  return (
    <span class={cx('lstack', className)}>
      <span class="tiles" aria-hidden="true">
        {tiles}
      </span>
      {children}
    </span>
  );
}
