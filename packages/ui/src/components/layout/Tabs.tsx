import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface TabItem {
  label: Child;
  href: string;
  /** Muted count after the label ("Access 3"). */
  count?: number | string;
  /** This tab is the current view (`aria-current="page"`). One per row. */
  current?: boolean;
}

export interface TabsProps {
  /** Name of the nav landmark ("Token views", "Outcome"). Required: a page can have several navs. */
  label: string;
  items: readonly TabItem[];
  class?: string;
}

/**
 * Tabs (`nav.tabs`): links to the views of one object (Overview, Access, Requests, Settings) or
 * one list (outcomes). Each tab is a page: the server marks the current one. One row; it scrolls
 * sideways on narrow screens. Sub-navigation of a section belongs in the sidebar, not here.
 */
export function Tabs({ label, items, class: className }: TabsProps) {
  return (
    <nav class={cx('tabs', className)} aria-label={label}>
      {items.map((item) => (
        <a href={item.href} aria-current={item.current ? 'page' : undefined}>
          {item.label}
          {item.count !== undefined ? (
            <>
              {' '}
              <span class="n">{item.count}</span>
            </>
          ) : null}
        </a>
      ))}
    </nav>
  );
}
