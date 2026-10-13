// User mutations (owner only, via RBAC), each with one audit row in the same batch (I-AUDIT-1).
// Role/status changes and login resets revoke the user's sessions in that batch (I-SESS-1); the
// last-owner trigger aborts it (I-OWNER-1).
import { revokeSessionsForUserStatement } from '../../db/sessions';
import type { Actor, Role, User, UserStatus } from '../../db/types';
import {
  getUser,
  INVITE_TTL_MS,
  inviteUserStatements,
  listIdentities,
  renewInviteStatements,
  resetLoginStatements,
  updateUserStatements,
} from '../../db/users';
import type { Deps } from '../../deps';
import { newId } from '../../lib/ids';
import {
  ActorNotAuthorizedError,
  actorNotAuthorized,
  allOf,
  type CommitOutcome,
  commitAudited,
  type OpFailure,
  opFailure,
  type SqlGuard,
} from './shared';

export const ROLES: readonly Role[] = ['owner', 'admin', 'viewer'];
/** Statuses an owner may set directly. `invited` is reached only by invite or login reset. */
export const SETTABLE_STATUSES: readonly Exclude<UserStatus, 'invited'>[] = ['active', 'disabled'];

export const EMAIL_MAX_LENGTH = 254;

export const LAST_OWNER_MESSAGE =
  'This change would leave no active owner. Make another user an owner first, then try again.';
const SELF_MESSAGE =
  'You cannot change your own account here. Ask another owner to do it, so nobody locks themselves out by mistake.';
const NO_IDENTITY_MESSAGE =
  'This user has never signed in, so they cannot be made active. Use "Invite again" so their next sign-in links their account.';
const DUPLICATE_EMAIL_MESSAGE =
  'A user with this email address already exists; see their row in the list above. If their invitation expired or was cancelled, use "Resend invitation" or "Invite again" there.';

export type UserOpResult = { ok: true; user: User } | OpFailure;

/**
 * Lowercased, trimmed address, or null when it is not a plausible single email address. Stricter
 * than auth/email.ts normalizeEmail (dotted ASCII domain): this one checks operator input.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) return null;
  for (let i = 0; i < email.length; i++) {
    const code = email.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  // One "@", non-empty local part, dotted ASCII domain; no whitespace or list separators.
  return /^[^\s@,;<>"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email) ? email : null;
}

export async function inviteUser(
  deps: Deps,
  actor: Actor,
  input: { email: string; role: Role },
): Promise<UserOpResult> {
  const email = normalizeEmail(input.email);
  const errors = [
    ...(email === null ? ['Enter a valid email address, for example alex@example.com.'] : []),
    ...roleErrors(input.role),
  ];
  if (errors.length > 0 || email === null) return opFailure('invalid', errors);

  const now = deps.now();
  const user: User = {
    id: newId('usr', now, deps.random),
    email,
    name: null,
    role: input.role,
    status: 'invited',
    invite_expires_at: now + INVITE_TTL_MS,
    created_at: now,
    updated_at: now,
    last_login_at: null,
  };
  const outcome = await commitUserChange(
    deps,
    actor,
    {
      action: 'user.invite',
      targetType: 'user',
      targetId: user.id,
      summary: `Invited ${email} as ${user.role}`,
      diff: {
        after: {
          email,
          role: user.role,
          status: user.status,
          invite_expires_at: user.invite_expires_at,
        },
      },
    },
    null,
    inviteUserStatements(deps.env.DB, {
      id: user.id,
      email,
      role: user.role,
      now,
      inviteExpiresAt: user.invite_expires_at as number,
    }),
  );
  if (!outcome.ok) return outcome;
  return { ok: true, user };
}

/**
 * Changes role and/or status. Refuses changes to the actor's own account and `invited → active`
 * (only a login activates an invitation, which also links the login identity). `changed` is false
 * when the values already match: nothing is written and no audit row is added.
 */
