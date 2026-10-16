import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { type ChoiceBase, choiceAttrs, isChecked } from './choice';
import { useChoiceIds } from './context';

export interface Pick extends ChoiceBase {
  /** Short value: “7 days”, “production”. */
  label: Child;
  /** Mono label, for environment names and other exact values. */
  mono?: boolean;
  /** Small second fact after the label (“most used”). */
  meta?: Child;
}

export interface PicksProps {
  name: string;
  options: readonly Pick[];
  value?: string;
  /** Input id prefix; defaults to the FieldSet's id. */
  id?: string;
  /** Never inside a Reveal. */
  required?: boolean;
  class?: string;
}

/** Compact pill radios (`.picks` + `.pick`) for short values: environment, expiry. */
export function Picks(props: PicksProps) {
  const prefix = useChoiceIds('Picks', props);
  return (
    <div class={cx('picks', props.class)}>
      {props.options.map((option, index) => {
        const attrs = choiceAttrs(option, index, prefix);
        return (
          <label class="pick" data-o={attrs.o} data-risk={attrs.risk}>
            <input
              type="radio"
              id={attrs.inputId}
              name={props.name}
              value={option.value}
              checked={isChecked(option, props.value)}
              disabled={option.disabled}
              required={props.required}
            />
            {option.mono ? <span class="mono">{option.label}</span> : option.label}
            {option.meta ? <span class="meta">{option.meta}</span> : null}
          </label>
        );
      })}
    </div>
  );
}
