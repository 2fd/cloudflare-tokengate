import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

/**
 * Display formats, always in UTC (pages say "times in UTC" once, in the tray or pager):
 * `time` 14:03:22 · `clock` 14:03 · `day` 15 Oct · `date` 15 Oct 2026 · `datetime` 15 Oct 2026, 14:03.
 */
export type TimeFormat = 'time' | 'clock' | 'day' | 'date' | 'datetime';

export interface TimeProps {
  /** The moment: a `Date` or an ISO 8601 string. Written to the `datetime` attribute. */
  datetime: Date | string;
  /** How the text reads when there are no children. */
  format?: TimeFormat;
  /** Log cells: mono, 13px, secondary color, one line (`.time`). */
  mono?: boolean;
  class?: string;
  /** Text to show instead of the formatted value: a relative time ("2 min ago"), "Today 09:12". */
  children?: Child;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const two = (n: number) => String(n).padStart(2, '0');

/** Formats a date in UTC with fixed English month names (no locale data, same on every runtime). */
export function formatTime(date: Date, format: TimeFormat = 'datetime'): string {
  const clock = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  switch (format) {
    case 'time':
      return `${clock}:${two(date.getUTCSeconds())}`;
    case 'clock':
      return clock;
    case 'day':
      return day;
    case 'date':
      return `${day} ${date.getUTCFullYear()}`;
    case 'datetime':
      return `${day} ${date.getUTCFullYear()}, ${clock}`;
  }
}

/**
 * A moment in time (`time[datetime]`). The attribute carries the exact machine-readable value
 * (a string as given, a `Date` as ISO 8601 UTC); the text is what people read, formatted in UTC
 * or given as children. An invalid value renders its text without a `datetime` attribute.
 */
export function Time(props: TimeProps) {
  const date = typeof props.datetime === 'string' ? new Date(props.datetime) : props.datetime;
  const valid = !Number.isNaN(date.getTime());
  const attr = !valid
    ? undefined
    : typeof props.datetime === 'string'
      ? props.datetime
      : date.toISOString().replace('.000Z', 'Z');
  const text = props.children ?? (valid ? formatTime(date, props.format) : String(props.datetime));
  return (
    <time class={cx(props.mono && 'time', props.class)} datetime={attr}>
      {text}
    </time>
  );
}
