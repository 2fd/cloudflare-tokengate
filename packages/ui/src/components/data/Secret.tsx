import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { Mask } from '../base/Mask';

export interface SecretProps {
  /**
   * The last 4 characters, the only part tokengate keeps for display ("9fQa"). Only the last 4
   * are ever rendered, whatever is passed (the mask is a `Mask`).
   */
  last4: string;
  /** First fact line: kind and length ("Bot token · 51 characters"). */
  facts?: Child;
  /** Muted second line: when and by whom it was set, expiry, sealing key. */
  meta?: Child;
  /** "Replace secret" and "Test" (`.btn.secondary`). Never Reveal or Copy. */
  actions?: Child;
  /** Screen reader text before the last 4 characters. Default "Secret ending in". */
  srPrefix?: string;
  class?: string;
}

/**
 * A stored secret (`.secret`): the masked last 4 characters (`Mask size="lg"`), its facts, and
 * the actions. The value itself is never sent to the page, so there is nothing to reveal or copy.
 */
export function Secret(props: SecretProps) {
  return (
    <div class={cx('secret', props.class)}>
      <Mask last4={props.last4} size="lg" srPrefix={props.srPrefix} />
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
