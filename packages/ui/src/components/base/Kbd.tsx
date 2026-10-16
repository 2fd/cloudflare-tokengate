import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface KbdProps {
  class?: string;
  /** The key, as printed on it ("Esc", "Enter", "⌘"). */
  children: Child;
}

/** A key on the keyboard (`kbd`), for instructions such as "Press Esc to close". */
export function Kbd({ class: className, children }: KbdProps) {
  return <kbd class={cx(className)}>{children}</kbd>;
}
