// User mutations (owner only, via RBAC), each with one audit row in the same batch (I-AUDIT-1).
// Admin requests re-read the user on every request, so changes apply on the user's next request
// (I-SESS-1); the last-owner trigger aborts a batch that would leave no active owner (I-OWNER-1).
// Only a sign-in links an identity: an invitation is redeemed by email, and a user who ever linked
// one is never invited again or deleted by email (I-LINK-1).

import {
  getJoinDefaults,
  JOIN_ROLES,
  JOIN_STATUSES,
  type JoinDefaults,
  type JoinRole,
  putSettingStatement,
} from '../../db/settings';
import type { Actor, Role, User, UserStatus } from '../../db/types';
import {
  approveStatements,
  deleteUserStatements,
  dismissRefusedStatements,
  getUser,
  getUserByEmail,
  INVITE_TTL_MS,
  inviteUserStatements,
  listIdentities,
  reinviteStatements,
  renewInviteStatements,
  resetLoginStatements,
  updateUserStatements,
} from '../../db/users';
import type { Deps } from '../../deps';
import { newId } from '../../lib/ids';
import { formatTime } from '../views/format';
import { ROLE_INFO } from '../views/roles';
import {
  ActorNotAuthorizedError,
  actorNotAuthorized,
  allOf,
  type CommitOutcome,
  commitAudited,
  fieldError,
  nextVersion,
  type OpFailure,
  opFailure,
  type SqlGuard,
} from './shared';

export const ROLES: readonly Role[] = [
  'owner',
  'admin',
  'token_manager',
  'access_manager',
  'viewer',
];
/**
 * Statuses an owner may set directly. `invited` is reached only by invite or login reset, `pending`
 * only by a first sign-in while the join status is pending.
 */
export type SettableStatus = Exclude<UserStatus, 'invited' | 'pending'>;
export const SETTABLE_STATUSES: readonly SettableStatus[] = ['active', 'suspended'];

export const EMAIL_MAX_LENGTH = 254;

export const ROLE_MESSAGE =
  'Choose one of: Viewer, Credential manager, Access manager, Admin, Owner.';
export const LAST_OWNER_MESSAGE =
  'This change would leave no active owner. Make another user an owner first, then try again.';
export const SELF_MESSAGE =
  'You cannot change your own account here. Ask another owner to do it, so nobody locks themselves out by mistake.';
const NO_IDENTITY_MESSAGE =
  'This user has never signed in, so they cannot be made active. Use "Invite again" so their next sign-in links their account.';
const EMAIL_MESSAGE = 'Enter an email address like alex@acme.com.';

/** A committed change and the id of its audit row (for the `done` notice), or nothing changed. */
export type UserChangeResult =
  | { ok: true; user: User; changed: boolean; auditId: string | null }
  | OpFailure;

/** An invitation refused because the email belongs to a user who signed in (`existingUserId`). */
export type InviteResult =
  | { ok: true; user: User; again: boolean; auditId: string }
  | (OpFailure & { existingUserId?: string });

/** "Active", "Invitation expired", …: the status as the People list shows it. */
export function userStatusText(user: Pick<User, 'status' | 'invite_expires_at'>, now: number) {
  switch (user.status) {
    case 'active':
      return 'Active';
    case 'pending':
      return 'Pending approval';
    case 'suspended':
      return 'Suspended';
    case 'invited':
      return user.invite_expires_at !== null && user.invite_expires_at > now
        ? 'Invited'
        : 'Invitation expired';
  }
}

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

/**
 * Invites `email` with `role`. An email nobody has gets a new invited user. An email whose user
 * never signed in (invited or suspended, no identity: an expired or cancelled invitation) is
 * invited again with the new role and a fresh expiry. Any other existing user is refused, with
 * `existingUserId` so the page can offer that user's own action (I-LINK-1).
 */
