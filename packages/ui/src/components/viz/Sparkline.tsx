import { r1 } from './parts';

export interface SparkBar {
  allowed: number;
  /** Denied calls, hatched on top of the allowed part. */
  denied?: number;
}

export interface SparklineProps {
  /** Prefix of the ids inside (`${id}-t`, `${id}-d`). Unique on the page. */
  id: string;
  /** Accessible name ("Slack requests per hour, last 24 hours"). */
  title: string;
  /** The finding in a sentence: the peak, where the denials are. Read with the title. */
  description: string;
  /** Bars in time order, oldest first. */
  bars: readonly SparkBar[];
  /** Labels under the chart, spread from the first bar to the last ("15:00", "03:00", "14:00"). */
  axis?: readonly string[];
  class?: string;
}

const W = 240;
const H = 44;
const TOP = 2;

/**
 * A small bar chart (`svg.chart.spark`, 44px) of allowed and denied (hatched) calls, for a rail
 * next to KPIs. It has a title and a one-sentence description instead of axes; the page links to
 * the full chart or the request list for the numbers. Needs `ChartPatterns` once on the page.
 */
export function Sparkline(props: SparklineProps) {
  const totals = props.bars.map((bar) => bar.allowed + (bar.denied ?? 0));
  const scale = (H - TOP) / Math.max(1, ...totals);
  const slot = props.bars.length > 0 ? W / props.bars.length : 0;
  const width = r1(slot * 0.7);
  return (
    <div class={props.class}>
      <svg
        class="chart spark"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-labelledby={`${props.id}-t ${props.id}-d`}
        focusable="false"
      >
        <title id={`${props.id}-t`}>{props.title}</title>
        <desc id={`${props.id}-d`}>{props.description}</desc>
        <g class="b-allowed">
          {props.bars.map((bar, index) => {
            const h = bar.allowed * scale;
            return h > 0 ? (
              <rect
                x={r1(index * slot + (slot - width) / 2)}
                y={r1(H - h)}
                width={width}
                height={r1(h)}
              />
            ) : null;
          })}
        </g>
        {props.bars.map((bar, index) => {
          const denied = bar.denied ?? 0;
          if (denied <= 0) return null;
          const h = Math.max(1.5, denied * scale);
          const y = H - bar.allowed * scale - h;
          return (
            <rect
              class="b-denied"
              x={r1(index * slot + (slot - width) / 2)}
              y={r1(y)}
              width={width}
              height={r1(h)}
            />
          );
        })}
      </svg>
      {props.axis && props.axis.length > 0 ? (
        <div class="spark-axis" aria-hidden="true">
          {props.axis.map((label) => (
            <span>{label}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
