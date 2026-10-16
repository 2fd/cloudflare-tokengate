// Users and login identities. Linking and bootstrap are SQL-guarded batches: every statement
// repeats the precondition in its WHERE clause, so a concurrent or replayed attempt is a no-op
// instead of a second link or a second owner (I-LINK-1, I-BOOT-1).
import { auditStatement } from './audit';
import { userFromRow } from './rows';
import type { JoinRole, JoinStatus } from './settings';
import type { AuditEvent, Role, User, UserStatus } from './types';

/** Boolean SQL expression plus its binds, ANDed into every WHERE clause (see admin/ops/shared). */
type SqlGuard = { sql: string; binds: unknown[] };

/** How long an invitation (or a login reset) stays redeemable. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface UserListEntry extends User {
  identity_count: number;
}

export interface UserIdentity {
  login_provider: string;
  subject: string;
  user_id: string;
  email: string | null;
  created_at: number;
  last_used_at: number | null;
}

export async function getUser(db: D1Database, id: string): Promise<User | null> {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  return row ? userFromRow(row) : null;
}

/** Case-insensitive (the column is COLLATE NOCASE). */
export async function getUserByEmail(db: D1Database, email: string): Promise<User | null> {
  const row = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  return row ? userFromRow(row) : null;
}

export async function listUsers(db: D1Database): Promise<UserListEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT users.*, (SELECT count(*) FROM user_identities WHERE user_id = users.id) AS identity_count
       FROM users ORDER BY email`,
    )
    .all<Record<string, unknown>>();
  return results.map((row) => ({
    ...userFromRow(row),
    identity_count: Number(row.identity_count),
  }));
}

export async function countActiveOwners(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT count(*) AS n FROM users WHERE role = 'owner' AND status = 'active'")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listIdentities(db: D1Database, userId: string): Promise<UserIdentity[]> {
  const { results } = await db
    .prepare('SELECT * FROM user_identities WHERE user_id = ? ORDER BY created_at')
    .bind(userId)
    .all<UserIdentity>();
  return results;
}

/** The user bound to an exact (login provider, subject) identity, whatever its status. */
export async function findUserByIdentity(
  db: D1Database,
  loginProvider: string,
  subject: string,
): Promise<User | null> {
  const row = await db
    .prepare(
      `SELECT users.* FROM user_identities JOIN users ON users.id = user_identities.user_id
       WHERE user_identities.login_provider = ? AND user_identities.subject = ?`,
    )
    .bind(loginProvider, subject)
    .first();
  return row ? userFromRow(row) : null;
}

/** An invitation that can still be redeemed by email at `now`. */
export async function findRedeemableInvite(
  db: D1Database,
  email: string,
  now: number,
): Promise<User | null> {
  const row = await db
    .prepare("SELECT * FROM users WHERE email = ? AND status = 'invited' AND invite_expires_at > ?")
    .bind(email, now)
    .first();
  return row ? userFromRow(row) : null;
}

export function inviteUserStatements(
  db: D1Database,
  input: { id: string; email: string; role: Role; now: number; inviteExpiresAt: number },
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO users (id, email, name, role, status, invite_expires_at, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'invited', ?, ?, ?)`,
      )
      .bind(input.id, input.email, input.role, input.inviteExpiresAt, input.now, input.now),
  ];
}

/** Extends a pending invitation. Only touches users that are still `invited`. */
export function renewInviteStatements(
  db: D1Database,
  input: { id: string; now: number; inviteExpiresAt: number },
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        "UPDATE users SET invite_expires_at = ?, updated_at = MAX(?, updated_at + 1) WHERE id = ? AND status = 'invited'",
      )
      .bind(input.inviteExpiresAt, input.now, input.id),
  ];
}

/**
 * Role and/or status change. Admin requests re-read the user on every request, so the change
 * applies to the user's next request (I-SESS-1). The last-owner trigger aborts the whole batch with
 * `last_owner` when the change would leave no active owner (I-OWNER-1). With a `guard`, every
 * statement applies only while it holds; the users UPDATE runs last because it may change what the
 * guard reads.
 */
