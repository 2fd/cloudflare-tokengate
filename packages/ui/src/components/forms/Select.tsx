import { cx } from '../../lib/cx';
import { useControl } from './context';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  /** Defaults to the id of the Field around it. */
  id?: string;
  name?: string;
  /** Seven options or more; for 2–6 use RadioCards, for short values Picks. */
  options: readonly SelectOption[];
  /** The selected value. */
  value?: string;
  /** First option with an empty value ("Choose a region"); not selectable once a value is set. */
  placeholder?: string;
  /** Never inside a Reveal. */
  required?: boolean;
  disabled?: boolean;
  autocomplete?: string;
  invalid?: boolean;
  describedBy?: string;
  class?: string;
}

/** Native select (`.select`, 40px, drawn chevron). Use it only for 7 or more options. */
export function Select(props: SelectProps) {
  const control = useControl('Select', props);
  const hasValue = props.value !== undefined && props.value !== '';
  return (
    <select
      class={cx('select', props.class)}
      id={control.id}
      name={props.name}
      required={props.required}
      disabled={props.disabled}
      autocomplete={props.autocomplete}
      aria-invalid={control.invalid ? 'true' : undefined}
      aria-describedby={control.describedBy}
    >
      {props.placeholder !== undefined ? (
        <option value="" disabled={hasValue} selected={!hasValue}>
          {props.placeholder}
        </option>
      ) : null}
      {props.options.map((option) => (
        <option
          value={option.value}
          selected={option.value === props.value}
          disabled={option.disabled}
        >
          {option.label}
        </option>
      ))}
    </select>
  );
}
