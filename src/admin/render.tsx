// Helpers shared by admin pages: render inside the shell (one load of the shell data per page),
// parse the form body once with a size cap applied before buffering (I-CSRF-1), audit actor,
// repeating form rows and POST-redirect-GET with a notice key (notice.ts).
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { parseBody } from 'hono/utils/body';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppContext } from '../app';
import { parseConfig } from '../config';
import { loadKeyring } from '../crypto/keyring';
import { schemaStatusByDatabase } from '../db/migrations';
import type { Role } from '../db/types';
import { activeUsersByRole, countNeedsDecision } from '../db/users';
import type { Deps } from '../deps';
import { signOutUrl } from './auth/identity';
import { can, type Permission, rolesWith } from './auth/rbac';
import type { AdminActor, AdminViewer } from './auth/types';
import type { Notice, PendingNotice } from './notice';
import type { FieldError } from './ops/shared';
import { paths } from './paths';
import { docsUrl } from './views/docs';
import { type HealthProblem, Layout, type SectionKey } from './views/layout';
import type { Banner } from './views/legacy';

export { redirectWithNotice } from './notice';
export { RETURN_PATHS, type ReturnRoute, returnPath } from './paths';

export type AdminContext = Context<AppContext>;

export interface PageProps {
  title: string;
  section: SectionKey;
  /** The subnav tab this page belongs to (a Tabs item key of the section). */
  subsection: string;
  breadcrumbs?: Array<{ href: string; label: string }>;
  /** Error re-render: the title gets "Error: " and an ErrorSummary heads the page. */
  errors?: FieldError[];
  /** Shown after the h1. A function is called with the view context (resolveNotice). */
  notice?: Notice | PendingNotice | null;
  /** Rendered after the subnav, for example a section-wide search form. */
  subnavExtra?: Child;
  /** Defaults to 200. */
  status?: ContentfulStatusCode;
  /** Transition only: notices and warnings of the legacy page bodies. */
  legacyBanners?: Banner[];
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
  const shell = await loadShell(deps, viewer, url.hostname);
  const notice = typeof props.notice === 'function' ? props.notice(shell.view) : props.notice;
  return c.html(
    <Layout
      title={props.title}
      shell={{
        section: props.section,
        subsection: props.subsection,
        path: url.pathname,
        view: shell.view,
        email: viewer.user.email,
        signOutUrl: signOutUrl(viewer.loginProvider),
        needsDecision: shell.needsDecision,
        problems: props.section === 'monitoring' && url.pathname === '/admin' ? [] : shell.problems,
      }}
      breadcrumbs={props.breadcrumbs}
      errors={props.errors}
      notice={notice ?? null}
      subnavExtra={props.subnavExtra}
      legacyBanners={props.legacyBanners}
    >
      {body(shell.view)}
    </Layout>,
    props.status ?? 200,
  );
}

/** Names per role AskSomeone may need; the first ones by email. */
const ASKERS_SHOWN = 3;
/** Roles that hold more than `read`, so someone may ask them for a change. */
const ASKABLE_ROLES: readonly Role[] = ['token_manager', 'access_manager', 'admin', 'owner'];

async function loadShell(
  deps: Deps,
  viewer: ShellViewer,
  host: string,
): Promise<{ view: ViewContext; needsDecision: number; problems: HealthProblem[] }> {
  const now = deps.now();
  const role = viewer.user.role;
  const [people, needsDecision, problems] = await Promise.all([
    activeUsersByRole(deps.env.DB, ASKABLE_ROLES, ASKERS_SHOWN),
    can(role, 'users:write') ? countNeedsDecision(deps.env.DB, now) : Promise.resolve(0),
    healthProblems(deps),
  ]);
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
  };
  return { view, needsDecision, problems };
}

/**
 * Error-level problems cheap enough to check on every page: the keyring (cached per isolate), a
 * database missing migrations (cached) and configuration errors (pure). Values are never shown,
 * only variable names and states. The Overview health panel lists every check.
 */
async function healthProblems(deps: Deps): Promise<HealthProblem[]> {
  const [keyring, schema] = await Promise.all([
    loadKeyring(deps.env),
    schemaStatusByDatabase(deps),
  ]);
  const problems: HealthProblem[] = [];
  if (!keyring.ok) {
    problems.push({
      title: `Encryption keys are not loaded (${keyring.error}): token requests fail and secrets cannot change.`,
      fix: { href: paths.tokenKeys(), label: 'Open encryption keys' },
    });
  }
  for (const database of ['DB', 'TELEMETRY_DB'] as const) {
    if (schema[database] === 'behind') {
      problems.push({
        title: `Database ${database} is missing migrations.`,
        fix: { href: docsUrl('operations/upgrades.md'), label: 'How to apply migrations' },
      });
    }
  }
  for (const error of parseConfig(deps.env).errors) {
    problems.push({
      title: `${error.variable}: ${error.message}`,
      fix: { href: docsUrl('configuration.md'), label: 'Configuration reference' },
    });
  }
  return problems;
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

export type ParsedForm = { ok: true; fields: FormFields } | { ok: false; error: 'too_large' };

const parsedForms = new WeakMap<Request, Promise<ParsedForm>>();

/**
 * The request body as form fields, read and parsed once per request (the admin middleware reads
 * `_csrf` from the same result). Repeated fields become arrays; file uploads are ignored. A body
 * that is not a form yields no fields; one over ADMIN_FORM_MAX_BYTES yields `too_large`.
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

async function parseForm(c: AdminContext): Promise<ParsedForm> {
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
  if (!(declared <= ADMIN_FORM_MAX_BYTES)) return { ok: false, error: 'too_large' };
  const bytes = await readAtMost(c.req.raw.body, ADMIN_FORM_MAX_BYTES);
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
  for (const [name, value] of Object.entries(body)) {
    if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value)) {
      const strings = value.filter((item): item is string => typeof item === 'string');
      if (strings.length > 0) out[name] = strings;
    }
  }
  return { ok: true, fields: out };
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
