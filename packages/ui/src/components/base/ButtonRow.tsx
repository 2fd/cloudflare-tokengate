import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface ButtonRowProps {
  /** Element id, for an `aria-describedby` or a link that points at the row. */
  id?: string;
  class?: string;
  /** Buttons, links and one-button forms; a `form` inside becomes `display: contents`. */
  children: Child;
}

/** A wrapping row of buttons with 8px gaps (`.btn-row`). Primary first. */
export function ButtonRow({ id, class: className, children }: ButtonRowProps) {
  return (
    <div class={cx('btn-row', className)} id={id}>
      {children}
    </div>
  );
}
