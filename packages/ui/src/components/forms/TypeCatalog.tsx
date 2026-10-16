import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface TypeCatalogProps {
  /** Heading id base: the section is labelled by `${id}-h`. */
  id: string;
  /** The question (“Which API does this token unlock?”). */
  title: Child;
  description?: Child;
  headingLevel?: 2 | 3;
  class?: string;
  /** TypeCard items, with CatalogGroup labels and an Or before the generic type. */
  children: Child;
}

/**
 * Type catalog (`.cat-list`): a tray of exclusive cards, one per type; opening one closes the
 * others (`details[name]`) and shows that type's own form. No JS.
 */
export function TypeCatalog(props: TypeCatalogProps) {
  const headingId = `${props.id}-h`;
  const Heading = props.headingLevel === 3 ? 'h3' : 'h2';
  return (
    <section class={props.class} id={props.id} aria-labelledby={headingId}>
      <div class="cat-list">
        <div class="tray-h">
          <div class="t">
            <Heading class={props.headingLevel === 3 ? 'h2' : undefined} id={headingId}>
              {props.title}
            </Heading>
            {props.description ? <p>{props.description}</p> : null}
          </div>
        </div>
        {props.children}
      </div>
    </section>
  );
}

export interface TypeCardProps {
  /** Exclusive group: every card of one catalog shares it, so one is open at a time. */
  name: string;
  id: string;
  /** Logo tile (`logo`, 32px), decorative. */
  logo: Child;
  /** Type name, bold (“Slack Web API”). */
  title: Child;
  /** Small line: host and secret format (“slack.com/api · bot token xoxb-…”). */
  description?: Child;
  /** Open on load: the type from the URL, or the one whose form has an error. */
  open?: boolean;
  /** With an action, the body is the type's form (`form.type-body`); without, a plain div. */
  action?: string;
  method?: 'post' | 'get';
  /** `form-layout`: fields next to a SubBox note at >= 80rem. Default `fields`: one column. */
  layout?: 'fields' | 'form-layout';
  class?: string;
  /** The type's fields and its SubmitRow. */
  children: Child;
}

/**
 * One type in a TypeCatalog (`details.type-card`): logo, name, a line, “✓ Selected” and a chevron.
 * Open: accent ring and accent-soft summary.
 */
export function TypeCard(props: TypeCardProps) {
  const bodyClass = cx('type-body', props.layout ?? 'fields');
  return (
    <details class={cx('type-card', props.class)} name={props.name} id={props.id} open={props.open}>
      <summary>
        {props.logo}
        <span>
          <b>{props.title}</b>
          {props.description ? <small>{props.description}</small> : null}
        </span>
        <span class="sel" aria-hidden="true">
          ✓ Selected
        </span>
        <span class="chev" aria-hidden="true">
          ›
        </span>
      </summary>
      {props.action ? (
        <form class={bodyClass} method={props.method ?? 'post'} action={props.action}>
          {props.children}
        </form>
      ) : (
        <div class={bodyClass}>{props.children}</div>
      )}
    </details>
  );
}

/** A group label between cards of a TypeCatalog (`.cat-group`): “Chat”, “AI”. */
export function CatalogGroup(props: { level?: 3 | 4; class?: string; children: Child }) {
  const Heading = props.level === 4 ? 'h4' : 'h3';
  return <Heading class={cx('cat-group', props.class)}>{props.children}</Heading>;
}
