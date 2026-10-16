// Small building blocks shared by the docs pages (not product components).
import type { Child } from 'hono/jsx';

/** A bulleted list of rich items. */
export function List(props: { items: readonly Child[]; ordered?: boolean }) {
  const items = props.items.map((item) => <li>{item}</li>);
  return props.ordered ? <ol class="dx-list">{items}</ol> : <ul class="dx-list">{items}</ul>;
}

/** Link cards (`.tcards`): title, one line, chevron. */
export function LinkCards(props: {
  label: string;
  cards: ReadonlyArray<{ href: string; title: string; description: string; meta?: string }>;
}) {
  return (
    <nav aria-label={props.label}>
      <ul class="tcards plain dx-cards">
        {props.cards.map((card) => (
          <li>
            <a class="tcard" href={card.href}>
              <span class="t">
                {card.title}
                {card.meta ? <span class="faint"> · {card.meta}</span> : null}
              </span>
              <span class="d">{card.description}</span>
              <span class="go" aria-hidden="true">
                ›
              </span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
