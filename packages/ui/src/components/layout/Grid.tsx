import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface GridProps {
  class?: string;
  /** `Column`s whose spans add up to 12 per row. */
  children: Child;
}

/**
 * The 12-column page grid (`.grid`, 24px gaps): main content next to a side column, such as the
 * Overview (8 + 4). Below 80rem every column takes the full row.
 */
export function Grid({ class: className, children }: GridProps) {
  return <div class={cx('grid', className)}>{children}</div>;
}

export interface ColumnProps {
  /** Columns of 12 it spans from 80rem (`.span-N`). */
  span: 4 | 5 | 6 | 7 | 8 | 12;
  /**
   * A side column (`.rail`: trays 24px apart). As an `aside` it needs `label`, the name of the
   * complementary landmark.
   */
  rail?: boolean;
  /** `div` (default), `section` or `aside`. */
  as?: 'div' | 'section' | 'aside';
  /** Accessible name, for an `aside` or a `section`. */
  label?: string;
  class?: string;
  children: Child;
}

/** One column of a `Grid` (`.span-N`), optionally a rail (`.rail`). */
export function Column(props: ColumnProps) {
  const Tag = props.as ?? 'div';
  return (
    <Tag
      class={cx(`span-${props.span}`, props.rail && 'rail', props.class)}
      aria-label={props.label}
    >
      {props.children}
    </Tag>
  );
}

export interface StackProps {
  /** `md` (default): 32px between blocks, as trays on a page. `sm`: 16px, inside a form or panel. */
  gap?: 'md' | 'sm';
  class?: string;
  children: Child;
}

/** A vertical stack of blocks (`.stack` 32px, `.stack-sm` 16px). */
export function Stack({ gap = 'md', class: className, children }: StackProps) {
  return <div class={cx(gap === 'sm' ? 'stack-sm' : 'stack', className)}>{children}</div>;
}
