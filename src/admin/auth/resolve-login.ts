// Maps a verified login (provider, stable subject, authoritative emails) to a user. Only invited
// users are linked by email (I-LINK-1); the first owner is bootstrapped at most once (I-BOOT-1);
// anyone else that Access lets through joins with the owner-configured role and status.
import { buildAuditEvent, emitAuditLine } from '../../db/audit';
import { getJoinDefaults } from '../../db/settings';
import type { Actor, User } from '../../db/types';
import {
  bootstrapOwnerStatements,
  findRedeemableInvite,
  findUserByIdentity,
  getUser,
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
  | { ok: false; reason: 'email_taken' | 'pending' | 'suspended' };

const NAME_MAX = 200;

/**
 * 1) Known identity: its user, if active.
 * 2) Else an invited, unexpired user matching an authoritative email is linked and activated.
 * 3) Else, while no owner exists and bootstrap has never run, this person becomes the first owner.
 * 4) Else a user is created for the first authoritative email with the join defaults (role
 * viewer or admin; status active, pending or suspended; set by owners on the users page).
 * 5) Else (that email already belongs to another user, e.g. an expired invitation) `email_taken`.
 */
export async function resolveLogin(
  deps: Deps,
  input: LoginIdentity & { meta?: RequestMeta },
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
    const now = deps.now();
    const userId = newId('usr', now, deps.random);
    const audit = buildAuditEvent(deps, actorFor(userId, email, meta), {
      action: 'user.bootstrap',
      targetType: 'user',
      targetId: userId,
      summary: 'First owner created on the first sign-in',
      diff: { login_provider: input.loginProvider, subject: input.subject, email, role: 'owner' },
    });
    const results = await db.batch(
      bootstrapOwnerStatements(db, {
        userId,
        email,
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

  return { ok: false, reason: 'email_taken' };
}

/** Only active users get in; a pending user waits for an owner, anyone else is suspended. */
function byStatus(user: User, via: 'identity' | 'join'): LoginResolution {
  if (user.status === 'active') return { ok: true, user, via };
  return { ok: false, reason: user.status === 'pending' ? 'pending' : 'suspended' };
}

function actorFor(userId: string, email: string, meta: RequestMeta): Actor {
  return { type: 'user', id: userId, email, ip: meta.ip, userAgent: meta.userAgent };
}
