import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

interface FiltersBase {
  /** Accessible name ("Filter requests"). Required for a group; a search form gets one too. */
  label: string;
  /** Sit at the right of the tray title (`.tray-h > .filters.end`) instead of taking the row. */
  end?: boolean;
  class?: string;
  /** `FilterSearch`, `AddFilter`s, a submit button, a `.suggest` line (it takes its own row). */
  children?: Child;
}

export type FiltersProps = FiltersBase &
  (
    | {
        /** A GET form (`form.filters[role=search]`): a search box or inputs that submit. */
        as?: 'form';
        /** Where the form submits (GET). Defaults to the current URL. */
        action?: string;
        /** Filters already applied, kept when the form submits (`input type=hidden`). */
        hidden?: Readonly<Record<string, string>>;
        /** Label of a trailing submit button (`.btn.secondary`): "Apply". */
        submitLabel?: string;
      }
    | {
        /** Only `AddFilter` menus (links), no inputs: a labelled group (`div.filters[role=group]`). */
        as: 'group';
        action?: undefined;
        hidden?: undefined;
        submitLabel?: undefined;
      }
  );

/**
 * Filter bar (`.filters`) for the tray header above a table: a search box, "+ Token" style
 * add-filter menus and Apply. A GET form, so a filtered list is a URL that can be shared.
 */
export function Filters(props: FiltersProps) {
  const className = cx('filters', props.end && 'end', props.class);
  if (props.as === 'group') {
    return (
      <div class={className} role="group" aria-label={props.label}>
        {props.children}
      </div>
    );
  }
  return (
    <form
      class={className}
      role="search"
      method="get"
      action={props.action}
      aria-label={props.label}
    >
      {Object.entries(props.hidden ?? {}).map(([name, value]) => (
        <input type="hidden" name={name} value={value} />
      ))}
      {props.children}
      {props.submitLabel ? (
        <button class="btn secondary" type="submit">
          {props.submitLabel}
        </button>
      ) : null}
    </form>
  );
}
