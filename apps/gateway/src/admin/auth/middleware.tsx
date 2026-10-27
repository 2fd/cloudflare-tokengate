// Gate for every /admin route, in order: verified identity from the Cloudflare Access JWT, on every
// request (I-SESS-1) → linked, active user (or invite link / first-owner bootstrap, I-LINK-1,
// I-BOOT-1) → route listed in the RBAC table (I-RBAC-1) → body cap and CSRF for unsafe methods or
// mutating routes (I-CSRF-1) → role permission, plus the field permissions of submitted fields
// (I-RBAC-1). Only then is `viewer` set and the handler run. The actor carries the identity and
// permissions so audited writes re-check both at commit (I-SESS-1).
// There are no gateway sessions: Access owns sign-in, sign-out and session lifetime.
import {
  Button,
  ButtonRow,
  Callout,
  Cell,
  PageHeader,
  Panel,
  Row,
  RowHeader,
  Stack,
  Table,
  Tray,
} from '@tokengate/ui';
import type { MiddlewareHandler } from 'hono';
import type { Child } from 'hono/jsx';
import { matchedRoutes } from 'hono/route';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { App, AppContext } from '../../app';
import { parseConfig } from '../../config';
import type { User } from '../../db/types';
import { recordRefusedStatements, recordSeenStatements } from '../../db/users';
import type { Deps } from '../../deps';
import { adminBrand } from '../branding';
import { paths } from '../paths';
import {
  adminFormLimit,
  type AdminContext,
  type FormFields,
  parsedForm,
  renderPageFor,
  type ShellViewer,
} from '../render';
import { readTheme } from '../theme';
import { AskSomeone, NotFound, type NotFoundLinks, notFoundText } from '../views/components';
import {
  BareLayout,
  documentTitle,
  SECTION_ORDER,
  SECTIONS,
  type SectionKey,
} from '../views/layout';
import { permissionSentence } from '../views/roles';
import { CSRF_FIELD, csrfCheck, ensureCsrfCookie, isUnsafeMethod, readCsrfCookie } from './csrf';
import { type IdentityError, requestIdentity, requestMeta, signOutUrl } from './identity';
import { can, type Permission, requestPermissions, routePermission } from './rbac';
import { type LoginIdentity, type LoginProviderId, resolveLogin } from './resolve-login';
import { SetupInstructions } from './setup';

/** users.last_login_at / user_identities.last_used_at are written at most this often per user. */
export const SEEN_INTERVAL_MS = 5 * 60 * 1000;

/** User-facing messages. Keys only ever come from this module. */
const MESSAGES = {
  access_invalid:
    'Cloudflare Access did not present a valid user identity for this request. Check that the Access application covers /admin on this hostname, then reload.',
  certs_unavailable: 'Cloudflare Access could not be reached to check your identity. Try again.',
  email_taken:
    'Another user already has this email address with a different sign-in account. Owners can see that you tried. Ask one to reset your sign-in, then reload.',
  email_taken_expired:
    'Your invitation expired. Owners can see that you tried. Ask one to renew it, then reload.',
  pending:
    'Your account is waiting for an owner to approve it. Owners see your request on their Overview. Reload this page after they do.',
  suspended: 'This account is suspended. Owners can see that you tried. Ask one to reactivate it.',
} as const;
type MessageKey = keyof typeof MESSAGES;

const IDENTITY_FAILURE: Record<
  Exclude<IdentityError, 'not_configured'>,
  { key: MessageKey; status: ContentfulStatusCode }
> = {
  missing: { key: 'access_invalid', status: 401 },
  invalid: { key: 'access_invalid', status: 401 },
  no_email: { key: 'access_invalid', status: 401 },
  certs_unavailable: { key: 'certs_unavailable', status: 503 },
};

export function registerAdminMiddleware(app: App): void {
  // `/admin/*` also matches `/admin` itself.
  app.use('/admin/*', adminMiddleware);
}

