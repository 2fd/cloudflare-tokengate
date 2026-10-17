import { cx } from '../../lib/cx';

export interface FilterSearchProps {
  /** Id of the input; the suggestion list is `${id}-list`. Unique on the page. */
  id: string;
  /** Accessible name, visually hidden ("Search requests"). The placeholder is not a label. */
  label: string;
  /** Query parameter. */
  name?: string;
  /** The current query, so the box shows what the list is filtered by. */
  value?: string;
  /** The exact format to type ("Path, repository or request ID"). */
  placeholder?: string;
  /** Known values offered by the browser (`datalist`): repositories, token slugs. */
  suggestions?: readonly string[];
  /** Format the browser checks before it submits (`pattern`), for example a repository `owner/name`. */
  pattern?: string;
  /** Longest query accepted (`maxlength`): 254 for an email search, 256 for a repository filter. */
  maxlength?: number;
  /** The query was refused: `aria-invalid="true"`. Say why in the element named by `describedBy`. */
  invalid?: boolean;
  /**
   * Id of the hint or the `FieldError` the page renders in the filter bar (`aria-describedby`).
   * The component renders no error line of its own.
   */
  describedBy?: string;
  class?: string;
}

/**
 * Search box of a filter bar (`label.search`): magnifier glyph, a hidden label and a search
 * input, with an optional `datalist` of known values. Goes inside `Filters`.
 */
export function FilterSearch(props: FilterSearchProps) {
  const listId = props.suggestions && props.suggestions.length > 0 ? `${props.id}-list` : undefined;
  return (
    <>
      <label class={cx('search', props.class)} for={props.id}>
        <span class="vh">{props.label}</span>
        <svg class="ic" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6" />
          <path d="M20 20l-4.5-4.5" />
        </svg>
        <input
          class="input"
          id={props.id}
          type="search"
          name={props.name ?? 'q'}
          value={props.value}
          placeholder={props.placeholder}
          list={listId}
          pattern={props.pattern}
          maxlength={props.maxlength}
          aria-invalid={props.invalid ? 'true' : undefined}
          aria-describedby={props.describedBy}
          autocomplete="off"
          spellcheck={false}
          autocapitalize="none"
        />
      </label>
      {listId ? (
        <datalist id={listId}>
          {props.suggestions?.map((value) => (
            <option value={value}></option>
          ))}
        </datalist>
      ) : null}
    </>
  );
}
