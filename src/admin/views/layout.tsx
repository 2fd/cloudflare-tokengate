// Page shell for the admin UI. Server-rendered with no client-side JavaScript: the CSP is
// `default-src 'none'` with no script-src (src/http/security.ts).
import type { Child } from 'hono/jsx';
import type { Role } from '../../db/types';

export interface Viewer {
  email: string;
  role: Role;
  /** Sign-out link; null when the login has none (local dev login). */
  signOutUrl: string | null;
}

export interface Banner {
  level: 'info' | 'warning' | 'error';
  text: string;
}

const NAV: Array<{ href: string; label: string }> = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/services', label: 'Services' },
  { href: '/admin/caller-providers', label: 'Caller providers' },
  { href: '/admin/grants', label: 'Grants' },
  { href: '/admin/requests', label: 'Requests' },
  { href: '/admin/audit', label: 'Audit log' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/settings', label: 'Settings' },
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
          <a class="brand" href="/admin">
            tokengate
          </a>
          {props.viewer ? (
            <nav>
              {NAV.map((item) => (
                <a href={item.href} aria-current={props.section === item.href ? 'page' : undefined}>
                  {item.label}
                </a>
              ))}
            </nav>
          ) : null}
          {props.viewer ? (
            <div class="whoami">
              <span>
                {props.viewer.email} <span class="badge">{props.viewer.role}</span>
              </span>
              {props.viewer.signOutUrl ? <a href={props.viewer.signOutUrl}>Sign out</a> : null}
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
      </body>
    </html>
  );
}
