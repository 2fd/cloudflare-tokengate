import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface MoreProps {
  /** The disclosure label (“More constraints”). */
  summary: Child;
  /** Regular-weight note after the label: what is set inside (“workflow pin”). */
  meta?: Child;
  /** Open when a field inside has a value or an error. */
  open?: boolean;
  class?: string;
  /** Rarely needed fields. */
  children: Child;
}

/** “More …” disclosure (`details.more`): rarely needed fields, closed by default, chevron. */
export function More(props: MoreProps) {
  return (
    <details class={cx('more', props.class)} open={props.open}>
      <summary>
        {props.summary}
        {props.meta ? (
          <>
            {' '}
            <span class="meta">{props.meta}</span>
          </>
        ) : null}
      </summary>
      <div class="more-b">{props.children}</div>
    </details>
  );
}
