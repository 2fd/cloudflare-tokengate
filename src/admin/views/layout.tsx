// Page shell for the admin UI. Server-rendered with no client-side JavaScript: the CSP is
// `default-src 'none'` with no script-src (src/http/security.ts).
import type { Child } from 'hono/jsx';
import type { Role } from '../../db/types';
import { CSRF_FIELD } from '../auth/csrf';
import { can } from '../auth/rbac';
import { paths } from '../paths';

export interface Viewer {
  email: string;
  role: Role;
  /** Sign-out link; null when the login has none (local dev login). */
  signOutUrl: string | null;
  /** CSRF token for the forms the shell itself renders (the export in the footer). */
  csrfToken?: string;
}

export interface Banner {
  level: 'info' | 'warning' | 'error';
  text: string;
}

// Interim navigation until the section shell lands: every page that exists, under its URL.
const NAV: Array<{ href: string; label: string }> = [
  { href: paths.overview(), label: 'Dashboard' },
  { href: paths.tokens(), label: 'Services' },
  { href: paths.consumers(), label: 'Caller providers' },
  { href: paths.access(), label: 'Grants' },
  { href: paths.requests(), label: 'Requests' },
  { href: paths.audit(), label: 'Audit log' },
  { href: paths.users(), label: 'Users' },
  { href: paths.signIn(), label: 'Sign-in' },
  { href: paths.tokenHosts(), label: 'Allowed hosts' },
  { href: paths.tokenKeys(), label: 'Encryption keys' },
  { href: paths.retention(), label: 'Data retention' },
];

export function Layout(props: {
  title: string;
  viewer?: Viewer;
  /** Path of the current section, used to highlight the navigation entry. */
  section?: string;
  banners?: Banner[];
  notice?: string | null;
  children?: Child;
}) {
  const viewer = props.viewer;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <title>{`${props.title} · tokengate`}</title>
        <link rel="stylesheet" href="/static/app.css" />
      </head>
      <body>
        <header class="topbar">
          <a class="brand" href={paths.overview()}>
            tokengate
          </a>
          {viewer ? (
            <nav>
              {NAV.map((item) => (
                <a href={item.href} aria-current={props.section === item.href ? 'page' : undefined}>
                  {item.label}
                </a>
              ))}
            </nav>
          ) : null}
          {viewer ? (
            <div class="whoami">
              <span>
                {viewer.email} <span class="badge">{viewer.role}</span>
              </span>
              {viewer.signOutUrl ? <a href={viewer.signOutUrl}>Sign out</a> : null}
            </div>
          ) : null}
        </header>
        <main>
          {(props.banners ?? []).map((banner) => (
            <p
              class={`banner ${banner.level}`}
              role={banner.level === 'error' ? 'alert' : 'status'}
            >
              {banner.text}
            </p>
          ))}
          {props.notice ? (
            <p class="banner info" role="status">
              {props.notice}
            </p>
          ) : null}
          <h1>{props.title}</h1>
          {props.children}
        </main>
        {viewer?.csrfToken && can(viewer.role, 'config:export') ? (
          <footer class="footer">
            <form method="post" action="/admin/export" class="inline">
              <input type="hidden" name={CSRF_FIELD} value={viewer.csrfToken} />
              <button type="submit" class="secondary">
                Download configuration export
              </button>{' '}
              <small class="muted">No secrets. Includes every user's email.</small>
            </form>
          </footer>
        ) : null}
      </body>
    </html>
  );
}