export function updateUserStatements(
  db: D1Database,
  input: { id: string; now: number; role?: Role; status?: Exclude<UserStatus, 'invited'> },
  guard?: SqlGuard,
): D1PreparedStatement[] {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (input.role !== undefined) {
    sets.push('role = ?');
    binds.push(input.role);
  }
  if (input.status !== undefined) {
    sets.push('status = ?');
    binds.push(input.status);
  }
  if (sets.length === 0) return [];
  return [
    db
      .prepare(
        `UPDATE users SET ${sets.join(', ')}, updated_at = MAX(?, updated_at + 1) WHERE id = ?${andGuard(guard)}`,
      )
      .bind(...binds, input.now, input.id, ...(guard?.binds ?? [])),
  ];
}

/**
 * "Reset login": forget every identity and return the user to `invited` with a fresh expiry. The
 * next login links a new identity through the invite path. With a `guard`,
 * every statement applies only while it holds; the users UPDATE runs last (see updateUserStatements).
 */
export function resetLoginStatements(
  db: D1Database,
  input: { id: string; now: number; inviteExpiresAt: number },
  guard?: SqlGuard,
): D1PreparedStatement[] {
  return [
    db
      .prepare(`DELETE FROM user_identities WHERE user_id = ?${andGuard(guard)}`)
      .bind(input.id, ...(guard?.binds ?? [])),
    db
      .prepare(
        `UPDATE users SET status = 'invited', invite_expires_at = ?, updated_at = MAX(?, updated_at + 1) WHERE id = ?${andGuard(guard)}`,
      )
      .bind(input.inviteExpiresAt, input.now, input.id, ...(guard?.binds ?? [])),
  ];
}

function andGuard(guard: SqlGuard | undefined): string {
  return guard ? ` AND (${guard.sql})` : '';
}

export interface LinkInput {
  userId: string;
  email: string;
  loginProvider: string;
  subject: string;
  name: string | null;
  now: number;
  audit: AuditEvent;
}

/**
 * Links a login identity to an invited user and activates it (I-LINK-1). Every statement is
 * guarded by "this user is still invited, unexpired, with this email", and the UPDATE that flips
 * the status runs last, so the audit row and identity are written exactly when the link happens.
 * The caller checks `meta.changes === 1` on the last result.
 */
export function linkInvitedUserStatements(db: D1Database, input: LinkInput): D1PreparedStatement[] {
  const guard =
    "EXISTS (SELECT 1 FROM users WHERE id = ? AND email = ? AND status = 'invited' AND invite_expires_at > ?)";
  const guardBinds = [input.userId, input.email, input.now];
  return [
    auditStatement(db, input.audit, { sql: guard, binds: guardBinds }),
    db
      .prepare(
        `INSERT INTO user_identities (login_provider, subject, user_id, email, created_at, last_used_at)
         SELECT ?, ?, ?, ?, ?, NULL WHERE ${guard}`,
      )
      .bind(
        input.loginProvider,
        input.subject,
        input.userId,
        input.email,
        input.now,
        ...guardBinds,
      ),
    db
      .prepare(
        `UPDATE users SET status = 'active', invite_expires_at = NULL, name = COALESCE(name, ?), updated_at = ?
         WHERE id = ? AND email = ? AND status = 'invited' AND invite_expires_at > ?`,
      )
      .bind(input.name, input.now, ...guardBinds),
  ];
}

export interface BootstrapInput {
  userId: string;
  email: string;
  loginProvider: string;
  subject: string;
  name: string | null;
  /** Hostname of the bootstrap request, for the admin host allowlist (I-DEPLOY-1); null skips it. */
  host: string | null;
  now: number;
  audit: AuditEvent;
}

/**
 * Creates the first owner (I-BOOT-1). The user INSERT only happens while no owner exists,
 * `bootstrap_completed_at` is absent and no user has this email; identity, settings marker,
 * admin hosts and audit row are each conditioned on that new user row existing. Admin hosts
 * already set are kept. The caller checks `meta.changes === 1` on the first result.
 */
