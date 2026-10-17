import { cx } from '../../lib/cx';
import { fmt, plural, r1 } from './parts';

export interface ChartBar {
  /** Axis label of the bar ("15:00"). Also the row header of the numbers table. */
  label: string;
  /** What the bar covers, for its tooltip ("15:00–16:00"). Defaults to `label`. */
  range?: string;
  allowed: number;
  denied: number;
  errors: number;
  /** The period is still running: the bar is drawn lighter and says "so far". */
  partial?: boolean;
}

export interface ChartProps {
  /** Prefix of the ids inside the chart (`${id}-t`, `${id}-d`). Unique on the page. */
  id: string;
  /** Accessible name of the chart ("Requests per hour, last 24 hours"). */
  title: string;
  /** The finding in one or two sentences: totals, the peak, what changed. Read with the title. */
  description: string;
  /** Bars in time order, oldest first. */
  bars: readonly ChartBar[];
  /** Label every n-th bar on the x axis, starting with the first. */
  tickEvery?: number;
  /** Label at the right end of the x axis ("now"); `''` for none. */
  endLabel?: string;
  /** Header of the first column of the numbers table. */
  columnLabel?: string;
  /** Summary of the numbers disclosure. */
  numbersLabel?: string;
  class?: string;
}

// Geometry, in viewBox units. The chart scales to the panel width.
const W = 960;
const H = 300;
const LEFT = 44;
const RIGHT = 952;
const BASE = 268;
const TOP = 16;
const MIN_SEGMENT = 2.5; // a non-zero denied or error count stays visible
const BAR_SHARE = 24 / 37.83; // bar width / slot width (24px bars for 24 hours)
const BAR_MAX = 48; // few bars (7 days) stay bars, not blocks

/** The largest of 1, 2 and 5 × 10^n that is at most `raw`: the y grid step. */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const steps = [5, 2, 1].map((m) => m * magnitude);
  return steps.find((step) => step <= raw) ?? magnitude;
}

function barTitle(bar: ChartBar): string {
  const total = bar.allowed + bar.denied + bar.errors;
  return `${bar.range ?? bar.label}${bar.partial ? ' (so far)' : ''}: ${plural(total, 'request', 'requests')}, ${fmt(bar.allowed)} allowed, ${fmt(bar.denied)} denied, ${plural(bar.errors, 'error', 'errors')}`;
}

/**
 * A server-computed stacked bar chart (`svg.chart`) of allowed, denied (hatched) and error
 * (dotted) requests, followed by its numbers as a table in a `details.numbers` disclosure.
 *
 * Renders two panels: the chart (`.panel.pad`) and the numbers (`.panel`), so it goes straight
 * into a `Tray`. Needs `ChartPatterns` once on the page for the hatch and dot fills.
 */
export function Chart(props: ChartProps) {
  const { id, bars } = props;
  const tickEvery = props.tickEvery ?? 3;
  const endLabel = props.endLabel ?? 'now';
  const totals = bars.map((bar) => bar.allowed + bar.denied + bar.errors);
  const max = Math.max(1, ...totals);
  const step = niceStep(max / 3);
  // the axis ends on a gridline: the top of the scale is the first tick at or above the tallest bar
  const top = Math.ceil(max / step) * step;
  const scale = (BASE - TOP) / top;
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  const slot = bars.length > 0 ? (RIGHT - LEFT) / bars.length : 0;
  const width = r1(Math.min(BAR_MAX, slot * BAR_SHARE));
  const segment = (value: number) => (value > 0 ? Math.max(MIN_SEGMENT, value * scale) : 0);

  return (
    <>
      <div class={cx('panel pad chart-panel', props.class)}>
        <svg
          class="chart"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-labelledby={`${id}-t ${id}-d`}
          focusable="false"
        >
          <title id={`${id}-t`}>{props.title}</title>
          <desc id={`${id}-d`}>{props.description}</desc>
          {ticks.map((value) => {
            const y = r1(BASE - value * scale);
            return (
              <>
                <line class="gridl" x1={LEFT} x2={RIGHT} y1={y} y2={y} />
                <text
                  class={cx('axis', value === 0 && 'y0')}
                  x={LEFT - 8}
                  y={r1(y + 5)}
                  text-anchor="end"
                >
                  {fmt(value)}
                </text>
              </>
            );
          })}
          {bars.map((bar, index) => {
            const x = r1(LEFT + index * slot + (slot - width) / 2);
            const hAllowed = bar.allowed * scale;
            const hError = segment(bar.errors);
            const hDenied = segment(bar.denied);
            const yAllowed = BASE - hAllowed;
            const yError = yAllowed - hError;
            const yDenied = yError - hDenied;
            return (
              <>
                <g class={cx('bar', bar.partial && 'so-far')}>
                  <title>{barTitle(bar)}</title>
                  {bar.allowed > 0 ? (
                    <rect
                      class="b-allowed"
                      x={x}
                      y={r1(yAllowed)}
                      width={width}
                      height={r1(hAllowed)}
                    />
                  ) : null}
                  {hError > 0 ? (
                    <rect class="b-error" x={x} y={r1(yError)} width={width} height={r1(hError)} />
                  ) : null}
                  {hDenied > 0 ? (
                    <rect
                      class="b-denied"
                      x={x}
                      y={r1(yDenied)}
                      width={width}
                      height={r1(hDenied)}
                    />
                  ) : null}
                </g>
                {tickEvery > 0 && index % tickEvery === 0 ? (
                  <text
                    class={cx('axis', (index / tickEvery) % 2 === 1 && 'xo')}
                    x={r1(x + width / 2)}
                    y="292"
                    text-anchor="middle"
                  >
                    {bar.label}
                  </text>
                ) : null}
              </>
            );
          })}
          {endLabel ? (
            <text class="axis" x={RIGHT} y="292" text-anchor="end">
              {endLabel}
            </text>
          ) : null}
        </svg>
      </div>
      <div class="panel">
        <details class="numbers">
          <summary>{props.numbersLabel ?? 'Show the numbers'}</summary>
          <div class="scroll" role="region" aria-label={`${props.title}, numbers`} tabindex={0}>
            <table class="tbl dense">
              <caption class="vh">{`${props.title}, numbers`}</caption>
              <thead>
                <tr>
                  <th scope="col">{props.columnLabel ?? 'Hour (UTC)'}</th>
                  <th scope="col" class="num">
                    Requests
                  </th>
                  <th scope="col" class="num">
                    Allowed
                  </th>
                  <th scope="col" class="num">
                    Denied
                  </th>
                  <th scope="col" class="num">
                    Errors
                  </th>
                </tr>
              </thead>
              <tbody>
                {bars.map((bar, index) => (
                  <tr>
                    <th scope="row">
                      {bar.label}
                      {bar.partial ? <span class="meta"> (so far)</span> : null}
                    </th>
                    <td class="num">{fmt(totals[index] ?? 0)}</td>
                    <td class="num">{fmt(bar.allowed)}</td>
                    <td class="num">{fmt(bar.denied)}</td>
                    <td class="num">{fmt(bar.errors)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </>
  );
}
