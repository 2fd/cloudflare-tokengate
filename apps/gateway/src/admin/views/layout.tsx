// Page shell of the admin UI (ADR 0019 sections, ADR 0022 design system D): the ui AppShell with
// the instance block, the health line, the sidebar navigation of the four sections and their
// pages, and the account menu (Export configuration, Docs, Sign out); the health strip at the top
// of main; then one centered Page: the page's header, the ErrorSummary, the notice and the body.
// Server rendered with no client-side JavaScript: the CSP is `default-src 'none'` with no
// script-src and `style-src 'self'` (src/http/security.ts), so there is no <script>, <style> or
// style= anywhere. The stylesheets are served by the Worker (src/http/static.ts).
import {
  AccountMenu,
  AppShell,
  type AppShellBrand,
  ChartPatterns,
  HealthLine,
  HealthStrip,
  Icon,
  type IconName,
  MenuHeader,
  MenuItem,
  MenuSeparator,
  Page,
  SideNav,
  type SideNavSection,
} from '@tokengate/ui';
import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import { version } from '../../../package.json';
import { ADMIN_STYLESHEETS } from '../assets';
import { CSRF_FIELD } from '../auth/csrf';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import type { HealthProblem, HealthSummary } from '../shell-health';
import { Time } from './components';
import { docsUrl } from './docs';
import { roleLabel } from './roles';

export type { HealthProblem } from '../shell-health';

export type SectionKey = 'monitoring' | 'users' | 'tokens' | 'consumers';

export interface SectionInfo {
  label: string;
  root: string;
  /** Docs page behind the Docs item of the account menu, relative to docs/. */
  help: string;
  /** Decorative sidebar icon. */
  icon: IconName;
  /** The section's pages: sidebar items under the open section. */
  tabs: ReadonlyArray<{ key: string; href: string; label: string }>;
}

export const SECTIONS: Readonly<Record<SectionKey, SectionInfo>> = {
  monitoring: {
    label: 'Monitoring',
    root: paths.overview(),
    help: 'observability.md',
    icon: 'monitoring',
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
    icon: 'users',
    tabs: [
      { key: 'people', href: paths.users(), label: 'People' },
      { key: 'sign-in', href: paths.signIn(), label: 'Sign-in' },
      { key: 'appearance', href: paths.appearance(), label: 'Appearance' },
    ],
  },
  tokens: {
    label: 'Credentials',
    root: paths.tokens(),
    help: 'concepts.md#credential',
    icon: 'token',
    tabs: [
      { key: 'tokens', href: paths.tokens(), label: 'Credentials' },
      { key: 'hosts', href: paths.tokenHosts(), label: 'Allowed hosts' },
      { key: 'keys', href: paths.tokenKeys(), label: 'Encryption keys' },
    ],
  },
  consumers: {
    label: 'Access Rules',
    root: paths.consumers(),
    help: 'concepts.md#credential-access-rule',
    icon: 'consumer',
    tabs: [
      { key: 'consumers', href: paths.consumers(), label: 'Credential Access Rules' },
      { key: 'access', href: paths.access(), label: 'Issuer Access Rules' },
    ],
  },
};

const TAB_ICONS: Readonly<Record<string, IconName>> = {
  overview: 'monitoring',
  requests: 'chart',
  audit: 'table',
  retention: 'system',
  tokens: 'token',
  hosts: 'home',
  keys: 'gate',
  consumers: 'consumer',
  access: 'gate',
  appearance: 'palette',
  people: 'users',
  'sign-in': 'user',
};

/** Sidebar order (ADR 0022): the product's core in the middle. */
export const SECTION_ORDER: readonly SectionKey[] = ['monitoring', 'tokens', 'consumers', 'users'];

export interface ShellProps {
  brand?: AppShellBrand;
  /** The open section; null opens none (an unknown or moved URL). */
  section: SectionKey | null;
  /** The section page this page belongs to (a `tabs` key); '' for none (403, 404). */
  subsection: string;
  /** Path of the request, to tell a section page from a deeper page under it. */
  path: string;
  view: ViewContext;
  user: { email: string; name: string | null };
  /** Sign-out link; null when the login has none (local dev login). */
  signOutUrl: string | null;
  /** People who need an owner's decision (pill on Users, `users:write` holders only). */
  needsDecision: number;
  /** Sidebar counts; a zero shows nothing. */
  counts: { tokens: number; consumers: number };
  health: HealthSummary;
  /** Error-level problems for the health strip; empty on the Overview, which lists them. */
  problems: HealthProblem[];
}

/** The document around every admin page: doctype, head with both stylesheets, body. */
export function Document(props: { title: string; children?: Child }) {
  const page = (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <meta name="color-scheme" content="light dark" />
        <title>{props.title}</title>
        {ADMIN_STYLESHEETS.map((asset) => (
          <link rel="stylesheet" href={asset.href} />
        ))}
      </head>
      <body>{props.children}</body>
    </html>
  );
  // c.html() adds no doctype, and without one the page renders in quirks mode.
  return (
    <>
      {raw('<!doctype html>')}
      {page}
    </>
  );
}

/**
 * `Error: Title – Section – tokengate`. The section part only inside the signed-in shell, and not
 * when the title is the section name ("Credentials – tokengate").
 */
export function documentTitle(title: string, section: SectionKey | null, errors: boolean): string {
  const label = section ? SECTIONS[section].label : undefined;
  return [`${errors ? 'Error: ' : ''}${title}`, label === title ? undefined : label]
    .concat('tokengate')
    .filter((part): part is string => part !== undefined)
    .join(' – ');
}

