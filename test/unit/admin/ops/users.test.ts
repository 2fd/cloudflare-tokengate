import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  inviteUser,
  LAST_OWNER_MESSAGE,
  normalizeEmail,
  resendInvite,
  resetLogin,
  revokeSessions,
  updateUser,
} from '../../../../src/admin/ops/users';
import { auditFromRow } from '../../../../src/db/audit';
import type { Actor, User } from '../../../../src/db/types';
import { getUser, INVITE_TTL_MS, listIdentities } from '../../../../src/db/users';
import { createUser, loginAs, resetControlPlane } from '../../../helpers/admin-auth';
import { opsDeps } from './helpers';

const T0 = Date.UTC(2026, 9, 13, 12);
const deps = () => opsDeps({ now: () => T0 });

function actorFor(user: User): Actor {
  return { type: 'user', id: user.id, email: user.email, ip: null, userAgent: null };
}

/** Audit rows written by the ops under test (logins in fixtures write `user.login`). */
async function audits() {
  const { results } = await env.DB.prepare(
    "SELECT * FROM audit_log WHERE action <> 'user.login' ORDER BY rowid",
  ).all<Record<string, unknown>>();
  return results.map(auditFromRow);
}

/** Deps whose next db.batch first runs `sql` (bound to `id`), as a concurrent writer would. */
function racingDeps(sql: string, id: string) {
  const base = deps();
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          await target.prepare(sql).bind(id).run();
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...base, env: { ...base.env, DB: db } };
}

