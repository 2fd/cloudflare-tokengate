import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { SrSuffix } from '../../lib/sr';

export interface LinkActionProps {
  href: string;
  /** Adds a trailing "→" (decorative): "See denied →". */
  arrow?: boolean;
  /** Screen-reader-only suffix (`.vh`) naming the object: "for OpenAI". The space is added. */
  srSuffix?: string;
  class?: string;
  /** The label: what happens ("See denied", "Owner or reject…"). */
  children: Child;
}

/** A text link that reads as an action (`.linkish`): medium weight, accent, underlined (WCAG 1.4.1). */
export function LinkAction({ href, arrow, srSuffix, class: className, children }: LinkActionProps) {
  return (
    <a class={cx('linkish', className)} href={href}>
      {children}
      <SrSuffix text={srSuffix} />
      {arrow ? <span aria-hidden="true"> →</span> : null}
    </a>
  );
}
