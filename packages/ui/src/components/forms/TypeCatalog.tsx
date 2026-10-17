import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { HeadingScope, H, useHeadingLevel, type HeadingLevel } from '../../lib/heading';
import { Hidden, type HiddenFields } from '../../lib/hidden';
import { LogoTile, type LogoSpec } from '../base/Logo';

export interface TypeCatalogProps {
  /** Heading id base: the section is labelled by `${id}-h`. */
  id: string;
  /** The question (“Which API does this token unlock?”). */
  title: Child;
  description?: Child;
  /** Level of the title: 2 (default), 3 under another h2. CatalogGroup labels follow one deeper. */
  headingLevel?: HeadingLevel;
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
  const nominal = props.headingLevel ?? 2;
  const hLevel = useHeadingLevel(nominal);
  return (
    <section class={props.class} id={props.id} aria-labelledby={headingId}>
      <div class="cat-list">
        <div class="tray-h">
          <div class="t">
            <H level={hLevel} id={headingId}>
              {props.title}
            </H>
            {props.description ? <p>{props.description}</p> : null}
          </div>
        </div>
        <HeadingScope by={nominal - 2}>{props.children}</HeadingScope>
      </div>
    </section>
  );
}

export interface TypeCardProps {
  /** Exclusive group: every card of one catalog shares it, so one is open at a time. */
  name: string;
  id: string;
  /** Brand tile (32px), decorative. */
  logo: LogoSpec;
  /** Type name, bold (“Slack Web API”). */
  title: Child;
  /** Small line: host and secret format (“slack.com/api · bot token xoxb-…”). */
  description?: Child;
  /** Open on load: the type from the URL, or the one whose form has an error. */
  open?: boolean;
  /** With an action, the body is the type's form (`form.type-body`); without, a plain div. */
  action?: string;
  method?: 'post' | 'get';
  /** Hidden fields at the top of the type's form (`_csrf`, the type), with `action`. */
  hidden?: HiddenFields;
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
        <LogoTile logo={props.logo} />
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
          <Hidden fields={props.hidden} />
          {props.children}
        </form>
      ) : (
        <div class={bodyClass}>{props.children}</div>
      )}
    </details>
  );
}

export interface CatalogGroupProps {
  /** Level of the label: 3 (default), one under its TypeCatalog title (which sets it). */
  headingLevel?: HeadingLevel;
  class?: string;
  /** The group (“Chat”, “AI”). */
  children: Child;
}

/** A group label between cards of a TypeCatalog (`.cat-group`): “Chat”, “AI”. */
export function CatalogGroup(props: CatalogGroupProps) {
  const hLevel = useHeadingLevel(props.headingLevel ?? 3);
  return (
    <H level={hLevel} class={cx('cat-group', props.class)}>
      {props.children}
    </H>
  );
}
