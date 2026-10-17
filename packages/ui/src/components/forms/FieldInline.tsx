import type { Child } from 'hono/jsx';
import { cx, idList } from '../../lib/cx';
import { Hidden, type HiddenFields } from '../../lib/hidden';
import { FieldError } from './Field';

interface FieldInlineBase {
  /** Id of the input. */
  id: string;
  /** Leading label inside the box ("Request ID", "Organization"). */
  label: Child;
  name: string;
  value?: string;
  placeholder?: string;
  /** Input type; `text` (default) renders no attribute. */
  type?: 'text' | 'search' | 'url';
  pattern?: string;
  minlength?: number;
  maxlength?: number;
  required?: boolean;
  inputmode?: 'text' | 'url' | 'search';
  /** Label of the Enter key on virtual keyboards. */
  enterkeyhint?: 'go' | 'search' | 'send' | 'done';
  /** Marks the input invalid (`aria-invalid`); implied by `error`. */
  invalid?: boolean;
  /**
   * The server's error, as a line above the box (`${id}-error`), so the 40px box keeps its shape.
   * Re-render with the submitted `value`.
   */
  error?: Child;
  /** Text of the trailing submit button ("Find", "Add"). */
  submit: Child;
  /** Name of the form: the id of the visible title it sits under. */
  labelledBy?: string;
  /** Name of the form when there is no visible title. */
  formLabel?: string;
  /**
   * Ids of elements that describe the input: a hint under the box ("ID or login, one per line").
   * Listed after the error.
   */
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
 * organizations") is not, and carries its `_csrf` in `hidden`. Full width below 40rem. An `error`
 * renders its line before the form.
 */
export function FieldInline(props: FieldInlineProps) {
  const method = props.method ?? 'get';
  const search = method === 'get' && props.search !== false;
  const errorId = props.error ? `${props.id}-error` : undefined;
  const form = (
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
        type={props.type === 'text' ? undefined : props.type}
        name={props.name}
        value={props.value}
        placeholder={props.placeholder}
        pattern={props.pattern}
        minlength={props.minlength}
        maxlength={props.maxlength}
        required={props.required}
        inputmode={props.inputmode}
        enterkeyhint={props.enterkeyhint}
        aria-invalid={props.invalid || errorId ? 'true' : undefined}
        aria-describedby={idList(errorId, props.describedBy)}
        autocomplete="off"
        spellcheck={false}
        autocapitalize="none"
      />
      <button class="btn secondary" type="submit">
        {props.submit}
      </button>
    </form>
  );
  if (!errorId) return form;
  return (
    <>
      <FieldError id={errorId}>{props.error}</FieldError>
      {form}
    </>
  );
}
