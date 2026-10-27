// The team tables of the control-plane schema (migrations/0001_initial.sql, ADR 0023): the seed of
// the built-in teams, the CHECKs, the cascades and every team trigger. These tests write raw SQL,
// so no op or JS check stands between them and the schema. They seed only credentials, never access
// rules: a team's scope is on credentials only.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_TEAM_ORDER, BUILTIN_TEAMS, getTeam, getTeamPowers } from '../../../src/db/teams';
import { createUser, resetControlPlane } from '../../helpers/admin-auth';
import { addMember, createTeam } from '../../helpers/teams';

const db = env.DB;
const T = 1_700_000_000_000;
const CUSTOM_ID = 'tea_01HZZZZZZZZZZZZZZZZZZZZZZZ';

/** The error text of a refused statement or batch, or 'not refused'. */
async function refused(write: D1PreparedStatement | Promise<unknown>): Promise<string> {
  try {
    await (write instanceof Promise ? write : write.run());
  } catch (error) {
    return error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  }
  return 'not refused';
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${sql}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

const insertTeam = (id: string, name: string, columns: Record<string, unknown> = {}) => {
  const names = ['id', 'name', 'created_at', 'updated_at', ...Object.keys(columns)];
  return db
    .prepare(`INSERT INTO teams (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .bind(id, name, T, T, ...Object.values(columns));
};

const insertCredential = (id: string) => {
  const slug = id.toLowerCase().replace('_', '-');
  return db
    .prepare(
      `INSERT INTO credentials (id, slug, name, base_url, injection, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{"kind":"bearer"}', ?, ?)`,
    )
    .bind(id, slug, id, `https://${slug}.example.com`, T, T);
};

/** team_credentials (team_id, credential_id, level, reveal, access_rules). */
const insertRow = (team: string, credential: string, level: unknown, reveal = 0, accessRules = 0) =>
  db
    .prepare('INSERT INTO team_credentials VALUES (?, ?, ?, ?, ?)')
    .bind(team, credential, level, reveal, accessRules);

const grant = (team: string, permission: string) =>
  db.prepare('INSERT INTO team_permissions VALUES (?, ?)').bind(team, permission);

const removeMember = (teamId: string, userId: string) =>
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').bind(teamId, userId);

// The statement of putSettingStatement (src/db/settings.ts): an upsert.
const joinTeam = (teamId: string) =>
  db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('join_team', ?, ?, NULL)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(teamId), T);

const updateJoinTeam = (teamId: string) =>
  db.prepare("UPDATE settings SET value = ? WHERE key = 'join_team'").bind(JSON.stringify(teamId));

beforeEach(resetControlPlane);

describe('I-RBAC-3: built-in teams', () => {
  it('seeds the five built-in teams exactly as BUILTIN_TEAMS', async () => {
    for (const key of BUILTIN_TEAM_ORDER) {
      const expected = BUILTIN_TEAMS[key];
      const powers = await getTeamPowers(db, `tea_${key}`);
      expect(powers, key).toEqual({
        id: expected.id,
        builtin: expected.builtin,
        permissions: expected.permissions,
        credentialsAll: expected.credentialsAll,
        allReveal: expected.allReveal,
        allAccessRules: expected.allAccessRules,
        credentials: expected.credentials,
      });
      const team = await getTeam(db, `tea_${key}`);
      expect({ name: team?.name, description: team?.description }, key).toEqual({
        name: expected.name,
        description: expected.description,
      });
    }
    expect(await count('teams')).toBe(5);
    expect(await count('team_credentials')).toBe(0);
  });

  it('gives reveal to Owners only, and access_rules:global only with all-scope delete (D23)', async () => {
    const { results } = await db
      .prepare(
        `SELECT t.id FROM teams t JOIN team_permissions p ON p.team_id = t.id
         WHERE p.permission = 'access_rules:global' AND t.credentials_all = 3 ORDER BY t.id`,
      )
      .all<{ id: string }>();
    expect(results.map((row) => row.id)).toEqual(['tea_admin', 'tea_owner']);
    expect(await count('teams WHERE credentials_all_reveal = 1')).toBe(1);
    // Credential managers do not manage access rules (D21).
    expect(BUILTIN_TEAMS.token_manager.allAccessRules).toBe(false);
  });

  it('refuses every change to a built-in team row', async () => {
    expect(await refused(insertTeam('tea_viewer2', 'Viewers 2', { builtin: 'viewer' }))).toContain(
      'builtin_team',
    );
    expect(
      await refused(db.prepare("UPDATE teams SET name = 'Lookers' WHERE id = 'tea_viewer'")),
    ).toContain('builtin_team');
    expect(
      await refused(db.prepare("UPDATE teams SET credentials_all = 3 WHERE id = 'tea_viewer'")),
    ).toContain('builtin_team');
    expect(
      await refused(
        db.prepare("UPDATE teams SET credentials_all_access_rules = 1 WHERE id = 'tea_viewer'"),
      ),
    ).toContain('builtin_team');
    expect(await refused(db.prepare("DELETE FROM teams WHERE id = 'tea_admin'"))).toContain(
      'builtin_team',
    );
    // A custom team cannot become built-in.
    await insertTeam(CUSTOM_ID, 'Payments').run();
    expect(
      await refused(
        db.prepare('UPDATE teams SET builtin = ? WHERE id = ?').bind('viewer', CUSTOM_ID),
      ),
    ).toContain('builtin_team');
  });

  it('refuses every change to the permissions and scope rows of a built-in team', async () => {
    await insertCredential('svc_1').run();
    expect(await refused(grant('tea_viewer', 'credentials:create'))).toContain('builtin_team');
    expect(await refused(grant('tea_viewer', 'access_rules:global'))).toContain('builtin_team');
    expect(
      await refused(db.prepare("DELETE FROM team_permissions WHERE team_id = 'tea_admin'")),
    ).toContain('builtin_team');
    expect(
      await refused(
        db.prepare(
          "UPDATE team_permissions SET permission = 'users:write' WHERE team_id = 'tea_admin'",
        ),
      ),
    ).toContain('immutable_row');
    // Built-in teams have all-scopes, so scope_mixed refuses these rows too. Either trigger may fire first.
    expect(await refused(insertRow('tea_viewer', 'svc_1', 1))).toMatch(/builtin_team|scope_mixed/);
    expect(await getTeamPowers(db, 'tea_admin')).toEqual(
      expect.objectContaining({ permissions: BUILTIN_TEAMS.admin.permissions }),
    );
  });

  it('lets the membership of a built-in team change', async () => {
    const user = await createUser({ email: 'v@example.com', role: 'viewer' });
    await addMember('tea_viewer', user.id);
    expect(await count('team_members WHERE team_id = ?', 'tea_viewer')).toBe(1);
    await removeMember('tea_viewer', user.id).run();
    expect(await count('team_members')).toBe(0);
  });
});

describe('teams: CHECKs and fixed keys', () => {
  it('accepts a custom team id of 30 characters and refuses other ids', async () => {
    await insertTeam(CUSTOM_ID, 'Payments').run();
    for (const id of [
      'tea_short',
      'tea_owner',
      'usr_01HZZZZZZZZZZZZZZZZZZZZZZZ',
      'tea_01hzzzzzzzzzzzzzzzzzzzzz',
    ]) {
      expect(await refused(insertTeam(id, `Team ${id}`)), id).toMatch(/CHECK constraint/);
    }
  });

  it('checks the name, the description, the level and the flags', async () => {
    expect(await refused(insertTeam(CUSTOM_ID, '   '))).toMatch(/CHECK constraint/);
    expect(await refused(insertTeam(CUSTOM_ID, 'x'.repeat(65)))).toMatch(/CHECK constraint/);
    expect(await refused(insertTeam(CUSTOM_ID, 'owners'))).toMatch(/UNIQUE constraint/);
    expect(
      await refused(insertTeam(CUSTOM_ID, 'Payments', { description: 'd'.repeat(281) })),
    ).toMatch(/CHECK constraint/);
    for (const columns of [
      { credentials_all: 4 },
      { credentials_all: -1 },
      { credentials_all: 3, credentials_all_reveal: 2 },
      { credentials_all: 3, credentials_all_access_rules: 2 },
    ]) {
      expect(
        await refused(insertTeam(CUSTOM_ID, 'Payments', columns)),
        JSON.stringify(columns),
      ).toMatch(/CHECK constraint/);
    }
    // A flag without a level: each all-scope flag implies all-scope view.
    for (const flag of ['credentials_all_reveal', 'credentials_all_access_rules']) {
      expect(await refused(insertTeam(CUSTOM_ID, 'Payments', { [flag]: 1 })), flag).toMatch(
        /CHECK constraint/,
      );
    }
    await insertTeam(CUSTOM_ID, 'Payments', {
      credentials_all: 1,
      credentials_all_reveal: 1,
      credentials_all_access_rules: 1,
    }).run();
    // Lowering the level to none while a flag is set is refused too.
    expect(
      await refused(
        db.prepare('UPDATE teams SET credentials_all = 0 WHERE id = ?').bind(CUSTOM_ID),
      ),
    ).toMatch(/CHECK constraint/);
  });

  it('checks the permissions and the explicit rows', async () => {
    await insertCredential('svc_1').run();
    await insertTeam(CUSTOM_ID, 'Payments').run();
    // The removed permissions and the implicit `read` are not stored.
    for (const permission of ['read', 'tokens:create', 'consumers:create', 'access:write']) {
      expect(await refused(grant(CUSTOM_ID, permission)), permission).toMatch(/CHECK constraint/);
    }
    for (const permission of [
      'credentials:create',
      'config:export',
      'users:write',
      'settings:write',
      'keyring:rewrap',
    ]) {
      await grant(CUSTOM_ID, permission).run();
    }
    for (const level of [0, 4]) {
      expect(await refused(insertRow(CUSTOM_ID, 'svc_1', level)), String(level)).toMatch(
        /CHECK constraint/,
      );
    }
    expect(await refused(insertRow(CUSTOM_ID, 'svc_1', 1, 2))).toMatch(/CHECK constraint/);
    expect(await refused(insertRow(CUSTOM_ID, 'svc_1', 1, 0, 2))).toMatch(/CHECK constraint/);
    expect(await refused(insertRow(CUSTOM_ID, 'svc_missing', 1))).toMatch(/FOREIGN KEY constraint/);
    await insertRow(CUSTOM_ID, 'svc_1', 1, 1, 1).run();
    expect((await getTeamPowers(db, CUSTOM_ID))?.credentials.get('svc_1')).toEqual({
      level: 1,
      reveal: true,
      accessRules: true,
    });
  });

  it('keeps membership rows and the keys of scope rows fixed, and lets a level or flag change', async () => {
    await db.batch([insertCredential('svc_1'), insertCredential('svc_2')]);
    const user = await createUser({ email: 'u@example.com', role: 'viewer' });
    const team = await createTeam({
      name: 'Payments',
      credentials: { svc_1: { level: 1 } },
      members: [user],
    });
    expect(
      await refused(
        db.prepare('UPDATE team_members SET added_by = ? WHERE team_id = ?').bind('x', team),
      ),
    ).toContain('immutable_row');
    expect(
      await refused(
        db
          .prepare("UPDATE team_credentials SET credential_id = 'svc_2' WHERE team_id = ?")
          .bind(team),
      ),
    ).toContain('immutable_row');
    expect(
      await refused(
        db
          .prepare('UPDATE team_credentials SET team_id = ? WHERE team_id = ?')
          .bind(CUSTOM_ID, team),
      ),
    ).toContain('immutable_row');
    await db
      .prepare(
        'UPDATE team_credentials SET level = 3, reveal = 1, access_rules = 1 WHERE team_id = ?',
      )
      .bind(team)
      .run();
    const powers = await getTeamPowers(db, team);
    expect(powers?.credentials.get('svc_1')).toEqual({ level: 3, reveal: true, accessRules: true });
  });
});

describe('teams: scope_mixed', () => {
  beforeEach(async () => {
    await insertCredential('svc_1').run();
  });

  it('refuses an explicit row on a team with all-scope credentials, and the reverse', async () => {
    const all = await createTeam({ name: 'All credentials', credentials: { all: 1 } });
    expect(await refused(insertRow(all, 'svc_1', 2))).toContain('scope_mixed');
    const list = await createTeam({
      name: 'Some credentials',
      credentials: { svc_1: { level: 1 } },
    });
    expect(
      await refused(db.prepare('UPDATE teams SET credentials_all = 1 WHERE id = ?').bind(list)),
    ).toContain('scope_mixed');
    // Other columns and "none" stay writable.
    await db
      .prepare("UPDATE teams SET credentials_all = 0, description = 'Rows' WHERE id = ?")
      .bind(list)
      .run();
  });

  it('allows list → all once the rows are deleted in the same batch', async () => {
    const list = await createTeam({
      name: 'Some credentials',
      credentials: { svc_1: { level: 1 } },
    });
    await db.batch([
      db.prepare('DELETE FROM team_credentials WHERE team_id = ?').bind(list),
      db.prepare('UPDATE teams SET credentials_all = 2 WHERE id = ?').bind(list),
    ]);
    expect((await getTeamPowers(db, list))?.credentialsAll).toBe(2);
  });
});

describe('D23: access_rules:global only with all-scope view', () => {
  beforeEach(async () => {
    await insertCredential('svc_1').run();
  });

  it('refuses the permission on a team with no scope or a list', async () => {
    const none = await createTeam({ name: 'None' });
    const list = await createTeam({
      name: 'List',
      credentials: { svc_1: { level: 3, accessRules: true } },
    });
    for (const team of [none, list]) {
      expect(await refused(grant(team, 'access_rules:global')), team).toContain(
        'global_rules_scope',
      );
    }
    expect(await refused(grant(CUSTOM_ID, 'access_rules:global'))).toContain('global_rules_scope');
    expect(await count("team_permissions WHERE permission = 'access_rules:global'")).toBe(2);
  });

  it('accepts the permission with all-scope view, and keeps it there', async () => {
    const team = await createTeam({
      name: 'Global rules',
      credentials: { all: 1 },
      permissions: ['access_rules:global'],
    });
    expect(
      await refused(db.prepare('UPDATE teams SET credentials_all = 0 WHERE id = ?').bind(team)),
    ).toContain('global_rules_scope');
    // all → list goes through "none", so it is refused the same way, and the batch rolls back.
    expect(
      await refused(
        db.batch([
          db.prepare('UPDATE teams SET credentials_all = 0 WHERE id = ?').bind(team),
          insertRow(team, 'svc_1', 1),
        ]),
      ),
    ).toContain('global_rules_scope');
    expect(await getTeamPowers(db, team)).toEqual(
      expect.objectContaining({ credentialsAll: 1, credentials: new Map() }),
    );
    // Changing the level within "all" is allowed.
    await db.prepare('UPDATE teams SET credentials_all = 3 WHERE id = ?').bind(team).run();
    // Once the permission is removed, the team can leave "all".
    await db.batch([
      db
        .prepare(
          "DELETE FROM team_permissions WHERE team_id = ? AND permission = 'access_rules:global'",
        )
        .bind(team),
      db.prepare('UPDATE teams SET credentials_all = 0 WHERE id = ?').bind(team),
    ]);
    expect((await getTeamPowers(db, team))?.credentialsAll).toBe(0);
  });
});

describe('teams: cascades', () => {
  it('deletes the members, permissions and credential rows of a deleted custom team', async () => {
    await insertCredential('svc_1').run();
    const user = await createUser({ email: 'u@example.com', role: 'viewer' });
    const team = await createTeam({
      name: 'Payments',
      permissions: ['credentials:create'],
      credentials: { svc_1: { level: 2, accessRules: true } },
      members: [user],
    });
    await db.prepare('DELETE FROM teams WHERE id = ?').bind(team).run();
    for (const table of ['team_members', 'team_permissions', 'team_credentials']) {
      expect(await count(`${table} WHERE team_id = ?`, team), table).toBe(0);
    }
  });

  it('deletes the rows of a deleted credential, and the memberships of a deleted user', async () => {
    await db.batch([insertCredential('svc_1'), insertCredential('svc_2')]);
    const user = await createUser({ email: 'u@example.com', role: 'viewer' });
    const team = await createTeam({
      name: 'Credentials',
      credentials: { svc_1: { level: 1 }, svc_2: { level: 2, reveal: true } },
      members: [user],
    });
    await db.prepare("DELETE FROM credentials WHERE id = 'svc_1'").run();
    expect(await count('team_credentials')).toBe(1);
    expect(await count("team_credentials WHERE credential_id = 'svc_2'")).toBe(1);
    await db.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
    expect(await count('team_members')).toBe(0);
    expect(await count('teams WHERE id = ?', team)).toBe(1);
  });
});

describe('I-OWNER-1: the last active Owners member', () => {
  it('cannot leave the Owners team', async () => {
    const owner = await createUser({ email: 'o@example.com', role: 'viewer' });
    await addMember('tea_owner', owner.id);
    expect(await refused(removeMember('tea_owner', owner.id))).toContain('last_owner');
    expect(await count("team_members WHERE team_id = 'tea_owner'")).toBe(1);
  });

  it('can leave when another active owner exists', async () => {
    const first = await createUser({ email: 'o1@example.com', role: 'viewer' });
    const second = await createUser({ email: 'o2@example.com', role: 'viewer' });
    await addMember('tea_owner', first.id);
    await addMember('tea_owner', second.id);
    await removeMember('tea_owner', first.id).run();
    expect(await refused(removeMember('tea_owner', second.id))).toContain('last_owner');
  });

  it('a suspended owner does not count, and can be removed', async () => {
    const active = await createUser({ email: 'o1@example.com', role: 'viewer' });
    const suspended = await createUser({
      email: 'o2@example.com',
      role: 'viewer',
      status: 'suspended',
    });
    await addMember('tea_owner', active.id);
    await addMember('tea_owner', suspended.id);
    await removeMember('tea_owner', suspended.id).run();
    await addMember('tea_owner', suspended.id);
    expect(await refused(removeMember('tea_owner', active.id))).toContain('last_owner');
  });
});

describe('I-LINK-1: the default team is join-safe', () => {
  it('accepts a join-safe team, on insert and on the upsert conflict path', async () => {
    const reader = await createTeam({ name: 'Readers', credentials: { all: 1 } });
    await joinTeam('tea_viewer').run();
    await joinTeam(reader).run();
    // access_rules:global and the access_rules flag are elevated, not owner-grade (D6).
    await joinTeam('tea_access_manager').run();
    await joinTeam('tea_admin').run();
    expect(
      await db.prepare("SELECT value FROM settings WHERE key = 'join_team'").first('value'),
    ).toBe('"tea_admin"');
  });

  it('refuses Owners, owner-grade permissions, reveal and unknown teams', async () => {
    await insertCredential('svc_1').run();
    const managers = await createTeam({ name: 'Managers', permissions: ['users:write'] });
    const settings = await createTeam({ name: 'Settings', permissions: ['settings:write'] });
    const keys = await createTeam({ name: 'Keys', permissions: ['keyring:rewrap'] });
    const allReveal = await createTeam({
      name: 'All reveal',
      credentials: { all: 1, reveal: true },
    });
    const rowReveal = await createTeam({
      name: 'Row reveal',
      credentials: { svc_1: { level: 1, reveal: true } },
    });
    for (const team of ['tea_owner', managers, settings, keys, allReveal, rowReveal, CUSTOM_ID]) {
      expect(await refused(joinTeam(team)), team).toContain('join_team_unsafe');
    }
    // The conflict path and a plain UPDATE refuse the same values.
    await joinTeam('tea_viewer').run();
    for (const team of ['tea_owner', managers, rowReveal]) {
      expect(await refused(joinTeam(team)), team).toContain('join_team_unsafe');
      expect(await refused(updateJoinTeam(team)), team).toContain('join_team_unsafe');
    }
    expect(
      await db.prepare("SELECT value FROM settings WHERE key = 'join_team'").first('value'),
    ).toBe('"tea_viewer"');
  });

  it('refuses a malformed value', async () => {
    const raw = (value: string) =>
      db
        .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('join_team', ?, ?)")
        .bind(value, T);
    expect(await refused(raw('not json'))).not.toBe('not refused');
    expect(await refused(raw('["tea_viewer"]'))).toContain('join_team_unsafe');
    expect(await refused(raw('null'))).toContain('join_team_unsafe');
  });

  it('leaves other settings keys alone', async () => {
    await db
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('other', 'not json', ?)")
      .bind(T)
      .run();
    expect(await count("settings WHERE key = 'other'")).toBe(1);
  });

  it('keeps the default team join-safe and undeletable', async () => {
    await insertCredential('svc_1').run();
    const team = await createTeam({ name: 'Readers', credentials: { svc_1: { level: 1 } } });
    await joinTeam(team).run();
    expect(await refused(db.prepare('DELETE FROM teams WHERE id = ?').bind(team))).toContain(
      'default_team',
    );
    for (const permission of ['users:write', 'settings:write', 'keyring:rewrap']) {
      expect(await refused(grant(team, permission)), permission).toContain('join_team_unsafe');
    }
    // Elevated but join-safe powers stay allowed (the ops ask for a confirmation).
    await grant(team, 'credentials:create').run();
    await db
      .prepare('UPDATE team_credentials SET level = 3, access_rules = 1 WHERE team_id = ?')
      .bind(team)
      .run();
    expect(
      await refused(
        db.prepare('UPDATE team_credentials SET reveal = 1 WHERE team_id = ?').bind(team),
      ),
    ).toContain('join_team_unsafe');
    await insertCredential('svc_2').run();
    expect(await refused(insertRow(team, 'svc_2', 1, 1))).toContain('join_team_unsafe');
    await db.batch([
      db.prepare('DELETE FROM team_credentials WHERE team_id = ?').bind(team),
      db.prepare('UPDATE teams SET credentials_all = 1 WHERE id = ?').bind(team),
    ]);
    await grant(team, 'access_rules:global').run();
    await db
      .prepare('UPDATE teams SET credentials_all_access_rules = 1 WHERE id = ?')
      .bind(team)
      .run();
    expect(
      await refused(
        db.prepare('UPDATE teams SET credentials_all_reveal = 1 WHERE id = ?').bind(team),
      ),
    ).toContain('join_team_unsafe');
    // Another team can still be deleted.
    const other = await createTeam({ name: 'Other' });
    await db.prepare('DELETE FROM teams WHERE id = ?').bind(other).run();
  });
});

describe('audit_log.resources', () => {
  const audit = (resources?: string) =>
    db
      .prepare(
        `INSERT INTO audit_log (id, ts, actor_type, action, summary${resources === undefined ? '' : ', resources'})
         VALUES ('aud_1', ?, 'system', 'test', 'test'${resources === undefined ? '' : ', ?'})`,
      )
      .bind(T, ...(resources === undefined ? [] : [resources]));

  it('defaults to an empty JSON array', async () => {
    await audit().run();
    expect(
      await db.prepare("SELECT resources FROM audit_log WHERE id = 'aud_1'").first('resources'),
    ).toBe('[]');
  });

  it.each(['{}', '"svc_1"', 'not json', 'null'])('refuses %j', async (value) => {
    expect(await refused(audit(value))).toMatch(/CHECK constraint/);
  });

  it('accepts credential ids and the "*" sentinel', async () => {
    await audit('["svc_1","svc_2","*"]').run();
    expect(await count('audit_log')).toBe(1);
  });
});
