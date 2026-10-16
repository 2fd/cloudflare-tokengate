import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeUsersWithRoles,
  countNeedsDecision,
  listPendingUsers,
  REFUSED_ATTEMPT_TTL_MS,
} from '../../../src/db/users';
import { createUser, resetControlPlane } from '../../helpers/admin-auth';

const NOW = Date.UTC(2026, 9, 14, 12);

async function refusedAt(id: string, at: number) {
  await env.DB.prepare(
    "UPDATE users SET last_refused_at = ?, last_refused_subject = 'team|x' WHERE id = ?",
  )
    .bind(at, id)
    .run();
}

beforeEach(resetControlPlane);

describe('users that need a decision', () => {
  it('counts pending users and unanswered recent refused sign-ins', async () => {
    const before = NOW - 60_000;
    await createUser({ email: 'owner@example.com', role: 'owner' }, before);
    await createUser({ email: 'p1@example.com', status: 'pending' }, before);
    await createUser({ email: 'p2@example.com', status: 'pending' }, before - 1);
    expect(await countNeedsDecision(env.DB, NOW)).toBe(2);

    // Refused after the last change: counts; refused before it or too long ago: does not.
    const invited = await createUser({ email: 'i@example.com', status: 'invited' }, before);
    await refusedAt(invited.id, NOW - 1000);
    const answered = await createUser({ email: 'a@example.com', status: 'invited' }, before);
    await refusedAt(answered.id, before - 1);
    const old = await createUser(
      { email: 'o@example.com', status: 'invited' },
      before - 2 * REFUSED_ATTEMPT_TTL_MS,
    );
    await refusedAt(old.id, NOW - REFUSED_ATTEMPT_TTL_MS - 1);
    expect(await countNeedsDecision(env.DB, NOW)).toBe(3);

    // A suspended user who signed in before was suspended on purpose; one without an identity was not.
    const suspended = await createUser(
      {
        email: 's@example.com',
        status: 'suspended',
        identity: { loginProvider: 'access', subject: 'team|s' },
      },
      before,
    );
    await refusedAt(suspended.id, NOW - 1000);
    const neverLinked = await createUser({ email: 'n@example.com', status: 'suspended' }, before);
    await refusedAt(neverLinked.id, NOW - 1000);
    expect(await countNeedsDecision(env.DB, NOW)).toBe(4);
  });

  it('lists pending users oldest first, bounded', async () => {
    await createUser({ email: 'late@example.com', status: 'pending' }, NOW);
    await createUser({ email: 'early@example.com', status: 'pending' }, NOW - 10);
    await createUser({ email: 'active@example.com' }, NOW - 20);
    expect((await listPendingUsers(env.DB, 10)).map((user) => user.email)).toEqual([
      'early@example.com',
      'late@example.com',
    ]);
    expect(await listPendingUsers(env.DB, 1)).toHaveLength(1);
  });

  it('lists active users with one of the roles, by email', async () => {
    await createUser({ email: 'b@example.com', role: 'owner' });
    await createUser({ email: 'a@example.com', role: 'admin' });
    await createUser({ email: 'c@example.com', role: 'token_manager' });
    await createUser({ email: 'd@example.com', role: 'admin', status: 'suspended' });
    expect(
      (await activeUsersWithRoles(env.DB, ['admin', 'owner'], 10)).map((user) => user.email),
    ).toEqual(['a@example.com', 'b@example.com']);
    expect(await activeUsersWithRoles(env.DB, [], 10)).toEqual([]);
    expect(await activeUsersWithRoles(env.DB, ['admin', 'owner'], 1)).toHaveLength(1);
  });
});
