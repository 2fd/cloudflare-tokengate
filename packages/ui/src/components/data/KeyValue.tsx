import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface KeyValueItem {
  /** The fact's name ("Upstream"). */
  label: Child;
  value: Child;
  /** The value is a URL, path or ID: mono. */
  mono?: boolean;
  /** Selecting the value selects all of it (`.copyable`), so it copies whole. There is no copy button. */
  copyable?: boolean;
  /** The value is a row of chips or badges (`dd .line`): they wrap with an 8px gap. */
  line?: boolean;
}

export interface KeyValueProps {
  items: readonly KeyValueItem[];
  class?: string;
}

/**
 * Facts list in the main column (`dl.kv`): a 12rem label column and the value, divided by lines.
 * Below 48rem the label sits above its value.
 */
export function KeyValue({ items, class: className }: KeyValueProps) {
  return (
    <dl class={cx('kv', className)}>
      {items.map((item) => (
        <div>
          <dt>{item.label}</dt>
          <dd class={cx(item.mono && 'mono', item.copyable && 'copyable')}>
            {item.line ? <div class="line">{item.value}</div> : item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