export async function inviteUser(
  deps: Deps,
  actor: Actor,
  input: { email: unknown; role: unknown },
): Promise<InviteResult> {
  const email = normalizeEmail(input.email);
  const errors = [
    ...(email === null ? [fieldError('email', EMAIL_MESSAGE)] : []),
    ...(isRole(input.role) ? [] : [fieldError('role', ROLE_MESSAGE)]),
  ];
  if (errors.length > 0 || email === null || !isRole(input.role)) {
    return opFailure('invalid', errors);
  }
  const role = input.role;
  const db = deps.env.DB;
  const now = deps.now();
  const inviteExpiresAt = now + INVITE_TTL_MS;

  const existing = await getUserByEmail(db, email);
  if (existing) {
    const identities = (await listIdentities(db, existing.id)).length;
    if (identities > 0 || (existing.status !== 'invited' && existing.status !== 'suspended')) {
      return {
        ...opFailure('invalid', [
          fieldError(
            'email',
            `${email} already signed in with an account (${userStatusText(existing, now)}).`,
          ),
        ]),
        existingUserId: existing.id,
      };
    }
    // The same predicate as the UPDATE, plus the version read, so the diff describes this row.
    const guard: SqlGuard = {
      sql: `EXISTS (SELECT 1 FROM users WHERE id = ? AND status IN ('invited', 'suspended') AND updated_at = ?)
        AND NOT EXISTS (SELECT 1 FROM user_identities WHERE user_id = ?)`,
      binds: [existing.id, existing.updated_at, existing.id],
    };
    const outcome = await commitUserChange(
      deps,
      actor,
      {
        action: 'user.invite',
        targetType: 'user',
        targetId: existing.id,
        summary: `Invited ${email} again as ${ROLE_INFO[role].label}`,
        diff: {
          before: {
            role: existing.role,
            status: existing.status,
            invite_expires_at: existing.invite_expires_at,
          },
          after: { role, status: 'invited', invite_expires_at: inviteExpiresAt },
        },
      },
      guard,
      reinviteStatements(db, { id: existing.id, role, now, inviteExpiresAt }, guard),
    );
    if (!outcome.ok) return outcome;
    if (!outcome.committed) return changedMeanwhile(existing);
    return {
      ok: true,
      again: true,
      auditId: outcome.event.id,
      user: {
        ...existing,
        role,
        status: 'invited',
        invite_expires_at: inviteExpiresAt,
        updated_at: nextVersion(existing.updated_at, now),
      },
    };
  }

  const user: User = {
    id: newId('usr', now, deps.random),
    email,
    name: null,
    role,
    status: 'invited',
    invite_expires_at: inviteExpiresAt,
    created_at: now,
    updated_at: now,
    last_login_at: null,
    last_refused_at: null,
    last_refused_subject: null,
  };
  const outcome = await commitUserChange(
    deps,
    actor,
    {
      action: 'user.invite',
      targetType: 'user',
      targetId: user.id,
      summary: `Invited ${email} as ${ROLE_INFO[role].label}`,
      diff: {
        after: { email, role, status: user.status, invite_expires_at: inviteExpiresAt },
      },
    },
    null,
    inviteUserStatements(db, { id: user.id, email, role, now, inviteExpiresAt }),
  );
  if (!outcome.ok) return outcome;
  return { ok: true, user, again: false, auditId: outcome.event.id };
}

/**
 * Changes the role or the status (one field per click in the UI; both are accepted). Refuses
 * changes to the actor's own account and `invited → active` (only a sign-in activates an
 * invitation, which also links the identity). `expectedUpdatedAt` is the version the page showed:
 * a mismatch is a conflict before anything is written. `changed` is false when the values already
 * match: nothing is written and no audit row is added.
 */
