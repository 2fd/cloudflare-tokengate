import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface EmptyStateProps {
  /** What is missing, as a sentence ("No consumer can use a token yet"). */
  title: Child;
  /** Why it matters and what the action does. One or two sentences. */
  description?: Child;
  /** Decorative 16px icon (`svg.ic`) in the 40px glyph tile. Hidden from assistive tech. */
  glyph?: Child;
  /** One `.btn.primary` that fixes it, then an optional "How it works" link (`.btn-row`). */
  actions?: Child;
  /** Heading level of the title: 3 under a tray title (default), 2 when no heading is above it. */
  level?: 2 | 3 | 4;
  class?: string;
}

/**
 * Empty state (`.empty`) inside a panel, in place of the rows: after a table that keeps its
 * header (`Table scroll={false}` with no rows), so the shape of the list stays visible.
 */
export function EmptyState(props: EmptyStateProps) {
  const Heading = props.level === 2 ? 'h2' : props.level === 4 ? 'h4' : 'h3';
  return (
    <div class={cx('empty', props.class)}>
      {props.glyph !== undefined ? (
        <span class="glyph" aria-hidden="true">
          {props.glyph}
        </span>
      ) : null}
      <Heading>{props.title}</Heading>
      {props.description !== undefined ? <p>{props.description}</p> : null}
      {props.actions !== undefined ? <div class="btn-row">{props.actions}</div> : null}
    </div>
  );
}
