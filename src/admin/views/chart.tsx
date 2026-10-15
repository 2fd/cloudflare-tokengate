// Server-rendered stacked bar chart of the Overview traffic (no script). The SVG is one image with
// a title and a description naming the peak and the totals; each bar has its own title, and the
// same numbers are in a table under "Show the numbers", so nothing depends on hover or colour:
// denied segments are hatched and errors dotted (WCAG 1.1.1, 1.4.1, 1.4.13). Geometry uses
// presentation attributes and fills come from classes in app.css (CSP: no style=).
import type { SeriesBucket } from '../../telemetry/dashboard';
import { DataTable } from './components';
import { formatCount, formatShortTime } from './format';

const WIDTH = 720;
const HEIGHT = 160;
const TOP = 8;
const BOTTOM = 4;
const GAP = 2;

function total(bucket: SeriesBucket): number {
  return bucket.allowed + bucket.denied + bucket.errors;
}

function bucketLabel(bucket: SeriesBucket): string {
  return `${formatShortTime(bucket.start)}${bucket.partial ? ' (so far)' : ''}`;
}

function bucketSummary(bucket: SeriesBucket): string {
  return `${bucketLabel(bucket)}: ${formatCount(bucket.allowed)} allowed, ${formatCount(bucket.denied)} denied, ${formatCount(bucket.errors)} errors`;
}

export function TrafficChart(props: {
  id: string;
  /** "Requests per hour, last 24 hours". */
  title: string;
  buckets: readonly SeriesBucket[];
}) {
  const { buckets, id } = props;
  const peak = buckets.reduce<SeriesBucket | null>(
    (best, bucket) => (best === null || total(bucket) > total(best) ? bucket : best),
    null,
  );
  const max = Math.max(1, ...buckets.map(total));
  const sum = (key: 'allowed' | 'denied' | 'errors') =>
    buckets.reduce((acc, bucket) => acc + bucket[key], 0);
  const all = sum('allowed') + sum('denied') + sum('errors');
  const desc =
    all === 0 || peak === null
      ? 'No requests in this range.'
      : `Peak: ${formatCount(total(peak))} requests at ${bucketLabel(peak)}. Total: ${formatCount(all)} requests, ${formatCount(sum('allowed'))} allowed, ${formatCount(sum('denied'))} denied, ${formatCount(sum('errors'))} errors.`;
  const slot = WIDTH / Math.max(1, buckets.length);
  const usable = HEIGHT - TOP - BOTTOM;
  const scale = (n: number) => (n / max) * usable;
  return (
    <figure class="chart">
      <svg
        class="chart-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-labelledby={`${id}-title ${id}-desc`}
      >
        <title id={`${id}-title`}>{props.title}</title>
        <desc id={`${id}-desc`}>{desc}</desc>
        <ChartPatterns />
        <line class="chart-axis" x1="0" y1={HEIGHT - BOTTOM} x2={WIDTH} y2={HEIGHT - BOTTOM} />
        {buckets.map((bucket, i) => {
          const x = i * slot + GAP / 2;
          const width = Math.max(1, slot - GAP);
          let y = HEIGHT - BOTTOM;
          const segment = (value: number, cls: string) => {
            const height = scale(value);
            y -= height;
            return value > 0 ? (
              <rect
                class={cls}
                x={x.toFixed(2)}
                y={y.toFixed(2)}
                width={width.toFixed(2)}
                height={height.toFixed(2)}
              />
            ) : null;
          };
          return (
            <g class={bucket.partial ? 'chart-bar partial' : 'chart-bar'}>
              <title>{bucketSummary(bucket)}</title>
              {segment(bucket.allowed, 'chart-allowed')}
              {segment(bucket.denied, 'chart-denied')}
              {segment(bucket.errors, 'chart-errors')}
            </g>
          );
        })}
      </svg>
      <figcaption>
        <ul class="chart-legend">
          <li>
            <Swatch cls="chart-allowed" /> Allowed
          </li>
          <li>
            <Swatch cls="chart-denied" /> Denied (hatched)
          </li>
          <li>
            <Swatch cls="chart-errors" /> Errors (dotted)
          </li>
        </ul>
      </figcaption>
      <details>
        <summary>Show the numbers</summary>
        <DataTable
          id={`${id}-numbers`}
          caption={props.title}
          rowHeader="start"
          rows={buckets}
          columns={[
            {
              key: 'start',
              header: 'From',
              render: (b) => (
                <time datetime={new Date(b.start).toISOString()}>{bucketLabel(b)}</time>
              ),
            },
            {
              key: 'allowed',
              header: 'Allowed',
              numeric: true,
              render: (b) => formatCount(b.allowed),
            },
            {
              key: 'denied',
              header: 'Denied',
              numeric: true,
              render: (b) => formatCount(b.denied),
            },
            {
              key: 'errors',
              header: 'Errors',
              numeric: true,
              render: (b) => formatCount(b.errors),
            },
            { key: 'total', header: 'Total', numeric: true, render: (b) => formatCount(total(b)) },
          ]}
        />
      </details>
    </figure>
  );
}

/** Hatch and dot patterns; referenced by the chart-denied and chart-errors fills in app.css. */
function ChartPatterns() {
  return (
    <defs>
      <pattern
        id="chart-hatch"
        width="6"
        height="6"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect class="chart-denied-bg" x="0" y="0" width="6" height="6" />
        <line class="chart-denied-line" x1="0" y1="0" x2="0" y2="6" />
      </pattern>
      <pattern id="chart-dots" width="5" height="5" patternUnits="userSpaceOnUse">
        <rect class="chart-errors-bg" x="0" y="0" width="5" height="5" />
        <circle class="chart-errors-dot" cx="2.5" cy="2.5" r="1.3" />
      </pattern>
    </defs>
  );
}

function Swatch(props: { cls: string }) {
  return (
    <svg class="chart-swatch" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <rect class={props.cls} x="0" y="0" width="12" height="12" />
    </svg>
  );
}
