import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { Hidden, type HiddenFields } from '../../lib/hidden';

interface FieldInlineBase {
  /** Id of the input. */
  id: string;
  /** Leading label inside the box ("Request ID", "Organization"). */
  label: Child;
  name: string;
  value?: string;
  placeholder?: string;
  /** Text of the trailing submit button ("Find", "Add"). */
  submit: Child;
  /** Name of the form: the id of the visible title it sits under. */
  labelledBy?: string;
  /** Name of the form when there is no visible title. */
  formLabel?: string;
  /** Ids of elements that describe the input: a hint under the box ("ID or login, one per line"). */
  describedBy?: string;
  action?: string;
  /** Hidden fields at the top of the form (`_csrf` for a POST, kept filters for a GET). */
  hidden?: HiddenFields;
  class?: string;
}

export type FieldInlineProps = FieldInlineBase &
  (
    | {
        /** `get` (default): a lookup. */
        method?: 'get';
        /** A lookup is a search landmark (`role="search"`). Default true for GET. */
        search?: boolean;
      }
    | {
        /** `post`: a one-field action ("Add organizations"), never a search landmark. */
        method: 'post';
        search?: false;
      }
  );

/**
 * One-line form (`form.field-inline`): a leading label, a mono input and a trailing button in one
 * 40px box. A GET lookup ("Find a request") is a search landmark; a POST one-field action ("Add
 * organizations") is not, and carries its `_csrf` in `hidden`. Full width below 40rem.
 */
export function FieldInline(props: FieldInlineProps) {
  const method = props.method ?? 'get';
  const search = method === 'get' && props.search !== false;
  return (
    <form
      class={cx('field-inline', props.class)}
      role={search ? 'search' : undefined}
      method={method}
      action={props.action}
      aria-labelledby={props.labelledBy}
      aria-label={props.labelledBy ? undefined : props.formLabel}
    >
      <Hidden fields={props.hidden} />
      <label for={props.id}>{props.label}</label>
      <input
        id={props.id}
        name={props.name}
        value={props.value}
        placeholder={props.placeholder}
        aria-describedby={props.describedBy}
        autocomplete="off"
        spellcheck={false}
        autocapitalize="none"
      />
      <button class="btn secondary" type="submit">
        {props.submit}
      </button>
    </form>
  );
}