export function bootstrapOwnerStatements(
  db: D1Database,
  input: BootstrapInput,
): D1PreparedStatement[] {
  const created = 'EXISTS (SELECT 1 FROM users WHERE id = ?)';
  return [
    db
      .prepare(
        `INSERT INTO users (id, email, name, role, status, invite_expires_at, created_at, updated_at)
         SELECT ?, ?, ?, 'owner', 'active', NULL, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner')
           AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'bootstrap_completed_at')
           AND NOT EXISTS (SELECT 1 FROM users WHERE email = ?)`,
      )
      .bind(input.userId, input.email, input.name, input.now, input.now, input.email),
    db
      .prepare(
        `INSERT INTO user_identities (login_provider, subject, user_id, email, created_at, last_used_at)
         SELECT ?, ?, ?, ?, ?, NULL WHERE ${created}`,
      )
      .bind(input.loginProvider, input.subject, input.userId, input.email, input.now, input.userId),
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at, updated_by)
         SELECT 'bootstrap_completed_at', ?, ?, ? WHERE ${created}`,
      )
      .bind(JSON.stringify(input.now), input.now, input.userId, input.userId),
    ...(input.host === null
      ? []
      : [
          db
            .prepare(
              `INSERT INTO settings (key, value, updated_at, updated_by)
               SELECT 'admin_hosts', ?, ?, ? WHERE ${created}
               ON CONFLICT (key) DO NOTHING`,
            )
            .bind(JSON.stringify([input.host]), input.now, input.userId, input.userId),
        ]),
    auditStatement(db, input.audit, { sql: created, binds: [input.userId] }),
  ];
}

export interface JoinInput {
  userId: string;
  role: JoinRole;
  status: JoinStatus;
  email: string;
  loginProvider: string;
  subject: string;
  name: string | null;
  now: number;
  audit: AuditEvent;
}

/**
 * Creates the user for a first sign-in that matches no user, with the configured join role and
 * status (I-LINK-1: an existing user is never linked by email outside an invitation). The user INSERT only happens while no user has this
 * email; identity and audit row are each conditioned on that new user row existing. The caller
 * checks `meta.changes === 1` on the first result.
 */
export function joinStatements(db: D1Database, input: JoinInput): D1PreparedStatement[] {
  const created = 'EXISTS (SELECT 1 FROM users WHERE id = ?)';
  return [
    db
      .prepare(
        `INSERT INTO users (id, email, name, role, status, invite_expires_at, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, NULL, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ?)`,
      )
      .bind(
        input.userId,
        input.email,
        input.name,
        input.role,
        input.status,
        input.now,
        input.now,
        input.email,
      ),
    db
      .prepare(
        `INSERT INTO user_identities (login_provider, subject, user_id, email, created_at, last_used_at)
         SELECT ?, ?, ?, ?, ?, NULL WHERE ${created}`,
      )
      .bind(input.loginProvider, input.subject, input.userId, input.email, input.now, input.userId),
    auditStatement(db, input.audit, { sql: created, binds: [input.userId] }),
  ];
}

/**
 * SQL condition: identity (login_provider, subject) is linked to `userId`, that user is active and,
 * when `roles` is given, holds one of them. Admin writes re-check it inside their batch, so a
 * disable, demotion or login reset that commits while a request is in flight stops its write
 * (I-SESS-1).
 */
export function liveIdentityGuard(input: {
  userId: string;
  loginProvider: string;
  subject: string;
  roles?: readonly Role[];
}): SqlGuard {
  const roles = input.roles ?? null;
  const roleSql =
    roles === null
      ? ''
      : ` AND ${roles.length === 0 ? '0' : `u.role IN (${roles.map(() => '?').join(', ')})`}`;
  return {
    sql: `EXISTS (SELECT 1 FROM user_identities i JOIN users u ON u.id = i.user_id
           WHERE i.login_provider = ? AND i.subject = ? AND i.user_id = ? AND u.status = 'active'${roleSql})`,
    binds: [input.loginProvider, input.subject, input.userId, ...(roles ?? [])],
  };
}

/**
 * Records that the user used the admin UI with this identity. Both updates apply only while the
 * identity is still linked to the active user, so a refused request records nothing.
 */
export function recordSeenStatements(
  db: D1Database,
  input: { userId: string; loginProvider: string; subject: string; now: number },
): D1PreparedStatement[] {
  const guard = liveIdentityGuard(input);
  return [
    db
      .prepare(`UPDATE users SET last_login_at = ? WHERE id = ?${andGuard(guard)}`)
      .bind(input.now, input.userId, ...guard.binds),
    db
      .prepare(
        `UPDATE user_identities SET last_used_at = ? WHERE login_provider = ? AND subject = ?${andGuard(guard)}`,
      )
      .bind(input.now, input.loginProvider, input.subject, ...guard.binds),
  ];
}

/** A refused sign-in counts as needing a decision for this long, unless the user changed since. */
export const REFUSED_ATTEMPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Users an owner should decide on: pending users, plus users with a refused sign-in in the last
 * REFUSED_ATTEMPT_TTL_MS that no change to the user answered yet. A deliberately suspended user
 * who has signed in before is left out. One count over `users` (index `users_status`).
 */
export async function countNeedsDecision(db: D1Database, now: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*) AS n FROM users
       WHERE status = 'pending'
         OR (last_refused_at > updated_at AND last_refused_at > ?
           AND (status <> 'suspended'
             OR NOT EXISTS (SELECT 1 FROM user_identities WHERE user_id = users.id)))`,
    )
    .bind(now - REFUSED_ATTEMPT_TTL_MS)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Users waiting for approval, oldest first. */
