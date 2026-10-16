import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

/**
 * The mark before a legend label: chart swatches (`allowed`, `denied` hatched, `error` dotted,
 * `bad` solid), connections-map wires (`wire`, `wire-warn`, `wire-off` dashed, `wire-on`,
 * `wire-dim`) and matrix cells (`cell`, `cell-warn`, `cell-bad`, `cell-off` dashed).
 */
export type LegendMark =
  | 'allowed'
  | 'denied'
  | 'error'
  | 'bad'
  | 'wire'
  | 'wire-warn'
  | 'wire-off'
  | 'wire-on'
  | 'wire-dim'
  | 'cell'
  | 'cell-warn'
  | 'cell-bad'
  | 'cell-off';

export interface LegendItem {
  mark: LegendMark;
  /** The word. The mark only adds to it. */
  label: Child;
}

export interface LegendProps {
  items: readonly LegendItem[];
  /**
   * Hide the whole legend from assistive tech, when the chart's own text alternative already
   * names the series (a chart legend in a tray header). Default: read.
   */
  decorative?: boolean;
  /** Root element: `span` (default, inside a tray header or footer) or `p` (a block of its own). */
  as?: 'span' | 'p';
  class?: string;
}

/** The mark of one legend entry, always hidden from assistive tech. */
export function LegendMarkGlyph(props: { mark: LegendMark }) {
  const { mark } = props;
  if (mark.startsWith('wire')) {
    const tone = mark === 'wire' ? undefined : mark.slice('wire-'.length);
    return (
      <svg width="20" height="8" aria-hidden="true" focusable="false">
        <line x1="0" y1="4" x2="20" y2="4" class={cx('wire', tone)} />
      </svg>
    );
  }
  if (mark.startsWith('cell')) {
    const tone = mark === 'cell' ? undefined : mark.slice('cell-'.length);
    return <i class={cx('lg-sw', tone)} aria-hidden="true" />;
  }
  return <i class={cx('sw', mark)} aria-hidden="true" />;
}

/** A row of legend entries (`.legend`): mark + word for charts, the map and the matrix. */
export function Legend({ items, decorative, as = 'span', class: className }: LegendProps) {
  const Root = as;
  return (
    <Root class={cx('legend', className)} aria-hidden={decorative ? 'true' : undefined}>
      {items.map((item) => (
        <span>
          <LegendMarkGlyph mark={item.mark} />
          {item.label}
        </span>
      ))}
    </Root>
  );
}
