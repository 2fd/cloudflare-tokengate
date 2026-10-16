import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface ButtonRowProps {
  class?: string;
  /** Buttons, links and one-button forms; a `form` inside becomes `display: contents`. */
  children: Child;
}

/** A wrapping row of buttons with 8px gaps (`.btn-row`). Primary first. */
export function ButtonRow({ class: className, children }: ButtonRowProps) {
  return <div class={cx('btn-row', className)}>{children}</div>;
}
