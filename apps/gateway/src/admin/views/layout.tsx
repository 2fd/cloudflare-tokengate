// Page shell of the admin UI (ADR 0019 sections, ADR 0022 design system D): the ui AppShell with
// the instance block, the health line, the sidebar navigation of the three sections and their
// pages, and the account menu (Theme, Export configuration, Docs, Sign out); the health strip at
// the top of main; then one centered Page: the page's header, the ErrorSummary, the notice and the
// body.
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
  MenuChoice,
  MenuHeader,
  MenuItem,
  MenuSeparator,
  Page,
  SideNav,
  type SideNavSection,
} from '@tokengate/ui';
import { favicon } from '@tokengate/ui/favicon';
import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import { version } from '../../../package.json';
import { ADMIN_STYLESHEETS } from '../assets';
import { CSRF_FIELD } from '../auth/csrf';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import type { HealthProblem, HealthSummary, NavAttention } from '../shell-health';
import { THEMES, type Theme } from '../theme';
import { Time } from './components';
import { docsUrl } from './docs';
import { roleLabel } from './roles';

export type { HealthProblem } from '../shell-health';

export type SectionKey = 'monitoring' | 'credentials' | 'settings';

export interface SectionTab {
  key: string;
  href: string;
  label: string;
  /** Docs page of this page, relative to docs/; default the section's `help`. */
  help?: string;
  /** More path roots whose pages belong to this item (the global access rules). */
  under?: readonly string[];
}

export interface SectionInfo {
  label: string;
  root: string;
  /** Docs page behind the Docs item of the account menu, relative to docs/. */
  help: string;
  /** Decorative sidebar icon. */
  icon: IconName;
  /** The section's pages: sidebar items under the open section. */
  tabs: readonly SectionTab[];
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
  credentials: {
    label: 'Credentials',
    root: paths.tokens(),
    help: 'concepts.md',
    icon: 'token',
    tabs: [
      { key: 'tokens', href: paths.tokens(), label: 'Credentials', help: 'concepts.md#credential' },
      {
        key: 'access-rules',
        href: paths.accessRules(),
        label: 'Access Rules',
        help: 'concepts.md#credential-access-rule',
        under: [paths.globalRules()],
      },
    ],
  },
  settings: {
    label: 'Settings',
    root: paths.users(),
    help: 'configuration.md',
    icon: 'system',
    tabs: [
      { key: 'members', href: paths.users(), label: 'Members' },
      { key: 'hosts', href: paths.tokenHosts(), label: 'Allowed hosts' },
      { key: 'keys', href: paths.tokenKeys(), label: 'Rotate encryption' },
      { key: 'appearance', href: paths.appearance(), label: 'Appearance' },
      { key: 'faq', href: paths.faq(), label: 'FAQ' },
    ],
  },
};

const TAB_ICONS: Readonly<Record<string, IconName>> = {
  overview: 'monitoring',
  requests: 'chart',
  audit: 'table',
  retention: 'system',
  tokens: 'token',
  'access-rules': 'consumer',
  hosts: 'home',
  keys: 'gate',
  appearance: 'palette',
  members: 'users',
  faq: 'help',
};

const THEME_LABELS: Readonly<Record<Theme, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/** Sidebar order (ADR 0022): the product's core in the middle. */
export const SECTION_ORDER: readonly SectionKey[] = ['monitoring', 'credentials', 'settings'];

/** Sidebar count of a page; a zero shows nothing. */
function tabCount(key: string, counts: ShellProps['counts']): number {
  if (key === 'tokens') return counts.tokens;
  if (key === 'access-rules') return counts.rules;
  return 0;
}

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
  /** People who need an owner's decision (pill on Settings, `users:write` holders only). */
  needsDecision: number;
  /** Sidebar counts; a zero shows nothing. */
  counts: { tokens: number; rules: number; globals: number };
  health: HealthSummary;
  /** Sidebar dots by tab key: pages that show a problem, a warning or a note. */
  attention: Record<string, NavAttention>;
  /** Error-level problems for the health strip; empty on the Overview, which lists them. */
  problems: HealthProblem[];
  /** The browser's theme preference (a cookie), shown and changed in the account menu. */
  theme: Theme;
  /** Where the theme form returns to: this page's path, without the query. */
  returnTo: string;
}

