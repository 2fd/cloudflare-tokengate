// Time ranges of the Monitoring pages. One rule for the Overview and Requests, so a count on the
// Overview and the filtered list it links to cover the same window. Buckets are UTC multiples of
// their size; the last bucket is the current, partial one. Requests' 1 hour is rolling.
import { HOUR_MS } from '../db/rollups';

export const DAY_MS = 86_400_000;

/** Ranges of the Overview chart; Requests adds `1h`. */
export type OverviewRange = '24h' | '7d' | '30d';
export type RequestsRange = '1h' | OverviewRange;

export const OVERVIEW_RANGES: readonly OverviewRange[] = ['24h', '7d', '30d'];
export const REQUESTS_RANGES: readonly RequestsRange[] = ['1h', '24h', '7d', '30d'];

/** Tab and title text of each range. */
export const RANGE_LABEL: Readonly<Record<RequestsRange | '90d', string>> = {
  '1h': '1 hour',
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
};

/** Size of one chart bucket. */
export const RANGE_BUCKET_MS: Readonly<Record<OverviewRange, number>> = {
  '24h': HOUR_MS,
  '7d': 6 * HOUR_MS,
  '30d': DAY_MS,
};

/** Number of chart buckets (the last one partial). */
export const RANGE_BUCKETS: Readonly<Record<OverviewRange, number>> = {
  '24h': 24,
  '7d': 28,
  '30d': 30,
};

/** Start of the UTC-aligned bucket of size `size` that holds `ms`. */
export function alignedStart(ms: number, size: number): number {
  return ms - (((ms % size) + size) % size);
}

/** First instant of a range at `now`: aligned for the Overview ranges, rolling for 1 hour. */
export function rangeStart(range: RequestsRange, now: number): number {
  if (range === '1h') return now - HOUR_MS;
  const size = RANGE_BUCKET_MS[range];
  return alignedStart(now, size) - (RANGE_BUCKETS[range] - 1) * size;
}

/** Start of every bucket of `range`, oldest first. */
export function bucketStarts(range: OverviewRange, now: number): number[] {
  const size = RANGE_BUCKET_MS[range];
  const first = rangeStart(range, now);
  return Array.from({ length: RANGE_BUCKETS[range] }, (_, i) => first + i * size);
}

/** `raw` when it is one of `allowed`, otherwise null (unknown values are never echoed). */
export function parseRange<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : null;
}
