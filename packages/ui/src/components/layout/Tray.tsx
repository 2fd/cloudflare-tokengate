import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { HeadingScope, H, useHeadingLevel, type HeadingLevel } from '../../lib/heading';

export interface TrayProps {
  /** Id of the section (unique on the page); the title gets `${id}-h` and labels the section. */
  id: string;
  /** Tray title (h2 by default). */
  title: Child;
  /** Count after the title. */
  count?: number | string;
  /** One line under the title. */
  description?: Child;
  /**
   * A bar that sits directly in the header row (`.tray-h`), after the title: a filter bar
   * (`Filters`) or quick links (`QuickLinks`), which size themselves against the title.
   */
  bar?: Child;
  /**
   * Keep the title for screen readers only (`.vh`): the header row then holds just the `bar` and
   * the actions, as on the request log ("Requests, newest first" over the filter bar). With
   * neither `bar` nor `actions`, there is no header row: the hidden heading opens the section.
   */
  hideTitle?: boolean;
  /** Header actions on the right (`.tray-h .end`): secondary buttons, filters, a segmented link. */
  actions?: Child;
  /** Footer facts (`.tray-f`). */
  footer?: Child;
  /**
   * Level of the title: 2 (default) on pages, 3 when the tray sits under another h2. Headings
   * inside the tray (an EmptyState, a DangerRow, a FeedDay) follow it one level deeper.
   */
  headingLevel?: HeadingLevel;
  /** `warn` adds the 3px warn bar at the top. */
  tone?: 'warn';
  class?: string;
  /** Panels (`Panel`), stacked with 4px between them. Never another tray. */
  children?: Child;
}

/**
 * Tray card (`section.tray`): a gray shell with a title row, then one or more white panels.
 * Hierarchy: page header > tray > panel content.
 */
export function Tray(props: TrayProps) {
  const headingId = `${props.id}-h`;
  const nominal = props.headingLevel ?? 2;
  const level = useHeadingLevel(nominal);
  const heading = (
    <H level={level} class={props.hideTitle ? 'vh' : undefined} id={headingId}>
      {props.title}
      {props.count !== undefined ? <span class="count">{props.count}</span> : null}
    </H>
  );
  // a hidden title with nothing beside it needs no header row (no empty 3rem bar)
  const headerless =
    props.hideTitle === true && (props.bar === undefined || props.bar === null) && !props.actions;
  return (
    <section
      class={cx('tray', props.tone === 'warn' && 'tone-warn', props.class)}
      id={props.id}
      aria-labelledby={headingId}
    >
      {headerless ? (
        heading
      ) : (
        <div class="tray-h">
          {props.hideTitle ? (
            heading
          ) : (
            <div class="t">
              {heading}
              {props.description ? <p>{props.description}</p> : null}
            </div>
          )}
          {props.bar ?? null}
          {props.actions ? <div class="end">{props.actions}</div> : null}
        </div>
      )}
      {/* headings inside sit one level under the title, whatever level it took */}
      <HeadingScope by={nominal - 2}>{props.children}</HeadingScope>
      {props.footer ? <div class="tray-f">{props.footer}</div> : null}
    </section>
  );
}
