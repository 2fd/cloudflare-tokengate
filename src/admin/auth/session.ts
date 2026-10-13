// Admin session lifecycle (I-SESS-1): 32 random bytes in a `__Host-` cookie, only SHA-256(id) in
// D1, idle (12 h) and absolute (7 d) expiry, user status and role re-read on every request, a new
// id on every login (the cookie's previous session is revoked), revocation effective immediately.
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppContext } from '../../app';
import { randomToken, sha256Hex } from '../../crypto/hash';
import { auditStatement, buildAuditEvent, emitAuditLine } from '../../db/audit';
import {
  insertSessionStatement,
  liveIdentityGuard,
  loadLiveSession,
  revokeSessionStatement,
  revokeSessionsForUserStatement,
  touchSessionStatement,
} from '../../db/sessions';
import type { Session, User } from '../../db/types';
import { recordLoginStatements } from '../../db/users';
import type { Deps } from '../../deps';

export const SESSION_COOKIE = '__Host-tokengate_session';
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
/** last_seen_at / idle expiry are written at most this often per session. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** base64url of 32 bytes. Anything else is rejected before hashing or querying. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const USER_AGENT_MAX = 256;

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function requestMeta(headers: Headers): RequestMeta {
  return {
    ip: headers.get('cf-connecting-ip'),
    userAgent: headers.get('user-agent')?.slice(0, USER_AGENT_MAX) ?? null,
  };
}

export interface IssuedSession {
  /** Cookie value. Never stored or logged. */
  sessionId: string;
  session: Session;
}

/**
 * Creates a session for a resolved login in one batch: revokes the session named by the browser's
 * current cookie (if any), inserts the new one, records the login on the user and identity, and
 * writes a `user.login` audit row. Every statement but the revoke is conditioned in SQL on the
 * identity still being linked to an active user; null when it no longer is (I-SESS-1).
 */
export async function issueSession(
  deps: Deps,
  input: {
    user: User;
    loginProvider: string;
    identitySubject: string;
    previousSessionId: string | null;
    meta: RequestMeta;
  },
): Promise<IssuedSession | null> {
  const db = deps.env.DB;
  const now = deps.now();
  const sessionId = randomToken(deps.random);
  const session: Session = {
    id_hash: await sha256Hex(sessionId),
    user_id: input.user.id,
    login_provider: input.loginProvider,
    identity_subject: input.identitySubject,
    csrf_token: randomToken(deps.random),
    created_at: now,
    last_seen_at: now,
    expires_at: now + SESSION_ABSOLUTE_MS,
    idle_expires_at: now + SESSION_IDLE_MS,
    ip: input.meta.ip,
    user_agent: input.meta.userAgent,
    revoked_at: null,
  };
  const audit = buildAuditEvent(
    deps,
    {
      type: 'user',
      id: input.user.id,
      email: input.user.email,
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
    },
    {
      action: 'user.login',
      targetType: 'user',
      targetId: input.user.id,
      summary: `Signed in with ${input.loginProvider}`,
      diff: { login_provider: input.loginProvider, subject: input.identitySubject },
    },
  );
  const guard = liveIdentityGuard({
    userId: input.user.id,
    loginProvider: input.loginProvider,
    subject: input.identitySubject,
  });
  const statements: D1PreparedStatement[] = [];
  if (input.previousSessionId !== null && SESSION_ID_RE.test(input.previousSessionId)) {
    statements.push(revokeSessionStatement(db, await sha256Hex(input.previousSessionId), now));
  }
  const insertIndex = statements.length;
  statements.push(
    insertSessionStatement(db, session),
    ...recordLoginStatements(
      db,
      {
        userId: input.user.id,
        loginProvider: input.loginProvider,
        subject: input.identitySubject,
        now,
      },
      guard,
    ),
    auditStatement(db, audit, guard),
  );
  const results = await db.batch(statements);
  if (results[insertIndex]?.meta.changes !== 1) return null;
  emitAuditLine(audit);
  return { sessionId, session };
}

/** The live session and its active user for a cookie value, or null. */
export async function loadSession(
  deps: Pick<Deps, 'env' | 'now'>,
  sessionId: string,
): Promise<{ session: Session; user: User } | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  return loadLiveSession(deps.env.DB, await sha256Hex(sessionId), deps.now());
}

/** Slides the idle expiry, at most once per SESSION_TOUCH_INTERVAL_MS. */
export async function touchSession(
  deps: Pick<Deps, 'env' | 'now'>,
  session: Session,
): Promise<void> {
  const now = deps.now();
  if (now - session.last_seen_at < SESSION_TOUCH_INTERVAL_MS) return;
  await touchSessionStatement(deps.env.DB, session.id_hash, now, now + SESSION_IDLE_MS).run();
}

export async function revokeSession(
  deps: Pick<Deps, 'env' | 'now'>,
  idHash: string,
): Promise<void> {
  await revokeSessionStatement(deps.env.DB, idHash, deps.now()).run();
}

export async function revokeAllForUser(
  deps: Pick<Deps, 'env' | 'now'>,
  userId: string,
): Promise<void> {
  await revokeSessionsForUserStatement(deps.env.DB, userId, deps.now()).run();
}

// Lax, not Strict: the OAuth callback is a cross-site top-level navigation, and Strict would drop
// the cookie on the redirect that follows it.
const SESSION_COOKIE_OPTIONS = {
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
} as const;

export function readSessionCookie(c: Context<AppContext>): string | null {
  return getCookie(c, SESSION_COOKIE) ?? null;
}

export function setSessionCookie(c: Context<AppContext>, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTIONS);
}

export function clearSessionCookie(c: Context<AppContext>): void {
  deleteCookie(c, SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
}

const RETURN_TO_BASE = 'https://return-to.invalid';
/** Sized so OAUTH_PENDING_MAX entries always fit OAUTH_COOKIE_VALUE_MAX (oauth-state.ts). */
export const RETURN_TO_MAX = 512;

/**
 * Post-login destination (I-OAUTH-1): `/admin` or a path below it on this origin, re-serialized
 * from the parsed URL (resolves `..`, drops the fragment), otherwise `/admin`. The length cap also
 * applies to the serialized form, which percent-encoding can make longer than the input: this keeps
 * the function idempotent and bounds the state cookie. The result contains only characters that
 * JSON.stringify writes as themselves, so its JSON form is its length plus the two quotes.
 */
export function sanitizeReturnTo(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.length > RETURN_TO_MAX) {
    return '/admin';
  }
  let url: URL;
  try {
    url = new URL(raw, RETURN_TO_BASE);
  } catch {
    return '/admin';
  }
  if (url.origin !== RETURN_TO_BASE) return '/admin';
  if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return '/admin';
  // URL serialization percent-encodes `"`, controls and non-ASCII but keeps `\` in the query
  // (https://url.spec.whatwg.org/#query-percent-encode-set); JSON would double it.
  const out = (url.pathname + url.search).replaceAll('\\', '%5C');
  return out.length > RETURN_TO_MAX ? '/admin' : out;
}