async function liveSessions(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT count(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

let owner: User;
beforeEach(async () => {
  await resetControlPlane();
  owner = await createUser({ email: 'owner@example.com', role: 'owner' }, T0);
});

describe('normalizeEmail', () => {
  it.each([
    [' Alex@Example.COM ', 'alex@example.com'],
    ['a.b+c@sub.example.co', 'a.b+c@sub.example.co'],
  ])('accepts %j', (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
  });

  it.each([
    '',
    'alex',
    'alex@localhost',
    'a b@example.com',
    'a@b@example.com',
    'a@example.com,b@example.com',
    'a\u0001@example.com',
    `${'a'.repeat(250)}@example.com`,
    42,
  ])('rejects %j', (raw) => {
    expect(normalizeEmail(raw)).toBeNull();
  });
});

describe('inviteUser', () => {
  it('creates an invited user with a 7-day expiry and one audit row', async () => {
    const result = await inviteUser(deps(), actorFor(owner), {
      email: ' New@Example.com',
      role: 'admin',
    });
    if (!result.ok) throw new Error(result.errors.join());
    expect(result.user).toMatchObject({
      email: 'new@example.com',
      role: 'admin',
      status: 'invited',
      invite_expires_at: T0 + INVITE_TTL_MS,
    });
    expect(await getUser(env.DB, result.user.id)).toEqual(result.user);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'user.invite',
      target_type: 'user',
      target_id: result.user.id,
      actor_id: owner.id,
    });
  });

  it('rejects invalid input without writing', async () => {
    const result = await inviteUser(deps(), actorFor(owner), {
      email: 'not-an-email',
      role: 'root' as never,
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (!result.ok) expect(result.errors).toHaveLength(2);
    expect(await audits()).toHaveLength(0);
  });

  it('maps a duplicate email (any case) to a friendly error and writes no audit row', async () => {
    const result = await inviteUser(deps(), actorFor(owner), {
      email: 'OWNER@example.com',
      role: 'viewer',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'invalid',
      errors: [expect.stringContaining('A user with this email address already exists;')],
      warnings: [],
    });
    expect(await audits()).toHaveLength(0);
  });
});

describe('updateUser', () => {
  it('changes the role, revokes their sessions and audits before/after', async () => {
    const admin = await createUser({ email: 'admin@example.com', role: 'admin' }, T0);
    await loginAs({ deps: deps() }, admin);
    expect(await liveSessions(admin.id)).toBe(1);

    const result = await updateUser(deps(), actorFor(owner), admin.id, { role: 'viewer' });
    expect(result).toMatchObject({ ok: true, user: { role: 'viewer', status: 'active' } });
    expect((await getUser(env.DB, admin.id))?.role).toBe('viewer');
    expect(await liveSessions(admin.id)).toBe(0);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.diff).toEqual({
      before: { role: 'admin', status: 'active' },
      after: { role: 'viewer', status: 'active' },
    });
  });

  it('disables a user and ends their sessions', async () => {
    const admin = await createUser({ email: 'admin@example.com', role: 'admin' }, T0);
    await loginAs({ deps: deps() }, admin);
    const result = await updateUser(deps(), actorFor(owner), admin.id, { status: 'disabled' });
    expect(result).toMatchObject({ ok: true, user: { status: 'disabled' } });
    expect(await liveSessions(admin.id)).toBe(0);
  });

  it('refuses when the user changed between read and write, writing nothing', async () => {
    const admin = await createUser({ email: 'admin@example.com', role: 'admin' }, T0);
    await loginAs({ deps: deps() }, admin);
    const racing = racingDeps(
      "UPDATE users SET status = 'disabled', updated_at = updated_at + 1 WHERE id = ?",
      admin.id,
    );
    const result = await updateUser(racing, actorFor(owner), admin.id, { role: 'viewer' });
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await getUser(env.DB, admin.id)).toMatchObject({ role: 'admin', status: 'disabled' });
    expect(await liveSessions(admin.id)).toBe(1);
    expect(await audits()).toEqual([]);
  });

  it('refuses changes to the actor’s own account', async () => {
    await createUser({ email: 'o2@example.com', role: 'owner' }, T0);
    const result = await updateUser(deps(), actorFor(owner), owner.id, { role: 'viewer' });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect((await getUser(env.DB, owner.id))?.role).toBe('owner');
    expect(await audits()).toHaveLength(0);
  });

  it('refuses invited → active (only a login activates)', async () => {
    const invited = await createUser({ email: 'i@example.com', status: 'invited' }, T0);
    const result = await updateUser(deps(), actorFor(owner), invited.id, { status: 'active' });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect((await getUser(env.DB, invited.id))?.status).toBe('invited');
  });

  it('allows cancelling an invitation (invited → disabled)', async () => {
    const invited = await createUser({ email: 'i@example.com', status: 'invited' }, T0);
    const result = await updateUser(deps(), actorFor(owner), invited.id, { status: 'disabled' });
    expect(result).toMatchObject({ ok: true, user: { status: 'disabled' } });
  });

  it('refuses invited → disabled → active: a user without a login identity cannot be active', async () => {
    const invited = await createUser({ email: 'i@example.com', status: 'invited' }, T0);
    expect(
      await updateUser(deps(), actorFor(owner), invited.id, { status: 'disabled' }),
    ).toMatchObject({ ok: true });
    const result = await updateUser(deps(), actorFor(owner), invited.id, { status: 'active' });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (!result.ok) expect(result.errors.join()).toMatch(/Invite again/);
    expect((await getUser(env.DB, invited.id))?.status).toBe('disabled');
    expect((await audits()).map((row) => row.action)).toEqual(['user.update']);
  });

  it('re-enables a disabled user who has a login identity', async () => {
    const user = await createUser(
      {
        email: 'u@example.com',
        status: 'disabled',
        identity: { loginProvider: 'github', subject: '77' },
      },
      T0,
    );
    const result = await updateUser(deps(), actorFor(owner), user.id, { status: 'active' });
    expect(result).toMatchObject({ ok: true, user: { status: 'active' } });
  });

  it('rejects invalid role or status values', async () => {
    const admin = await createUser({ email: 'admin@example.com', role: 'admin' }, T0);
    for (const input of [{ role: 'root' }, { status: 'invited' }, {}]) {
      const result = await updateUser(deps(), actorFor(owner), admin.id, input as never);
      expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    }
    expect(await audits()).toHaveLength(0);
  });

  it('returns not_found for unknown users', async () => {
    const result = await updateUser(deps(), actorFor(owner), 'usr_missing', { role: 'viewer' });
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('writes nothing when the values are unchanged', async () => {
    const admin = await createUser({ email: 'admin@example.com', role: 'admin' }, T0);
    const result = await updateUser(deps(), actorFor(owner), admin.id, {
      role: 'admin',
      status: 'active',
    });
    expect(result).toMatchObject({ ok: true, changed: false, user: { role: 'admin' } });
    expect(await audits()).toHaveLength(0);
  });
});

describe('I-OWNER-1: the last active owner cannot be removed', () => {
  it('maps the last_owner trigger to a friendly error and rolls back the audit row', async () => {
    // The actor is a disabled owner, so `owner` is the only active one.
    const other = await createUser({ email: 'o2@example.com', role: 'owner', status: 'disabled' });
    for (const input of [{ role: 'admin' as const }, { status: 'disabled' as const }]) {
      const result = await updateUser(deps(), actorFor(other), owner.id, input);
      expect(result).toEqual({
        ok: false,
        reason: 'invalid',
        errors: [LAST_OWNER_MESSAGE],
        warnings: [],
      });
    }
    const reset = await resetLogin(deps(), actorFor(other), owner.id);
    expect(reset).toMatchObject({ ok: false, errors: [LAST_OWNER_MESSAGE] });
    expect(await getUser(env.DB, owner.id)).toMatchObject({ role: 'owner', status: 'active' });
    expect(await audits()).toHaveLength(0);
  });

  it('allows demoting an owner while another active owner remains', async () => {
    const other = await createUser({ email: 'o2@example.com', role: 'owner' }, T0);
    const result = await updateUser(deps(), actorFor(other), owner.id, { role: 'admin' });
    expect(result).toMatchObject({ ok: true, user: { role: 'admin' } });
  });
});

describe('resetLogin', () => {
  it('unlinks identities, re-invites with a fresh expiry and ends sessions', async () => {
    const admin = await createUser(
      {
        email: 'admin@example.com',
        role: 'admin',
        identity: { loginProvider: 'github', subject: '123' },
      },
      T0,
    );
    await loginAs({ deps: deps() }, admin);
    const result = await resetLogin(deps(), actorFor(owner), admin.id);
    expect(result).toMatchObject({
      ok: true,
      user: { status: 'invited', invite_expires_at: T0 + INVITE_TTL_MS },
    });
    expect(await listIdentities(env.DB, admin.id)).toEqual([]);
    expect(await liveSessions(admin.id)).toBe(0);
    expect((await audits()).map((row) => row.action)).toEqual(['user.reset_login']);
  });

  it('refuses when the user changed between read and write, writing nothing', async () => {
    const admin = await createUser(
      {
        email: 'admin@example.com',
        role: 'admin',
        identity: { loginProvider: 'github', subject: '123' },
      },
      T0,
    );
    await loginAs({ deps: deps() }, admin);
    const racing = racingDeps(
      "UPDATE users SET role = 'viewer', updated_at = updated_at + 1 WHERE id = ?",
      admin.id,
    );
    const result = await resetLogin(racing, actorFor(owner), admin.id);
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await getUser(env.DB, admin.id)).toMatchObject({ role: 'viewer', status: 'active' });
    expect(await listIdentities(env.DB, admin.id)).toHaveLength(1);
    expect(await liveSessions(admin.id)).toBe(1);
    expect(await audits()).toEqual([]);
  });

  it('refuses resetting the actor’s own login', async () => {
    const result = await resetLogin(deps(), actorFor(owner), owner.id);
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('revokeSessions', () => {
  it('ends every live session of the user and reports the count', async () => {
    const admin = await createUser({ email: 'admin@example.com', role: 'admin' }, T0);
    await loginAs({ deps: deps() }, admin);
    await loginAs({ deps: deps() }, admin);
    const result = await revokeSessions(deps(), actorFor(owner), admin.id);
    expect(result).toEqual({ ok: true, revoked: 2 });
    expect(await liveSessions(admin.id)).toBe(0);
    expect((await audits()).map((row) => row.action)).toEqual(['user.revoke_sessions']);
  });
});

describe('resendInvite', () => {
  it('renews the expiry of a pending (even expired) invitation', async () => {
    const invited = await createUser(
      { email: 'i@example.com', status: 'invited', inviteExpiresAt: T0 - 1 },
      T0 - INVITE_TTL_MS,
    );
    const result = await resendInvite(deps(), actorFor(owner), invited.id);
    expect(result).toMatchObject({ ok: true, user: { invite_expires_at: T0 + INVITE_TTL_MS } });
    expect((await getUser(env.DB, invited.id))?.invite_expires_at).toBe(T0 + INVITE_TTL_MS);
    expect((await audits()).map((row) => row.action)).toEqual(['user.resend_invite']);
  });

  it('refuses users who are not invited', async () => {
    const admin = await createUser({ email: 'admin@example.com', role: 'admin' }, T0);
    const result = await resendInvite(deps(), actorFor(owner), admin.id);
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await audits()).toHaveLength(0);
  });
});
