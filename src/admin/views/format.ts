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

/** Builds a URL with query parameters, skipping empty values. */
export function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}

/** Display names of the login providers that are configured without errors. */
export function loginProviderNames(config: Config): string[] {
  return [
    config.login.github ? 'GitHub' : null,
    config.login.oidc ? config.login.oidc.label : null,
    config.login.access ? 'Cloudflare Access' : null,
  ].filter((name): name is string => name !== null);
}