/** The document around every admin page: doctype, head with the favicon and both stylesheets, body. */
export function Document(props: {
  title: string;
  /** The brand image the favicon is made from; none for the default shield. */
  image?: string;
  refresh?: number;
  /** A forced theme; `system` (the default) follows the OS. */
  theme?: Theme;
  children?: Child;
}) {
  const forced = props.theme === 'system' ? undefined : props.theme;
  const page = (
    <html lang="en" data-theme={forced}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <meta name="color-scheme" content={forced ?? 'light dark'} />
        {props.refresh ? <meta http-equiv="refresh" content={String(props.refresh)} /> : null}
        <title>{props.title}</title>
        <link rel="icon" type="image/svg+xml" href={favicon(props.image).href} />
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
 * `Error: Title – Section – Product`, where Product is the configured title (Settings → Appearance,
 * default tokengate). The section part only inside the signed-in shell, and not when the title is
 * the section name ("Credentials – tokengate").
 */
export function documentTitle(
  title: string,
  section: SectionKey | null,
  errors: boolean,
  product: string,
): string {
  const label = section ? SECTIONS[section].label : undefined;
  return [`${errors ? 'Error: ' : ''}${title}`, label === title ? undefined : label]
    .concat(product)
    .filter((part): part is string => part !== undefined)
    .join(' – ');
}

/**
 * Every signed-in page. `children` are the Page blocks in order (header, ErrorSummary, notice,
 * body); they stay direct children of `.page`, so a form page's `form.form-layout` narrows it.
 */
export function Layout(props: {
  title: string;
  shell: ShellProps;
  /** Seconds after which the browser reloads the page (a progress page); no script needed. */
  refresh?: number;
  children?: Child;
}) {
  const { shell } = props;
  return (
    <Document
      title={props.title}
      image={shell.brand?.image}
      refresh={props.refresh}
      theme={shell.theme}
    >
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
  theme?: Theme;
  children?: Child;
}) {
  return (
    <Document title={props.title} image={props.brand?.image} theme={props.theme}>
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
    const pending = key === 'settings' && shell.view.can('users:write') ? shell.needsDecision : 0;
    return {
      label: info.label,
      href: info.root,
      icon: <Icon name={info.icon} />,
      open: key === shell.section,
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
        count: tabCount(tab.key, shell.counts) || undefined,
        attention: shell.attention[tab.key],
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
 * The account block: who is signed in (name, role, email, version), the theme (a cookie; System
 * follows the OS), the configuration export for `config:export` holders (a CSRF POST, audited,
 * never a link), the docs of this section, and Sign out when the login has one. The menu never
 * opens a dialog.
 */
function AdminAccountMenu(props: { shell: ShellProps }) {
  const { shell } = props;
  // A page of no section links the docs index; a page with its own docs links those.
  const section = shell.section ? SECTIONS[shell.section] : null;
  const tab = section?.tabs.find((item) => item.key === shell.subsection);
  const docs = section
    ? { href: docsUrl(tab?.help ?? section.help), name: tab?.help ? tab.label : section.label }
    : { href: docsUrl('index.md'), name: 'index' };
  return (
    <AccountMenu
      id="acct"
      name={shell.user.name ?? shell.user.email}
      role={roleLabel(shell.view.role)}
    >
      <MenuHeader end={`tokengate ${version}`}>{shell.user.email}</MenuHeader>
      <MenuChoice
        label="Theme"
        action={paths.theme()}
        name="theme"
        hidden={shell.view.hidden({ return: shell.returnTo })}
        options={THEMES.map((theme) => ({
          value: theme,
          label: THEME_LABELS[theme],
          current: theme === shell.theme,
        }))}
      />
      <MenuSeparator />
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
