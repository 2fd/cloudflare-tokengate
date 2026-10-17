import { cx } from '../../lib/cx';

export interface Crumb {
  label: string;
  /** Link target; the last crumb is the current page and is never a link. */
  href?: string;
}

export interface BreadcrumbsProps {
  /** From the list page the object belongs to, to the current page (last). */
  items: readonly Crumb[];
  /**
   * Name of the navigation landmark. Default "Breadcrumb". Give a second trail on the same page
   * its own name, so the landmarks can be told apart.
   */
  label?: string;
  class?: string;
}

/** Breadcrumb trail (`nav.crumbs`); the last item carries `aria-current="page"`. */
export function Breadcrumbs({ items, label, class: className }: BreadcrumbsProps) {
  return (
    <nav class={cx('crumbs', className)} aria-label={label ?? 'Breadcrumb'}>
      <ol>
        {items.map((item, i) =>
          i === items.length - 1 ? (
            <li aria-current="page">{item.label}</li>
          ) : (
            <li>{item.href ? <a href={item.href}>{item.label}</a> : item.label}</li>
          ),
        )}
      </ol>
    </nav>
  );
}
