import type { Child } from 'hono/jsx';
import { cx, idList } from '../../lib/cx';
import { assertNotRequiredInReveal } from './context';
import { FieldError } from './Field';

export interface CheckboxProps {
  name: string;
  /** Submitted value when checked (the browser sends `on` without one). */
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  /** Never inside a Reveal. */
  required?: boolean;
  id?: string;
  /** Second line under the label, in hint style. It is part of the label. */
  hint?: Child;
  /** Set when the server rejected the form because of this box (risk not accepted). */
  invalid?: boolean;
  /**
   * The server's error for this box, as a line above it (`${id}-error`). Needs `id`. Implies
   * `invalid`.
   */
  error?: Child;
  /** Ids that describe the box, after the error. */
  describedBy?: string;
  class?: string;
  /** The label: what checking the box does, as a statement. */
  children: Child;
}

/**
 * A single checkbox row (`label.check`): box, then the label and an optional hint line. With an
 * `error`, the error line (`p.field-error`) comes first, outside the label.
 */
export function Checkbox(props: CheckboxProps) {
  assertNotRequiredInReveal('Checkbox', props.required);
  if (props.error && !props.id) throw new Error('Checkbox: error needs an id');
  const errorId = props.error ? `${props.id}-error` : undefined;
  const row = (
    <label class={cx('check', props.class)}>
      <input
        type="checkbox"
        id={props.id}
        name={props.name}
        value={props.value}
        checked={props.checked}
        disabled={props.disabled}
        required={props.required}
        aria-invalid={props.invalid || errorId ? 'true' : undefined}
        aria-describedby={idList(errorId, props.describedBy)}
      />
      {props.hint ? (
        <span>
          <span>{props.children}</span>
          <span class="hint">{props.hint}</span>
        </span>
      ) : (
        <span>{props.children}</span>
      )}
    </label>
  );
  if (!errorId) return row;
  return (
    <>
      <FieldError id={errorId}>{props.error}</FieldError>
      {row}
    </>
  );
}
