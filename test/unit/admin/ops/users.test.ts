import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  decidePending,
  deleteUser,
  dismissRefusedAttempt,
  inviteUser,
  JOIN_POLICIES,
  joinPolicyOf,
  LAST_OWNER_MESSAGE,
  normalizeEmail,
  parseJoinPolicy,
  ROLE_MESSAGE,
  ROLES,
  resendInvite,
  resetLogin,
  updateJoinDefaults,
  updateUser,
} from '../../../../src/admin/ops/users';
import { auditFromRow } from '../../../../src/db/audit';
import type { Actor, User } from '../../../../src/db/types';
import { getUser, INVITE_TTL_MS, listIdentities } from '../../../../src/db/users';
import { createUser, resetControlPlane } from '../../../helpers/admin-auth';
import { opsDeps } from './helpers';

const T0 = Date.UTC(2026, 9, 13, 12);
const deps = () => opsDeps({ now: () => T0 });

function actorFor(user: User): Actor {
  return { type: 'user', id: user.id, email: user.email, ip: null, userAgent: null };
}

/** Audit rows written by the ops under test. */
async function audits() {
  const { results } = await env.DB.prepare('SELECT * FROM audit_log ORDER BY rowid').all<
    Record<string, unknown>
  >();
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

  it('refuses the email (any case) of a user who signed in, naming that user', async () => {
    const result = await inviteUser(deps(), actorFor(owner), {
      email: 'OWNER@example.com',
      role: 'viewer',
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'invalid',
      errors: ['owner@example.com already signed in with an account (Active).'],
      fieldErrors: [{ field: 'email' }],
      existingUserId: owner.id,
    });
    expect(await audits()).toHaveLength(0);
  });
});

