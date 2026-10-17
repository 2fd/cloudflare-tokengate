import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { LogoTile, type LogoSpec } from '../base/Logo';
import { RiskTag } from '../base/RiskTag';
import { type ChoiceBase, choiceAttrs, isChecked } from './choice';
import { useChoiceIds } from './context';

export interface RadioCard extends ChoiceBase {
  /** First line, medium weight. */
  title: Child;
  /** One line under the title. For a risky option, start it with “Risk:”. */
  description?: Child;
  /** A label after the title, e.g. `<Badge tone="accent">Most used</Badge>`. */
  badge?: Child;
  /**
   * Brand tile (32px) above the title, decorative: type cards such as “Add a consumer” (GitHub
   * Actions, GitLab CI). “✓ Selected” then sits in the top right corner.
   */
  logo?: LogoSpec;
  /** Spans the whole row (`.rc.wide`): a last, different option. */
  wide?: boolean;
}

export interface RadioCardsProps {
  /** Radio group name. */
  name: string;
  /** 2–6 options. */
  options: readonly RadioCard[];
  /** The checked value (preselect from context; the server renders it checked). */
  value?: string;
  /** Cards per row: 2 (default), 1 or 3. One column below 40rem; 3 becomes 2 below 64rem. */
  columns?: 1 | 2 | 3;
  /** Input id prefix; defaults to the FieldSet's id (inputs get `${id}-1` …). */
  id?: string;
  /** Never inside a Reveal. */
  required?: boolean;
  class?: string;
}

/** `.rcs` with its column count (shared with ActionCards). */
export function cardsClass(columns: 1 | 2 | 3 | undefined, className: string | undefined) {
  return cx('rcs', columns === 1 && 'c1', columns === 3 && 'c3', className);
}

/**
 * Radio cards (`.rcs` + `.rc`) for 2–6 options with a line of explanation each. Checked: accent
 * border and “✓ Selected”; a risky option turns warn and shows a “⚠ Risk” tag; disabled is struck.
 * For cards that act on click (submit the form, or open a confirm), use `ActionCards`.
 */
export function RadioCards(props: RadioCardsProps) {
  const prefix = useChoiceIds('RadioCards', props);
  return (
    <div class={cardsClass(props.columns, props.class)}>
      {props.options.map((option, index) => {
        const attrs = choiceAttrs(option, index, prefix);
        return (
          <label
            class={cx('rc', option.risk && 'risk', option.wide && 'wide')}
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
            <span class="rc-b">
              {option.logo !== undefined ? <LogoTile logo={option.logo} /> : null}
              <span class="rc-t">
                {option.title}
                {option.badge ? <> {option.badge}</> : null}
                {option.risk ? (
                  <>
                    {' '}
                    <RiskTag />
                  </>
                ) : null}
                <span class="sel" aria-hidden="true">
                  ✓ Selected
                </span>
              </span>
              {option.description ? <span class="rc-d">{option.description}</span> : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}
