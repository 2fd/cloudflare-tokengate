import { cx } from '../../lib/cx';
import { LogoTile, type LogoSpec } from '../base/Logo';
import { useControl } from './context';

declare module 'hono/jsx' {
  namespace JSX {
    interface IntrinsicElements {
      /** Mirror of the chosen option inside a customizable select's button. */
      selectedcontent: { class?: string };
    }
  }
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /**
   * Brand tile (24px) before the label, decorative: a type choice (issuer types). Any option with
   * a `logo` or `description` makes the select rich.
   */
  logo?: LogoSpec;
  /** One line under the label in the open list (rich select). */
  description?: string;
  /**
   * Option number (`data-o`, 1–12) inside a live field (`Field live`): picking it shows the
   * `Reveal` and summary phrase of that number, as a RadioCards option does.
   */
  o?: number;
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
   * Seven options or more, or a type choice that keeps growing (rich: `logo` and `description`).
   * For 2–6 fixed options use RadioCards, for short values Picks. Options and option groups mix,
   * rendered in the order given.
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

function isRich(options: SelectProps['options']): boolean {
  return options.some((item) =>
    'group' in item
      ? item.options.some((option) => option.logo !== undefined || option.description)
      : item.logo !== undefined || Boolean(item.description),
  );
}

/**
 * Native select (`.select`, 40px, drawn chevron). Rich (`.select.rich`): a customizable select
 * (`appearance: base-select`) whose button shows the chosen option's logo and label and whose
 * list adds each description. Keyboard, type-ahead, form value and the listbox semantics stay
 * the browser's. Each description is also in the option's text, after a visually hidden
 * separator, so a browser without base-select shows "GitHub Actions: Workflows in …" and a
 * screen reader reads it with the label.
 */
export function Select(props: SelectProps) {
  const control = useControl('Select', props);
  const hasValue = props.value !== undefined && props.value !== '';
  const rich = isRich(props.options);
  const option = (item: SelectOption) => (
    <option
      value={item.value}
      selected={item.value === props.value}
      disabled={item.disabled}
      data-o={item.o === undefined ? undefined : String(item.o)}
    >
      {rich ? (
        <>
          {item.logo !== undefined ? <LogoTile logo={item.logo} size="sm" cssLetters /> : null}
          <span class="sel-b">
            <span class="sel-t">{item.label}</span>
            {item.description ? (
              <span class="sel-d">
                <span class="sel-sep">: </span>
                {item.description}
              </span>
            ) : null}
          </span>
        </>
      ) : (
        item.label
      )}
    </option>
  );
  return (
    <select
      class={cx('select', rich && 'rich', props.class)}
      id={control.id}
      name={props.name}
      required={props.required}
      disabled={props.disabled}
      autocomplete={props.autocomplete}
      aria-invalid={control.invalid ? 'true' : undefined}
      aria-describedby={control.describedBy}
    >
      {rich ? (
        // The button is the closed select; it mirrors the chosen option. Not a control of its
        // own: the select takes focus and keys.
        <button type="button" tabindex={-1}>
          <selectedcontent />
        </button>
      ) : null}
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
