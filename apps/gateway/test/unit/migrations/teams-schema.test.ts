// The team tables of the control-plane schema (migrations/0001_initial.sql, ADR 0023): the seed of
// the built-in teams, the CHECKs, the cascades and every team trigger. These tests write raw SQL,
// so no op or JS check stands between them and the schema.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_TEAM_ORDER, BUILTIN_TEAMS, getTeam, getTeamPowers } from '../../../src/db/teams';
import { createUser, resetControlPlane } from '../../helpers/admin-auth';
import { addMember, createTeam } from '../../helpers/teams';

const db = env.DB;
const T = 1_700_000_000_000;
const CUSTOM_ID = 'tea_01HZZZZZZZZZZZZZZZZZZZZZZZ';

async function refused(statement: D1PreparedStatement): Promise<string> {
  try {
    await statement.run();
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

const insertService = (id: string) =>
  db
    .prepare(
      `INSERT INTO credentials (id, slug, name, base_url, injection, created_at, updated_at)
       VALUES (?, ?, ?, 'https://api.example.com', '{"kind":"bearer"}', ?, ?)`,
    )
    .bind(id, id.toLowerCase().replace('_', '-'), id, T, T);

const insertConsumer = (id: string) =>
  db
    .prepare(
      `INSERT INTO credential_access_rules (id, credential_id, name, profile, issuer, jwks_uri, audience, allowed_algs,
         max_token_age_seconds, created_at, updated_at)
       VALUES (?, (SELECT id FROM credentials ORDER BY id LIMIT 1), ?, 'generic', ?, 'https://issuer.example.com/jwks', 'tokengate:0123456789abcdef',
         '["RS256"]', 900, ?, ?)`,
    )
    .bind(id, id, `https://${id}.example.com`, T, T);

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
        tokensAll: expected.tokensAll,
        tokensAllReveal: expected.tokensAllReveal,
        consumersAll: expected.consumersAll,
        tokens: expected.tokens,
        consumers: expected.consumers,
      });
      const team = await getTeam(db, `tea_${key}`);
      expect({ name: team?.name, description: team?.description }, key).toEqual({
        name: expected.name,
        description: expected.description,
      });
    }
    expect(await count('teams')).toBe(5);
  });

  it('refuses every change to a built-in team row', async () => {
    expect(await refused(insertTeam('tea_viewer2', 'Viewers 2', { builtin: 'viewer' }))).toContain(
      'builtin_team',
    );
    expect(
      await refused(db.prepare("UPDATE teams SET name = 'Lookers' WHERE id = 'tea_viewer'")),
    ).toContain('builtin_team');
    expect(
      await refused(db.prepare("UPDATE teams SET tokens_all = 3 WHERE id = 'tea_viewer'")),
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
    await insertService('svc_1').run();
    await insertConsumer('cpr_1').run();
    expect(
      await refused(
        db.prepare("INSERT INTO team_permissions VALUES ('tea_viewer', 'tokens:create')"),
      ),
    ).toContain('builtin_team');
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
    expect(
      await refused(db.prepare("INSERT INTO team_tokens VALUES ('tea_viewer', 'svc_1', 1, 0)")),
    ).toMatch(/builtin_team|scope_mixed/);
    expect(
      await refused(db.prepare("INSERT INTO team_consumers VALUES ('tea_viewer', 'cpr_1', 1)")),
    ).toMatch(/builtin_team|scope_mixed/);
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

  it('checks the name, the description and the levels', async () => {
    expect(await refused(insertTeam(CUSTOM_ID, '   '))).toMatch(/CHECK constraint/);
    expect(await refused(insertTeam(CUSTOM_ID, 'x'.repeat(65)))).toMatch(/CHECK constraint/);
    expect(await refused(insertTeam(CUSTOM_ID, 'owners'))).toMatch(/UNIQUE constraint/);
    expect(
      await refused(insertTeam(CUSTOM_ID, 'Payments', { description: 'd'.repeat(281) })),
    ).toMatch(/CHECK constraint/);
    for (const column of ['tokens_all', 'consumers_all']) {
      expect(await refused(insertTeam(CUSTOM_ID, 'Payments', { [column]: 4 })), column).toMatch(
        /CHECK constraint/,
      );
    }
    // All-scope reveal implies all-scope view.
    expect(await refused(insertTeam(CUSTOM_ID, 'Payments', { tokens_all_reveal: 1 }))).toMatch(
      /CHECK constraint/,
    );
    await insertTeam(CUSTOM_ID, 'Payments', { tokens_all: 1, tokens_all_reveal: 1 }).run();
  });

  it('checks the permissions and the levels of explicit rows', async () => {
    await insertService('svc_1').run();
    await insertConsumer('cpr_1').run();
    await insertTeam(CUSTOM_ID, 'Payments').run();
    expect(
      await refused(
        db.prepare('INSERT INTO team_permissions VALUES (?, ?)').bind(CUSTOM_ID, 'read'),
      ),
    ).toMatch(/CHECK constraint/);
    for (const level of [0, 4]) {
      expect(
        await refused(
          db.prepare('INSERT INTO team_tokens VALUES (?, ?, ?, 0)').bind(CUSTOM_ID, 'svc_1', level),
        ),
      ).toMatch(/CHECK constraint/);
      expect(
        await refused(
          db.prepare('INSERT INTO team_consumers VALUES (?, ?, ?)').bind(CUSTOM_ID, 'cpr_1', level),
        ),
      ).toMatch(/CHECK constraint/);
    }
    expect(
      await refused(
        db.prepare('INSERT INTO team_tokens VALUES (?, ?, 1, 2)').bind(CUSTOM_ID, 'svc_1'),
      ),
    ).toMatch(/CHECK constraint/);
    expect(
      await refused(
        db.prepare('INSERT INTO team_tokens VALUES (?, ?, 1, 0)').bind(CUSTOM_ID, 'svc_missing'),
      ),
    ).toMatch(/FOREIGN KEY constraint/);
  });

  it('keeps membership rows and the keys of scope rows fixed, and lets a level change', async () => {
    await insertService('svc_1').run();
    await insertService('svc_2').run();
    await insertConsumer('cpr_1').run();
    await insertConsumer('cpr_2').run();
    const user = await createUser({ email: 'u@example.com', role: 'viewer' });
    const team = await createTeam({
      name: 'Payments',
      tokens: { svc_1: { level: 1 } },
      consumers: { cpr_1: { level: 1 } },
      members: [user],
    });
    expect(
      await refused(
        db.prepare('UPDATE team_members SET added_by = ? WHERE team_id = ?').bind('x', team),
      ),
    ).toContain('immutable_row');
    expect(
      await refused(
        db.prepare("UPDATE team_tokens SET service_id = 'svc_2' WHERE team_id = ?").bind(team),
      ),
    ).toContain('immutable_row');
    expect(
      await refused(
        db
          .prepare(
            "UPDATE team_consumers SET credential_access_rule_id = 'cpr_2' WHERE team_id = ?",
          )
          .bind(team),
      ),
    ).toContain('immutable_row');
    await db.batch([
      db.prepare('UPDATE team_tokens SET level = 3, reveal = 1 WHERE team_id = ?').bind(team),
      db.prepare('UPDATE team_consumers SET level = 2 WHERE team_id = ?').bind(team),
    ]);
    const powers = await getTeamPowers(db, team);
    expect(powers?.tokens.get('svc_1')).toEqual({ level: 3, reveal: true });
    expect(powers?.consumers.get('cpr_1')).toEqual({ level: 2 });
  });
});

describe('teams: scope_mixed', () => {
  beforeEach(async () => {
    await db.batch([insertService('svc_1'), insertConsumer('cpr_1')]);
  });

  it('refuses an explicit token row on a team with all-scope tokens, and the reverse', async () => {
    const all = await createTeam({ name: 'All tokens', tokens: { all: 1 } });
    expect(
      await refused(db.prepare("INSERT INTO team_tokens VALUES (?, 'svc_1', 2, 0)").bind(all)),
    ).toContain('scope_mixed');
    const list = await createTeam({ name: 'Some tokens', tokens: { svc_1: { level: 1 } } });
    expect(
      await refused(db.prepare('UPDATE teams SET tokens_all = 1 WHERE id = ?').bind(list)),
    ).toContain('scope_mixed');
    // Other columns and "none" stay writable.
    await db
      .prepare('UPDATE teams SET tokens_all = 0, consumers_all = 2 WHERE id = ?')
      .bind(list)
      .run();
  });

  it('refuses an explicit consumer row on a team with all-scope consumers, and the reverse', async () => {
    const all = await createTeam({ name: 'All credential access rules', consumers: { all: 2 } });
    expect(
      await refused(db.prepare("INSERT INTO team_consumers VALUES (?, 'cpr_1', 1)").bind(all)),
    ).toContain('scope_mixed');
    const list = await createTeam({ name: 'Some consumers', consumers: { cpr_1: { level: 1 } } });
    expect(
      await refused(db.prepare('UPDATE teams SET consumers_all = 3 WHERE id = ?').bind(list)),
    ).toContain('scope_mixed');
  });

  it('allows list → all once the rows are deleted in the same batch', async () => {
    const list = await createTeam({ name: 'Some tokens', tokens: { svc_1: { level: 1 } } });
    await db.batch([
      db.prepare('DELETE FROM team_tokens WHERE team_id = ?').bind(list),
      db.prepare('UPDATE teams SET tokens_all = 2 WHERE id = ?').bind(list),
    ]);
    expect((await getTeamPowers(db, list))?.tokensAll).toBe(2);
  });
});

describe('teams: cascades', () => {
  it('deletes the members, permissions and scope rows of a deleted custom team', async () => {
    await db.batch([insertService('svc_1'), insertConsumer('cpr_1')]);
    const user = await createUser({ email: 'u@example.com', role: 'viewer' });
    const team = await createTeam({
      name: 'Payments',
      permissions: ['tokens:create'],
      tokens: { svc_1: { level: 2 } },
      consumers: { cpr_1: { level: 1 } },
      members: [user],
    });
    await db.prepare('DELETE FROM teams WHERE id = ?').bind(team).run();
    for (const table of ['team_members', 'team_permissions', 'team_tokens', 'team_consumers']) {
      expect(await count(`${table} WHERE team_id = ?`, team), table).toBe(0);
    }
  });

  it('deletes the scope rows of a deleted credential or consumer, and the memberships of a deleted user', async () => {
    await db.batch([insertService('svc_1'), insertConsumer('cpr_1')]);
    const user = await createUser({ email: 'u@example.com', role: 'viewer' });
    const tokens = await createTeam({
      name: 'Credentials',
      tokens: { svc_1: { level: 1 } },
      members: [user],
    });
    const consumers = await createTeam({
      name: 'Credential access rules',
      consumers: { cpr_1: { level: 1 } },
    });
    await db.prepare("DELETE FROM credentials WHERE id = 'svc_1'").run();
    await db.prepare("DELETE FROM credential_access_rules WHERE id = 'cpr_1'").run();
    expect(await count('team_tokens')).toBe(0);
    expect(await count('team_consumers')).toBe(0);
    await db.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
    expect(await count('team_members')).toBe(0);
    expect(await count('teams WHERE id IN (?, ?)', tokens, consumers)).toBe(2);
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
    const reader = await createTeam({ name: 'Readers', tokens: { all: 1 }, consumers: { all: 1 } });
    await joinTeam('tea_viewer').run();
    await joinTeam(reader).run();
    await joinTeam('tea_admin').run();
    expect(
      await db.prepare("SELECT value FROM settings WHERE key = 'join_team'").first('value'),
    ).toBe('"tea_admin"');
  });

  it('refuses Owners, owner-grade permissions, reveal and unknown teams', async () => {
    await insertService('svc_1').run();
    const managers = await createTeam({ name: 'Managers', permissions: ['users:write'] });
    const settings = await createTeam({ name: 'Settings', permissions: ['settings:write'] });
    const keys = await createTeam({ name: 'Keys', permissions: ['keyring:rewrap'] });
    const allReveal = await createTeam({ name: 'All reveal', tokens: { all: 1, reveal: true } });
    const rowReveal = await createTeam({
      name: 'Row reveal',
      tokens: { svc_1: { level: 1, reveal: true } },
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
    await insertService('svc_1').run();
    const team = await createTeam({ name: 'Readers', tokens: { svc_1: { level: 1 } } });
    await joinTeam(team).run();
    expect(await refused(db.prepare('DELETE FROM teams WHERE id = ?').bind(team))).toContain(
      'default_team',
    );
    for (const permission of ['users:write', 'settings:write', 'keyring:rewrap']) {
      expect(
        await refused(
          db.prepare('INSERT INTO team_permissions VALUES (?, ?)').bind(team, permission),
        ),
        permission,
      ).toContain('join_team_unsafe');
    }
    // Elevated but join-safe permissions stay allowed (the ops ask for a confirmation).
    await db.prepare("INSERT INTO team_permissions VALUES (?, 'tokens:create')").bind(team).run();
    expect(
      await refused(db.prepare('UPDATE team_tokens SET reveal = 1 WHERE team_id = ?').bind(team)),
    ).toContain('join_team_unsafe');
    await insertService('svc_2').run();
    expect(
      await refused(db.prepare("INSERT INTO team_tokens VALUES (?, 'svc_2', 1, 1)").bind(team)),
    ).toContain('join_team_unsafe');
    await db.batch([
      db.prepare('DELETE FROM team_tokens WHERE team_id = ?').bind(team),
      db.prepare('UPDATE teams SET tokens_all = 1 WHERE id = ?').bind(team),
    ]);
    expect(
      await refused(db.prepare('UPDATE teams SET tokens_all_reveal = 1 WHERE id = ?').bind(team)),
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

  it('accepts ids and the "*" sentinel', async () => {
    await audit('["svc_1","cpr_1","*"]').run();
    expect(await count('audit_log')).toBe(1);
  });
});
