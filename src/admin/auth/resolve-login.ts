// Maps a verified login (provider, stable subject, authoritative emails) to a user. Only invited
// users are linked by email (I-LINK-1); the first owner is bootstrapped at most once (I-BOOT-1).
import { parseConfig } from '../../config';
import { buildAuditEvent, emitAuditLine } from '../../db/audit';
import type { Actor, User } from '../../db/types';
import {
  bootstrapOwnerStatements,
  findRedeemableInvite,
  findUserByIdentity,
  getUser,
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
      via: 'identity' | 'invite' | 'bootstrap';
    }
  | { ok: false; reason: 'not_invited' | 'disabled' };

const NAME_MAX = 200;

/**
 * 1) Known identity: its user, if active.
 * 2) Else an invited, unexpired user matching an authoritative email is linked and activated.
 * 3) Else, if an email is in BOOTSTRAP_OWNER_EMAILS and bootstrap has never run, the first owner
 * is created. 4) Else `not_invited`.
 */
export async function resolveLogin(
  deps: Deps,
  input: LoginIdentity & { meta?: RequestMeta },
): Promise<LoginResolution> {
  const db = deps.env.DB;
  const known = await findUserByIdentity(db, input.loginProvider, input.subject);
  if (known) {
    return known.status === 'active'
      ? { ok: true, user: known, via: 'identity' }
      : { ok: false, reason: 'disabled' };
  }

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

  const bootstrapEmails = parseConfig(deps.env).bootstrapOwnerEmails;
  const email = input.emails.find((candidate) => bootstrapEmails.includes(candidate));
  if (email !== undefined) {
    const now = deps.now();
    const userId = newId('usr', now, deps.random);
    const audit = buildAuditEvent(deps, actorFor(userId, email, meta), {
      action: 'user.bootstrap',
      targetType: 'user',
      targetId: userId,
      summary: 'First owner created from BOOTSTRAP_OWNER_EMAILS',
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

  return { ok: false, reason: 'not_invited' };
}

function actorFor(userId: string, email: string, meta: RequestMeta): Actor {
  return { type: 'user', id: userId, email, ip: meta.ip, userAgent: meta.userAgent };
}
