import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface SubmitRowProps {
  /** Line under the buttons: what happens after saving. */
  hint?: Child;
  /** Target of an ErrorSummary or callout link (“Check again or save anyway”). */
  id?: string;
  class?: string;
  /** The primary submit first (named for the outcome), then Cancel or a second submit. */
  children: Child;
}

/** The form's last row (`.submit-row`): primary, then Cancel, then a hint on its own line. */
export function SubmitRow(props: SubmitRowProps) {
  return (
    <div class={cx('submit-row', props.class)} id={props.id}>
      {props.children}
      {props.hint ? <p class="hint">{props.hint}</p> : null}
    </div>
  );
}
