import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface LinkActionProps {
  href: string;
  /** Adds a trailing "→" (decorative): "See denied →". */
  arrow?: boolean;
  /** Screen-reader-only suffix (`.vh`) naming the object: " for OpenAI". Start it with a space. */
  context?: string;
  class?: string;
  /** The label: what happens ("See denied", "Owner or reject…"). */
  children: Child;
}

/** A text link that reads as an action (`.linkish`): medium weight, accent, no underline at rest. */
export function LinkAction({ href, arrow, context, class: className, children }: LinkActionProps) {
  return (
    <a class={cx('linkish', className)} href={href}>
      {children}
      {context ? <span class="vh">{context}</span> : null}
      {arrow ? <span aria-hidden="true"> →</span> : null}
    </a>
  );
}
