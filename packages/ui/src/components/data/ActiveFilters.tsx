import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface ActiveFilter {
  /** Name and value ("Token: Slack"). */
  label: Child;
  /** The same list without this filter. */
  href: string;
}

export interface ActiveFiltersProps {
  filters: readonly ActiveFilter[];
  /** The list with no filters ("Clear all"). Shown when set. */
  clearHref?: string;
  clearLabel?: string;
  /** Visible lead text before the chips ("Active filters"). */
  lead?: Child;
  /** Accessible name of the group. */
  label?: string;
  class?: string;
}

/**
 * Active filter chips (`.achips` > `a.achip`): each chip is a link to the list without that
 * filter, read as "Remove filter Token: Slack". Renders nothing when no filter is active.
 */
export function ActiveFilters(props: ActiveFiltersProps) {
  if (props.filters.length === 0) return null;
  return (
    <div
      class={cx('achips', props.class)}
      role="group"
      aria-label={props.label ?? 'Active filters'}
    >
      {props.lead !== undefined ? <span class="hint">{props.lead}</span> : null}
      {props.filters.map((filter) => (
        <a class="achip" href={filter.href}>
          <span class="vh">Remove filter </span>
          {filter.label}
          <span class="x" aria-hidden="true">
            ✕
          </span>
        </a>
      ))}
      {props.clearHref ? (
        <a class="sm" href={props.clearHref}>
          {props.clearLabel ?? 'Clear all'}
        </a>
      ) : null}
    </div>
  );
}