export const adminMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const deps = c.get('deps');
  const config = parseConfig(deps.env);

  const verified = await requestIdentity(c.req.raw, config, deps);
  if (!verified.ok) {
    if (verified.error === 'not_configured') return setupPage(c);
    console.warn(JSON.stringify({ type: 'auth.login_failed', error: verified.error }));
    const failure = IDENTITY_FAILURE[verified.error];
    return errorPage(c, failure.key, failure.status, null);
  }
  const identity = verified.identity;
  const meta = requestMeta(c.req.raw.headers);
  const requestUrl = new URL(c.req.url);
  const resolution = await resolveLogin(deps, { ...identity, meta });
  if (!resolution.ok) {
    console.warn(
      JSON.stringify({
        type: 'auth.login_denied',
        provider: identity.loginProvider,
        reason: resolution.reason,
      }),
    );
    // Only a verified Access identity gets here. The refusal is recorded on the user it names, so
    // owners see that they tried (not audited, links nothing: I-LINK-1).
    if (resolution.userId !== undefined) {
      await recordRefused(deps, resolution.userId, resolution.lastRefusedAt ?? null, identity);
    }
    return errorPage(c, resolution.reason, 403, identity.loginProvider);
  }
  const { user } = resolution;
  const cookieToken = readCsrfCookie(c);
  const csrfToken = ensureCsrfCookie(c, deps);
  const shellViewer: ShellViewer = { user, csrfToken, loginProvider: identity.loginProvider };

  const route = endpointRoute(c);
  const rule = route ? routePermission(route.method, route.path) : null;
  if (!rule) {
    // No handler runs either way (fail closed). A page that does not exist is a 404 with a static
    // hint for old URLs; any other unlisted request stays 403.
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      return notFound(c, shellViewer, requestUrl.pathname);
    }
    return forbidden(c, shellViewer, 'This page does not exist or is not available.');
  }

  let fields: FormFields = Object.create(null);
  if (isUnsafeMethod(c.req.method) || rule.mutates) {
    // Bounded read: any role's oversized body is refused before it is buffered in full.
    const form = await parsedForm(c);
    if (!form.ok) {
      return c.text(`Request body too large (limit ${adminFormLimit(c)} bytes).`, 413);
    }
    fields = form.fields;
    const passed = await csrfCheck({
      headers: c.req.raw.headers,
      expectedOrigin: requestUrl.origin,
      submittedToken: form.fields[CSRF_FIELD],
      cookieToken,
    });
    if (!passed) {
      return forbidden(
        c,
        shellViewer,
        'The form was not accepted (it expired or came from another site). Reload the page and try again.',
      );
    }
  }

  // The route's permission, then the field permissions of the fields the form submits (only
  // mutating routes declare them, and their form was read above).
  const permissions = requestPermissions(rule, fields);
  const missing = permissions.find((permission) => !can(user.role, permission));
  if (missing) {
    return forbidden(c, shellViewer, 'Your role does not allow this action.', missing);
  }

  await recordSeen(deps, user, identity);
  c.set('viewer', {
    user,
    csrfToken,
    loginProvider: identity.loginProvider,
    actor: {
      type: 'user',
      id: user.id,
      email: user.email,
      ...meta,
      authority: {
        userId: user.id,
        loginProvider: identity.loginProvider,
        subject: identity.subject,
        permissions,
      },
    },
  });
  await next();
};

/** Updates last-seen times at most once per SEEN_INTERVAL_MS, so reads rarely write. */
async function recordSeen(deps: Deps, user: User, identity: LoginIdentity): Promise<void> {
  const now = deps.now();
  if (user.last_login_at !== null && now - user.last_login_at < SEEN_INTERVAL_MS) return;
  await deps.env.DB.batch(
    recordSeenStatements(deps.env.DB, {
      userId: user.id,
      loginProvider: identity.loginProvider,
      subject: identity.subject,
      now,
    }),
  );
}

/**
 * Records a refused sign-in on the user it names, at most once per SEEN_INTERVAL_MS (the same
 * throttle as recordSeen; the UPDATE repeats it in SQL). Never touches `updated_at`.
 */
async function recordRefused(
  deps: Deps,
  userId: string,
  lastRefusedAt: number | null,
  identity: LoginIdentity,
): Promise<void> {
  const now = deps.now();
  if (lastRefusedAt !== null && now - lastRefusedAt < SEEN_INTERVAL_MS) return;
  await deps.env.DB.batch(
    recordRefusedStatements(deps.env.DB, {
      userId,
      subject: identity.subject,
      now,
      minIntervalMs: SEEN_INTERVAL_MS,
    }),
  );
}

/**
 * The page handler Hono will run: the first matched route registered with a concrete method.
 * Middleware (`app.use`, `app.all`) is registered as method `ALL` and skipped, so an `app.all`
 * page can never satisfy the RBAC lookup (fail closed). HEAD resolves to the GET route.
 */
