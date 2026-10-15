// Page shell for the admin UI (ADR 0019): skip link, header with the four sections, Help and the
// account, the section's subnav, the health strip, main, and the footer with the export. Server
// rendered with no client-side JavaScript: the CSP is `default-src 'none'` with no script-src and
// `style-src 'self'` (src/http/security.ts), so there is no <script>, <style> or style= anywhere.
import type { Child } from 'hono/jsx';
import { version } from '../../../package.json';
import type { Notice } from '../notice';
import type { FieldError } from '../ops/shared';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { Breadcrumbs, ErrorSummary, NoticeView, PostForm, Tabs } from './components';
import { docsUrl } from './docs';
import type { Banner } from './legacy';
import { roleLabel } from './roles';

export type SectionKey = 'monitoring' | 'users' | 'tokens' | 'consumers';

export interface SectionInfo {
  label: string;
  root: string;
  /** Docs page behind the Help link, relative to docs/. */
  help: string;
  tabs: ReadonlyArray<{ key: string; href: string; label: string }>;
}

export const SECTIONS: Readonly<Record<SectionKey, SectionInfo>> = {
  monitoring: {
    label: 'Monitoring',
    root: paths.overview(),
    help: 'observability.md',
    tabs: [
      { key: 'overview', href: paths.overview(), label: 'Overview' },
      { key: 'requests', href: paths.requests(), label: 'Requests' },
      { key: 'audit', href: paths.audit(), label: 'Audit log' },
      { key: 'retention', href: paths.retention(), label: 'Data retention' },
    ],
  },
  users: {
    label: 'Users',
    root: paths.users(),
    help: 'concepts.md#user',
    tabs: [
      { key: 'people', href: paths.users(), label: 'People' },
      { key: 'sign-in', href: paths.signIn(), label: 'Sign-in' },
    ],
  },
  tokens: {
    label: 'Service tokens',
    root: paths.tokens(),
    help: 'concepts.md#service-token',
    tabs: [
      { key: 'tokens', href: paths.tokens(), label: 'Tokens' },
      { key: 'hosts', href: paths.tokenHosts(), label: 'Allowed hosts' },
      { key: 'keys', href: paths.tokenKeys(), label: 'Encryption keys' },
    ],
  },
  consumers: {
    label: 'Service consumers',
    root: paths.consumers(),
    help: 'concepts.md#service-consumer',
    tabs: [
      { key: 'consumers', href: paths.consumers(), label: 'Consumers' },
      { key: 'access', href: paths.access(), label: 'Consumer access' },
    ],
  },
};

export const SECTION_ORDER: readonly SectionKey[] = ['monitoring', 'users', 'tokens', 'consumers'];

/** An error-level system problem shown in the health strip on every page. */
export interface HealthProblem {
  title: string;
  fix: { href: string; label: string };
}

export interface ShellProps {
  section: SectionKey;
  subsection: string;
  /** Path of the request, to tell a section's root page from its subpages. */
  path: string;
  view: ViewContext;
  email: string;
  /** Sign-out link; null when the login has none (local dev login). */
  signOutUrl: string | null;
  /** People who need an owner's decision (badge on Users, `users:write` holders only). */
  needsDecision: number;
  problems: HealthProblem[];
}

export function Layout(props: {
  title: string;
  /** The signed-in shell; omitted on the pages shown before a user is resolved. */
  shell?: ShellProps;
  breadcrumbs?: Array<{ href: string; label: string }>;
  errors?: FieldError[];
  notice?: Notice | null;
  subnavExtra?: Child;
  legacyBanners?: Banner[];
  children?: Child;
}) {
  const shell = props.shell;
  const section = shell ? SECTIONS[shell.section] : null;
  const errors = props.errors ?? [];
  const title = [`${errors.length > 0 ? 'Error: ' : ''}${props.title}`, section?.label, 'tokengate']
    .filter((part) => part !== undefined)
    .join(' – ');
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <meta name="color-scheme" content="light dark" />
        <title>{title}</title>
        <link rel="stylesheet" href="/static/app.css" />
      </head>
      <body>
        <a class="skip-link" href="#main">
          Skip to main content
        </a>
        <header class="topbar">
          <a class="brand" href={paths.overview()}>
            tokengate
          </a>
          {shell && section ? <SectionNav shell={shell} /> : null}
          {shell && section ? (
            <a class="help" href={docsUrl(section.help)}>
              Help<span class="vh">: {section.label} (GitHub docs)</span>
            </a>
          ) : null}
          {shell ? (
            <div class="account">
              <span>{shell.email}</span> <span class="badge">{roleLabel(shell.view.role)}</span>
              {shell.signOutUrl ? <a href={shell.signOutUrl}>Sign out</a> : null}
            </div>
          ) : null}
        </header>
        {shell && section ? (
          <>
            <Tabs
              label={`${section.label} pages`}
              class="subnav"
              items={section.tabs.map((tab) => ({ ...tab }))}
              current={shell.subsection}
              currentState={section.tabs.some((tab) => tab.href === shell.path) ? 'page' : 'true'}
            />
            {props.subnavExtra}
            <HealthStrip problems={shell.problems} />
          </>
        ) : null}
        <main id="main" tabindex={-1}>
          {props.breadcrumbs && props.breadcrumbs.length > 0 ? (
            <Breadcrumbs items={props.breadcrumbs} />
          ) : null}
          <ErrorSummary errors={errors} />
          <h1>{props.title}</h1>
          {props.notice && shell ? (
            <NoticeView
              notice={props.notice}
              csrf={shell.view.csrf}
              autofocus={errors.length === 0}
            />
          ) : null}
          {(props.legacyBanners ?? []).map((banner) => (
            <p
              class={`banner ${banner.level}`}
              role={banner.level === 'error' ? 'alert' : 'status'}
            >
              {banner.text}
            </p>
          ))}
          {props.children}
        </main>
        <footer class="footer">
          <p>tokengate {version}</p>
          {shell?.view.can('config:export') ? (
            <PostForm action="/admin/export" csrf={shell.view.csrf} class="inline">
              <button type="submit" class="secondary">
                Download configuration export (JSON)
              </button>{' '}
              <span class="hint">No secrets. Includes every user's email.</span>
            </PostForm>
          ) : null}
        </footer>
      </body>
    </html>
  );
}

function SectionNav(props: { shell: ShellProps }) {
  const { shell } = props;
  return (
    <nav class="sections" aria-label="Sections">
      <ul>
        {SECTION_ORDER.map((key) => {
          const info = SECTIONS[key];
          const current = key === shell.section;
          const count = key === 'users' && shell.view.can('users:write') ? shell.needsDecision : 0;
          return (
            <li>
              <a
                href={info.root}
                aria-current={current ? (shell.path === info.root ? 'page' : 'true') : undefined}
              >
                {info.label}
                {count > 0 ? (
                  <>
                    {' '}
                    <span class="count">
                      {count}
                      <span class="vh"> need a decision</span>
                    </span>
                  </>
                ) : null}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function HealthStrip(props: { problems: HealthProblem[] }) {
  const [first, ...rest] = props.problems;
  if (!first) return null;
  return (
    <section class="health-strip" aria-labelledby="hs-h">
      <h2 id="hs-h" class="vh">
        System problems
      </h2>
      <p>
        <strong>Error:</strong> {first.title}
        {rest.length > 0 ? ` · ${rest.length} more` : ''}{' '}
        <a href={first.fix.href}>{first.fix.label}</a>
        {' · '}
        <a href={paths.overview({ hash: 'health' })}>Show all problems</a>
      </p>
    </section>
  );
}
