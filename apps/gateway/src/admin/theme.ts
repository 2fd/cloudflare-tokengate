// The admin theme preference: System (follow the OS), Light or Dark. It is a cookie in the browser,
// not server state: no D1 write and no audit row. A forced theme becomes `data-theme` on <html>,
// which sets `color-scheme` on :root (packages/ui ui.css tokens).
import { getCookie, setCookie } from 'hono/cookie';
import type { AdminContext } from './render';

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_COOKIE = '__Host-tokengate_theme';
/** One year: a preference, renewed on every change. */
const THEME_MAX_AGE = 365 * 24 * 60 * 60;

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** The browser's theme; `system` when the cookie is absent or not a value we write. */
export function readTheme(c: AdminContext): Theme {
  const value = getCookie(c, THEME_COOKIE);
  return isTheme(value) ? value : 'system';
}

/** Stores the theme; `system` clears the cookie (an expired one), so the OS decides again. */
export function writeTheme(c: AdminContext, theme: Theme): void {
  setCookie(c, THEME_COOKIE, theme, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: theme === 'system' ? 0 : THEME_MAX_AGE,
  });
}

/**
 * Where to go after the theme changes: the submitted page when it is an admin path of this site,
 * else the Overview. Only the path is kept, never a scheme, host or query, so this is no open
 * redirect.
 */
export function themeReturnPath(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !raw.startsWith('/admin')) return fallback;
  let url: URL;
  try {
    url = new URL(raw, 'https://admin.invalid');
  } catch {
    return fallback;
  }
  if (url.origin !== 'https://admin.invalid') return fallback;
  if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return fallback;
  return url.pathname;
}
