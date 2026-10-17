import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { SrPrefix } from '../../lib/sr';
import { Badge } from '../base/Badge';
import { RiskTag } from '../base/RiskTag';
import { cardsClass } from './RadioCards';

export interface ActionCard {
  /** Submitted value of the card's button (`name={props.name} value={value}`). */
  value: string;
  /** First line, medium weight: the choice (“Viewer”, “Only invited people”). */
  title: Child;
  /** One line under the title: what the choice does. */
  description?: Child;
  /** Badge after the title (“Most used”). */
  badge?: Child;
  /** Under a dashed line (`.rc-q`): a short fact, usually a Badge (“Reads only”). */
  footnote?: Child;
  /** Screen-reader text before the title (“Invite as”). The space is added. */
  srPrefix?: string;
  /** The visible verb at the right (`.rc-go`, decorative): default the cards' `go`. */
  go?: Child;
  /**
   * The current value (`div.rc.is-current`, `aria-current`): not a button, with a “✓ Current”
   * badge. Clicking it would change nothing.
   */
  current?: boolean;
  /**
   * A risky choice: warn bar and a “⚠ Risk” tag. Give it a `dialog` so it confirms first; its
   * title ends with “…”.
   */
  risk?: boolean;
  /** Opens this `Dialog` (`command="show-modal"`) instead of submitting. */
  dialog?: string;
}

export interface ActionCardsProps {
  /** Name of the submitted field (“role”, “join_policy”). The cards sit inside its form. */
  name: string;
  cards: readonly ActionCard[];
  /** The verb on every card (`.rc-go`): “Invite →”, “Save →”. */
  go?: Child;
  /** Cards per row: 2 (default), 1 or 3. One column below 40rem. */
  columns?: 1 | 2 | 3;
  /** Id of the heading that names the group of choices (`role="group"`). */
  labelledBy?: string;
  class?: string;
}

/**
 * Action cards (`.rcs` + `button.rc`): radio-card looks on submit buttons, where the click is the
 * choice (“Invite as Viewer”, “When someone new signs in”). One click submits the surrounding
 * form with `name=value`; a risky card opens its confirm dialog instead; the current value is a
 * plain card marked `aria-current`. No JS.
 */
export function ActionCards(props: ActionCardsProps) {
  return (
    <div
      class={cardsClass(props.columns, props.class)}
      role={props.labelledBy ? 'group' : undefined}
      aria-labelledby={props.labelledBy}
    >
      {props.cards.map((card) => {
        const body = (
          <span class="rc-b">
            <span class="rc-t">
              <SrPrefix text={card.srPrefix} />
              {card.title}
              {card.badge ? <> {card.badge}</> : null}
              {card.current ? (
                <>
                  {' '}
                  <Badge tone="accent" glyph="✓">
                    Current
                  </Badge>
                </>
              ) : null}
              {card.risk ? (
                <>
                  {' '}
                  <RiskTag />
                </>
              ) : null}
              {card.current ? null : (
                <span class="rc-go" aria-hidden="true">
                  {card.go ?? props.go ?? 'Choose →'}
                </span>
              )}
            </span>
            {card.description ? <span class="rc-d">{card.description}</span> : null}
            {card.footnote !== undefined ? <span class="rc-q">{card.footnote}</span> : null}
          </span>
        );
        if (card.current) {
          return (
            <div class="rc is-current" aria-current="true">
              {body}
            </div>
          );
        }
        const className = cx('rc', card.risk && 'risk');
        return card.dialog ? (
          <button
            class={className}
            type="button"
            command="show-modal"
            commandfor={card.dialog}
            popovertarget={card.dialog}
          >
            {body}
          </button>
        ) : (
          <button class={className} type="submit" name={props.name} value={card.value}>
            {body}
          </button>
        );
      })}
    </div>
  );
}
