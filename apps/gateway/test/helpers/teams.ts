// Team fixtures: custom teams and memberships written with raw SQL, which bypasses the ops and
// their checks. resetControlPlane (admin-auth.ts) deletes them again.
//
//   const payments = await createTeam({ name: 'Payments',
//     credentials: { [svc.id]: { level: 2, accessRules: true } }, members: [alice] });
//   const readers = await createTeam({ name: 'Readers', credentials: { all: 1 } });
//   await setBuiltinTeam(bob.id, 'viewer');
import { env } from 'cloudflare:workers';
import type { BuiltinTeam, GlobalPermission, Level } from '../../src/db/teams';
import { newId } from '../../src/lib/ids';

type CredentialSeed = { level: Level; reveal?: boolean; accessRules?: boolean };

export interface TeamSeed {
  name: string;
  description?: string;
  permissions?: readonly GlobalPermission[];
  /** All-scope (`{ all }` with its flags), or explicit rows by credential id. */
  credentials?: ({ all: Level } & Omit<CredentialSeed, 'level'>) | Record<string, CredentialSeed>;
  members?: ReadonlyArray<{ id: string }>;
}

function isAllScope(value: object): value is { all: Level } & Omit<CredentialSeed, 'level'> {
  return typeof (value as { all?: unknown }).all === 'number';
}

const flag = (value: boolean | undefined) => (value ? 1 : 0);

/**
 * Inserts a custom team with its scope, permissions and members. Returns its id. The scope goes
 * in before the permissions, so the global_rules_scope trigger (D23) sees it.
 */
export async function createTeam(seed: TeamSeed, now: number = Date.now()): Promise<string> {
  const db = env.DB;
  const id = newId('tea', now, (n) => crypto.getRandomValues(new Uint8Array(n)));
  const credentials = seed.credentials ?? {};
  const all = isAllScope(credentials) ? credentials : null;
  const statements = [
    db
      .prepare(
        `INSERT INTO teams (id, name, description, credentials_all, credentials_all_reveal,
           credentials_all_access_rules, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        seed.name,
        seed.description ?? '',
        all?.all ?? 0,
        flag(all?.reveal),
        flag(all?.accessRules),
        now,
        now,
      ),
    ...(seed.permissions ?? []).map((permission) =>
      db
        .prepare('INSERT INTO team_permissions (team_id, permission) VALUES (?, ?)')
        .bind(id, permission),
    ),
  ];
  if (!all) {
    for (const [credentialId, row] of Object.entries(
      credentials as Record<string, CredentialSeed>,
    )) {
      statements.push(
        db
          .prepare(
            `INSERT INTO team_credentials (team_id, credential_id, level, reveal, access_rules)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(id, credentialId, row.level, flag(row.reveal), flag(row.accessRules)),
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
