import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { type ChoiceBase, choiceAttrs, isChecked } from './choice';
import { useChoiceIds } from './context';

export interface RowPick extends ChoiceBase {
  /** The value as people know it ("GitHub Actions (acme)", "acme/api"). */
  title: Child;
  /** Mono title, for repositories, paths and IDs. */
  mono?: boolean;
  /** Muted part after the title: the numeric ID in brackets, “(89012345)”. */
  detail?: Child;
  /** Right column: usage count, “most used · 6 accesses”. */
  meta?: Child;
  /** Logo tile (24px, `logo sm`), decorative. Rows without one get `.nologo`. */
  logo?: Child;
}

export interface RowPickerProps {
  name: string;
  /** Existing values, most used first. End with a generic row (“Another repository”). */
  options: readonly RowPick[];
  value?: string;
  /** Input id prefix; defaults to the FieldSet's id. */
  id?: string;
  /** Never inside a Reveal. */
  required?: boolean;
  class?: string;
}

/**
 * Row picker (`.rlist` + `.row-pick`): existing values as a bordered list of radio rows, with a
 * logo, the value, and a usage count. Checked: accent-soft background and a 3px accent bar.
 */
export function RowPicker(props: RowPickerProps) {
  const prefix = useChoiceIds('RowPicker', props);
  return (
    <div class={cx('rlist', props.class)}>
      {props.options.map((option, index) => {
        const attrs = choiceAttrs(option, index, prefix);
        return (
          <label
            class={cx('row-pick', !option.logo && 'nologo')}
            data-o={attrs.o}
            data-risk={attrs.risk}
          >
            <input
              type="radio"
              id={attrs.inputId}
              name={props.name}
              value={option.value}
              checked={isChecked(option, props.value)}
              disabled={option.disabled}
              required={props.required}
            />
            {option.logo ?? null}
            <span class={cx('t', option.mono && 'mono')}>
              {option.title}
              {option.detail ? (
                <>
                  {' '}
                  <span class="muted">{option.detail}</span>
                </>
              ) : null}
            </span>
            {option.meta ? <span class="meta">{option.meta}</span> : <span></span>}
          </label>
        );
      })}
    </div>
  );
}

export interface OrProps {
  /** The divider word. */
  label?: string;
  class?: string;
}

/**
 * “OR” divider (`p.or`) between a list of known values and the generic option. Decorative: hidden
 * from assistive tech, which reads the options in order.
 */
export function Or(props: OrProps) {
  return (
    <p class={cx('or', props.class)} aria-hidden="true">
      {props.label ?? 'OR'}
    </p>
  );
}
