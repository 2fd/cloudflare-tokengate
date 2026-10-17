import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { SrSuffix } from '../../lib/sr';
import { ariaCurrent } from './current';

export interface SideNavItem {
  label: string;
  href: string;
  /** Decorative icon for a grouped navigation row. */
  icon?: Child;
  /**
   * `true` or `'page'`: this item is the current page (`aria-current="page"`). `'true'`: it holds
   * the current page, a deeper page not in the nav (`aria-current="true"`): a token detail under
   * Tokens. Both are highlighted.
   */
  current?: boolean | 'page' | 'true';
}

export interface SideNavSection {
  label: string;
  href: string;
  /** Decorative 16px icon (`svg.ic` with `aria-hidden`). */
  icon?: Child;
  /** Count on the section row (tokens 6), shown open or closed. */
  count?: number;
  /** Warn pill on the section row ("1 pending"); `srSuffix` completes it for screen readers. */
  pill?: { label: string; srSuffix?: string };
  /** The section holds the current page: its row is highlighted and its items are shown. */
  open?: boolean;
  /**
   * The section row itself is the current page (a section without sub-items): `true` or `'page'`
   * (`aria-current="page"`); `'true'` when it holds a deeper page (`aria-current="true"`).
   */
  current?: boolean | 'page' | 'true';
  /** Sub-items, rendered only under the open section. */
  items?: readonly SideNavItem[];
}

export interface SideNavProps {
  /** Accessible name of the navigation landmark ("Sections"). */
  label: string;
  sections: readonly SideNavSection[];
  /** Show labeled groups with every page visible. */
  grouped?: boolean;
  class?: string;
}

/**
 * Sidebar navigation (`nav.nav`): one row per section, the sub-items of the open section under
 * it. No group labels. Data driven, so every page renders the same markup and only the current
 * item changes.
 */
export function SideNav({ label, sections, grouped, class: className }: SideNavProps) {
  if (grouped) {
    return (
      <nav class={cx('nav', className)} aria-label={label}>
        {sections.map((section) => (
          <section class="nav-group" aria-label={section.label}>
            <div class="nav-label">{section.label}</div>
            <ul class="nav-pages">
              {(section.items?.length ? section.items : [section]).map((item, index) => (
                <li>
                  <a class="nav-item" href={item.href} aria-current={ariaCurrent(item.current)}>
                    {item.icon ?? section.icon}
                    <span class="nav-text">{item.label}</span>
                    {index === 0 && section.pill ? (
                      <span class="nav-pill">
                        {section.pill.label}
                        <SrSuffix text={section.pill.srSuffix} />
                      </span>
                    ) : null}
                    {index === 0 && section.count !== undefined ? (
                      <span class="nav-count">{section.count}</span>
                    ) : null}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
    );
  }
  return (
    <nav class={cx('nav', className)} aria-label={label}>
      {sections.map((section) => (
        <>
          <a
            class={cx('nav-item', section.open && 'is-open')}
            href={section.href}
            aria-current={ariaCurrent(section.current)}
          >
            {section.icon}
            {section.label}
            {section.count !== undefined ? <span class="nav-count">{section.count}</span> : null}
            {section.pill ? (
              <span class="nav-pill">
                {section.pill.label}
                <SrSuffix text={section.pill.srSuffix} />
              </span>
            ) : null}
          </a>
          {section.open && section.items && section.items.length > 0 ? (
            <ul class="nav-sub">
              {section.items.map((item) => (
                <li>
                  <a href={item.href} aria-current={ariaCurrent(item.current)}>
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ))}
    </nav>
  );
}