export async function updateUser(
  deps: Deps,
  actor: Actor,
  id: string,
  input: { role?: Role; status?: SettableStatus; expectedUpdatedAt?: unknown },
): Promise<UserChangeResult> {
  const errors = [
    ...(input.role === undefined ? [] : roleErrors(input.role)),
    ...(input.status === undefined || SETTABLE_STATUSES.includes(input.status)
      ? []
      : ['Choose Active or Suspended.']),
  ];
  if (input.role === undefined && input.status === undefined) {
    errors.push('Choose a role or a status.');
  }
  if (errors.length > 0) return opFailure('invalid', errors);

  const existing = await getUser(deps.env.DB, id);
  if (!existing) return opFailure('not_found', ['User not found.']);
  const stale = staleUser(existing, input.expectedUpdatedAt);
  if (stale) return stale;
  // A pending sign-in is decided with a role in one step (user.approve / user.reject), never
  // through a plain role or status change.
  if (existing.status === 'pending') return pendingFailure(existing);
  return changeUser(deps, actor, existing, input, 'user.update');
}

async function changeUser(
  deps: Deps,
  actor: Actor,
  existing: User,
  input: { role?: Role; status?: SettableStatus },
  action: 'user.update' | 'user.reject',
): Promise<UserChangeResult> {
  if (actor.id === existing.id) return opFailure('invalid', [SELF_MESSAGE]);
  if (input.status === 'active' && existing.status === 'invited') {
    return opFailure('invalid', [
      'An invited user becomes active by signing in. Use "Renew invitation" if their invitation expired.',
    ]);
  }

  const role = input.role ?? existing.role;
  const status = input.status ?? existing.status;
  const changes: { role?: Role; status?: SettableStatus } = {};
  if (role !== existing.role) changes.role = role;
  if (input.status !== undefined && status !== existing.status) changes.status = input.status;
  if (Object.keys(changes).length === 0) {
    return { ok: true, user: existing, changed: false, auditId: null };
  }

  const now = deps.now();
  // Only a user with a login identity can be active: a never-linked invitation (e.g. cancelled,
  // then re-enabled) could not sign in. Checked in SQL so a concurrent reset cannot slip past.
  const activating = changes.status === 'active';
  const guard = activating
    ? allOf(userUnchangedGuard(existing), userHasIdentityGuard(existing.id))
    : userUnchangedGuard(existing);
  const outcome = await commitUserChange(
    deps,
    actor,
    {
      action,
      targetType: 'user',
      targetId: existing.id,
      summary:
        action === 'user.reject'
          ? `Rejected ${existing.email}`
          : `Changed ${describeChanges(existing, changes)} of ${existing.email}`,
      diff: {
        before: { role: existing.role, status: existing.status },
        after: { role, status },
      },
    },
    guard,
    updateUserStatements(deps.env.DB, { id: existing.id, now, ...changes }, guard),
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) {
    if (activating && (await listIdentities(deps.env.DB, existing.id)).length === 0) {
      return opFailure('invalid', [NO_IDENTITY_MESSAGE]);
    }
    return changedMeanwhile(existing);
  }
  return {
    ok: true,
    changed: true,
    auditId: outcome.event.id,
    user: { ...existing, role, status, updated_at: nextVersion(existing.updated_at, now) },
  };
}

/** A pending user is decided only by approve or reject (user.approve / user.reject). */
function pendingFailure(user: User): OpFailure {
  return opFailure('invalid', [
    `${user.email} is waiting for approval. Approve them with a role, or reject them, under "Needs your decision".`,
  ]);
}

/**
 * "Reset sign-in": removes every login identity and returns the user to `invited` with a fresh
 * expiry. The next sign-in with an authoritative email links again. For a user without an
 * identity this is "Invite again" (nothing is removed).
 */
