import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export type CalloutTone = 'info' | 'ok' | 'warn' | 'bad';

/** Default glyph per tone; decorative, the bold first sentence says it in words. */
export const CALLOUT_GLYPHS: Record<CalloutTone, string> = {
  info: 'i',
  ok: '✓',
  warn: '⚠',
  bad: '✕',
};

export interface CalloutProps {
  /** `info` (default): a note. `ok`: done. `warn`: needs action soon. `bad`: something failed. */
  tone?: CalloutTone;
  /** The bold first sentence: what is true ("The secret of OpenAI expires on 21 Oct 2026."). */
  title: Child;
  /** Glyph in the left column; default per tone (`i`, `✓`, `⚠`, `✕`). Decorative. */
  glyph?: string;
  /** Second line in 13px secondary text (`.more`): the consequence. */
  more?: Child;
  /** One action, usually a small secondary `Button` (`.acts`, right; under the text on phones). */
  actions?: Child;
  /** `status` for a message that appears after an action (see `Notice`). Never `alert`. */
  role?: 'status';
  /**
   * Moves focus to the callout on load (`tabindex="-1" autofocus`): a `Notice` after a redirect.
   * Default false. Only one autofocus per page; an `ErrorSummary` takes it when there are errors.
   */
  autofocus?: boolean;
  class?: string;
  /** The rest of the first paragraph, after the bold sentence. */
  children?: Child;
}

/**
 * A callout (`.callout`): tone background, 4px bar, glyph, a bold first sentence, an optional
 * second line and one action. It explains a state of the page; it is not an alert.
 */
export function Callout(props: CalloutProps) {
  const tone = props.tone ?? 'info';
  return (
    <div
      class={cx('callout', tone !== 'info' && tone, props.class)}
      role={props.role}
      tabindex={props.autofocus ? -1 : undefined}
      autofocus={props.autofocus || undefined}
    >
      <span class="gl" aria-hidden="true">
        {props.glyph ?? CALLOUT_GLYPHS[tone]}
      </span>
      <div class="body">
        <p>
          <b>{props.title}</b>
          {props.children !== undefined ? <> {props.children}</> : null}
        </p>
        {props.more !== undefined ? <p class="more">{props.more}</p> : null}
      </div>
      {props.actions !== undefined ? <div class="acts">{props.actions}</div> : null}
    </div>
  );
}
