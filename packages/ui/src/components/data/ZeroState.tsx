import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface ZeroStateProps {
  class?: string;
  /** One positive sentence ("No denied calls in the last 24 hours."). */
  children: Child;
}

/**
 * Zero state (`p.oneline`): one muted line inside a panel when a list is empty for a good
 * reason (nothing denied, nothing expiring). No glyph, no action: nothing needs fixing.
 */
export function ZeroState({ class: className, children }: ZeroStateProps) {
  return <p class={cx('oneline', className)}>{children}</p>;
}
