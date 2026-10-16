import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface FilterOption {
  /** The list with this filter added ("?token=slack"). */
  href: string;
  /** What it filters by ("Slack"). */
  label: Child;
  /** Decorative logo or avatar before the label (`aria-hidden`). */
  logo?: Child;
  /** Mono slug or kind after the label ("slack", "token"). */
  slug?: string;
  /** How many rows match, right-aligned ("2,140"). */
  count?: number | string;
}

export interface AddFilterProps {
  /** What the menu filters by: the summary reads "+ Token". */
  label: string;
  /** Values, most rows first. */
  options: readonly FilterOption[];
  /** Special values after a divider ("No token chosen", "Unverified callers"). */
  extra?: readonly FilterOption[];
  /** Screen reader unit after each count (" requests"). */
  unit?: string;
  /** Render the menu open (server state, or docs). */
  open?: boolean;
  class?: string;
}

function Option(props: { option: FilterOption; unit: string | undefined }) {
  const { option } = props;
  return (
    <a href={option.href}>
      {option.logo}
      {option.label}
      {option.slug !== undefined ? (
        <>
          {' '}
          <span class="slug">{option.slug}</span>
        </>
      ) : null}
      {option.count !== undefined ? (
        <span class="n">
          {option.count}
          {props.unit ? <span class="vh">{props.unit}</span> : null}
        </span>
      ) : null}
    </a>
  );
}

/**
 * "+ Token" add-filter menu (`details.fadd` > `.fpop`): a disclosure holding one link per value,
 * so adding a filter is following a link. No JavaScript; the menu closes on the next page.
 */
export function AddFilter(props: AddFilterProps) {
  return (
    <details class={cx('fadd', props.class)} open={props.open}>
      <summary>
        <span aria-hidden="true">+</span>
        <span class="vh">Filter by </span>
        {props.label}
      </summary>
      <div class="fpop">
        {props.options.map((option) => (
          <Option option={option} unit={props.unit} />
        ))}
        {props.extra && props.extra.length > 0 ? (
          <>
            <hr />
            {props.extra.map((option) => (
              <Option option={option} unit={props.unit} />
            ))}
          </>
        ) : null}
      </div>
    </details>
  );
}