export async function updateUser(
  deps: Deps,
  actor: Actor,
  id: string,
  input: { role?: Role; status?: Exclude<UserStatus, 'invited'> },
): Promise<{ ok: true; user: User; changed: boolean } | OpFailure> {
  const errors = [
    ...(input.role === undefined ? [] : roleErrors(input.role)),
    ...(input.status === undefined || SETTABLE_STATUSES.includes(input.status)
      ? []
      : ['Status must be active or disabled.']),
  ];
  if (input.role === undefined && input.status === undefined) errors.push('Nothing to change.');
  if (errors.length > 0) return opFailure('invalid', errors);

  const existing = await getUser(deps.env.DB, id);
  if (!existing) return opFailure('not_found', ['User not found.']);
  if (actor.id === id) return opFailure('invalid', [SELF_MESSAGE]);
  if (input.status === 'active' && existing.status === 'invited') {
    return opFailure('invalid', [
      'An invited user becomes active by signing in. Use "Resend invitation" if their invitation expired.',
    ]);
  }

  const role = input.role ?? existing.role;
  const status = input.status ?? existing.status;
  const changes: { role?: Role; status?: Exclude<UserStatus, 'invited'> } = {};
  if (role !== existing.role) changes.role = role;
  if (input.status !== undefined && status !== existing.status) changes.status = input.status;
  if (Object.keys(changes).length === 0) return { ok: true, user: existing, changed: false };

  const now = deps.now();
  // Only a user with a login identity can be active: a never-linked invitation (e.g. cancelled,
  // then re-enabled) could not sign in. Checked in SQL so a concurrent reset cannot slip past.
  const activating = changes.status === 'active';
  const guard = activating
    ? allOf(userUnchangedGuard(existing), userHasIdentityGuard(id))
    : userUnchangedGuard(existing);
  const outcome = await commitUserChange(
    deps,
    actor,
    {
      action: 'user.update',
      targetType: 'user',
      targetId: id,
      summary: `Changed ${describeChanges(existing, changes)} of ${existing.email}; their sessions were ended`,
      diff: {
        before: { role: existing.role, status: existing.status },
        after: { role, status },
      },
    },
    guard,
    updateUserStatements(deps.env.DB, { id, now, ...changes }, guard),
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) {
    if (activating && (await listIdentities(deps.env.DB, id)).length === 0) {
      return opFailure('invalid', [NO_IDENTITY_MESSAGE]);
    }
    return changedMeanwhile(existing);
  }
  return { ok: true, user: { ...existing, role, status, updated_at: now }, changed: true };
}

/**
 * "Reset login": removes every login identity, returns the user to `invited` with a fresh
 * expiry and ends their sessions. The next sign-in with an authoritative email links again.
 */
