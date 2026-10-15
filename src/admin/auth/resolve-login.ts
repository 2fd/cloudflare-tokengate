// Maps a verified login (provider, stable subject, authoritative emails) to a user. Only invited
// users are linked by email (I-LINK-1); the first owner is bootstrapped at most once (I-BOOT-1),
// with the request hostname as the admin host allowlist (I-DEPLOY-1);
// anyone else that Access lets through joins with the owner-configured role and status.
import { isAdminHostEntry } from '../../config';
import { buildAuditEvent, emitAuditLine } from '../../db/audit';
import { getJoinDefaults } from '../../db/settings';
import type { Actor, User } from '../../db/types';
import {
  bootstrapOwnerStatements,
  findRedeemableInvite,
  findUserByIdentity,
  getUser,
  getUserByEmail,
  joinStatements,
  linkInvitedUserStatements,
} from '../../db/users';
import type { Deps } from '../../deps';
import { newId } from '../../lib/ids';
import type { RequestMeta } from './identity';

export type LoginProviderId = 'access' | 'dev';

export const LOGIN_PROVIDER_IDS: readonly LoginProviderId[] = ['access', 'dev'];

export function isLoginProviderId(value: string): value is LoginProviderId {
  return (LOGIN_PROVIDER_IDS as readonly string[]).includes(value);
}

/** Result of a successful sign-in with a login provider. */
export interface LoginIdentity {
  loginProvider: LoginProviderId;
  /** Stable, provider-scoped subject (never an email). */
  subject: string;
  /** Output of `authoritativeEmails` only. */
  emails: string[];
  name: string | null;
}

export type LoginResolution =
  | {
      ok: true;
      user: User;
      via: 'identity' | 'invite' | 'bootstrap' | 'join';
    }
  | {
      ok: false;
      reason: LoginRefusal;
      /** The known user the sign-in was refused for, so the refusal can be recorded on it. */
      userId?: string;
      /** That user's last recorded refusal (the caller skips a write it would throttle anyway). */
      lastRefusedAt?: number | null;
    };

/** Why a verified sign-in was refused. `email_taken_expired`: the email's invitation expired. */
export type LoginRefusal = 'email_taken' | 'email_taken_expired' | 'pending' | 'suspended';

const NAME_MAX = 200;

/**
 * 1) Known identity: its user, if active.
 * 2) Else an invited, unexpired user matching an authoritative email is linked and activated.
 * 3) Else, while no owner exists and bootstrap has never run, this person becomes the first owner,
 * and `host` (the request hostname) becomes the admin host allowlist unless one is already set.
 * 4) Else a user is created for the first authoritative email with the join policy (any role but
 * owner; status active, pending or suspended; set by owners in Users › Sign-in).
 * 5) Else (that email already belongs to another user) `email_taken`, or `email_taken_expired`
 * when that user is an expired invitation; the refusal names the user so it can be recorded.
 */
