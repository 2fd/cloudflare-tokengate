import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { H, useHeadingLevel, type HeadingLevel } from '../../lib/heading';
import { Icon, type IconName } from '../base/Icon';

export interface EmptyStateProps {
  /** What is missing, as a sentence ("No consumer can use a token yet"). */
  title: Child;
  /** Why it matters and what the action does. One or two sentences. */
  description?: Child;
  /** Icon of the set in the 40px tile (`.glyph`), decorative. */
  icon?: IconName;
  /** One `.btn.primary` that fixes it, then an optional "How it works" link (`.btn-row`). */
  actions?: Child;
  /**
   * Level of the title: 3 (default) under a tray title (a Tray sets it), 2 when no heading is
   * above it.
   */
  headingLevel?: HeadingLevel;
  class?: string;
}

/**
 * Empty state (`.empty`) inside a panel, in place of the rows: after a table that keeps its
 * header (`Table scroll={false}` with no rows), so the shape of the list stays visible.
 */
export function EmptyState(props: EmptyStateProps) {
  const hLevel = useHeadingLevel(props.headingLevel ?? 3);
  return (
    <div class={cx('empty', props.class)}>
      {props.icon !== undefined ? (
        <span class="glyph" aria-hidden="true">
          <Icon name={props.icon} />
        </span>
      ) : null}
      <H level={hLevel}>{props.title}</H>
      {props.description !== undefined ? <p>{props.description}</p> : null}
      {props.actions !== undefined ? <div class="btn-row">{props.actions}</div> : null}
    </div>
  );
}