/**
 * Every signed-in page. `children` are the Page blocks in order (header, ErrorSummary, notice,
 * body); they stay direct children of `.page`, so a form page's `form.form-layout` narrows it.
 */
export function Layout(props: { title: string; shell: ShellProps; children?: Child }) {
  const { shell } = props;
  return (
    <Document title={props.title}>
      <AppShell
        brand={shell.brand ?? { name: 'tokengate', href: paths.overview(), host: shell.view.host }}
        health={
          <HealthLine
            href={shell.health.href}
            tone={shell.health.tone}
            srSuffix={shell.health.srSuffix}
          >
            {shell.health.text}
          </HealthLine>
        }
        nav={<SideNav label="Sections" sections={sideNavSections(shell)} grouped />}
        account={<AdminAccountMenu shell={shell} />}
        banner={
          shell.problems.length > 0 ? <AdminHealthStrip problems={shell.problems} /> : undefined
        }
        mainId="main"
      >
        <ChartPatterns />
        <Page>{props.children}</Page>
      </AppShell>
    </Document>
  );
}

/**
 * The pages shown before a user is resolved (sign-in problem, set up sign-in): the brand only,
 * no navigation and no account.
 */
export function BareLayout(props: {
  title: string;
  host: string;
  brand?: AppShellBrand;
  children?: Child;
}) {
  return (
    <Document title={props.title}>
      <AppShell
        brand={props.brand ?? { name: 'tokengate', href: paths.overview(), host: props.host }}
        mainId="main"
      >
        <Page>{props.children}</Page>
      </AppShell>
    </Document>
  );
}

/**
 * Labeled groups in SECTION_ORDER, with all pages visible. A page item is the
 * current page (`aria-current="page"`) on its own URL, and "true" on a deeper page under it (a
 * token under Tokens, a request under Requests).
 */
export function sideNavSections(shell: ShellProps): SideNavSection[] {
  return SECTION_ORDER.map((key) => {
    const info = SECTIONS[key];
    const count =
      key === 'tokens' ? shell.counts.tokens : key === 'consumers' ? shell.counts.consumers : 0;
    const pending = key === 'users' && shell.view.can('users:write') ? shell.needsDecision : 0;
    return {
      label: info.label,
      href: info.root,
      icon: <Icon name={info.icon} />,
      open: key === shell.section,
      count: count > 0 ? count : undefined,
      pill:
        pending > 0
          ? {
              label: `${pending} pending`,
              srSuffix: `: ${pending === 1 ? 'a person needs' : `${pending} people need`} your decision`,
            }
          : undefined,
      items: info.tabs.map((tab) => ({
        label: tab.label,
        href: tab.href,
        icon: <Icon name={TAB_ICONS[tab.key] ?? info.icon} />,
        current:
          key === shell.section && tab.key === shell.subsection
            ? tab.href === shell.path
              ? ('page' as const)
              : ('true' as const)
            : false,
      })),
    };
  });
}

/**
 * The account block: who is signed in (name, role, email, version), the configuration export for
 * `config:export` holders (a CSRF POST, audited, never a link), the docs of this section, and
 * Sign out when the login has one. The menu never opens a dialog.
 */
function AdminAccountMenu(props: { shell: ShellProps }) {
  const { shell } = props;
  // A page of no section links the docs index.
  const docs = shell.section
    ? { href: docsUrl(SECTIONS[shell.section].help), name: SECTIONS[shell.section].label }
    : { href: docsUrl('index.md'), name: 'index' };
  return (
    <AccountMenu
      id="acct"
      name={shell.user.name ?? shell.user.email}
      role={roleLabel(shell.view.role)}
    >
      <MenuHeader end={`tokengate ${version}`}>{shell.user.email}</MenuHeader>
      {shell.view.can('config:export') ? (
        <MenuItem
          action={paths.export()}
          hidden={{ [CSRF_FIELD]: shell.view.csrf }}
          detail="No secrets. Includes every user's email."
        >
          Export configuration
        </MenuItem>
      ) : null}
      <MenuItem href={docs.href} srSuffix={`: ${docs.name} (GitHub docs)`}>
        Docs
      </MenuItem>
      {shell.signOutUrl ? (
        <>
          <MenuSeparator />
          <MenuItem href={shell.signOutUrl}>Sign out</MenuItem>
        </>
      ) : null}
    </AccountMenu>
  );
}

/**
 * The first error-level problem with its fix, and how many more there are: the short title in
 * bold, then the detail in plain text (a time in the ui Time format). Not a live region: it is
 * part of every page load, so it is not announced each time (the hidden "Error:" says what the
 * glyph means).
 */
function AdminHealthStrip(props: { problems: HealthProblem[] }) {
  const [first, ...rest] = props.problems;
  if (!first) return null;
  return (
    <HealthStrip
      role={null}
      srPrefix="Error:"
      title={first.title}
      action={
        <>
          <a href={first.fix.href}>{first.fix.label}</a>
          {' · '}
          <a href={paths.overview({ hash: 'health' })}>Show all problems</a>
        </>
      }
    >
      {first.detail}
      {first.at !== undefined ? (
        <>
          {' '}
          Last failure: <Time ms={first.at} />.
        </>
      ) : null}
      {rest.length > 0 ? ` ${rest.length} more.` : null}
    </HealthStrip>
  );
}
