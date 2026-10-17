import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { H, useHeadingLevel, type HeadingLevel } from '../../lib/heading';
import { fmt, pct, plural } from './parts';

export type ReasonKind = 'bad' | 'denied' | 'error';

export interface Reason {
  count: number;
  /** The reason in words ("Unknown issuer: no credential access rule trusts it"). */
  label: Child;
  /** The reason in a few words, for the bar's accessible name ("unknown issuer"). */
  short: string;
  /** Second fact after the label ("1 caller"). */
  meta?: Child;
  /**
   * Fill of the segment and swatch: `bad` solid red, `denied` hatched, `error` dotted. Defaults
   * by position: bad, denied, error, then bad again.
   */
  kind?: ReasonKind;
}

export interface ReasonBarProps {
  /** What the reasons break down ("Denied by reason"). Heading and the bar's accessible name. */
  title: string;
  /** Biggest first. */
  reasons: readonly Reason[];
  /** Render the `h3.sm` heading with the total. Default true. */
  heading?: boolean;
  /** Level of the heading. Default 3, one under the tray title (a Tray sets it). */
  headingLevel?: HeadingLevel;
  /** Extra classes on the `svg.rbar`. */
  class?: string;
}

const KIND_ORDER: readonly ReasonKind[] = ['bad', 'denied', 'error'];
const RECT = { bad: 'r-bad', denied: 'r-hatch', error: 'r-err' } as const;
const GAP = 2;

/**
 * Reasons bar (`svg.rbar` + `ul.reasons`): one 12px bar split by reason, then one row per reason
 * with its swatch, count, words and share. Server-computed widths, no inline styles. Goes inside a
 * `.panel.pad`; needs `ChartPatterns` once on the page.
 */
export function ReasonBar(props: ReasonBarProps) {
  const { reasons } = props;
  const total = reasons.reduce((sum, reason) => sum + reason.count, 0);
  const kinds = reasons.map(
    (reason, index) => reason.kind ?? KIND_ORDER[index % KIND_ORDER.length] ?? 'bad',
  );
  const available = 1000 - GAP * Math.max(0, reasons.length - 1);
  let x = 0;
  const segments = reasons.map((reason, index) => {
    const last = index === reasons.length - 1;
    const width = last ? 1000 - x : Math.floor((reason.count / Math.max(1, total)) * available);
    const segment = { x, width, kind: kinds[index] ?? 'bad' };
    x += width + GAP;
    return segment;
  });
  const hLevel = useHeadingLevel(props.headingLevel ?? 3);
  const name = `${props.title}: ${reasons.map((reason) => `${fmt(reason.count)} ${reason.short}`).join(', ')}`;
  return (
    <>
      {props.heading === false ? null : (
        <H level={hLevel} class="sm">
          <b>{props.title}</b>{' '}
          <span class="muted">
            {fmt(total)} in {plural(reasons.length, 'reason', 'reasons')}
          </span>
        </H>
      )}
      <svg
        class={cx('rbar', props.class)}
        viewBox="0 0 1000 12"
        preserveAspectRatio="none"
        role="img"
        aria-label={name}
        focusable="false"
      >
        {total > 0
          ? segments
              .filter((segment) => segment.width > 0)
              .map((segment) => (
                <rect class={RECT[segment.kind]} x={segment.x} width={segment.width} height="12" />
              ))
          : null}
      </svg>
      <ul class="reasons">
        {reasons.map((reason, index) => (
          <li>
            <span class={`sw ${kinds[index] ?? 'bad'}`} aria-hidden="true" />
            <span class="n">{fmt(reason.count)}</span>
            <span>
              {reason.label}
              {reason.meta !== undefined ? <span class="meta"> · {reason.meta}</span> : null}
            </span>
            <span class="pct">{pct(reason.count, total)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