export async function listPendingUsers(db: D1Database, limit: number): Promise<User[]> {
  const { results } = await db
    .prepare("SELECT * FROM users WHERE status = 'pending' ORDER BY created_at, id LIMIT ?")
    .bind(limit)
    .all<Record<string, unknown>>();
  return results.map(userFromRow);
}

/**
 * The first `perRole` active users of each of `roles` by email, each with the role's total count of
 * active users. One bounded read however many users exist; enough to name "who to ask" for any
 * permission and say how many more there are (AskSomeone).
 */
export async function activeUsersByRole(
  db: D1Database,
  roles: readonly Role[],
  perRole: number,
): Promise<Array<{ email: string; role: Role; roleTotal: number }>> {
  if (roles.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT email, role, total FROM (
         SELECT email, role,
           ROW_NUMBER() OVER (PARTITION BY role ORDER BY email, id) AS position,
           COUNT(*) OVER (PARTITION BY role) AS total
         FROM users WHERE status = 'active' AND role IN (${roles.map(() => '?').join(', ')})
       ) WHERE position <= ? ORDER BY email`,
    )
    .bind(...roles, perRole)
    .all<{ email: string; role: Role; total: number }>();
  return results.map((row) => ({ email: row.email, role: row.role, roleTotal: Number(row.total) }));
}

/** Active users with one of `roles`, by email (who to ask for a change the viewer cannot make). */
export async function activeUsersWithRoles(
  db: D1Database,
  roles: readonly Role[],
  limit: number,
): Promise<User[]> {
  if (roles.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT * FROM users WHERE status = 'active' AND role IN (${roles.map(() => '?').join(', ')})
       ORDER BY email LIMIT ?`,
    )
    .bind(...roles, limit)
    .all<Record<string, unknown>>();
  return results.map(userFromRow);
}

/** Filters of the People list. `expired` is an invitation whose expiry has passed. */
export interface UserFilter {
  role?: Role;
  status?: 'active' | 'invited' | 'expired' | 'suspended';
  /** Case-insensitive part of the email or the name. */
  q?: string;
}

/**
 * The users that are not pending (pending people are listed apart, as decisions), matching
 * `filter`, by email. `q` is matched with instr() on bound values, never LIKE, so `%` and `_` in
 * the search text are plain characters.
 */
export async function listUsersFiltered(
  db: D1Database,
  filter: UserFilter,
  now: number,
): Promise<UserListEntry[]> {
  const where = ["status <> 'pending'"];
  const binds: unknown[] = [];
  if (filter.role) {
    where.push('role = ?');
    binds.push(filter.role);
  }
  if (filter.status === 'expired') {
    where.push("status = 'invited' AND invite_expires_at <= ?");
    binds.push(now);
  } else if (filter.status === 'invited') {
    where.push("status = 'invited' AND invite_expires_at > ?");
    binds.push(now);
  } else if (filter.status) {
    where.push('status = ?');
    binds.push(filter.status);
  }
  if (filter.q) {
    const q = filter.q.toLowerCase();
    where.push("(instr(lower(email), ?) > 0 OR instr(lower(coalesce(name, '')), ?) > 0)");
    binds.push(q, q);
  }
  const { results } = await db
    .prepare(
      `SELECT users.*, (SELECT count(*) FROM user_identities WHERE user_id = users.id) AS identity_count
       FROM users WHERE ${where.join(' AND ')} ORDER BY email`,
    )
    .bind(...binds)
    .all<Record<string, unknown>>();
  return results.map((row) => ({
    ...userFromRow(row),
    identity_count: Number(row.identity_count),
  }));
}

