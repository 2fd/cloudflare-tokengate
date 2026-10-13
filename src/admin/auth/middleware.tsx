// Gate for every /admin route, in order: live session (I-SESS-1) → Access JWT re-check for Access
// sessions → route listed in the RBAC table (I-RBAC-1) → body cap and CSRF for unsafe methods or
// mutating routes (I-CSRF-1) → role permission. Only then is `viewer` set and the handler run. The
// actor carries the session and permission so audited writes re-check both at commit (I-SESS-1).
import type { MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import type { App, AppContext } from '../../app';
import { type Config, canonicalOrigin, parseConfig } from '../../config';
import type { Session, User } from '../../db/types';
import { ADMIN_FORM_MAX_BYTES, type AdminContext, parsedForm } from '../render';
import { Layout } from '../views/layout';
import { ACCESS_JWT_HEADER, verifyAccessAssertion } from './access';
import { CSRF_FIELD, csrfCheck, isUnsafeMethod } from './csrf';
import { can, routePermission } from './rbac';
import {
  clearSessionCookie,
  loadSession,
  readSessionCookie,
  requestMeta,
  revokeSession,
  touchSession,
} from './session';

export function registerAdminMiddleware(app: App): void {
  // `/admin/*` also matches `/admin` itself.
  app.use('/admin/*', adminMiddleware);
}

export const adminMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const deps = c.get('deps');
  const config = parseConfig(deps.env);

  const cookie = readSessionCookie(c);
  const loaded = cookie === null ? null : await loadSession(deps, cookie);
  if (!loaded) {
    if (cookie !== null) clearSessionCookie(c);
    return unauthenticated(c);
  }
  const { session, user } = loaded;

  if (session.login_provider === 'access' && !(await accessStillValid(c, config, session))) {
    await revokeSession(deps, session.id_hash);
    clearSessionCookie(c);
    return unauthenticated(c);
  }

  const route = endpointRoute(c);
  const rule = route ? routePermission(route.method, route.path) : null;
  if (!rule) return forbidden(c, loaded, 'This page does not exist or is not available.');

  if (isUnsafeMethod(c.req.method) || rule.mutates) {
    // Bounded read: any role's oversized body is refused before it is buffered in full.
    const form = await parsedForm(c);
    if (!form.ok) {
      return c.text(`Request body too large (limit ${ADMIN_FORM_MAX_BYTES} bytes).`, 413);
    }
    const passed = await csrfCheck({
      headers: c.req.raw.headers,
      canonicalOrigin: canonicalOrigin(config, new URL(c.req.url)),
      submittedToken: form.fields[CSRF_FIELD],
      sessionToken: session.csrf_token,
    });
    if (!passed) {
      return forbidden(
        c,
        loaded,
        'The form was not accepted (it expired or came from another site). Reload the page and try again.',
      );
    }
  }

  if (!can(user.role, rule.permission)) {
    return forbidden(c, loaded, 'Your role does not allow this action.');
  }

  await touchSession(deps, session);
  const meta = requestMeta(c.req.raw.headers);
  c.set('viewer', {
    user,
    sessionIdHash: session.id_hash,
    csrfToken: session.csrf_token,
    loginProvider: session.login_provider,
    actor: {
      type: 'user',
      id: user.id,
      email: user.email,
      ...meta,
      authority: { sessionIdHash: session.id_hash, permission: rule.permission },
    },
  });
  await next();
};

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

/** Access sessions stay valid only while the edge keeps presenting a JWT for the same subject. */
async function accessStillValid(
  c: AdminContext,
  config: Config,
  session: Session,
): Promise<boolean> {
  const access = config.login.access;
  if (!access) return false;
  const result = await verifyAccessAssertion(
    c.req.header(ACCESS_JWT_HEADER),
    access,
    c.get('deps'),
  );
  return result.ok && result.identity.subject === session.identity_subject;
}

function unauthenticated(c: AdminContext): Response {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    const url = new URL(c.req.url);
    const target = new URLSearchParams({ return_to: url.pathname + url.search });
    return c.redirect(`/auth/login?${target}`, 302);
  }
  return c.text('Sign-in required.', 401);
}

function forbidden(
  c: AdminContext,
  { session, user }: { session: Session; user: User },
  message: string,
) {
  return c.html(
    <Layout
      title="Forbidden"
      viewer={{ email: user.email, role: user.role, csrfToken: session.csrf_token }}
    >
      <p class="banner error" role="alert">
        {message}
      </p>
      <p>
        <a href="/admin">Back to the dashboard</a>
      </p>
    </Layout>,
    403,
  );
}