export async function resetLogin(
  deps: Deps,
  actor: Actor,
  id: string,
  expectedUpdatedAt?: unknown,
): Promise<UserChangeResult> {
  const existing = await getUser(deps.env.DB, id);
  if (!existing) return opFailure('not_found', ['User not found.']);
  if (actor.id === id) return opFailure('invalid', [SELF_MESSAGE]);
  const stale = staleUser(existing, expectedUpdatedAt);
  if (stale) return stale;
  // Resetting a pending user would make them `invited`, and their next sign-in would activate
  // them with no decision. The guard pins the status, so a concurrent change cannot slip past.
  if (existing.status === 'pending') return pendingFailure(existing);

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
      summary: `Reset sign-in of ${existing.email}; identities removed, invitation renewed`,
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
    changed: true,
    auditId: outcome.event.id,
    user: {
      ...existing,
      status: 'invited',
      invite_expires_at: inviteExpiresAt,
      updated_at: nextVersion(existing.updated_at, now),
    },
  };
}

/** "Renew invitation": another INVITE_TTL_MS for a user still `invited` (even expired). */
export async function resendInvite(
  deps: Deps,
  actor: Actor,
  id: string,
): Promise<UserChangeResult> {
  const existing = await getUser(deps.env.DB, id);
  if (!existing) return opFailure('not_found', ['User not found.']);
  if (existing.status !== 'invited') {
    return opFailure('invalid', [
      `${existing.email} is not waiting for an invitation. To let them sign in with a different account, use "Reset sign-in".`,
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
      `${existing.email} signed in or was changed meanwhile. The page now shows the current state.`,
    ]);
  }
  return {
    ok: true,
    changed: true,
    auditId: outcome.event.id,
    user: {
      ...existing,
      invite_expires_at: inviteExpiresAt,
      updated_at: nextVersion(existing.updated_at, now),
    },
  };
}

/**
 * "Cancel invitation": deletes a user who never signed in (invited, or suspended without an
 * identity). A user who ever linked an identity is refused: their next sign-in would join anew
 * with the join policy, which undoes a suspension.
 */
