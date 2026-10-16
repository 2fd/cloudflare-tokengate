import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface LinkCard {
  href: string;
  /** Bold first line. */
  title: Child;
  /** One line under the title. */
  description?: Child;
  /** Faint fact after the title (“6 tokens”). */
  meta?: Child;
  /** Logo tile (`logo`, 32px), decorative. Cards without one use two columns. */
  logo?: Child;
}

export interface LinkCardsProps {
  /** Name of the list, for a list that is not under its own heading. */
  label?: string;
  cards: readonly LinkCard[];
  class?: string;
}

/**
 * Link cards (`.tcards` + `a.tcard`): pick one to go to its form page. A grid of cards at least
 * 15rem wide, each a single link with a chevron.
 */
export function LinkCards(props: LinkCardsProps) {
  return (
    <ul class={cx('tcards', 'plain', props.class)} aria-label={props.label}>
      {props.cards.map((card) => (
        <li>
          <a class="tcard" href={card.href}>
            {card.logo ?? null}
            <span class="t">
              {card.title}
              {card.meta ? <span class="faint"> · {card.meta}</span> : null}
            </span>
            {card.description ? <span class="d">{card.description}</span> : null}
            <span class="go" aria-hidden="true">
              ›
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
