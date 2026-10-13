// Admin auth fixtures: user rows, logged-in sessions, cookie handling and an app with stub admin
// pages so the middleware (session, RBAC, CSRF) can be exercised without the real pages.
//
//   await resetControlPlane();
//   const owner = await createUser({ email: 'o@example.com', role: 'owner' });
//   const app = createAdminTestApp();
//   const session = await loginAs(app, owner);
//   const res = await adminPost(app, session, '/admin/settings', { retention: '30' });
import { env } from 'cloudflare:workers';
import { type Context, Hono } from 'hono';
import { registerAuthRoutes } from '../../src/admin/auth/routes';
import { issueSession, SESSION_COOKIE } from '../../src/admin/auth/session';
import type { App, AppContext } from '../../src/app';
import { userFromRow } from '../../src/db/rows';
import type { Role, User, UserStatus } from '../../src/db/types';
import type { Deps } from '../../src/deps';
import type { AppEnv } from '../../src/env';
import { applySecurityMiddleware } from '../../src/http/security';
import { newId } from '../../src/lib/ids';
import { TEST_ORIGIN } from './app';

export { TEST_ORIGIN };

/**
 * Empties the control-plane tables, grants before the services and caller providers they
 * reference. The last-owner delete trigger (I-OWNER-1) is dropped and re-created from its stored
 * SQL inside the same batch, since it forbids deleting the last owner.
 */
export async function resetControlPlane(): Promise<void> {
  const db = env.DB;
  const trigger = await db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'users_last_owner_delete'",
    )
    .first<{ sql: string }>();
  if (!trigger) throw new Error('users_last_owner_delete trigger missing');
  await db.batch([
    db.prepare('DROP TRIGGER users_last_owner_delete'),
    db.prepare('DELETE FROM sessions'),
    db.prepare('DELETE FROM user_identities'),
    db.prepare('DELETE FROM audit_log'),
    db.prepare('DELETE FROM settings'),
    db.prepare('DELETE FROM grants'),
    db.prepare('DELETE FROM services'),
    db.prepare('DELETE FROM caller_providers'),
    db.prepare('DELETE FROM users'),
    db.prepare(trigger.sql),
  ]);
}

export interface UserSeed {
  email: string;
  role?: Role;
  status?: UserStatus;
  inviteExpiresAt?: number | null;
  name?: string | null;
  /** Adds a (login_provider, subject) identity for the user. */
  identity?: { loginProvider: string; subject: string };
}

