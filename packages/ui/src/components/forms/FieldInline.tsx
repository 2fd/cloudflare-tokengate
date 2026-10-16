import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface FieldInlineProps {
  /** Id of the input. */
  id: string;
  /** Leading label inside the box ("Request ID"). */
  label: Child;
  name: string;
  value?: string;
  placeholder?: string;
  /** Text of the trailing submit button ("Find"). */
  submit: Child;
  /** Name of the search landmark: the visible field title it sits under (its id). */
  labelledBy?: string;
  /** Name of the search landmark when there is no visible title. */
  searchLabel?: string;
  action?: string;
  method?: 'get' | 'post';
  class?: string;
}

/**
 * One-line lookup form (`form.field-inline`, role search): a leading label, a mono input and a
 * trailing button in one 40px box ("Find a request"). Full width below 40rem.
 */
export function FieldInline(props: FieldInlineProps) {
  return (
    <form
      class={cx('field-inline', props.class)}
      role="search"
      method={props.method ?? 'get'}
      action={props.action}
      aria-labelledby={props.labelledBy}
      aria-label={props.labelledBy ? undefined : props.searchLabel}
    >
      <label for={props.id}>{props.label}</label>
      <input
        id={props.id}
        name={props.name}
        value={props.value}
        placeholder={props.placeholder}
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