/** A user with its identity count, or null. */
export async function getUserEntry(db: D1Database, id: string): Promise<UserListEntry | null> {
  const row = await db
    .prepare(
      `SELECT users.*, (SELECT count(*) FROM user_identities WHERE user_id = users.id) AS identity_count
       FROM users WHERE id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
  return row ? { ...userFromRow(row), identity_count: Number(row.identity_count) } : null;
}

/**
 * Records a refused sign-in of a known user (time and login subject), so owners see that they
 * tried. Not audited and never changes `updated_at` (like last_login_at), so version guards keep
 * holding; links nothing (I-LINK-1). Written at most once per `minIntervalMs`.
 */
export function recordRefusedStatements(
  db: D1Database,
  input: { userId: string; subject: string; now: number; minIntervalMs: number },
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE users SET last_refused_at = ?, last_refused_subject = ?
         WHERE id = ? AND (last_refused_at IS NULL OR last_refused_at <= ?)`,
      )
      .bind(input.now, input.subject, input.userId, input.now - input.minIntervalMs),
  ];
}

/**
 * Approves a pending user with a role: role and status in one UPDATE that applies only while the
 * user is still pending and has a login identity (only a linked user can be active).
 */
export function approveStatements(
  db: D1Database,
  input: { id: string; role: Role; now: number },
  guard?: SqlGuard,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE users SET role = ?, status = 'active', updated_at = MAX(?, updated_at + 1)
         WHERE id = ? AND status = 'pending'
           AND EXISTS (SELECT 1 FROM user_identities WHERE user_id = ?)${andGuard(guard)}`,
      )
      .bind(input.role, input.now, input.id, input.id, ...(guard?.binds ?? [])),
  ];
}

/**
 * Invites again a user who never signed in (invited or suspended, no identity), with a new role and
 * a fresh expiry. A user who ever linked an identity is never re-invited by email (I-LINK-1).
 */
export function reinviteStatements(
  db: D1Database,
  input: { id: string; role: Role; now: number; inviteExpiresAt: number },
  guard?: SqlGuard,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE users SET role = ?, status = 'invited', invite_expires_at = ?, updated_at = MAX(?, updated_at + 1)
         WHERE id = ? AND status IN ('invited', 'suspended')
           AND NOT EXISTS (SELECT 1 FROM user_identities WHERE user_id = ?)${andGuard(guard)}`,
      )
      .bind(
        input.role,
        input.inviteExpiresAt,
        input.now,
        input.id,
        input.id,
        ...(guard?.binds ?? []),
      ),
  ];
}

/**
 * Deletes a user who never signed in (an invitation, or a cancelled one). A user who ever linked an
 * identity is kept: deleting them would let their next sign-in join anew and undo a suspension.
 */
export function deleteUserStatements(
  db: D1Database,
  input: { id: string },
  guard?: SqlGuard,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `DELETE FROM users WHERE id = ? AND status IN ('invited', 'suspended')
           AND NOT EXISTS (SELECT 1 FROM user_identities WHERE user_id = ?)${andGuard(guard)}`,
      )
      .bind(input.id, input.id, ...(guard?.binds ?? [])),
  ];
}

/** Clears the recorded refused sign-in, only while it is still the one the owner saw. */
export function dismissRefusedStatements(
  db: D1Database,
  input: { id: string; expectedRefusedAt: number },
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        'UPDATE users SET last_refused_at = NULL, last_refused_subject = NULL WHERE id = ? AND last_refused_at = ?',
      )
      .bind(input.id, input.expectedRefusedAt),
  ];
}

/**
 * Whether a recorded refused sign-in still waits for an owner: within REFUSED_ATTEMPT_TTL_MS, newer
 * than the last change to the user, and not a deliberately suspended user who has signed in
 * before. The same rule as countNeedsDecision.
 */
export function refusedAttemptOpen(
  user: Pick<User, 'status' | 'updated_at' | 'last_refused_at'> & { identity_count: number },
  now: number,
): boolean {
  const at = user.last_refused_at;
  if (at === null) return false;
  if (!(at > user.updated_at && at > now - REFUSED_ATTEMPT_TTL_MS)) return false;
  return user.status !== 'suspended' || user.identity_count === 0;
}
