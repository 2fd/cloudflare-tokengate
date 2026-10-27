// Helpers shared by admin pages: render inside the shell (one load of the shell data per page),
// parse the form body once with a size cap applied before buffering (I-CSRF-1), audit actor,
// repeating form rows and POST-redirect-GET with a notice key (notice.ts).
import { PageHeader } from '@tokengate/ui';
import type { Context } from 'hono';
import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import { parseBody } from 'hono/utils/body';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppContext } from '../app';
import { parseConfig } from '../config';
import { loadKeyring } from '../crypto/keyring';
import { schemaStatusByDatabase } from '../db/migrations';
import type { Role } from '../db/types';
import { activeUsersByRole } from '../db/users';
import type { Deps } from '../deps';
import { configErrorsForStatus } from '../health';
import { type AlertData, loadAlertData, overviewAlerts } from '../telemetry/dashboard';
import { CSRF_FIELD } from './auth/csrf';
import { signOutUrl } from './auth/identity';
import { can, type Permission, rolesWith } from './auth/rbac';
import type { AdminActor, AdminViewer } from './auth/types';
import { adminBrand } from './branding';
import type { Notice, PendingNotice } from './notice';
import type { FieldError } from './ops/shared';
import { paths } from './paths';
import {
  type HealthProblem,
  type HealthSummary,
  healthSummary,
  type NavAttention,
  navAttention,
  stripProblems,
  uncheckedHealth,
} from './shell-health';
import { readTheme } from './theme';
import { ErrorSummary, FocusTargets, focusTarget, NoticeView } from './views/components';
import { documentTitle, Layout, type SectionKey } from './views/layout';

export { redirectWithNotice } from './notice';
export { RETURN_PATHS, type ReturnRoute, returnPath } from './paths';

export type AdminContext = Context<AppContext>;

export interface PageProps {
  /** The <title> part, and the H1 of the default header. */
  title: string;
  /** The open sidebar section; null for a page of no section (an unknown or moved URL). */
  section: SectionKey | null;
  /** The sidebar item of the section this page belongs to (a SECTIONS tabs key); '' for none. */
  subsection: string;
  /** Defaults to 200. */
  status?: ContentfulStatusCode;
  /** Error re-render: the title gets "Error: " and an ErrorSummary follows the header. */
  errors?: FieldError[];
  /**
   * The ErrorSummary link target of a field error. Default: the field's control, and for a group
   * of choices rendered by the RadioCards or CheckboxGroup adapter its first enabled input
   * (focusTarget). Pass it only for a control those adapters do not render.
   */
  errorTarget?: (field: string) => string;
  /** ErrorSummary heading and sentence ("The token was not saved"); default "There is a problem". */
  errorSummary?: { title?: Child; description?: Child };
  /** Shown after the header and the ErrorSummary. A function is called with the view context. */
  notice?: Notice | PendingNotice | null;
  /**
   * The page's own header: a ui PageHeader (title, count, description, actions; or crumbs, an
   * Identity, a RelationLine and Tabs on a detail page). A function gets the view context. It
   * holds the only H1 of the page. Default: a PageHeader with `title` only.
   */
  header?: Child | ((ctx: ViewContext) => Child);
  /** Seconds after which the browser reloads the page, for a page that shows progress. */
  refresh?: number;
  /** The Overview's alert data, so the shell does not load it a second time. */
  alertData?: AlertData;
}

/** What every page body can know about the viewer, from the shell data loaded once per page. */
export interface ViewContext {
  csrf: string;
  userId: string;
  role: Role;
  /** Hostname of the request. */
  host: string;
  now: number;
  can(permission: Permission): boolean;
  /** Active users whose role holds `permission`, owners last, at most 3 (for AskSomeone). */
  askers(permission: Permission): Array<{ email: string }>;
  /** How many more such users exist than `askers` lists. */
  askersMore(permission: Permission): number;
  /** The `hidden` fields of a ui form (ActionForm, MenuItem, Dialog): `_csrf`, then `extra`. */
  hidden(extra?: Record<string, string>): Record<string, string>;
}

/** The signed-in user a page is rendered for (the request's viewer, or the middleware's user). */
export type ShellViewer = Pick<AdminViewer, 'user' | 'csrfToken' | 'loginProvider'>;

