import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { ariaCurrent } from './current';

export interface TabItem {
  label: Child;
  href: string;
  /** Muted count after the label ("Access 3"). */
  count?: number | string;
  /**
   * This tab is the current view: `true` or `'page'` (`aria-current="page"`); `'true'` when a
   * deeper page of this view is shown (`aria-current="true"`). One per row.
   */
  current?: boolean | 'page' | 'true';
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
        <a href={item.href} aria-current={ariaCurrent(item.current)}>
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
