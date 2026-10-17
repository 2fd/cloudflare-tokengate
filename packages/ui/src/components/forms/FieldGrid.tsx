import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface FieldGridProps {
  class?: string;
  /**
   * Up to three short `Field`s side by side (Name · Slug · Expires). A field that takes the whole
   * row gets `class="span-all"`.
   */
  children: Child;
}

/**
 * Short fields in one row (`.fgrid`, three columns, 16px apart): optional details that belong
 * together. One column below 48rem.
 */
export function FieldGrid({ class: className, children }: FieldGridProps) {
  return <div class={cx('fgrid', className)}>{children}</div>;
}