export async function resolveLogin(
  deps: Deps,
  input: LoginIdentity & { meta?: RequestMeta; host: string },
): Promise<LoginResolution> {
  const db = deps.env.DB;
  const known = await findUserByIdentity(db, input.loginProvider, input.subject);
  if (known) return byStatus(known, 'identity');

  const name = input.name?.trim().slice(0, NAME_MAX) || null;
  const meta = input.meta ?? { ip: null, userAgent: null };

  for (const email of input.emails) {
    const now = deps.now();
    const invited = await findRedeemableInvite(db, email, now);
    if (!invited) continue;
    const audit = buildAuditEvent(deps, actorFor(invited.id, email, meta), {
      action: 'user.link',
      targetType: 'user',
      targetId: invited.id,
      summary: `Linked ${input.loginProvider} identity to invited user`,
      diff: { login_provider: input.loginProvider, subject: input.subject, email },
    });
    const results = await db.batch(
      linkInvitedUserStatements(db, {
        userId: invited.id,
        email,
        loginProvider: input.loginProvider,
        subject: input.subject,
        name,
        now,
        audit,
      }),
    );
    if (results.at(-1)?.meta.changes === 1) {
      emitAuditLine(audit);
      const user = await getUser(db, invited.id);
      if (user?.status === 'active') return { ok: true, user, via: 'invite' };
    }
  }

  const email = input.emails[0];
  if (email !== undefined) {
    const host = isAdminHostEntry(input.host) ? input.host : null;
    const now = deps.now();
    const userId = newId('usr', now, deps.random);
    const audit = buildAuditEvent(deps, actorFor(userId, email, meta), {
      action: 'user.bootstrap',
      targetType: 'user',
      targetId: userId,
      summary: 'First owner created on the first sign-in',
      diff: {
        login_provider: input.loginProvider,
        subject: input.subject,
        email,
        role: 'owner',
        host,
      },
    });
    const results = await db.batch(
      bootstrapOwnerStatements(db, {
        userId,
        email,
        loginProvider: input.loginProvider,
        subject: input.subject,
        name,
        host,
        now,
        audit,
      }),
    );
    if (results[0]?.meta.changes === 1) {
      emitAuditLine(audit);
      const user = await getUser(db, userId);
      if (user) return { ok: true, user, via: 'bootstrap' };
    }
  }

  const joinEmail = input.emails[0];
  if (joinEmail !== undefined) {
    const defaults = await getJoinDefaults(db);
    const now = deps.now();
    const userId = newId('usr', now, deps.random);
    const audit = buildAuditEvent(deps, actorFor(userId, joinEmail, meta), {
      action: 'user.join',
      targetType: 'user',
      targetId: userId,
      summary: `Joined as ${defaults.status} ${defaults.role} on the first sign-in`,
      diff: {
        login_provider: input.loginProvider,
        subject: input.subject,
        email: joinEmail,
        role: defaults.role,
        status: defaults.status,
      },
    });
    const results = await db.batch(
      joinStatements(db, {
        userId,
        role: defaults.role,
        status: defaults.status,
        email: joinEmail,
        loginProvider: input.loginProvider,
        subject: input.subject,
        name,
        now,
        audit,
      }),
    );
    if (results[0]?.meta.changes === 1) {
      emitAuditLine(audit);
      const user = await getUser(db, userId);
      if (user) return byStatus(user, 'join');
    }
    // A concurrent first request of the same identity may have created the user meanwhile.
    const raced = await findUserByIdentity(db, input.loginProvider, input.subject);
    if (raced) return byStatus(raced, 'identity');
  }

  return emailTaken(db, input.emails[0], deps.now());
}

/**
 * The email already belongs to another user (I-LINK-1: never linked by email outside a redeemable
 * invitation). Names that user, and tells an expired invitation apart so the message can say so.
 */
async function emailTaken(
  db: D1Database,
  email: string | undefined,
  now: number,
): Promise<LoginResolution> {
  const holder = email === undefined ? null : await getUserByEmail(db, email);
  if (!holder) return { ok: false, reason: 'email_taken' };
  const expired =
    holder.status === 'invited' &&
    (holder.invite_expires_at === null || holder.invite_expires_at <= now);
  return {
    ok: false,
    reason: expired ? 'email_taken_expired' : 'email_taken',
    userId: holder.id,
    lastRefusedAt: holder.last_refused_at,
  };
}

/** Only active users get in; a pending user waits for an owner, anyone else is suspended. */
function byStatus(user: User, via: 'identity' | 'join'): LoginResolution {
  if (user.status === 'active') return { ok: true, user, via };
  return {
    ok: false,
    reason: user.status === 'pending' ? 'pending' : 'suspended',
    userId: user.id,
    lastRefusedAt: user.last_refused_at,
  };
}

function actorFor(userId: string, email: string, meta: RequestMeta): Actor {
  return { type: 'user', id: userId, email, ip: meta.ip, userAgent: meta.userAgent };
}
