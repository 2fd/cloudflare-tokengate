// Small building blocks shared by the docs pages (not product components).
import { LinkCards as UiLinkCards, type LinkCard } from '@tokengate/ui';
import type { Child } from 'hono/jsx';

/** A bulleted list of rich items. */
export function List(props: { items: readonly Child[]; ordered?: boolean }) {
  const items = props.items.map((item) => <li>{item}</li>);
  return props.ordered ? <ol class="dx-list">{items}</ol> : <ul class="dx-list">{items}</ul>;
}

/** The docs index cards: the system's `LinkCards` in a named navigation landmark. */
export function LinkCards(props: { label: string; cards: readonly LinkCard[] }) {
  return (
    <nav aria-label={props.label}>
      <UiLinkCards cards={props.cards} />
    </nav>
  );
}
