// Admin session rows. Only SHA-256(session id) is stored (I-SESS-1); validity (not revoked, idle
// and absolute expiry, user active, login identity still linked to the user) is decided in SQL on
// every load, together with the user's current role.
import { sessionFromRow, userFromRow } from './rows';
import type { Role, Session, User } from './types';

/**
 * FROM/WHERE shared by loadLiveSession and liveSessionGuard: the session is not revoked or expired,
 * its user is active and its login identity is still linked to that user. Binds: id_hash, now, now.
 */
const LIVE_SESSION = `FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN user_identities i ON i.login_provider = s.login_provider
           AND i.subject = s.identity_subject AND i.user_id = s.user_id
       WHERE s.id_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND s.idle_expires_at > ?
         AND u.status = 'active'`;

/**
 * SQL condition: session `idHash` is live at `now` (same rules as loadLiveSession) and its user's
 * role is one of `roles`. Used to re-check an admin request's authority inside its write.
 */
export function liveSessionGuard(input: { idHash: string; now: number; roles: readonly Role[] }): {
  sql: string;
  binds: unknown[];
} {
  const roles =
    input.roles.length === 0 ? '0' : `u.role IN (${input.roles.map(() => '?').join(', ')})`;
  return {
    sql: `EXISTS (SELECT 1 ${LIVE_SESSION} AND ${roles})`,
    binds: [input.idHash, input.now, input.now, ...input.roles],
  };
}

/**
 * SQL condition: identity (login_provider, subject) is linked to user_id and that user is active.
 * Re-checked inside the write, so a concurrent reset-login or disable between resolving the login
 * and issuing the session cannot leave a session behind (I-SESS-1).
 */
export function liveIdentityGuard(input: {
  userId: string;
  loginProvider: string;
  subject: string;
}): { sql: string; binds: unknown[] } {
  return {
    sql: `EXISTS (SELECT 1 FROM user_identities i JOIN users u ON u.id = i.user_id
           WHERE i.login_provider = ? AND i.subject = ? AND i.user_id = ? AND u.status = 'active')`,
    binds: [input.loginProvider, input.subject, input.userId],
  };
}

/** Inserts the session only while `liveIdentityGuard` holds; `meta.changes` is 0 otherwise. */
export function insertSessionStatement(db: D1Database, session: Session): D1PreparedStatement {
  const guard = liveIdentityGuard({
    userId: session.user_id,
    loginProvider: session.login_provider,
    subject: session.identity_subject,
  });
  return db
    .prepare(
      `INSERT INTO sessions (id_hash, user_id, login_provider, identity_subject, csrf_token, created_at,
         last_seen_at, expires_at, idle_expires_at, ip, user_agent, revoked_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL WHERE ${guard.sql}`,
    )
    .bind(
      session.id_hash,
      session.user_id,
      session.login_provider,
      session.identity_subject,
      session.csrf_token,
      session.created_at,
      session.last_seen_at,
      session.expires_at,
      session.idle_expires_at,
      session.ip,
      session.user_agent,
      ...guard.binds,
    );
}

/**
 * The live session for `idHash` and its (active) user, or null. The join on user_identities kills
 * a session as soon as its login identity is unlinked (reset login), even if the user is later
 * re-activated with another identity.
 */
export async function loadLiveSession(
  db: D1Database,
  idHash: string,
  now: number,
): Promise<{ session: Session; user: User } | null> {
  // Column aliases keep the two row shapes apart in one round trip.
  const row = await db
    .prepare(
      `SELECT s.id_hash, s.user_id, s.login_provider, s.identity_subject, s.csrf_token, s.created_at,
              s.last_seen_at, s.expires_at, s.idle_expires_at, s.ip, s.user_agent, s.revoked_at,
              u.id AS u_id, u.email AS u_email, u.name AS u_name, u.role AS u_role, u.status AS u_status,
              u.invite_expires_at AS u_invite_expires_at, u.created_at AS u_created_at,
              u.updated_at AS u_updated_at, u.last_login_at AS u_last_login_at
       ${LIVE_SESSION}`,
    )
    .bind(idHash, now, now)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const userRow: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('u_')) userRow[key.slice(2)] = value;
  }
  return { session: sessionFromRow(row), user: userFromRow(userRow) };
}

/** Slides the idle expiry. Never revives a revoked or already expired session. */
export function touchSessionStatement(
  db: D1Database,
  idHash: string,
  now: number,
  idleExpiresAt: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sessions SET last_seen_at = ?1, idle_expires_at = ?2
       WHERE id_hash = ?3 AND revoked_at IS NULL AND idle_expires_at > ?1 AND expires_at > ?1`,
    )
    .bind(now, idleExpiresAt, idHash);
}

export function revokeSessionStatement(
  db: D1Database,
  idHash: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL')
    .bind(now, idHash);
}

export function revokeSessionsForUserStatement(
  db: D1Database,
  userId: string,
  now: number,
  guard?: { sql: string; binds: unknown[] },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL${guard ? ` AND (${guard.sql})` : ''}`,
    )
    .bind(now, userId, ...(guard?.binds ?? []));
}

/** Sessions that would still be accepted at `now` (user status not considered), newest first. */
export async function listActiveSessions(
  db: D1Database,
  now: number,
  userId?: string,
): Promise<Session[]> {
  const byUser = userId === undefined ? '' : 'AND user_id = ?';
  const { results } = await db
    .prepare(
      `SELECT * FROM sessions
       WHERE revoked_at IS NULL AND expires_at > ? AND idle_expires_at > ? ${byUser}
       ORDER BY created_at DESC`,
    )
    .bind(...(userId === undefined ? [now, now] : [now, now, userId]))
    .all<Record<string, unknown>>();
  return results.map(sessionFromRow);
}