export async function resetLogin(deps: Deps, actor: Actor, id: string): Promise<UserOpResult> {
  const existing = await getUser(deps.env.DB, id);
  if (!existing) return opFailure('not_found', ['User not found.']);
  if (actor.id === id) return opFailure('invalid', [SELF_MESSAGE]);

  const now = deps.now();
  const inviteExpiresAt = now + INVITE_TTL_MS;
  const guard = userUnchangedGuard(existing);
  const outcome = await commitUserChange(
    deps,
    actor,
    {
      action: 'user.reset_login',
      targetType: 'user',
      targetId: id,
      summary: `Reset login of ${existing.email}; identities removed, sessions ended, invitation renewed`,
      diff: {
        before: { status: existing.status, invite_expires_at: existing.invite_expires_at },
        after: { status: 'invited', invite_expires_at: inviteExpiresAt },
      },
    },
    guard,
    resetLoginStatements(deps.env.DB, { id, now, inviteExpiresAt }, guard),
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return changedMeanwhile(existing);
  return {
    ok: true,
    user: { ...existing, status: 'invited', invite_expires_at: inviteExpiresAt, updated_at: now },
  };
}

/** Ends every live session of the user; they must sign in again. */
export async function revokeSessions(
  deps: Deps,
  actor: Actor,
  id: string,
): Promise<{ ok: true; revoked: number } | OpFailure> {
  const existing = await getUser(deps.env.DB, id);
  if (!existing) return opFailure('not_found', ['User not found.']);
  const outcome = await commitUserChange(
    deps,
    actor,
    {
      action: 'user.revoke_sessions',
      targetType: 'user',
      targetId: id,
      summary: `Ended all sessions of ${existing.email}`,
    },
    userExistsGuard(id),
    [revokeSessionsForUserStatement(deps.env.DB, id, deps.now())],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return opFailure('not_found', ['User not found.']);
  return { ok: true, revoked: outcome.results[1]?.meta.changes ?? 0 };
}

/** Renews a pending invitation for another INVITE_TTL_MS. Only for users still `invited`. */
export async function resendInvite(deps: Deps, actor: Actor, id: string): Promise<UserOpResult> {
  const existing = await getUser(deps.env.DB, id);
  if (!existing) return opFailure('not_found', ['User not found.']);
  if (existing.status !== 'invited') {
    return opFailure('invalid', [
      `${existing.email} is not waiting for an invitation. To let them sign in with a different account, use "Reset login".`,
    ]);
  }
  const now = deps.now();
  const inviteExpiresAt = now + INVITE_TTL_MS;
  // Same predicate as the UPDATE in renewInviteStatements, so the audit row and the change agree.
  const guard: SqlGuard = {
    sql: "EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'invited')",
    binds: [id],
  };
  const outcome = await commitUserChange(
    deps,
    actor,
    {
      action: 'user.resend_invite',
      targetType: 'user',
      targetId: id,
      summary: `Renewed the invitation of ${existing.email}`,
      diff: {
        before: { invite_expires_at: existing.invite_expires_at },
        after: { invite_expires_at: inviteExpiresAt },
      },
    },
    guard,
    renewInviteStatements(deps.env.DB, { id, now, inviteExpiresAt }),
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) {
    return opFailure('conflict', [
      `${existing.email} signed in or was changed meanwhile; reload the page.`,
    ]);
  }
  return { ok: true, user: { ...existing, invite_expires_at: inviteExpiresAt, updated_at: now } };
}

function roleErrors(role: unknown): string[] {
  return ROLES.includes(role as Role) ? [] : ['Role must be owner, admin or viewer.'];
}

function userExistsGuard(id: string): SqlGuard {
  return { sql: 'EXISTS (SELECT 1 FROM users WHERE id = ?)', binds: [id] };
}

/**
 * The user still has the role, status and version the op read, so a change decided on that state
 * (self check, invited → active refusal, audit before/after) cannot land on a newer one.
 */
function userUnchangedGuard(user: User): SqlGuard {
  return {
    sql: 'EXISTS (SELECT 1 FROM users WHERE id = ? AND role = ? AND status = ? AND updated_at = ?)',
    binds: [user.id, user.role, user.status, user.updated_at],
  };
}

function userHasIdentityGuard(id: string): SqlGuard {
  return { sql: 'EXISTS (SELECT 1 FROM user_identities WHERE user_id = ?)', binds: [id] };
}

function changedMeanwhile(user: User): OpFailure {
  return opFailure('conflict', [
    `${user.email} was changed or removed by someone else meanwhile. Reload the page and try again.`,
  ]);
}

function describeChanges(existing: User, changes: { role?: Role; status?: UserStatus }): string {
  const parts: string[] = [];
  if (changes.role) parts.push(`role ${existing.role} → ${changes.role}`);
  if (changes.status) parts.push(`status ${existing.status} → ${changes.status}`);
  return parts.join(' and ');
}

/**
 * commitAudited with the users-table constraint errors and a failed actor check (I-SESS-1) mapped
 * to admin-facing failures; nothing was written in either case.
 */
async function commitUserChange(
  ...args: Parameters<typeof commitAudited>
): Promise<CommitOutcome | OpFailure> {
  try {
    return await commitAudited(...args);
  } catch (error) {
    if (error instanceof ActorNotAuthorizedError) return actorNotAuthorized();
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes('last_owner')) return opFailure('invalid', [LAST_OWNER_MESSAGE]);
    if (/UNIQUE constraint failed: users\.email/.test(text)) {
      return opFailure('invalid', [DUPLICATE_EMAIL_MESSAGE]);
    }
    throw error;
  }
}
