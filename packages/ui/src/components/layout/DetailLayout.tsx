import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface DetailLayoutProps {
  /** Name of the rail landmark ("Slack activity and details"). */
  railLabel: string;
  /** The rail: trays with a `RailKeyValue`, a compact `Feed`, small KPIs. */
  rail: Child;
  class?: string;
  /** The main column: trays, 32px apart. */
  children: Child;
}

/**
 * Detail page body (`.detail`): main column plus a 20rem right rail (`aside.rail`) from 80rem;
 * below that the rail drops under the main column. Goes in `Page` after the header.
 */
export function DetailLayout({ railLabel, rail, class: className, children }: DetailLayoutProps) {
  return (
    <div class={cx('detail', className)}>
      <div class="col">{children}</div>
      <aside class="rail" aria-label={railLabel}>
        {rail}
      </aside>
    </div>
  );
}
