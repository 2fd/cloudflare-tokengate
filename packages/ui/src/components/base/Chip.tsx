import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { SrSuffix } from '../../lib/sr';
import { LogoTile, type LogoSpec } from './Logo';

export interface ChipProps {
  /** Link to the relation (the access, the consumer). Without it the chip is a plain span. */
  href?: string;
  /** Brand tile (18px) before the name. Without a logo the chip is a text chip (`.text`). */
  logo?: LogoSpec;
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
   * (": 2 accesses, one expiring. Open."). Required whenever a glyph or tone carries status. The
   * space before it is added (none before punctuation).
   */
  srSuffix?: string;
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
      {props.logo ? <LogoTile logo={props.logo} size="xs" disabled={props.tone === 'off'} /> : null}
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
      <SrSuffix text={props.srSuffix} />
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
  /**
   * Accessible name of the group ("Can use", "Where calls went"): `role="group"` and `aria-label`.
   * Without it the row is a plain `div`.
   */
  label?: string;
  /** A trailing "+N more" link (`.more-link`) to the full list. */
  more?: { href: string; label: string };
  class?: string;
  /** `Chip`s. */
  children: Child;
}

/** A wrapping row of chips with 6px gaps (`.chips`), and an optional "+1 more" link. */
export function Chips({ label, more, class: className, children }: ChipsProps) {
  return (
    <div
      class={cx('chips', className)}
      role={label ? 'group' : undefined}
      aria-label={label || undefined}
    >
      {children}
      {more ? (
        <a class="more-link" href={more.href}>
          {more.label}
        </a>
      ) : null}
    </div>
  );
}