export async function createUser(seed: UserSeed, now: number = Date.now()): Promise<User> {
  const id = newId('usr', now, (n) => crypto.getRandomValues(new Uint8Array(n)));
  const status = seed.status ?? 'active';
  const statements = [
    env.DB.prepare(
      `INSERT INTO users (id, email, name, role, status, invite_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      seed.email,
      seed.name ?? null,
      seed.role ?? 'admin',
      status,
      status === 'invited' ? (seed.inviteExpiresAt ?? now + 86_400_000) : null,
      now,
      now,
    ),
  ];
  if (seed.identity) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO user_identities (login_provider, subject, user_id, email, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(seed.identity.loginProvider, seed.identity.subject, id, seed.email, now),
    );
  }
  await env.DB.batch(statements);
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!row) throw new Error('user insert failed');
  return userFromRow(row);
}

export interface AdminSession {
  sessionId: string;
  csrfToken: string;
  /** `Cookie` request header value. */
  cookie: string;
}

/**
 * Issues a real session (as a login would) for `user`. Sessions only live while their login
 * identity is linked to the user (I-SESS-1): the user's existing identity for the login provider
 * is reused, otherwise one is linked first. Throws when no session is issued.
 */
export async function loginAs(
  app: { deps: Deps },
  user: User,
  options: { loginProvider?: string; subject?: string } = {},
): Promise<AdminSession> {
  const loginProvider = options.loginProvider ?? 'github';
  const linked = await env.DB.prepare(
    'SELECT subject FROM user_identities WHERE user_id = ? AND login_provider = ? LIMIT 1',
  )
    .bind(user.id, loginProvider)
    .first<{ subject: string }>();
  const subject = options.subject ?? linked?.subject ?? `subject-${user.id}`;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO user_identities (login_provider, subject, user_id, email, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(loginProvider, subject, user.id, user.email, app.deps.now())
    .run();
  const issued = await issueSession(app.deps, {
    user,
    loginProvider,
    identitySubject: subject,
    previousSessionId: null,
    meta: { ip: null, userAgent: null },
  });
  if (!issued) throw new Error(`loginAs: no session for ${user.email} (user not active?)`);
  const { sessionId, session } = issued;
  return { sessionId, csrfToken: session.csrf_token, cookie: `${SESSION_COOKIE}=${sessionId}` };
}

export interface AdminTestApp {
  app: App;
  deps: Deps;
  request(path: string, init?: RequestInit & { origin?: string }): Promise<Response>;
}

export interface AdminTestAppOptions {
  fetch?: typeof fetch;
  now?: () => number;
  env?: Partial<AppEnv> & Record<string, unknown>;
  /** Extra routes registered after the auth routes (stub admin pages). */
  routes?: (app: App) => void;
}

/**
 * The auth-relevant slice of the real app (security middleware, auth routes, admin middleware)
 * plus a stub proxy route registered before the security middleware, as in src/app.ts.
 */
export function createAdminTestApp(options: AdminTestAppOptions = {}): AdminTestApp {
  const testEnv = { ...env, ...options.env } as unknown as Env;
  const deps: Deps = {
    env: testEnv as unknown as AppEnv,
    fetch:
      options.fetch ??
      (async (input) => {
        throw new Error(`unexpected outbound fetch in test: ${String(input)}`);
      }),
    now: options.now ?? (() => Date.now()),
    random: (length) => crypto.getRandomValues(new Uint8Array(length)),
    waitUntil: () => {},
  };
  const app: App = new Hono<AppContext>();
  app.use(async (c, next) => {
    c.set('deps', deps);
    await next();
  });
  app.all('/proxy/*', (c) => c.text('proxied'));
  applySecurityMiddleware(app);
  registerAuthRoutes(app);
  options.routes?.(app);
  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return {
    app,
    deps,
    request: (path, init = {}) => {
      const { origin = TEST_ORIGIN, ...rest } = init;
      return Promise.resolve(app.fetch(new Request(new URL(path, origin), rest), testEnv, ctx));
    },
  };
}

/**
 * Stub pages for a few RBAC-listed routes (each answers `ok <role>`), plus `/admin/unlisted`,
 * which is registered but deliberately missing from the RBAC table.
 */
export function stubAdminPages(app: App): void {
  const ok = (c: Context<AppContext>) => c.text(`ok ${c.get('viewer').user.role}`);
  app.get('/admin', ok);
  app.get('/admin/services', ok);
  app.get('/admin/services/new', ok);
  app.post('/admin/services', ok);
  app.get('/admin/services/:id', ok);
  app.post('/admin/services/:id', ok);
  app.post('/admin/users', ok);
  app.post('/admin/settings/rewrap', ok);
  app.get('/admin/unlisted', ok);
  app.all('/admin/any-method', ok);
}

/** GET with the session cookie. */
export function adminGet(
  app: Pick<AdminTestApp, 'request'>,
  session: AdminSession | null,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    headers: { ...(session ? { cookie: session.cookie } : {}), ...headers },
    redirect: 'manual',
  });
}

/**
 * Form POST as a same-origin browser would send it: session cookie, `Sec-Fetch-Site: same-origin`
 * and the `_csrf` field (override with `csrf: null` to omit, or `headers` to replace metadata).
 */
export function adminPost(
  app: Pick<AdminTestApp, 'request'>,
  session: AdminSession | null,
  path: string,
  fields: Record<string, string | string[]> = {},
  options: { csrf?: string | null; headers?: Record<string, string | null> } = {},
): Promise<Response> {
  const body = new URLSearchParams();
  const csrf = options.csrf === undefined ? session?.csrfToken : options.csrf;
  if (csrf != null) body.set('_csrf', csrf);
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(name, item);
  }
  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
    'sec-fetch-site': 'same-origin',
  });
  if (session) headers.set('cookie', session.cookie);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return app.request(path, { method: 'POST', headers, body, redirect: 'manual' });
}

export interface SetCookie {
  value: string;
  attributes: string[];
}

/** `Set-Cookie` headers of a response, by cookie name. */
export function setCookies(response: Response): Map<string, SetCookie> {
  const out = new Map<string, SetCookie>();
  for (const header of response.headers.getSetCookie()) {
    const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
    const eq = pair.indexOf('=');
    out.set(pair.slice(0, eq), { value: decodeURIComponent(pair.slice(eq + 1)), attributes });
  }
  return out;
}
