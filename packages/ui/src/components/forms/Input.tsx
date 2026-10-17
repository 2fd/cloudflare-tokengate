import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { useControl } from './context';

/** A value offered for the input: always in the datalist; with `href`, also a visible link. */
export interface Suggestion {
  value: string;
  /** Text of the datalist option (`<option value="v">label</option>`). The `.suggest` link shows `value`. */
  label?: string;
  /** Link that reloads the form with this value filled in (no JS): shown in the `.suggest` line. */
  href?: string;
}

interface InputBase {
  /** Defaults to the id of the Field around it. One of the two is required. */
  id?: string;
  name?: string;
  type?: 'text' | 'password' | 'url' | 'email' | 'search' | 'date' | 'number' | 'tel';
  /** The exact format, as an example value: `acme/api (89012345)`, `xoxb-0000…`. Never the label. */
  placeholder?: string;
  /**
   * Mono type for IDs, paths, URLs and secrets. Also turns off autocomplete, autocorrect,
   * spellcheck and autocapitalize, which only get in the way of exact values.
   */
  mono?: boolean;
  /** Overrides the `mono` default (`false`): `spellcheck={false}` on an email input. */
  spellcheck?: boolean;
  /** Overrides the `mono` default (`none`). */
  autocapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  /** Focus the input on load: the one field of a page whose only task is to fill it. */
  autofocus?: boolean;
  /** Label of the Enter key on virtual keyboards. */
  enterkeyhint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send';
  /** Read-only, shown gray: a derived value. */
  readonly?: boolean;
  disabled?: boolean;
  /** Never inside a Reveal: the browser cannot submit a hidden required field. */
  required?: boolean;
  pattern?: string;
  minlength?: number;
  maxlength?: number;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  inputmode?: 'text' | 'numeric' | 'decimal' | 'email' | 'url' | 'search' | 'tel' | 'none';
  autocomplete?: string;
  /** `date`: 12rem wide (`.w-date`), for date inputs. */
  width?: 'date';
  /** Defaults to the Field's error state. */
  invalid?: boolean;
  /** Ids added after the Field's hint, error and note ids (a shared hint). */
  describedBy?: string;
  /** Datalist values, most used first. Those with `href` also show as a `.suggest` line. */
  suggestions?: readonly Suggestion[];
  /** Words before the visible suggestions. */
  suggestionsLabel?: Child;
  class?: string;
}

export type InputProps = InputBase &
  (
    | {
        secret?: false;
        /** The current value (the server re-renders what was submitted). */
        value?: string | number;
      }
    | {
        /**
         * A secret: password type, mono, no autocorrect, and ignored by password managers
         * (`data-1p-ignore`, `data-lpignore`, `data-bwignore`), so they never offer to save an API key as a login. A secret input never
         * renders a value: a rejected secret is not sent back in the page. Keep it server-side and
         * say so in a `Field` note ("The secret you entered, ending in 9fQa, is kept").
         */
        secret: true;
        value?: never;
      }
  );

/**
 * Text input (`.input`, 40px). Inside a Field it takes the Field's id and ARIA. Suggestions render
 * a `datalist` and, for those with a link, a visible line under the input.
 */
export function Input(props: InputProps) {
  const control = useControl('Input', props);
  const exact = props.mono || props.secret;
  const listId =
    props.suggestions && props.suggestions.length > 0 ? `${control.id}-list` : undefined;
  const links = props.suggestions?.filter((suggestion) => suggestion.href) ?? [];
  return (
    <>
      <input
        class={cx('input', exact && 'mono', props.width === 'date' && 'w-date', props.class)}
        id={control.id}
        name={props.name}
        type={props.secret ? 'password' : (props.type ?? 'text')}
        value={props.secret ? undefined : props.value}
        placeholder={props.placeholder}
        readonly={props.readonly}
        disabled={props.disabled}
        required={props.required}
        pattern={props.pattern}
        minlength={props.minlength}
        maxlength={props.maxlength}
        min={props.min}
        max={props.max}
        step={props.step}
        inputmode={props.inputmode}
        enterkeyhint={props.enterkeyhint}
        autofocus={props.autofocus}
        list={listId}
        aria-invalid={control.invalid ? 'true' : undefined}
        aria-describedby={control.describedBy}
        autocomplete={props.autocomplete ?? (exact ? 'off' : undefined)}
        spellcheck={props.spellcheck ?? (exact ? false : undefined)}
        autocapitalize={props.autocapitalize ?? (exact ? 'none' : undefined)}
        autocorrect={exact ? 'off' : undefined}
        data-1p-ignore={props.secret ? true : undefined}
        data-lpignore={props.secret ? 'true' : undefined}
        data-bwignore={props.secret ? 'true' : undefined}
      />
      {listId ? (
        <datalist id={listId}>
          {props.suggestions?.map((suggestion) =>
            suggestion.label !== undefined ? (
              <option value={suggestion.value}>{suggestion.label}</option>
            ) : (
              <option value={suggestion.value} />
            ),
          )}
        </datalist>
      ) : null}
      {links.length > 0 ? (
        <p class="suggest">
          {props.suggestionsLabel ?? 'Suggestions'}{' '}
          {links.map((suggestion) => (
            <a href={suggestion.href}>{suggestion.value}</a>
          ))}
        </p>
      ) : null}
    </>
  );
}
