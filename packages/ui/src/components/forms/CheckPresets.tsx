import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { type ChoiceBase, choiceAttrs, isChecked } from './choice';
import { useChoiceIds } from './context';

export interface CheckPreset extends ChoiceBase {
  /** What the preset allows, in words (“Post messages”). */
  title: Child;
  /** Muted note after the title: “(default)”. */
  note?: Child;
  /** The calls it allows, mono, under the title: `POST /chat.postMessage`. */
  code?: Child;
  /** Right column: a tag such as a risk tag. */
  tag?: Child;
}

export interface CheckPresetsProps {
  /** Checkbox name, shared by every preset (the server reads all values). */
  name: string;
  options: readonly CheckPreset[];
  /** Checked values. */
  value?: readonly string[];
  /** Input id prefix; defaults to the FieldSet's id. */
  id?: string;
  class?: string;
}

/**
 * Checkbox presets (`.ops` + `.op`): named groups of API calls, each with its endpoints in mono.
 * Checked rows get the accent-soft background.
 */
export function CheckPresets(props: CheckPresetsProps) {
  const idPrefix = useChoiceIds('CheckPresets', { id: props.id });
  return (
    <div class={cx('ops', props.class)}>
      {props.options.map((option, index) => {
        const attrs = choiceAttrs(option, index, idPrefix);
        return (
          <label class="op" data-o={attrs.o} data-risk={attrs.risk}>
            <input
              type="checkbox"
              id={attrs.inputId}
              name={props.name}
              value={option.value}
              checked={isChecked(option, props.value)}
              disabled={option.disabled}
            />
            <span>
              <span class="t">
                {option.title}
                {option.note ? (
                  <>
                    {' '}
                    <span class="muted">{option.note}</span>
                  </>
                ) : null}
              </span>
              {option.code ? <code>{option.code}</code> : null}
            </span>
            {option.tag ? <span>{option.tag}</span> : <span></span>}
          </label>
        );
      })}
    </div>
  );
}

export interface SelectedCountProps {
  /** Number of boxes in the scope (“of 4 selected”). */
  total: number;
  class?: string;
}

/**
 * “2 of 4 selected” under a group of checkboxes, counted by CSS (`.opsn`), no JS. Works inside a
 * LiveForm, in a FieldSet or FormStep with `countScope`. Decoration: hidden from assistive tech.
 */
export function SelectedCount(props: SelectedCountProps) {
  return (
    <p class={cx('hint', props.class)} aria-hidden="true">
      <span class="opsn"></span> of {props.total} selected
    </p>
  );
}
