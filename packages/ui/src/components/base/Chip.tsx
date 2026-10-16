import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { Logo, type LogoBrand } from './Logo';

export interface ChipProps {
  /** Link to the relation (the access, the consumer). Without it the chip is a plain span. */
  href?: string;
  /** Brand tile (18px) before the name. Without a logo the chip is a text chip (`.text`). */
  logo?: LogoBrand;
  /**
   * `warn` / `bad` tint the glyph (an expired access); `off` is dashed with a dimmed logo (inactive,
   * the token is disabled). Default: an active relation.
   */
  tone?: 'warn' | 'bad' | 'off';
  /** Count after the name (`.n`): accesses, repositories. */
  count?: number | string;
  /** Trailing status glyph (`.g`, decorative): ⌛ expiring, ✕ expired, ⚠ inactive. */
  glyph?: string;
  /** Tints only the glyph on an otherwise active chip: `warn` for "one access expiring". */
  glyphTone?: 'ok' | 'warn' | 'bad';
  /**
   * Screen-reader-only rest of the sentence (`.vh`): the status in words and the action
   * (": 2 accesses, one expiring. Open."). Required whenever a glyph or tone carries status.
   */
  context?: string;
  class?: string;
  /** The name of the related object ("Slack", "acme/api · env production"). */
  children: Child;
}

/**
 * A relationship chip (`.chip`, radius 4): the logo and name of a related object, a count and a
 * status glyph, linking to the relation. Put chips in `Chips`.
 */
export function Chip(props: ChipProps) {
  const className = cx('chip', props.tone, props.logo === undefined && 'text', props.class);
  const content = (
    <>
      {props.logo ? <Logo brand={props.logo} size="xs" disabled={props.tone === 'off'} /> : null}
      {props.children}
      {props.count !== undefined ? (
        <>
          {' '}
          <span class="n">{props.count}</span>
        </>
      ) : null}
      {props.glyph ? (
        <span class={cx('g', props.glyphTone && `t-${props.glyphTone}`)} aria-hidden="true">
          {props.glyph}
        </span>
      ) : null}
      {props.context ? <span class="vh">{props.context}</span> : null}
    </>
  );
  return props.href !== undefined ? (
    <a class={className} href={props.href}>
      {content}
    </a>
  ) : (
    <span class={className}>{content}</span>
  );
}

export interface ChipsProps {
  /** A trailing "+N more" link (`.more-link`) to the full list. */
  more?: { href: string; label: string };
  class?: string;
  /** `Chip`s. */
  children: Child;
}

/** A wrapping row of chips with 6px gaps (`.chips`), and an optional "+1 more" link. */
export function Chips({ more, class: className, children }: ChipsProps) {
  return (
    <div class={cx('chips', className)}>
      {children}
      {more ? (
        <a class="more-link" href={more.href}>
          {more.label}
        </a>
      ) : null}
    </div>
  );
}
