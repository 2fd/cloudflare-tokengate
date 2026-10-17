import { cx } from '../../lib/cx';
import { useControl } from './context';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Options under a group label (`optgroup`): the audit target filter's "Settings", "Tokens". */
export interface SelectOptionGroup {
  /** The group label (`optgroup label`). */
  group: string;
  options: readonly SelectOption[];
}

export interface SelectProps {
  /** Defaults to the id of the Field around it. */
  id?: string;
  name?: string;
  /**
   * Seven options or more; for 2–6 use RadioCards, for short values Picks. Options and option
   * groups mix, rendered in the order given.
   */
  options: readonly (SelectOption | SelectOptionGroup)[];
  /** The selected value. */
  value?: string;
  /** First option with an empty value ("Choose a region"); not selectable once a value is set. */
  placeholder?: string;
  /** Never inside a Reveal. */
  required?: boolean;
  disabled?: boolean;
  autocomplete?: string;
  invalid?: boolean;
  /** Ids added after the Field's hint, error and note ids (a shared hint). */
  describedBy?: string;
  class?: string;
}

/** Native select (`.select`, 40px, drawn chevron). Use it only for 7 or more options. */
export function Select(props: SelectProps) {
  const control = useControl('Select', props);
  const hasValue = props.value !== undefined && props.value !== '';
  const option = (item: SelectOption) => (
    <option value={item.value} selected={item.value === props.value} disabled={item.disabled}>
      {item.label}
    </option>
  );
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
      {props.options.map((item) =>
        'group' in item ? (
          <optgroup label={item.group}>{item.options.map(option)}</optgroup>
        ) : (
          option(item)
        ),
      )}
    </select>
  );
}
