import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { H, useHeadingLevel, type HeadingLevel } from '../../lib/heading';

export interface ErrorSummaryItem {
  /**
   * Id of the control to fix: an Input's id, or `${fieldSetId}-1` for a group of choices. Leave it
   * out for an error that is not about one field (a form-level error, a row that is not rendered):
   * the entry is then plain text, not a link.
   */
  target?: string;
  /** The same words as the field's inline error. */
  message: Child;
}

export interface ErrorSummaryProps {
  /** One entry per field error, in page order. Nothing renders when it is empty. */
  errors: readonly ErrorSummaryItem[];
  /** Heading. */
  title?: Child;
  /** A sentence under the heading (what was not saved, what is kept). */
  description?: Child;
  /** Id of the summary; heading `${id}-h`. */
  id?: string;
  /** Focus the summary on load (default), so keyboard and screen reader users start at it. */
  autofocus?: boolean;
  /**
   * `group` (default): focus on load already announces the summary, and `alert` together with
   * autofocus would announce it twice. `alert`: only for a summary rendered with `autofocus={false}`.
   */
  role?: 'alert' | 'group';
  /** Level of the heading. Default 2: the summary sits under the page H1. */
  headingLevel?: HeadingLevel;
  class?: string;
}

/**
 * Error summary (GOV.UK pattern) at the top of a re-rendered form: a bad callout, focused on load,
 * listing every error as a link to its field (plain text for an error that is not about one
 * field). Each field still shows its inline error with the same words.
 */
export function ErrorSummary(props: ErrorSummaryProps) {
  if (props.errors.length === 0) return null;
  const id = props.id ?? 'error-summary';
  const headingId = `${id}-h`;
  const hLevel = useHeadingLevel(props.headingLevel ?? 2);
  return (
    <div
      class={cx('callout', 'bad', 'errsum', props.class)}
      id={id}
      role={props.role ?? 'group'}
      tabindex={-1}
      autofocus={props.autofocus !== false}
      aria-labelledby={headingId}
    >
      <span class="gl" aria-hidden="true">
        ✕
      </span>
      <div class="body">
        <H level={hLevel} id={headingId}>
          {props.title ?? 'There is a problem'}
        </H>
        {props.description ? <p>{props.description}</p> : null}
        <ul>
          {props.errors.map((error) =>
            error.target !== undefined ? (
              <li>
                <a href={`#${error.target}`}>{error.message}</a>
              </li>
            ) : (
              <li>{error.message}</li>
            ),
          )}
        </ul>
      </div>
    </div>
  );
}
