// Display formatting for the admin UI.
import type { Config } from '../../config';

export function formatTime(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio < 0.01 && ratio > 0 ? 2 : 1)}%`;
}

/** Display names of the login providers that are configured without errors. */
export function loginProviderNames(config: Config): string[] {
  return [
    config.login.access ? 'Cloudflare Access' : null,
    config.login.dev ? 'the local development login' : null,
  ].filter((name): name is string => name !== null);
}

/** "3 min ago", "in 2 h", "just now": a coarse distance from `now`, for monitoring views. */
export function relativeTime(ms: number, now: number): string {
  const diff = now - ms;
  const abs = Math.abs(diff);
  if (abs < 60_000) return 'just now';
  const [amount, unit] =
    abs < 3_600_000
      ? [Math.floor(abs / 60_000), 'min']
      : abs < 86_400_000
        ? [Math.floor(abs / 3_600_000), 'h']
        : [Math.floor(abs / 86_400_000), abs < 2 * 86_400_000 ? 'day' : 'days'];
  return diff >= 0 ? `${amount} ${unit} ago` : `in ${amount} ${unit}`;
}

const HOUR_MS = 3_600_000;

/**
 * "22 min ago" for usage counted per hour (`hour` = the start of the newest hour with a call): the
 * middle of the part of that hour that has passed, so the current hour never reads "in 23 min".
 */
export function lastUsedTime(hour: number, now: number): string {
  const end = Math.min(hour + HOUR_MS, Math.max(now, hour));
  return relativeTime(hour + (end - hour) / 2, now);
}

/** "13 Oct 15:00 UTC": a short UTC time for "since …" lines. */
export function formatShortTime(ms: number): string {
  const date = new Date(ms);
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${date.getUTCDate()} ${month} ${hh}:${mm} UTC`;
}

/** "20 Oct 2026": the UTC date of `ms`, as the ui Time component writes a date. */
export function formatDate(ms: number): string {
  const date = new Date(ms);
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
}