export function renderPage(
  c: AdminContext,
  props: PageProps,
  body: (ctx: ViewContext) => Child,
): Promise<Response> {
  return renderPageFor(c, c.get('viewer'), props, body);
}

/** renderPage for an explicit user: the middleware's forbidden and not-found pages. */
export async function renderPageFor(
  c: AdminContext,
  viewer: ShellViewer,
  props: PageProps,
  body: (ctx: ViewContext) => Child,
): Promise<Response> {
  const deps = c.get('deps');
  const url = new URL(c.req.url);
  const shell = await loadShell(deps, viewer, url.hostname, props.alertData);
  const view = shell.view;
  const errors = props.errors ?? [];
  const notice = typeof props.notice === 'function' ? props.notice(view) : props.notice;
  // The body renders first: the group adapters record their link targets (FocusTargets) for the
  // ErrorSummary, which comes before the body on the page.
  const targets = new Map<string, string>();
  const content = await toHtml(
    <FocusTargets.Provider value={targets}>{body(view)}</FocusTargets.Provider>,
  );
  const header =
    typeof props.header === 'function'
      ? props.header(view)
      : (props.header ?? <PageHeader title={props.title} />);
  const brand = await adminBrand(deps.env.DB, url.hostname);
  return c.html(
    <Layout
      title={documentTitle(props.title, props.section, errors.length > 0, brand.name)}
      refresh={props.refresh}
      shell={{
        brand,
        section: props.section,
        subsection: props.subsection,
        path: url.pathname,
        view,
        user: { email: viewer.user.email, name: viewer.user.name },
        signOutUrl: signOutUrl(viewer.loginProvider),
        needsDecision: shell.needsDecision,
        counts: shell.counts,
        health: shell.health,
        attention: shell.attention,
        // The Overview lists every problem itself.
        problems: props.section === 'monitoring' && url.pathname === '/admin' ? [] : shell.problems,
        theme: readTheme(c),
        // The path of a page that rendered, never its query (notices, searches) or an unknown path:
        // the page echoes no request text. A POST re-render or an error page returns to the Overview.
        returnTo:
          c.req.method === 'GET' && (props.status ?? 200) === 200 ? url.pathname : paths.overview(),
      }}
    >
      {header}
      {errors.length > 0 ? (
        <ErrorSummary
          errors={errors}
          target={props.errorTarget ?? ((field) => focusTarget(targets, field))}
          title={props.errorSummary?.title}
          description={props.errorSummary?.description}
        />
      ) : null}
      {notice ? (
        <NoticeView notice={notice} csrf={view.csrf} autofocus={errors.length === 0} />
      ) : null}
      {raw(content)}
    </Layout>,
    props.status ?? 200,
  );
}

/** A JSX tree as HTML (Hono's own escaping applied; async components resolved). */
async function toHtml(node: Child): Promise<string> {
  return String(await (node as { toString(): string | Promise<string> }).toString());
}

/** Names per role AskSomeone may need; the first ones by email. */
const ASKERS_SHOWN = 3;
/** Roles that hold more than `read`, so someone may ask them for a change. */
const ASKABLE_ROLES: readonly Role[] = ['token_manager', 'access_manager', 'admin', 'owner'];

interface Shell {
  view: ViewContext;
  needsDecision: number;
  counts: { tokens: number; rules: number; globals: number };
  health: HealthSummary;
  attention: Record<string, NavAttention>;
  problems: HealthProblem[];
}

/**
 * The data of the shell, in one round of parallel reads: the people AskSomeone names, the
 * sidebar counts, and the alert catalogue behind the health line and strip (cheap: no traffic
 * series; the keyring and schema status are cached per isolate). Values are never shown, only
 * variable names and states. When the alert data does not load (a database behind on a migration
 * that one of its queries needs), the page still renders: the strip falls back to the checks that
 * read no table, and the health line says the checks did not run.
 */