function endpointRoute(c: AdminContext): { method: string; path: string } | null {
  const route = matchedRoutes(c)
    .slice(c.req.routeIndex + 1)
    .find((candidate) => candidate.method !== 'ALL');
  return route ? { method: route.method, path: route.path } : null;
}

/** "Sign-in problem": no user yet, so the bare shell (brand only). One primary: Reload. */
async function errorPage(
  c: AdminContext,
  key: MessageKey,
  status: ContentfulStatusCode,
  loginProvider: LoginProviderId | null,
) {
  // The sign-out link lets a pending, suspended or mismatched user switch accounts.
  const signOut = loginProvider ? signOutUrl(loginProvider) : null;
  const host = new URL(c.req.url).hostname;
  const brand = await adminBrand(c.get('deps').env.DB, host);
  return c.html(
    <BareLayout
      title={documentTitle('Sign-in problem', null, false, brand.name)}
      brand={brand}
      host={host}
      theme={readTheme(c)}
    >
      <PageHeader
        title="Sign-in problem"
        actions={
          <>
            {signOut ? <Button href={signOut}>Sign out</Button> : null}
            <Button variant="primary" href={paths.overview()}>
              Reload
            </Button>
          </>
        }
      />
      <Callout tone="bad" title={MESSAGES[key]} />
    </BareLayout>,
    status,
  );
}

/** The login variables the setup page reports on, in the order an operator sets them. */
const LOGIN_VARIABLES = ['AUTH_ACCESS_TEAM_DOMAIN', 'AUTH_ACCESS_AUD'] as const;

/** Shown when no login is configured. Lists the variables to set, never their values (I-CFG-1). */
async function setupPage(c: AdminContext) {
  const env = c.get('deps').env;
  const config = parseConfig(env);
  const host = new URL(c.req.url).hostname;
  const problems = config.errors.filter((error) => error.feature.startsWith('login.'));
  const statusOf = (variable: string, value: string | undefined) => {
    const problem = problems.find((error) => error.variable === variable);
    if (problem) return `invalid: ${problem.message}`;
    return (value ?? '').trim() === '' ? 'missing' : 'set';
  };
  const rows: Array<{ variable: string; status: string }> = LOGIN_VARIABLES.map((variable) => ({
    variable,
    status: statusOf(variable, env[variable]),
  }));
  const development = (env.AUTH_ACCESS_DEVELOPMENT ?? '').trim() !== '';
  if (development || problems.some((error) => error.variable === 'AUTH_ACCESS_DEVELOPMENT')) {
    const problem = problems.find((error) => error.variable === 'AUTH_ACCESS_DEVELOPMENT');
    rows.push({
      variable: 'AUTH_ACCESS_DEVELOPMENT',
      status: problem
        ? `invalid: ${problem.message}`
        : `set, but it signs in only requests to localhost, 127.0.0.1 or [::1], not ${host}. In production, remove it and set the Access variables.`,
    });
  }
  const brand = await adminBrand(env.DB, host);
  return c.html(
    <BareLayout
      title={documentTitle('Set up sign-in', null, false, brand.name)}
      host={host}
      brand={brand}
      theme={readTheme(c)}
    >
      <PageHeader
        title="Set up sign-in"
        description="Sign-in to the admin console goes through Cloudflare Access, and no Access login is configured."
        actions={
          <Button variant="primary" href={paths.overview()}>
            Reload
          </Button>
        }
      />
      <Tray id="setup-vars" title="Sign-in variables">
        <Panel variant="flush">
          <Table
            labelledBy="setup-vars-h"
            columns={[{ label: 'Variable' }, { label: 'Status' }]}
            caption="Sign-in variables"
          >
            {rows.map((row) => (
              <Row>
                <RowHeader>
                  <code>{row.variable}</code>
                </RowHeader>
                <Cell>{row.status}</Cell>
              </Row>
            ))}
          </Table>
        </Panel>
      </Tray>
      <SetupInstructions host={host} />
    </BareLayout>,
    503,
  );
}

/**
 * The section a request path belongs to, for the shell of the middleware's own pages: the section
 * of a sidebar page or of a page under it. Null for any other path (an unknown or moved URL, the
 * export), so the sidebar opens no section.
 */
function sectionOf(pathname: string): SectionKey | null {
  for (const key of SECTION_ORDER) {
    for (const tab of SECTIONS[key].tabs) {
      for (const root of [tab.href, ...(tab.under ?? [])]) {
        // The Overview is /admin itself: every admin path starts with it.
        const under = root !== paths.overview() && pathname.startsWith(`${root}/`);
        if (pathname === root || under) return key;
      }
    }
  }
  return null;
}

