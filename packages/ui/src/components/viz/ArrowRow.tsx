import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { LogoTile, type LogoSpec } from '../base/Logo';

export interface ArrowEnd {
  /** "GitHub Actions (acme) › acme/api", "Slack". */
  name: Child;
  logo?: LogoSpec;
  /** Muted fact after the name, after a "·": "environment production", "Post messages". */
  context?: Child;
}

export interface ArrowRowProps {
  /** Left side: the consumer (and repository). */
  consumer: ArrowEnd;
  /**
   * Right side: the token (and operation). Leave out for a consumer-only row ("refused before a
   * token was chosen", an unverified caller): no arrow and no verb.
   */
  token?: ArrowEnd;
  /** Makes the whole row one link (the access). */
  href?: string;
  /** What the arrow means, read by screen readers instead of "→". Default "can use". */
  verb?: string;
  class?: string;
}

function Side(props: { end: ArrowEnd; cls: string; linked: boolean }) {
  const { end } = props;
  return (
    <span class={props.cls}>
      {end.logo ? <LogoTile logo={end.logo} size="xs" /> : null}
      {props.linked ? <span class="ent-n">{end.name}</span> : end.name}
      {end.context !== undefined ? (
        <span class="ctx">
          <span class="sep" aria-hidden="true">
            ·{' '}
          </span>
          {end.context}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Arrow row (`.arrow`): consumer → token, one delegation on one line (two on narrow screens).
 * Used in access lists, on detail pages and as the text form of the connections map.
 */
export function ArrowRow(props: ArrowRowProps) {
  const linked = props.href !== undefined;
  const body = (
    <>
      <Side end={props.consumer} cls="side-c" linked={linked} />
      {props.token ? (
        <>
          <span class="to" aria-hidden="true">
            →
          </span>
          <span class="vh">{` ${props.verb ?? 'can use'} `}</span>
          <Side end={props.token} cls="side-t" linked={false} />
        </>
      ) : null}
    </>
  );
  return linked ? (
    <a class={cx('arrow', props.class)} href={props.href}>
      {body}
    </a>
  ) : (
    <span class={cx('arrow', props.class)}>{body}</span>
  );
}
