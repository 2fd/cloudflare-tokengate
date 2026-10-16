import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface RailKeyValueItem {
  /** The fact's name ("Token ID"), 12px above the value. */
  label: Child;
  value: Child;
  /** IDs and slugs: mono at 13px. */
  mono?: boolean;
  /** Selecting the value selects all of it, so an ID copies whole. */
  copyable?: boolean;
  /** Small second line under the value ("by Maya Chen"). */
  note?: Child;
}

export interface RailKeyValueProps {
  items: readonly RailKeyValueItem[];
  class?: string;
}

/**
 * Facts list in the right rail (`dl.rkv`): label over value, one fact per row. Goes in a
 * `Panel` (no variant) inside the rail's "Details" tray.
 */
export function RailKeyValue({ items, class: className }: RailKeyValueProps) {
  return (
    <dl class={cx('rkv', className)}>
      {items.map((item) => (
        <div>
          <dt>{item.label}</dt>
          <dd class={cx(item.mono && 'mono', item.copyable && 'copyable')}>
            {item.value}
            {item.note !== undefined ? <small>{item.note}</small> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
