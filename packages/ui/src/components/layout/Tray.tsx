import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface TrayProps {
  /** Id of the tray heading; the section is labelled by it. Unique on the page. */
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
   * the actions, as on the request log ("Requests, newest first" over the filter bar).
   */
  hideTitle?: boolean;
  /** Header actions on the right (`.tray-h .end`): secondary buttons, filters, a segmented link. */
  actions?: Child;
  /** Footer facts (`.tray-f`). */
  footer?: Child;
  /** Heading level of the title: 2 on pages, 3 when the tray sits under another h2. */
  level?: 2 | 3;
  /** `warn` adds the 3px warn bar at the top. */
  tone?: 'warn';
  class?: string;
  /** Panels (`Panel`), stacked with 4px between them. Never another tray. */
  children?: Child;
}

/**
 * Tray card (`section.tray`): a gray shell with a title row, then one or more white panels.
 * Hierarchy: page header > tray > panel content. Minimal version from the docs scaffold.
 */
export function Tray(props: TrayProps) {
  const headingId = `${props.id}-h`;
  const Heading = props.level === 3 ? 'h3' : 'h2';
  const heading = (
    <Heading class={cx(props.level === 3 && 'h2', props.hideTitle && 'vh')} id={headingId}>
      {props.title}
      {props.count !== undefined ? <span class="count">{props.count}</span> : null}
    </Heading>
  );
  return (
    <section
      class={cx('tray', props.tone === 'warn' && 'tone-warn', props.class)}
      id={props.id}
      aria-labelledby={headingId}
    >
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
      {props.children}
      {props.footer ? <div class="tray-f">{props.footer}</div> : null}
    </section>
  );
}
