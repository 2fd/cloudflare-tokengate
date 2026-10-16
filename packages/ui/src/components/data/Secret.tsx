import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface SecretProps {
  /** The last 4 characters, the only part tokengate keeps for display ("9fQa"). */
  last4: string;
  /** First fact line: kind and length ("Bot token · 51 characters"). */
  facts?: Child;
  /** Muted second line: when and by whom it was set, expiry, sealing key. */
  meta?: Child;
  /** "Replace secret" and "Test" (`.btn.secondary`). Never Reveal or Copy. */
  actions?: Child;
  /** Screen reader text before the last 4 characters. */
  srLabel?: string;
  class?: string;
}

/**
 * A stored secret (`.secret`): the masked last 4 characters (`.mask.lg`), its facts, and the
 * actions. The value itself is never sent to the page, so there is nothing to reveal or copy.
 */
export function Secret(props: SecretProps) {
  return (
    <div class={cx('secret', props.class)}>
      <span class="mask lg">
        <span class="vh">{props.srLabel ?? 'Secret ending in'} </span>
        <span aria-hidden="true">{'•••• '}</span>
        {props.last4}
      </span>
      {props.facts !== undefined || props.meta !== undefined ? (
        <span class="facts">
          {props.facts !== undefined ? <span>{props.facts}</span> : null}
          {props.meta !== undefined ? <span class="meta">{props.meta}</span> : null}
        </span>
      ) : null}
      {props.actions !== undefined ? <span class="acts">{props.actions}</span> : null}
    </div>
  );
}
