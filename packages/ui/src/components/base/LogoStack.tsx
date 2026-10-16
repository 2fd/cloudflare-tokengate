import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { logoContent, type LogoBrand } from './Logo';

export interface LogoStackProps {
  /** Brands of the overlapping 24px tiles, in order. Decorative: the text carries the meaning. */
  brands: readonly LogoBrand[];
  /** The count in words ("2 consumers"). Required: the tiles are hidden from assistive tech. */
  children: Child;
  class?: string;
}

/** Overlapping logo tiles and a count (`.lstack`): "Used by" cells, "4 tokens". */
export function LogoStack({ brands, children, class: className }: LogoStackProps) {
  return (
    <span class={cx('lstack', className)}>
      <span class="tiles" aria-hidden="true">
        {brands.map((brand) => (
          <span class={`logo lg-${brand}`}>{logoContent(brand)}</span>
        ))}
      </span>
      {children}
    </span>
  );
}
