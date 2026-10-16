import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { assertNotRequiredInReveal } from './context';

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
  describedBy?: string;
  class?: string;
  /** The label: what checking the box does, as a statement. */
  children: Child;
}

/** A single checkbox row (`label.check`): box, then the label and an optional hint line. */
export function Checkbox(props: CheckboxProps) {
  assertNotRequiredInReveal('Checkbox', props.required);
  return (
    <label class={cx('check', props.class)}>
      <input
        type="checkbox"
        id={props.id}
        name={props.name}
        value={props.value}
        checked={props.checked}
        disabled={props.disabled}
        required={props.required}
        aria-invalid={props.invalid ? 'true' : undefined}
        aria-describedby={props.describedBy}
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
}