async function loadShell(
  deps: Deps,
  viewer: ShellViewer,
  host: string,
  loaded?: AlertData,
): Promise<Shell> {
  const now = deps.now();
  const role = viewer.user.role;
  const [people, counts, alertData] = await Promise.all([
    activeUsersByRole(deps.env.DB, ASKABLE_ROLES, ASKERS_SHOWN),
    deps.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM credentials) AS tokens,
         (SELECT COUNT(*) FROM access_rules WHERE credential_id IS NOT NULL) AS rules,
         (SELECT COUNT(*) FROM access_rules WHERE credential_id IS NULL) AS globals`,
    ).first<{ tokens: number; rules: number; globals: number }>(),
    loaded ??
      loadAlertData(deps).catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            type: 'admin.shell_health_failed',
            error: error instanceof Error ? error.message : 'unknown',
          }),
        );
        return null;
      }),
  ]);
  const health = alertData
    ? shellHealth(alertData, (permission) => can(role, permission))
    : await fallbackHealth(deps);
  const holders = (permission: Permission) => {
    const roles = new Set(rolesWith(permission));
    const rows = people.filter((person) => roles.has(person.role));
    // Owners last: they can do everything, so they are the fallback, not the first name.
    const ordered = [
      ...rows.filter((person) => person.role !== 'owner'),
      ...rows.filter((person) => person.role === 'owner'),
    ];
    const totals = new Map(rows.map((person) => [person.role, person.roleTotal]));
    const total = [...totals.values()].reduce((sum, n) => sum + n, 0);
    return { shown: ordered.slice(0, ASKERS_SHOWN), total };
  };
  const view: ViewContext = {
    csrf: viewer.csrfToken,
    userId: viewer.user.id,
    role,
    host,
    now,
    can: (permission) => can(role, permission),
    askers: (permission) => holders(permission).shown.map((person) => ({ email: person.email })),
    askersMore: (permission) => {
      const { shown, total } = holders(permission);
      return Math.max(0, total - shown.length);
    },
    hidden: (extra) => ({ [CSRF_FIELD]: viewer.csrfToken, ...extra }),
  };
  return {
    view,
    needsDecision: alertData && can(role, 'users:write') ? alertData.needsDecision : 0,
    counts: {
      tokens: Number(counts?.tokens ?? 0),
      rules: Number(counts?.rules ?? 0),
      globals: Number(counts?.globals ?? 0),
    },
    ...health,
  };
}

/** The health line, the sidebar dots and the strip from the alert catalogue. */
function shellHealth(
  data: AlertData,
  allowed: (permission: Permission) => boolean,
): Pick<Shell, 'health' | 'attention' | 'problems'> {
  const alerts = overviewAlerts(data);
  return {
    health: healthSummary(alerts),
    attention: navAttention(alerts, allowed),
    problems: stripProblems(data),
  };
}

/**
 * The health line and strip without the alert data: the keyring (cached per isolate), the schema
 * status (cached; it reads only `d1_migrations`) and the configuration (pure).
 */
async function fallbackHealth(
  deps: Deps,
): Promise<Pick<Shell, 'health' | 'attention' | 'problems'>> {
  const [keyring, schema] = await Promise.all([
    loadKeyring(deps.env),
    schemaStatusByDatabase(deps),
  ]);
  const problems = stripProblems({
    keyring: { error: keyring.ok ? null : keyring.error },
    schema,
    config: configErrorsForStatus(parseConfig(deps.env)),
    cron: null,
  });
  return { health: uncheckedHealth(problems.length), attention: {}, problems };
}

/** Audit actor for audit rows written during this admin request. */
export function adminActor(c: AdminContext): AdminActor {
  return c.get('viewer').actor;
}

export type FormFields = Record<string, string | string[]>;

/**
 * Largest admin form body accepted. Admin forms are a few KB (the largest field is a pasted
 * credential); anything bigger is refused before it is buffered or parsed, whatever the role.
 */
export const ADMIN_FORM_MAX_BYTES = 64 * 1024;

export type ParsedForm =
  | { ok: true; fields: FormFields; files?: Record<string, File> }
  | { ok: false; error: 'too_large' };

const parsedForms = new WeakMap<Request, Promise<ParsedForm>>();

/**
 * The request body as form fields, read and parsed once per request (the admin middleware reads
 * `_csrf` from the same result). Repeated text fields become arrays; files are kept separately.
 * A non-form body yields no fields; a body over the route limit yields `too_large`.
 */
export function parsedForm(c: AdminContext): Promise<ParsedForm> {
  const raw = c.req.raw;
  let parsed = parsedForms.get(raw);
  if (!parsed) {
    parsed = parseForm(c);
    parsedForms.set(raw, parsed);
  }
  return parsed;
}

/** Form fields of the request body; empty when the body is not a form or is too large. */
export async function formData(c: AdminContext): Promise<FormFields> {
  const parsed = await parsedForm(c);
  return parsed.ok ? parsed.fields : Object.create(null);
}

/** A branding image has a separate bounded upload allowance. */
export function adminFormLimit(c: AdminContext): number {
  return c.req.path === '/admin/users/appearance' ? 384 * 1024 : ADMIN_FORM_MAX_BYTES;
}

async function parseForm(c: AdminContext): Promise<ParsedForm> {
  const maxBytes = adminFormLimit(c);
  const type = c.req.header('content-type') ?? '';
  if (
    !type.startsWith('application/x-www-form-urlencoded') &&
    !type.startsWith('multipart/form-data')
  ) {
    return { ok: true, fields: Object.create(null) };
  }
  // Content-Length is checked first so an honest oversized upload is refused unread (a malformed one
  // is NaN and fails too); the counting read also covers chunked bodies and understated lengths.
  const declared = Number(c.req.header('content-length') ?? '0');
  if (!(declared <= maxBytes)) return { ok: false, error: 'too_large' };
  const bytes = await readAtMost(c.req.raw.body, maxBytes);
  if (bytes === null) return { ok: false, error: 'too_large' };
  let body: Record<string, unknown>;
  try {
    body = await parseBody(
      new Request(c.req.url, { method: 'POST', headers: { 'content-type': type }, body: bytes }),
      { all: true },
    );
  } catch {
    return { ok: true, fields: Object.create(null) };
  }
  // Null prototype: a field named `__proto__` stays an ordinary key, and unsubmitted names such as
  // `constructor` read as undefined.
  const out: FormFields = Object.create(null);
  const files: Record<string, File> = Object.create(null);
  for (const [name, value] of Object.entries(body)) {
    if (value instanceof File) files[name] = value;
    else if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value)) {
      const strings = value.filter((item): item is string => typeof item === 'string');
      if (strings.length > 0) out[name] = strings;
    }
  }
  return { ok: true, fields: out, files };
}

/** The whole stream, or null (stream cancelled) as soon as it exceeds `max` bytes. */
async function readAtMost(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array | null> {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * The `expected_updated_at` an edit form was opened at (see VersionField), as ops take it:
 * undefined when absent; anything else is passed on as a number for the op to check.
 */
export function submittedVersion(raw: string | undefined): number | undefined {
  return raw === undefined || raw.trim() === '' ? undefined : Number(raw);
}

/** Highest row index parseRows reads, so a crafted form cannot make it allocate without bound. */
export const MAX_ROWS = 200;

/**
 * The rows of a RepeatingRows group (views/rows.tsx): fields named `${group}.${i}.${key}`, in index
 * order. Rows whose `remove` box is ticked and rows with every key blank are left out; repeated
 * values of one name keep the first.
 */
export function parseRows<K extends string>(
  fields: FormFields,
  group: string,
  keys: readonly K[],
): Array<Record<K, string>> {
  const prefix = `${group}.`;
  const byIndex = new Map<number, Record<string, string>>();
  for (const [name, raw] of Object.entries(fields)) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(0|[1-9][0-9]{0,2})\.([A-Za-z0-9_]+)$/.exec(name.slice(prefix.length));
    if (!match) continue;
    const index = Number(match[1]);
    const key = match[2] as string;
    if (index >= MAX_ROWS || (key !== 'remove' && !(keys as readonly string[]).includes(key))) {
      continue;
    }
    const row = byIndex.get(index) ?? Object.create(null);
    row[key] = (Array.isArray(raw) ? raw[0] : raw) ?? '';
    byIndex.set(index, row);
  }
  const out: Array<Record<K, string>> = [];
  for (const index of [...byIndex.keys()].sort((a, b) => a - b)) {
    const row = byIndex.get(index) as Record<string, string>;
    if (row.remove !== undefined && row.remove !== '') continue;
    const values = Object.fromEntries(keys.map((key) => [key, row[key] ?? ''])) as Record<
      K,
      string
    >;
    if (keys.every((key) => values[key].trim() === '')) continue;
    out.push(values);
  }
  return out;
}