export async function deleteUser(
  deps: Deps,
  actor: Actor,
  id: string,
  expectedUpdatedAt?: unknown,
): Promise<UserChangeResult> {
  const db = deps.env.DB;
  const existing = await getUser(db, id);
  if (!existing) return opFailure('not_found', ['User not found.']);
  if (actor.id === id) return opFailure('invalid', [SELF_MESSAGE]);
  const stale = staleUser(existing, expectedUpdatedAt);
  if (stale) return stale;
  const linked = (await listIdentities(db, id)).length > 0;
  if (linked || (existing.status !== 'invited' && existing.status !== 'suspended')) {
    return opFailure('invalid', [
      `${existing.email} has signed in before. Suspend them instead, so a later sign-in stays refused.`,
    ]);
  }
  const guard = allOf(userUnchangedGuard(existing), {
    sql: 'NOT EXISTS (SELECT 1 FROM user_identities WHERE user_id = ?)',
    binds: [id],
  });
  const outcome = await commitUserChange(
    deps,
    actor,
    {
      action: 'user.delete',
      targetType: 'user',
      targetId: id,
      summary: `Deleted ${existing.email}, who never signed in`,
      diff: { before: { email: existing.email, role: existing.role, status: existing.status } },
    },
    guard,
    deleteUserStatements(db, { id }, guard),
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return changedMeanwhile(existing);
  return { ok: true, changed: true, auditId: outcome.event.id, user: existing };
}

/**
 * Clears a recorded refused sign-in without acting on it. `expectedRefusedAt` is the attempt the
 * owner saw: a newer attempt is not dismissed unseen (conflict).
 */
export async function dismissRefusedAttempt(
  deps: Deps,
  actor: Actor,
  id: string,
  expectedRefusedAt: unknown,
): Promise<UserChangeResult> {
  if (typeof expectedRefusedAt !== 'number' || !Number.isSafeInteger(expectedRefusedAt)) {
    return opFailure('invalid', ['The sign-in attempt to dismiss is missing. Use the page form.']);
  }
  const existing = await getUser(deps.env.DB, id);
  if (!existing) return opFailure('not_found', ['User not found.']);
  const refused = (): OpFailure =>
    opFailure('conflict', [
      existing.last_refused_at === null
        ? `There is no refused sign-in of ${existing.email} to dismiss.`
        : `${existing.email} tried to sign in again since. The page now shows the newest attempt.`,
    ]);
  if (existing.last_refused_at !== expectedRefusedAt) return refused();
  const guard: SqlGuard = {
    sql: 'EXISTS (SELECT 1 FROM users WHERE id = ? AND last_refused_at = ?)',
    binds: [id, expectedRefusedAt],
  };
  const outcome = await commitUserChange(
    deps,
    actor,
    {
      action: 'user.dismiss_attempt',
      targetType: 'user',
      targetId: id,
      summary: `Dismissed the refused sign-in of ${existing.email}`,
      diff: { before: { last_refused_at: existing.last_refused_at } },
    },
    guard,
    dismissRefusedStatements(deps.env.DB, { id, expectedRefusedAt }),
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) return refused();
  return {
    ok: true,
    changed: true,
    auditId: outcome.event.id,
    user: { ...existing, last_refused_at: null, last_refused_subject: null },
  };
}

/**
 * Approves a pending user with `role` (required): role and status in one guarded UPDATE and one
 * `user.approve` row. Rejecting suspends them (`user.reject`), so they do not come back as pending.
 * A user who is no longer pending is refused, so a stale page cannot reactivate someone.
 */
export async function decidePending(
  deps: Deps,
  actor: Actor,
  id: string,
  decision: 'approve' | 'reject',
  role?: unknown,
): Promise<UserChangeResult> {
  if (decision === 'approve' && !isRole(role)) return opFailure('invalid', [ROLE_MESSAGE]);
  const existing = await getUser(deps.env.DB, id);
  if (!existing) return opFailure('not_found', ['User not found.']);
  if (existing.status !== 'pending') return alreadyDecided(existing, deps.now());
  if (decision === 'reject') {
    return changeUser(deps, actor, existing, { status: 'suspended' }, 'user.reject');
  }
  const approvedRole = role as Role;
  const now = deps.now();
  const guard = allOf(
    { sql: "EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'pending')", binds: [id] },
    userHasIdentityGuard(id),
  );
  const outcome = await commitUserChange(
    deps,
    actor,
    {
      action: 'user.approve',
      targetType: 'user',
      targetId: id,
      summary: `Approved ${existing.email} as ${ROLE_INFO[approvedRole].label}`,
      diff: {
        before: { role: existing.role, status: 'pending' },
        after: { role: approvedRole, status: 'active' },
      },
    },
    guard,
    approveStatements(deps.env.DB, { id, role: approvedRole, now }),
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) {
    const current = await getUser(deps.env.DB, id);
    return current ? alreadyDecided(current, now) : opFailure('not_found', ['User not found.']);
  }
  return {
    ok: true,
    changed: true,
    auditId: outcome.event.id,
    user: {
      ...existing,
      role: approvedRole,
      status: 'active',
      updated_at: nextVersion(existing.updated_at, now),
    },
  };
}

function alreadyDecided(user: User, now: number): OpFailure {
  return opFailure('conflict', [
    `${user.email} was already approved or rejected (now ${userStatusText(user, now)}).`,
  ]);
}

// ---------------------------------------------------------------------------------------------
// Join policy: what a first sign-in that matches no user gets (I-LINK-1: any role except owner).

export type JoinPolicy =
  | 'pending'
  | 'active:viewer'
  | 'active:token_manager'
  | 'active:access_manager'
  | 'active:admin'
  | 'closed';

export const JOIN_POLICIES: readonly JoinPolicy[] = [
  'pending',
  'active:viewer',
  'active:token_manager',
  'active:access_manager',
  'active:admin',
  'closed',
];

export const JOIN_POLICY_LABELS: Readonly<Record<JoinPolicy, string>> = {
  pending: 'Ask an owner first',
  'active:viewer': 'Let them in as Viewer',
  'active:token_manager': 'Let them in as Credential manager',
  'active:access_manager': 'Let them in as Access manager',
  'active:admin': 'Let them in as Admin',
  closed: 'Only invited people',
};

/**
 * The join defaults of a policy value, or null for anything else (a repeated field included).
 * `pending` and `closed` store the role viewer: the role only matters when people are let in.
 */
export function parseJoinPolicy(raw: unknown): JoinDefaults | null {
  if (typeof raw !== 'string' || !(JOIN_POLICIES as readonly string[]).includes(raw)) return null;
  if (raw === 'pending') return { role: 'viewer', status: 'pending' };
  if (raw === 'closed') return { role: 'viewer', status: 'suspended' };
  return { role: raw.slice('active:'.length) as JoinRole, status: 'active' };
}

/** The policy value of stored join defaults. */
export function joinPolicyOf(defaults: JoinDefaults): JoinPolicy {
  if (defaults.status === 'pending') return 'pending';
  if (defaults.status === 'suspended') return 'closed';
  return `active:${defaults.role}`;
}

/**
 * Changes the role and status given to people on their first sign-in (not the first owner). The
 * role is forced to viewer unless people are let in.
 */
export async function updateJoinDefaults(
  deps: Deps,
  actor: Actor,
  input: { role: unknown; status: unknown },
): Promise<
  { ok: true; defaults: JoinDefaults; changed: boolean; auditId: string | null } | OpFailure
> {
  const valid =
    (JOIN_ROLES as readonly unknown[]).includes(input.role) &&
    (JOIN_STATUSES as readonly unknown[]).includes(input.status);
  if (!valid)
    return opFailure('invalid', [fieldError('join_policy', 'Choose one of the listed options.')]);
  const status = input.status as JoinDefaults['status'];
  const after: JoinDefaults = {
    role: status === 'active' ? (input.role as JoinRole) : 'viewer',
    status,
  };
  const db = deps.env.DB;
  const before = await getJoinDefaults(db);
  if (before.role === after.role && before.status === after.status) {
    return { ok: true, defaults: before, changed: false, auditId: null };
  }
  const now = deps.now();
  const outcome = await commitUserChange(
    deps,
    actor,
    {
      action: 'user.join_defaults',
      targetType: 'settings',
      targetId: null,
      summary: `New people: ${JOIN_POLICY_LABELS[joinPolicyOf(after)]}`,
      diff: { before, after },
    },
    null,
    [
      putSettingStatement(db, 'join_role', after.role, now, actor.id),
      putSettingStatement(db, 'join_status', after.status, now, actor.id),
    ],
  );
  if (!outcome.ok) return outcome;
  return { ok: true, defaults: after, changed: true, auditId: outcome.event.id };
}

// ---------------------------------------------------------------------------------------------

function isRole(role: unknown): role is Role {
  return ROLES.includes(role as Role);
}

function roleErrors(role: unknown): string[] {
  return isRole(role) ? [] : [ROLE_MESSAGE];
}

/** A conflict when the page showed another version of the user than the one just read. */
function staleUser(user: User, expected: unknown): OpFailure | null {
  if (expected === undefined) return null;
  if (expected === user.updated_at) return null;
  return opFailure('conflict', [
    `${user.email} was changed by someone else at ${formatTime(user.updated_at)}. The page now shows the current state.`,
  ]);
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
    `${user.email} was changed or removed by someone else meanwhile. The page now shows the current state.`,
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
    // A concurrent invite of the same email won the race (the UNIQUE constraint is the backstop).
    if (/UNIQUE constraint failed: users\.email/.test(text)) {
      return opFailure('conflict', [
        fieldError(
          'email',
          'Someone invited this email address meanwhile. The page now shows that person.',
        ),
      ]);
    }
    throw error;
  }
}