/**
 * 403 inside the shell. When a permission is missing, the page names the roles that hold it and
 * who to ask; the button goes back to the section root. Nothing to do here, so no primary.
 */
function forbidden(c: AdminContext, viewer: ShellViewer, message: string, permission?: Permission) {
  const section = sectionOf(new URL(c.req.url).pathname);
  return renderPageFor(
    c,
    viewer,
    {
      title: 'Forbidden',
      section,
      subsection: '',
      status: 403,
      header: <PageHeader title="Forbidden" description={message} />,
    },
    (view) => (
      <>
        {permission ? (
          <Stack gap="sm">
            <Callout tone="warn" title={permissionSentence(permission)} />
            {/* The callout names the roles, so the ask sentence leaves out its own lead. */}
            <AskSomeone permission={permission} ctx={view} lead={false} />
          </Stack>
        ) : null}
        <ButtonRow>
          {section ? (
            <Button href={SECTIONS[section].root}>Back to {SECTIONS[section].label}</Button>
          ) : (
            <Button href={paths.overview()}>Go to the Overview</Button>
          )}
        </ButtonRow>
      </>
    ),
  );
}

/**
 * Where the pages of old URL prefixes went (ADR 0019). There are no redirects; the 404 page of the
 * first matching prefix says where the page went, in its header. Static text only: the requested
 * path is never echoed.
 */
const MOVED_PAGES: ReadonlyArray<{
  prefix: string;
  title: string;
  description: () => Child;
  links?: () => NotFoundLinks;
}> = [
  {
    prefix: '/admin/tokens',
    title: 'This page moved',
    description: () => (
      <>
        Services are now <a href={paths.tokens()}>Credentials</a>.
      </>
    ),
  },
  {
    prefix: '/admin/consumers',
    title: 'This page moved',
    description: () => (
      <>
        Service consumers are now <a href={paths.accessRules()}>Credential access rules</a>.
      </>
    ),
  },
  {
    prefix: '/admin/access',
    title: 'This page moved',
    description: () => (
      <>
        Consumer access is now part of <a href={paths.accessRules()}>Credential access rules</a>.{' '}
        <a href={paths.globalRules()}>Global access rules</a> are the ceilings on every credential
        access rule of an issuer.
      </>
    ),
  },
  {
    prefix: '/admin/issuer-access-rules',
    title: 'This page moved',
    description: () => (
      <>
        Issuer access rules are now part of{' '}
        <a href={paths.accessRules()}>Credential access rules</a>. Each credential access rule now
        holds its issuer, its identity conditions and its operations.
      </>
    ),
  },
  {
    prefix: '/admin/settings',
    title: 'The Settings page was split up',
    description: () =>
      'Each setting is on the page of its section. Admins and owners download the configuration export from the account menu.',
    links: () => ({
      title: 'Where each setting is now',
      items: [
        {
          href: paths.retention(),
          title: 'Data retention',
          description: 'Retention, sampling and the row cap',
        },
        {
          href: paths.tokenHosts(),
          title: 'Allowed hosts',
          description: 'The upstream host allowlist',
        },
        {
          href: paths.tokenKeys(),
          title: 'Rotate encryption',
          description: 'Encryption keys and re-encryption',
        },
        {
          href: paths.users({ hash: 'login' }),
          title: 'Members',
          description: 'New people and the login provider',
        },
        {
          href: paths.overview({ hash: 'health' }),
          title: 'Overview',
          description: 'System status',
        },
      ],
    }),
  },
];

/**
 * The 404 page for an unlisted GET or HEAD, built from the resolved user (no handler ran). An old
 * URL says where its page went; any other path says there is no page. Neither opens a section.
 */
function notFound(c: AdminContext, viewer: ShellViewer, pathname: string) {
  const moved = MOVED_PAGES.find((entry) => pathname.startsWith(entry.prefix));
  const title = moved?.title ?? 'Page not found';
  return renderPageFor(
    c,
    viewer,
    {
      title,
      section: sectionOf(pathname),
      subsection: '',
      status: 404,
      header: (
        <PageHeader
          title={title}
          description={moved ? moved.description() : notFoundText('page')}
        />
      ),
    },
    () => <NotFound links={moved?.links?.()} />,
  );
}
