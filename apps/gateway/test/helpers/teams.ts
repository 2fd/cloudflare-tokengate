// Team fixtures: custom teams and memberships written with raw SQL, which bypasses the ops and
// their checks. resetControlPlane (admin-auth.ts) deletes them again.
//
//   const payments = await createTeam({ name: 'Payments', tokens: { [svc.id]: { level: 2 } },
//     consumers: { all: 1 }, members: [alice] });
//   await setBuiltinTeam(bob.id, 'viewer');
import { env } from 'cloudflare:workers';
import type { BuiltinTeam, GlobalPermission, Level } from '../../src/db/teams';
import { newId } from '../../src/lib/ids';

export interface TeamSeed {
  name: string;
  description?: string;
  permissions?: readonly GlobalPermission[];
  /** All-scope (`{ all }`), or explicit rows by service id. */
  tokens?: { all: Level; reveal?: boolean } | Record<string, { level: Level; reveal?: boolean }>;
  /** All-scope (`{ all }`), or explicit rows by credential access rule id. */
  consumers?: { all: Level } | Record<string, { level: Level }>;
  members?: ReadonlyArray<{ id: string }>;
}

function isAllScope(value: object): value is { all: Level; reveal?: boolean } {
  return typeof (value as { all?: unknown }).all === 'number';
}

/** Inserts a custom team with its permissions, scopes and members. Returns its id. */
export async function createTeam(seed: TeamSeed, now: number = Date.now()): Promise<string> {
  const db = env.DB;
  const id = newId('tea', now, (n) => crypto.getRandomValues(new Uint8Array(n)));
  const tokens = seed.tokens ?? {};
  const consumers = seed.consumers ?? {};
  const tokensAll = isAllScope(tokens) ? tokens : null;
  const consumersAll = isAllScope(consumers) ? consumers : null;
  const statements = [
    db
      .prepare(
        `INSERT INTO teams (id, name, description, tokens_all, tokens_all_reveal, consumers_all,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        seed.name,
        seed.description ?? '',
        tokensAll?.all ?? 0,
        tokensAll?.reveal ? 1 : 0,
        consumersAll?.all ?? 0,
        now,
        now,
      ),
    ...(seed.permissions ?? []).map((permission) =>
      db
        .prepare('INSERT INTO team_permissions (team_id, permission) VALUES (?, ?)')
        .bind(id, permission),
    ),
  ];
  if (!tokensAll) {
    for (const [serviceId, row] of Object.entries(
      tokens as Record<string, { level: Level; reveal?: boolean }>,
    )) {
      statements.push(
        db
          .prepare(
            'INSERT INTO team_tokens (team_id, service_id, level, reveal) VALUES (?, ?, ?, ?)',
          )
          .bind(id, serviceId, row.level, row.reveal ? 1 : 0),
      );
    }
  }
  if (!consumersAll) {
    for (const [consumerId, row] of Object.entries(consumers as Record<string, { level: Level }>)) {
      statements.push(
        db
          .prepare(
            'INSERT INTO team_consumers (team_id, credential_access_rule_id, level) VALUES (?, ?, ?)',
          )
          .bind(id, consumerId, row.level),
      );
    }
  }
  for (const member of seed.members ?? []) {
    statements.push(addMemberStatement(id, member.id, now));
  }
  await db.batch(statements);
  return id;
}

function addMemberStatement(teamId: string, userId: string, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO team_members (team_id, user_id, added_at, added_by)
     VALUES (?, ?, ?, 'test')`,
  ).bind(teamId, userId, now);
}

/** Adds the user to the team (no-op when already a member). */
export async function addMember(
  teamId: string,
  userId: string,
  now: number = Date.now(),
): Promise<void> {
  await addMemberStatement(teamId, userId, now).run();
}

/**
 * Makes the user a member of exactly one built-in team (`tea_<team>`), or of none with `null`.
 * Memberships of custom teams are kept.
 */
export async function setBuiltinTeam(
  userId: string,
  team: BuiltinTeam | null,
  now: number = Date.now(),
): Promise<void> {
  const statements = [
    env.DB.prepare(
      `DELETE FROM team_members WHERE user_id = ?
         AND team_id IN (SELECT id FROM teams WHERE builtin IS NOT NULL)${team ? ' AND team_id <> ?' : ''}`,
    ).bind(...(team ? [userId, `tea_${team}`] : [userId])),
  ];
  if (team) statements.push(addMemberStatement(`tea_${team}`, userId, now));
  await env.DB.batch(statements);
}
