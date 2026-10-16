import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { Delta, type DeltaProps } from './Delta';
import { fmt } from './parts';

export interface KpiItem {
  /** What is counted ("Requests", "Denied"). The `dt` of the tile. */
  label: Child;
  /** Chart swatch before the label, when the tile matches a chart series. */
  swatch?: 'allowed' | 'denied' | 'error' | 'bad';
  /** The number. Numbers get thousands separators; strings are shown as given. */
  value: number | string;
  /** Unit or share after the number, smaller: `2.9 %`, `ms p95`. */
  unit?: Child;
  /** Change against the previous period, before `meta`. */
  delta?: Omit<DeltaProps, 'class'>;
  /** Comparison or breakdown line: "vs previous 24 h", "OpenAI 11 · Anthropic 1". */
  meta?: Child;
  /** Extra content under the meta line, such as a small inline chart. */
  extra?: Child;
  /** Link to the filtered list behind the number. */
  link?: { href: string; label: Child };
  /**
   * The worst tile of the row: it takes the warn tone. Only the first item marked `worst` gets it,
   * so a row never shouts twice.
   */
  worst?: boolean;
}

export interface KpisProps {
  items: readonly KpiItem[];
  class?: string;
}

/**
 * KPI tiles (`dl.kpis > div.kpi`): label, big number with unit, change and a link to the list.
 * The tiles fill the row (minimum 10rem each) and wrap.
 */
export function Kpis({ items, class: className }: KpisProps) {
  const worst = items.findIndex((item) => item.worst);
  return (
    <dl class={cx('kpis', className)}>
      {items.map((item, index) => (
        <div class={cx('kpi', index === worst && 'tone-warn')}>
          <dt>
            {item.swatch ? <i class={`sw ${item.swatch}`} aria-hidden="true" /> : null}
            {item.label}
          </dt>
          <dd class="kpi-n">
            {fmt(item.value)}
            {item.unit !== undefined ? <small>{item.unit}</small> : null}
          </dd>
          {item.delta || item.meta !== undefined ? (
            <dd class="kpi-m">
              {item.delta ? <Delta {...item.delta} /> : null}
              {item.meta}
            </dd>
          ) : null}
          {item.extra !== undefined ? <dd>{item.extra}</dd> : null}
          {item.link ? (
            <dd class="kpi-l">
              <a href={item.link.href}>{item.link.label}</a>
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
