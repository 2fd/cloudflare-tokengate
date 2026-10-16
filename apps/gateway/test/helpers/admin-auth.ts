// Admin auth fixtures: user rows, signed-in browsers (an Access JWT plus a CSRF cookie), cookie
// handling and an app with stub admin pages so the middleware (identity, RBAC, CSRF) can be
// exercised without the real pages.
//
//   await resetControlPlane();
//   const owner = await createUser({ email: 'o@example.com', role: 'owner' });
//   const app = createAdminTestApp();
//   const session = await loginAs(app, owner);
//   const res = await adminPost(app, session, '/admin/retention', { request_log_retention_days: '30' });
import { env } from 'cloudflare:workers';
import { type Context, Hono } from 'hono';
import { ACCESS_JWT_HEADER, accessSubject } from '../../src/admin/auth/access';
import { CSRF_COOKIE } from '../../src/admin/auth/csrf';
import { registerAdminMiddleware } from '../../src/admin/auth/middleware';
import type { App, AppContext } from '../../src/app';
import { userFromRow } from '../../src/db/rows';
import type { Role, User, UserStatus } from '../../src/db/types';
import type { Deps } from '../../src/deps';
import type { AppEnv } from '../../src/env';
import { applySecurityMiddleware } from '../../src/http/security';
import { newId } from '../../src/lib/ids';
import { TEST_ACCESS_ENV, TEST_ORIGIN } from './app';
import { testAccess, withTestAccessCerts } from './login-providers';

export { TEST_ACCESS_ENV, TEST_ORIGIN };

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
    db.prepare('DELETE FROM user_identities'),
    db.prepare('DELETE FROM audit_log'),
    db.prepare('DELETE FROM settings'),
    db.prepare('DELETE FROM grants'),
    db.prepare('DELETE FROM claim_labels'),
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
  /** Access JWT sent in `Cf-Access-Jwt-Assertion`. */
  assertion: string;
  csrfToken: string;
  /** `Cookie` request header value (the CSRF cookie). */
  cookie: string;
  /** Both headers a signed-in browser behind Access sends. */
  headers: Record<string, string>;
  /** Stored identity subject (`<team domain>|<sub>`). */
  subject: string;
}

/**
 * A browser signed in to Access as `user`: links an `access` identity for the user (reusing an
 * existing one) and signs an Access JWT for it with the test team's key. Throws for a user that is
 * not active, since the middleware would refuse it anyway.
 */
export async function loginAs(
  app: { deps: Deps },
  user: User,
  options: { sub?: string; email?: string } = {},
): Promise<AdminSession> {
  const access = await testAccess();
  const row = await env.DB.prepare('SELECT status FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ status: string }>();
  if (row?.status !== 'active') throw new Error(`loginAs: ${user.email} is not active`);
  const linked = await env.DB.prepare(
    "SELECT subject FROM user_identities WHERE user_id = ? AND login_provider = 'access' LIMIT 1",
  )
    .bind(user.id)
    .first<{ subject: string }>();
  const prefix = `${access.teamDomain}|`;
  const sub =
    options.sub ??
    (linked?.subject.startsWith(prefix) ? linked.subject.slice(prefix.length) : `sub-${user.id}`);
  const subject = accessSubject(access.teamDomain, sub);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO user_identities (login_provider, subject, user_id, email, created_at)
     VALUES ('access', ?, ?, ?, ?)`,
  )
    .bind(subject, user.id, user.email, app.deps.now())
    .run();
  const assertion = await access.sign(
    { sub, email: options.email ?? user.email },
    { now: app.deps.now() },
  );
  const csrfToken = randomCsrfToken();
  const cookie = `${CSRF_COOKIE}=${csrfToken}`;
  return {
    assertion,
    csrfToken,
    cookie,
    headers: { cookie, [ACCESS_JWT_HEADER]: assertion },
    subject,
  };
}

/** A token in the shape the middleware writes (base64url of 32 bytes). */
export function randomCsrfToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
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
 * The auth-relevant slice of the real app (security middleware, admin middleware)
 * plus a stub proxy route registered before the security middleware, as in src/app.ts.
 */
export function createAdminTestApp(options: AdminTestAppOptions = {}): AdminTestApp {
  const testEnv = { ...env, ...TEST_ACCESS_ENV, ...options.env } as unknown as Env;
  const deps: Deps = {
    env: testEnv as unknown as AppEnv,
    fetch: withTestAccessCerts(
      options.fetch ??
        (async (input) => {
          throw new Error(`unexpected outbound fetch in test: ${String(input)}`);
        }),
    ),
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
  registerAdminMiddleware(app);
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
  app.get('/admin/tokens', ok);
  app.get('/admin/tokens/new', ok);
  app.post('/admin/tokens', ok);
  app.get('/admin/tokens/:id', ok);
  app.post('/admin/tokens/:id', ok);
  app.post('/admin/users', ok);
  app.post('/admin/tokens/keys/rewrap', ok);
  app.get('/admin/unlisted', ok);
  app.all('/admin/any-method', ok);
}

/** GET as a signed-in browser (Access JWT and CSRF cookie). */
export function adminGet(
  app: Pick<AdminTestApp, 'request'>,
  session: AdminSession | null,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    headers: { ...(session ? session.headers : {}), ...headers },
    redirect: 'manual',
  });
}

/**
 * Form POST as a same-origin browser would send it: Access JWT, CSRF cookie, `Sec-Fetch-Site: same-origin`
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
  for (const [name, value] of Object.entries(session?.headers ?? {})) headers.set(name, value);
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
