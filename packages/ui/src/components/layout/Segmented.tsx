import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface SegmentedItem {
  label: Child;
  href: string;
  /** The selected segment (`aria-current="page"`). Exactly one. */
  current?: boolean;
}

export interface SegmentedProps {
  /** Name of the nav landmark ("Range", "View"). */
  label: string;
  items: readonly SegmentedItem[];
  /** `sm`: 32px, for a tab row or a tray header. Default 40px. */
  size?: 'sm';
  class?: string;
}

/**
 * Linked segmented control (`nav.seg`): 2–5 links that switch one parameter of the same view,
 * such as the time range (24 hours | 7 days | 30 days) or Map | Matrix. Each segment is a GET link.
 */
export function Segmented({ label, items, size, class: className }: SegmentedProps) {
  return (
    <nav class={cx('seg', size, className)} aria-label={label}>
      {items.map((item) => (
        <a href={item.href} aria-current={item.current ? 'page' : undefined}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}