describe('updateUser', () => {
  it('changes the role and audits before/after', async () => {
    const admin = await createUser({ email: 'admin@example.com', role: 'admin' }, T0);

    const result = await updateUser(deps(), actorFor(owner), admin.id, { role: 'viewer' });
    expect(result).toMatchObject({ ok: true, user: { role: 'viewer', status: 'active' } });
    expect((await getUser(env.DB, admin.id))?.role).toBe('viewer');
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.diff).toEqual({
      before: { role: 'admin', status: 'active' },
      after: { role: 'viewer', status: 'active' },
    });
  });

  it('disables a user', async () => {
    const admin = await createUser({ email: 'admin@example.com', role: 'admin' }, T0);
    const result = await updateUser(deps(), actorFor(owner), admin.id, { status: 'suspended' });
    expect(result).toMatchObject({ ok: true, user: { status: 'suspended' } });
    expect((await getUser(env.DB, admin.id))?.status).toBe('suspended');
  });

  it('refuses when the user changed between read and write, writing nothing', async () => {
    const admin = await createUser({ email: 'admin@example.com', role: 'admin' }, T0);
    const racing = racingDeps(
      "UPDATE users SET status = 'suspended', updated_at = updated_at + 1 WHERE id = ?",
      admin.id,
    );
    const result = await updateUser(racing, actorFor(owner), admin.id, { role: 'viewer' });
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await getUser(env.DB, admin.id)).toMatchObject({ role: 'admin', status: 'suspended' });
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

  it('allows cancelling an invitation (invited → suspended)', async () => {
    const invited = await createUser({ email: 'i@example.com', status: 'invited' }, T0);
    const result = await updateUser(deps(), actorFor(owner), invited.id, { status: 'suspended' });
    expect(result).toMatchObject({ ok: true, user: { status: 'suspended' } });
  });

  it('refuses invited → suspended → active: a user without a login identity cannot be active', async () => {
    const invited = await createUser({ email: 'i@example.com', status: 'invited' }, T0);
    expect(
      await updateUser(deps(), actorFor(owner), invited.id, { status: 'suspended' }),
    ).toMatchObject({ ok: true });
    const result = await updateUser(deps(), actorFor(owner), invited.id, { status: 'active' });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    if (!result.ok) expect(result.errors.join()).toMatch(/Invite again/);
    expect((await getUser(env.DB, invited.id))?.status).toBe('suspended');
    expect((await audits()).map((row) => row.action)).toEqual(['user.update']);
  });

  it('re-activates a suspended user who has a login identity', async () => {
    const user = await createUser(
      {
        email: 'u@example.com',
        status: 'suspended',
        identity: { loginProvider: 'access', subject: 'team|77' },
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
    // The actor is a suspended owner, so `owner` is the only active one.
    const other = await createUser({ email: 'o2@example.com', role: 'owner', status: 'suspended' });
    for (const input of [{ role: 'admin' as const }, { status: 'suspended' as const }]) {
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
  it('unlinks identities and re-invites with a fresh expiry', async () => {
    const admin = await createUser(
      {
        email: 'admin@example.com',
        role: 'admin',
        identity: { loginProvider: 'access', subject: 'team|123' },
      },
      T0,
    );
    const result = await resetLogin(deps(), actorFor(owner), admin.id);
    expect(result).toMatchObject({
      ok: true,
      user: { status: 'invited', invite_expires_at: T0 + INVITE_TTL_MS },
    });
    expect(await listIdentities(env.DB, admin.id)).toEqual([]);
    expect((await audits()).map((row) => row.action)).toEqual(['user.reset_login']);
  });

  it('refuses when the user changed between read and write, writing nothing', async () => {
    const admin = await createUser(
      {
        email: 'admin@example.com',
        role: 'admin',
        identity: { loginProvider: 'access', subject: 'team|123' },
      },
      T0,
    );
    const racing = racingDeps(
      "UPDATE users SET role = 'viewer', updated_at = updated_at + 1 WHERE id = ?",
      admin.id,
    );
    const result = await resetLogin(racing, actorFor(owner), admin.id);
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await getUser(env.DB, admin.id)).toMatchObject({ role: 'viewer', status: 'active' });
    expect(await listIdentities(env.DB, admin.id)).toHaveLength(1);
    expect(await audits()).toEqual([]);
  });

  it('refuses resetting the actor’s own login', async () => {
    const result = await resetLogin(deps(), actorFor(owner), owner.id);
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
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

describe('roles of the role split (ADR 0018)', () => {
  it('ROLES has the five roles', () => {
    expect([...ROLES].sort()).toEqual(
      ['access_manager', 'admin', 'owner', 'token_manager', 'viewer'].sort(),
    );
  });

  it.each(['token_manager', 'access_manager'] as const)('invites a %s', async (role) => {
    const result = await inviteUser(deps(), actorFor(owner), { email: 'r@example.com', role });
    expect(result).toMatchObject({ ok: true, user: { role } });
  });

  it('new users can join with any role except owner', async () => {
    for (const role of ['token_manager', 'access_manager', 'admin', 'viewer']) {
      const result = await updateJoinDefaults(deps(), actorFor(owner), { role, status: 'active' });
      expect(result, role).toMatchObject({ ok: true });
    }
    const refused = await updateJoinDefaults(deps(), actorFor(owner), {
      role: 'owner',
      status: 'active',
    });
    expect(refused).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('decidePending', () => {
  async function pendingUser(email = 'p@example.com', identity = true) {
    return createUser(
      {
        email,
        role: 'viewer',
        status: 'pending',
        ...(identity ? { identity: { loginProvider: 'access', subject: `team|${email}` } } : {}),
      },
      T0 - 1000,
    );
  }

  it('approves with a role in one statement and one user.approve row', async () => {
    const pending = await pendingUser();
    const result = await decidePending(
      deps(),
      actorFor(owner),
      pending.id,
      'approve',
      'access_manager',
    );
    expect(result).toMatchObject({ ok: true, changed: true, auditId: expect.any(String) });
    expect(await getUser(env.DB, pending.id)).toMatchObject({
      status: 'active',
      role: 'access_manager',
    });
    const rows = await audits();
    expect(rows.map((row) => row.action)).toEqual(['user.approve']);
    expect(rows[0]?.diff).toEqual({
      before: { role: 'viewer', status: 'pending' },
      after: { role: 'access_manager', status: 'active' },
    });
    if (result.ok) expect(rows[0]?.id).toBe(result.auditId);
  });

  it.each([undefined, '', 'superuser'])(
    'refuses to approve without a valid role (%j)',
    async (role) => {
      const pending = await pendingUser();
      const result = await decidePending(deps(), actorFor(owner), pending.id, 'approve', role);
      expect(result).toMatchObject({ ok: false, reason: 'invalid', errors: [ROLE_MESSAGE] });
      expect(await getUser(env.DB, pending.id)).toMatchObject({ status: 'pending' });
      expect(await audits()).toHaveLength(0);
    },
  );

  it('never approves a pending row without a login identity', async () => {
    const pending = await pendingUser('noid@example.com', false);
    const result = await decidePending(deps(), actorFor(owner), pending.id, 'approve', 'viewer');
    expect(result).toMatchObject({ ok: false });
    expect(await getUser(env.DB, pending.id)).toMatchObject({ status: 'pending' });
    expect(await audits()).toHaveLength(0);
  });

  it('rejects to suspended, keeps the role and writes user.reject', async () => {
    const pending = await pendingUser();
    const result = await decidePending(deps(), actorFor(owner), pending.id, 'reject', 'admin');
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(await getUser(env.DB, pending.id)).toMatchObject({
      status: 'suspended',
      role: 'viewer',
    });
    expect((await audits()).map((row) => row.action)).toEqual(['user.reject']);
  });

  it('refuses users who are no longer pending, naming their status', async () => {
    const admin = await createUser({ email: 'a@example.com', role: 'admin' }, T0);
    const result = await decidePending(deps(), actorFor(owner), admin.id, 'approve', 'viewer');
    expect(result).toMatchObject({
      ok: false,
      reason: 'conflict',
      errors: ['a@example.com was already approved or rejected (now Active).'],
    });
  });

  it('a decision that loses the race to another owner writes nothing', async () => {
    const pending = await pendingUser();
    const racing = racingDeps("UPDATE users SET status = 'suspended' WHERE id = ?", pending.id);
    const result = await decidePending(racing, actorFor(owner), pending.id, 'approve', 'admin');
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await getUser(env.DB, pending.id)).toMatchObject({
      status: 'suspended',
      role: 'viewer',
    });
    expect(await audits()).toEqual([]);
  });
});

describe('expectedUpdatedAt: a change decided on a stale page is a conflict', () => {
  it.each(['updateUser', 'resetLogin', 'deleteUser'] as const)('%s', async (op) => {
    const target = await createUser(
      { email: 't@example.com', role: 'admin', status: op === 'deleteUser' ? 'invited' : 'active' },
      T0,
    );
    const stale = target.updated_at - 1;
    const result =
      op === 'updateUser'
        ? await updateUser(deps(), actorFor(owner), target.id, {
            role: 'viewer',
            expectedUpdatedAt: stale,
          })
        : op === 'resetLogin'
          ? await resetLogin(deps(), actorFor(owner), target.id, stale)
          : await deleteUser(deps(), actorFor(owner), target.id, stale);
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    if (!result.ok) expect(result.errors.join()).toContain('was changed by someone else at');
    expect(await getUser(env.DB, target.id)).toMatchObject({ role: 'admin' });
    expect(await audits()).toEqual([]);
  });

  it('the current version passes, and every write bumps it', async () => {
    const target = await createUser({ email: 't@example.com', role: 'admin' }, T0);
    const first = await updateUser(deps(), actorFor(owner), target.id, {
      status: 'suspended',
      expectedUpdatedAt: target.updated_at,
    });
    expect(first).toMatchObject({ ok: true, changed: true });
    const after = await getUser(env.DB, target.id);
    // The clock did not move (T0), yet the version did: a page opened before is stale.
    expect(after?.updated_at).toBe(target.updated_at + 1);
    const stale = await updateUser(deps(), actorFor(owner), target.id, {
      status: 'active',
      expectedUpdatedAt: target.updated_at,
    });
    expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
  });
});

describe('I-LINK-1: inviting an email again', () => {
  it.each([
    ['an expired invitation', { status: 'invited' as const, inviteExpiresAt: T0 - 1 }],
    ['a cancelled invitation (suspended, never signed in)', { status: 'suspended' as const }],
  ])('re-invites %s with the new role and one user.invite row', async (_label, seed) => {
    const row = await createUser({ email: 'again@example.com', role: 'viewer', ...seed }, T0 - 10);
    const result = await inviteUser(deps(), actorFor(owner), {
      email: 'Again@Example.com',
      role: 'token_manager',
    });
    expect(result).toMatchObject({ ok: true, again: true, user: { id: row.id } });
    expect(await getUser(env.DB, row.id)).toMatchObject({
      role: 'token_manager',
      status: 'invited',
      invite_expires_at: T0 + INVITE_TTL_MS,
    });
    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual(['user.invite']);
    expect(rows[0]?.summary).toBe('Invited again@example.com again as Token manager');
  });

  it('never re-invites a user who signed in (has an identity), whatever their status', async () => {
    for (const status of ['suspended', 'active', 'pending'] as const) {
      const email = `linked-${status}@example.com`;
      const row = await createUser(
        { email, role: 'viewer', status, identity: { loginProvider: 'access', subject: email } },
        T0,
      );
      const result = await inviteUser(deps(), actorFor(owner), { email, role: 'admin' });
      expect(result, status).toMatchObject({
        ok: false,
        reason: 'invalid',
        existingUserId: row.id,
      });
      if (!result.ok) expect(result.errors[0]).toContain('already signed in with an account');
      expect(await getUser(env.DB, row.id)).toMatchObject({ role: 'viewer', status });
    }
    expect(await audits()).toEqual([]);
  });
});

describe('deleteUser (cancel an invitation)', () => {
  it('deletes an invited user who never signed in, with one user.delete row', async () => {
    const invited = await createUser({ email: 'i@example.com', status: 'invited' }, T0);
    const result = await deleteUser(deps(), actorFor(owner), invited.id, invited.updated_at);
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(await getUser(env.DB, invited.id)).toBeNull();
    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual(['user.delete']);
    expect(rows[0]?.diff).toEqual({
      before: { email: 'i@example.com', role: 'admin', status: 'invited' },
    });
  });

  it('refuses users who signed in (suspended with an identity) and active users', async () => {
    const linked = await createUser(
      {
        email: 'l@example.com',
        status: 'suspended',
        identity: { loginProvider: 'access', subject: 'team|l' },
      },
      T0,
    );
    const active = await createUser({ email: 'a@example.com' }, T0);
    for (const user of [linked, active]) {
      const result = await deleteUser(deps(), actorFor(owner), user.id);
      expect(result).toMatchObject({ ok: false, reason: 'invalid' });
      if (!result.ok) expect(result.errors[0]).toContain('Suspend them instead');
      expect(await getUser(env.DB, user.id)).not.toBeNull();
    }
    expect(await audits()).toEqual([]);
  });

  it('refuses when an identity was linked between read and write', async () => {
    const invited = await createUser({ email: 'i@example.com', status: 'invited' }, T0);
    const racing = racingDeps(
      "INSERT INTO user_identities (login_provider, subject, user_id, created_at) VALUES ('access', 'team|race', ?, 0)",
      invited.id,
    );
    const result = await deleteUser(racing, actorFor(owner), invited.id);
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await getUser(env.DB, invited.id)).not.toBeNull();
    expect(await audits()).toEqual([]);
  });
});

describe('dismissRefusedAttempt', () => {
  async function refused(at: number) {
    const user = await createUser({ email: 'r@example.com', status: 'invited' }, T0 - 1000);
    await env.DB.prepare(
      "UPDATE users SET last_refused_at = ?, last_refused_subject = 'team|x' WHERE id = ?",
    )
      .bind(at, user.id)
      .run();
    return user;
  }

  it('clears the attempt it was shown, with one row, and leaves updated_at alone', async () => {
    const user = await refused(T0 - 10);
    const result = await dismissRefusedAttempt(deps(), actorFor(owner), user.id, T0 - 10);
    expect(result).toMatchObject({ ok: true });
    expect(await getUser(env.DB, user.id)).toMatchObject({
      last_refused_at: null,
      last_refused_subject: null,
      updated_at: user.updated_at,
    });
    expect((await audits()).map((r) => r.action)).toEqual(['user.dismiss_attempt']);
  });

  it('refuses a stale or missing attempt, writing nothing', async () => {
    const user = await refused(T0 - 10);
    for (const expected of [T0 - 20, undefined, Number.NaN]) {
      const result = await dismissRefusedAttempt(deps(), actorFor(owner), user.id, expected);
      expect(result).toMatchObject({ ok: false });
    }
    // A newer attempt arrives between read and write.
    const racing = racingDeps(
      'UPDATE users SET last_refused_at = last_refused_at + 5 WHERE id = ?',
      user.id,
    );
    expect(await dismissRefusedAttempt(racing, actorFor(owner), user.id, T0 - 10)).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    expect((await getUser(env.DB, user.id))?.last_refused_at).toBe(T0 - 5);
    expect(await audits()).toEqual([]);
  });
});

describe('join policy (I-LINK-1: any role except owner)', () => {
  it('parses the six options', () => {
    expect(JOIN_POLICIES.map((value) => [value, parseJoinPolicy(value)])).toEqual([
      ['pending', { role: 'viewer', status: 'pending' }],
      ['active:viewer', { role: 'viewer', status: 'active' }],
      ['active:token_manager', { role: 'token_manager', status: 'active' }],
      ['active:access_manager', { role: 'access_manager', status: 'active' }],
      ['active:admin', { role: 'admin', status: 'active' }],
      ['closed', { role: 'viewer', status: 'suspended' }],
    ]);
    for (const value of JOIN_POLICIES) {
      const parsed = parseJoinPolicy(value);
      if (parsed) expect(joinPolicyOf(parsed)).toBe(value);
    }
  });

  it.each(['active:owner', 'owner', 'active', 'pending:admin', '', ['pending', 'pending'], 1])(
    'rejects %j',
    (raw) => {
      expect(parseJoinPolicy(raw)).toBeNull();
    },
  );

  it('saves with one audit row, and an unchanged policy writes nothing', async () => {
    const saved = await updateJoinDefaults(deps(), actorFor(owner), {
      role: 'token_manager',
      status: 'active',
    });
    expect(saved).toMatchObject({ ok: true, changed: true });
    const again = await updateJoinDefaults(deps(), actorFor(owner), {
      role: 'token_manager',
      status: 'active',
    });
    expect(again).toMatchObject({ ok: true, changed: false, auditId: null });
    const rows = await audits();
    expect(rows.map((row) => row.action)).toEqual(['user.join_defaults']);
    expect(rows[0]?.summary).toBe('New people: Let them in as Token manager');
  });

  it('stores the role viewer unless people are let in', async () => {
    const result = await updateJoinDefaults(deps(), actorFor(owner), {
      role: 'admin',
      status: 'pending',
    });
    expect(result).toMatchObject({ ok: true, defaults: { role: 'viewer', status: 'pending' } });
  });
});
