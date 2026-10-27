// The actor check of src/db/authority.ts (I-SESS-1): hand-built fixtures for every claim kind, then
// a property test with a seeded PRNG. The property test builds random teams, memberships, scopes
// and claims (malformed ones too) and requires that three forms agree: the D1 statement, the JS
// model in test/helpers/authority-model.ts and the JS form in src/admin/auth/scope.ts.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { dominatesTeam, holds, loadScope, type Need } from '../../../src/admin/auth/scope';
import { ACTOR_CHECK_MARKER, actorCheckStatement, type Claim } from '../../../src/db/authority';
import { BUILTIN_TEAM_ORDER, GLOBAL_PERMISSIONS, getTeamPowers } from '../../../src/db/teams';
import { createUser, resetControlPlane } from '../../helpers/admin-auth';
import { type ActorRef, evaluateClaims, type World } from '../../helpers/authority-model';
import { addMember, createTeam } from '../../helpers/teams';

const db = env.DB;
const T = 1_700_000_000_000;
const PROVIDER = 'access';

/** True when the check lets the batch go on; false when it raises with the marker. */
async function passes(actor: ActorRef, claims: unknown): Promise<boolean> {
  try {
    await actorCheckStatement(db, { ...actor, claims: claims as Claim[] }).all();
    return true;
  } catch (error) {
    const text =
      error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
    // Every refusal is the marker error, never another SQL error (fail closed, and recognizable).
    expect(text).toContain(ACTOR_CHECK_MARKER);
    return false;
  }
}

async function actorFor(email: string, status: 'active' | 'suspended' = 'active') {
  const user = await createUser({
    email,
    role: 'viewer',
    status,
    identity: { loginProvider: PROVIDER, subject: `sub|${email}` },
  });
  return { user, actor: { userId: user.id, loginProvider: PROVIDER, subject: `sub|${email}` } };
}

const insertCredential = (id: string) => {
  const slug = id.toLowerCase().replace('_', '-');
  return db
    .prepare(
      `INSERT INTO credentials (id, slug, name, base_url, injection, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{"kind":"bearer"}', ?, ?)`,
    )
    .bind(id, slug, id, `https://${slug}.example.com`, T, T);
};

/** The two triggers that hold access_rules:global to all-scope view (D23). */
const D23_TRIGGERS = ['team_permissions_global_rules_scope', 'teams_global_rules_scope'];

/**
 * Runs `body` with the D23 triggers dropped, then re-creates them from their stored SQL. The SQL
 * check and the model must agree even on worlds that D23 forbids (defence in depth).
 */
async function withoutD23<R>(body: () => Promise<R>): Promise<R> {
  const { results: triggers } = await db
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${D23_TRIGGERS.map(() => '?').join(', ')})`,
    )
    .bind(...D23_TRIGGERS)
    .all<{ name: string; sql: string }>();
  if (triggers.length !== D23_TRIGGERS.length) throw new Error('D23 triggers missing');
  await db.batch(triggers.map((trigger) => db.prepare(`DROP TRIGGER ${trigger.name}`)));
  try {
    return await body();
  } finally {
    await db.batch(triggers.map((trigger) => db.prepare(trigger.sql)));
  }
}

beforeEach(resetControlPlane);

describe('I-SESS-1: the actor check, claim by claim', () => {
  beforeEach(async () => {
    await db.batch([insertCredential('svc_a'), insertCredential('svc_b')]);
  });

  it('requires the linked identity of an active user and a non-empty claim list', async () => {
    const { user, actor } = await actorFor('a@example.com');
    await addMember('tea_viewer', user.id);
    expect(await passes(actor, [{ k: 'read' }])).toBe(true);
    expect(await passes(actor, [])).toBe(false);
    expect(await passes(actor, {})).toBe(false);
    expect(await passes({ ...actor, subject: 'sub|other' }, [{ k: 'read' }])).toBe(false);
    expect(await passes({ ...actor, loginProvider: 'other' }, [{ k: 'read' }])).toBe(false);
    const { user: suspended, actor: suspendedActor } = await actorFor('s@example.com', 'suspended');
    await addMember('tea_viewer', suspended.id);
    expect(await passes(suspendedActor, [{ k: 'read' }])).toBe(false);
  });

  it('read: a member of at least one team', async () => {
    const { user, actor } = await actorFor('a@example.com');
    expect(await passes(actor, [{ k: 'read' }])).toBe(false);
    await createTeam({ name: 'Empty', members: [user] });
    expect(await passes(actor, [{ k: 'read' }])).toBe(true);
  });

  it('perm and member: a global permission, and the receiving team', async () => {
    const { user, actor } = await actorFor('a@example.com');
    const creators = await createTeam({
      name: 'Creators',
      permissions: ['credentials:create'],
      members: [user],
    });
    const other = await createTeam({ name: 'Other', permissions: ['credentials:create'] });
    const exporters = await createTeam({
      name: 'Exporters',
      permissions: ['config:export'],
      members: [user],
    });
    expect(await passes(actor, [{ k: 'perm', p: 'credentials:create' }])).toBe(true);
    expect(await passes(actor, [{ k: 'perm', p: 'users:write' }])).toBe(false);
    expect(await passes(actor, [{ k: 'member', t: creators, p: 'credentials:create' }])).toBe(true);
    expect(await passes(actor, [{ k: 'member', t: other, p: 'credentials:create' }])).toBe(false);
    expect(await passes(actor, [{ k: 'member', t: exporters, p: 'credentials:create' }])).toBe(
      false,
    );
  });

  it('credential and credential_flag: an explicit row or an all-scope, unioned over teams', async () => {
    const { user, actor } = await actorFor('a@example.com');
    await createTeam({
      name: 'Payments',
      credentials: { svc_a: { level: 2, reveal: true } },
      members: [user],
    });
    const flag = (id: string, f: string) => passes(actor, [{ k: 'credential_flag', id, f }]);
    expect(await passes(actor, [{ k: 'credential', id: 'svc_a', l: 2 }])).toBe(true);
    expect(await passes(actor, [{ k: 'credential', id: 'svc_a', l: 3 }])).toBe(false);
    expect(await passes(actor, [{ k: 'credential', id: 'svc_b', l: 1 }])).toBe(false);
    expect(await flag('svc_a', 'reveal')).toBe(true);
    expect(await flag('svc_a', 'access_rules')).toBe(false);
    expect(await flag('svc_b', 'reveal')).toBe(false);
    // Powers combine over teams: one team gives view, another the access_rules flag.
    await createTeam({
      name: 'Rules',
      credentials: { svc_b: { level: 1, accessRules: true } },
      members: [user],
    });
    expect(await flag('svc_b', 'access_rules')).toBe(true);
    expect(await flag('svc_b', 'reveal')).toBe(false);
    expect(await flag('svc_a', 'access_rules')).toBe(false);
    // An all-scope covers every credential, with its flags.
    await addMember('tea_access_manager', user.id);
    expect(await passes(actor, [{ k: 'credential', id: 'svc_b', l: 1 }])).toBe(true);
    expect(await passes(actor, [{ k: 'credential', id: 'svc_none', l: 1 }])).toBe(true);
    expect(await flag('svc_a', 'access_rules')).toBe(true);
    expect(await flag('svc_b', 'reveal')).toBe(false);
  });

  it('credential_all and credential_all_flag: all-scopes only', async () => {
    const { user, actor } = await actorFor('a@example.com');
    await createTeam({
      name: 'Rows',
      credentials: { svc_a: { level: 3, reveal: true, accessRules: true } },
      members: [user],
    });
    const allFlag = (f: string) => passes(actor, [{ k: 'credential_all_flag', f }]);
    expect(await passes(actor, [{ k: 'credential_all', l: 1 }])).toBe(false);
    expect(await allFlag('reveal')).toBe(false);
    expect(await allFlag('access_rules')).toBe(false);
    await addMember('tea_token_manager', user.id);
    expect(await passes(actor, [{ k: 'credential_all', l: 3 }])).toBe(true);
    expect(await allFlag('reveal')).toBe(false);
    expect(await allFlag('access_rules')).toBe(false);
    await addMember('tea_access_manager', user.id);
    expect(await allFlag('access_rules')).toBe(true);
    expect(await allFlag('reveal')).toBe(false);
    await addMember('tea_owner', user.id);
    expect(await allFlag('reveal')).toBe(true);
  });

  it('access_rules:global implies access_rules on every visible credential, never the reverse', async () => {
    const { user, actor } = await actorFor('a@example.com');
    const flag = (id: string) => passes(actor, [{ k: 'credential_flag', id, f: 'access_rules' }]);
    await createTeam({
      name: 'Global rules',
      permissions: ['access_rules:global'],
      credentials: { all: 1 },
      members: [user],
    });
    expect(await flag('svc_a')).toBe(true);
    expect(await flag('svc_none')).toBe(true);
    expect(await passes(actor, [{ k: 'credential_all_flag', f: 'access_rules' }])).toBe(true);
    // The implication gives no level and no reveal.
    expect(await passes(actor, [{ k: 'credential', id: 'svc_a', l: 2 }])).toBe(false);
    expect(await passes(actor, [{ k: 'credential_flag', id: 'svc_a', f: 'reveal' }])).toBe(false);
    // The flag alone never gives the permission.
    const { user: other, actor: otherActor } = await actorFor('b@example.com');
    await addMember('tea_access_manager', other.id);
    await createTeam({
      name: 'Rows',
      credentials: { svc_a: { level: 3, accessRules: true } },
      members: [other],
    });
    expect(await passes(otherActor, [{ k: 'credential_all_flag', f: 'access_rules' }])).toBe(true);
    expect(await passes(otherActor, [{ k: 'perm', p: 'access_rules:global' }])).toBe(false);
  });

  it('without D23, the implication still covers only the credentials the actor can view', async () => {
    const { user, actor } = await actorFor('a@example.com');
    await withoutD23(async () => {
      await createTeam({
        name: 'Global rules, no scope',
        permissions: ['access_rules:global'],
        members: [user],
      });
      await createTeam({
        name: 'View A',
        credentials: { svc_a: { level: 1 } },
        members: [user],
      });
    });
    const flag = (id: string) => passes(actor, [{ k: 'credential_flag', id, f: 'access_rules' }]);
    expect(await passes(actor, [{ k: 'perm', p: 'access_rules:global' }])).toBe(true);
    expect(await flag('svc_a')).toBe(true);
    expect(await flag('svc_b')).toBe(false);
    expect(await passes(actor, [{ k: 'credential_all_flag', f: 'access_rules' }])).toBe(false);
  });

  it('not_self and not_member', async () => {
    const { user, actor } = await actorFor('a@example.com');
    const mine = await createTeam({ name: 'Mine', members: [user] });
    const theirs = await createTeam({ name: 'Theirs' });
    expect(await passes(actor, [{ k: 'not_self', u: 'usr_someone' }])).toBe(true);
    expect(await passes(actor, [{ k: 'not_self', u: user.id }])).toBe(false);
    expect(await passes(actor, [{ k: 'read' }, { k: 'not_member', t: theirs }])).toBe(true);
    expect(await passes(actor, [{ k: 'not_member', t: mine }])).toBe(false);
    expect(await passes(actor, [{ k: 'not_member', t: 'tea_01HZZZZZZZZZZZZZZZZZZZZZZZ' }])).toBe(
      false,
    );
  });

  it('dominates_team: every permission, all-scope, flag and explicit row of the team', async () => {
    const { user, actor } = await actorFor('a@example.com');
    await createTeam({
      name: 'Manager',
      permissions: ['users:write', 'credentials:create'],
      credentials: { svc_a: { level: 2, accessRules: true } },
      members: [user],
    });
    const weaker = await createTeam({
      name: 'Weaker',
      permissions: ['credentials:create'],
      credentials: { svc_a: { level: 1, accessRules: true } },
    });
    const hiddenRow = await createTeam({
      name: 'Hidden row',
      credentials: { svc_b: { level: 1 } },
    });
    const reveal = await createTeam({
      name: 'Reveal',
      credentials: { svc_a: { level: 1, reveal: true } },
    });
    const morePerms = await createTeam({ name: 'Exporters', permissions: ['config:export'] });
    const allView = await createTeam({ name: 'All view', credentials: { all: 1 } });
    // Amendment A1: a team that holds users:write is dominated like any other team.
    const managers = await createTeam({ name: 'Managers', permissions: ['users:write'] });
    const dominates = (t: string) => passes(actor, [{ k: 'dominates_team', t }]);
    expect(await dominates(weaker)).toBe(true);
    expect(await dominates(managers)).toBe(true);
    expect(await dominates(hiddenRow)).toBe(false);
    expect(await dominates(reveal)).toBe(false);
    expect(await dominates(morePerms)).toBe(false);
    expect(await dominates(allView)).toBe(false);
    expect(await dominates('tea_viewer')).toBe(false);
    expect(await dominates('tea_01HZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false);
  });

  it('dominates_team: the access_rules flag needs the flag or access_rules:global with view', async () => {
    const { user, actor } = await actorFor('a@example.com');
    const rowRules = await createTeam({
      name: 'Rules on A',
      credentials: { svc_a: { level: 1, accessRules: true } },
    });
    const allRules = await createTeam({
      name: 'All rules',
      credentials: { all: 1, accessRules: true },
    });
    const globalRules = await createTeam({
      name: 'Global rules',
      permissions: ['access_rules:global'],
      credentials: { all: 1 },
    });
    const dominates = (t: string) => passes(actor, [{ k: 'dominates_team', t }]);
    // View on A only: a team with access_rules on A is not dominated.
    const viewA = await createTeam({
      name: 'View A',
      credentials: { svc_a: { level: 1 } },
      members: [user],
    });
    expect(await dominates(rowRules)).toBe(false);
    // The flag (all-scope, from Access managers) dominates the flag, not the permission.
    await addMember('tea_access_manager', user.id);
    expect(await dominates(rowRules)).toBe(true);
    expect(await dominates(allRules)).toBe(true);
    expect(await dominates(globalRules)).toBe(false);
    // access_rules:global with view dominates both flags and the permission.
    await db
      .prepare("DELETE FROM team_members WHERE user_id = ? AND team_id = 'tea_access_manager'")
      .bind(user.id)
      .run();
    await createTeam({
      name: 'Global rules member',
      permissions: ['access_rules:global'],
      credentials: { all: 1 },
      members: [user],
    });
    expect(await dominates(rowRules)).toBe(true);
    expect(await dominates(allRules)).toBe(true);
    expect(await dominates(globalRules)).toBe(true);
    expect(await dominates(viewA)).toBe(true);
  });

  it('dominates_team: only an Owners member dominates the Owners team', async () => {
    const { user, actor } = await actorFor('a@example.com');
    // A custom team with every power of Owners is still not Owners.
    await createTeam({
      name: 'Shadow owners',
      permissions: [...GLOBAL_PERMISSIONS],
      credentials: { all: 3, reveal: true, accessRules: true },
      members: [user],
    });
    expect(await passes(actor, [{ k: 'dominates_team', t: 'tea_admin' }])).toBe(true);
    expect(await passes(actor, [{ k: 'dominates_team', t: 'tea_owner' }])).toBe(false);
    await addMember('tea_owner', user.id);
    expect(await passes(actor, [{ k: 'dominates_team', t: 'tea_owner' }])).toBe(true);
  });

  it('dominates_user: every team of the user, and the user exists', async () => {
    const { user, actor } = await actorFor('a@example.com');
    await addMember('tea_admin', user.id);
    const target = await createUser({ email: 't@example.com', role: 'viewer' });
    const claim = { k: 'dominates_user', u: target.id };
    expect(await passes(actor, [claim])).toBe(true); // in no team
    await addMember('tea_viewer', target.id);
    expect(await passes(actor, [claim])).toBe(true);
    const hidden = await createTeam({
      name: 'Hidden',
      credentials: { svc_b: { level: 1, accessRules: true } },
    });
    await addMember(hidden, target.id);
    expect(await passes(actor, [claim])).toBe(true); // admins see every credential
    await addMember('tea_owner', target.id);
    expect(await passes(actor, [claim])).toBe(false);
    expect(await passes(actor, [{ k: 'dominates_user', u: 'usr_unknown' }])).toBe(false);
  });

  it.each([
    ['a bare string', 'read'],
    ['null', null],
    ['an array', [{ k: 'read' }]],
    ['an unknown kind', { k: 'superuser' }],
    ['a missing kind', {}],
    ['the removed kind token', { k: 'token', id: 'svc_a', l: 1 }],
    ['the removed kind consumer', { k: 'consumer', id: 'svc_a', l: 1 }],
    ['the removed kind token_all', { k: 'token_all', l: 1 }],
    ['the removed kind consumer_all', { k: 'consumer_all', l: 1 }],
    ['the removed kind token_reveal', { k: 'token_reveal', id: 'svc_a' }],
    ['the removed kind token_all_reveal', { k: 'token_all_reveal' }],
    ['the removed kind dominates_members', { k: 'dominates_members', t: 'tea_admin' }],
    ['dominates_user without u', { k: 'dominates_user' }],
    ['dominates_user with an unknown user', { k: 'dominates_user', u: 'usr_nobody' }],
    ['dominates_user with a numeric u', { k: 'dominates_user', u: 1 }],
    ['not_self without u', { k: 'not_self' }],
    ['dominates_team without t', { k: 'dominates_team' }],
    ['not_member without t', { k: 'not_member' }],
    ['member without p', { k: 'member', t: 'tea_owner' }],
    ['perm without p', { k: 'perm' }],
    ['credential without id', { k: 'credential', l: 1 }],
    ['credential with level 0', { k: 'credential', id: 'svc_a', l: 0 }],
    ['credential with level -1', { k: 'credential', id: 'svc_a', l: -1 }],
    ['credential with level 4', { k: 'credential', id: 'svc_a', l: 4 }],
    ['credential with level 1.5', { k: 'credential', id: 'svc_a', l: 1.5 }],
    ['credential with level "1"', { k: 'credential', id: 'svc_a', l: '1' }],
    ['credential with level null', { k: 'credential', id: 'svc_a', l: null }],
    ['credential without level', { k: 'credential', id: 'svc_a' }],
    ['credential_all with level 0', { k: 'credential_all', l: 0 }],
    ['credential_all with level "1"', { k: 'credential_all', l: '1' }],
    ['credential_all with level null', { k: 'credential_all', l: null }],
    ['credential_flag without id', { k: 'credential_flag', f: 'reveal' }],
    ['credential_flag without f', { k: 'credential_flag', id: 'svc_a' }],
    ['credential_flag with f "view"', { k: 'credential_flag', id: 'svc_a', f: 'view' }],
    ['credential_flag with f ""', { k: 'credential_flag', id: 'svc_a', f: '' }],
    ['credential_flag with f null', { k: 'credential_flag', id: 'svc_a', f: null }],
    ['credential_flag with f 1', { k: 'credential_flag', id: 'svc_a', f: 1 }],
    [
      'credential_flag with the removed f boundaries',
      { k: 'credential_flag', id: 'svc_a', f: 'boundaries' },
    ],
    [
      'credential_flag with the removed f issuer_rules',
      { k: 'credential_flag', id: 'svc_a', f: 'issuer_rules' },
    ],
    ['credential_all_flag with an unknown f', { k: 'credential_all_flag', f: 'delete' }],
    ['credential_all_flag without f', { k: 'credential_all_flag' }],
  ])('refuses %s, even for an owner', async (_name, claim) => {
    const { user, actor } = await actorFor('o@example.com');
    await addMember('tea_owner', user.id);
    expect(await passes(actor, [{ k: 'read' }])).toBe(true);
    expect(await passes(actor, [{ k: 'read' }, claim])).toBe(false);
  });
});

// ---- Property test --------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG, so a failure can be replayed from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const CREDENTIALS = ['svc_a', 'svc_b', 'svc_c', 'svc_d'];
const FLAGS = ['reveal', 'access_rules'] as const;
const WORLDS = 50;
const CLAIM_LISTS_PER_WORLD = 10;
/** Every WITHOUT_D23-th world is built with the D23 triggers dropped. */
const WITHOUT_D23 = 4;

async function readWorld(): Promise<World> {
  const all = async <R>(sql: string) => (await db.prepare(sql).all<R>()).results;
  return {
    users: await all<{ id: string; status: string }>('SELECT id, status FROM users'),
    identities: await all(
      'SELECT login_provider AS loginProvider, subject, user_id AS userId FROM user_identities',
    ),
    teams: await all(
      `SELECT id, credentials_all AS credentialsAll, credentials_all_reveal AS credentialsAllReveal,
         credentials_all_access_rules AS credentialsAllAccessRules FROM teams`,
    ),
    members: await all('SELECT team_id AS teamId, user_id AS userId FROM team_members'),
    permissions: await all('SELECT team_id AS teamId, permission FROM team_permissions'),
    teamCredentials: await all(
      `SELECT team_id AS teamId, credential_id AS credentialId, level, reveal,
         access_rules AS accessRules FROM team_credentials`,
    ),
  };
}

describe('I-SESS-1: the actor check agrees with the JS model (property test)', () => {
  it(`${WORLDS * CLAIM_LISTS_PER_WORLD} random cases, malformed claims included`, async () => {
    let checked = 0;
    let passed = 0;
    let impliedChecks = 0;
    for (let seed = 1; seed <= WORLDS; seed++) {
      const random = prng(seed);
      const pick = <V>(values: readonly V[]): V =>
        values[Math.floor(random() * values.length)] as V;
      const chance = (p: number) => random() < p;
      const d23 = seed % WITHOUT_D23 !== 0;
      await resetControlPlane();
      await db.batch(CREDENTIALS.map(insertCredential));

      // People: the actor and a few others. Statuses vary; the actor is usually active.
      const actorSeed = await actorFor(
        `actor${seed}@example.com`,
        chance(0.9) ? 'active' : 'suspended',
      );
      const people = [actorSeed.user];
      for (let i = 0; i < 3; i++) {
        people.push(
          await createUser({
            email: `p${i}-${seed}@example.com`,
            role: 'viewer',
            status: pick(['active', 'active', 'suspended', 'pending'] as const),
          }),
        );
      }

      // Custom teams: random permissions, and a scope that is none, all (with flags) or a list.
      // With D23, access_rules:global goes only to teams with all-scope view.
      const customs: string[] = [];
      const teamCount = Math.floor(random() * 5);
      const build = async () => {
        for (let i = 0; i < teamCount; i++) {
          const level = () => pick([1, 2, 3] as const);
          const all = chance(0.35);
          const credentials = all
            ? { all: level(), reveal: chance(0.3), accessRules: chance(0.3) }
            : Object.fromEntries(
                CREDENTIALS.filter(() => chance(0.4)).map((id) => [
                  id,
                  { level: level(), reveal: chance(0.3), accessRules: chance(0.3) },
                ]),
              );
          const permissions = GLOBAL_PERMISSIONS.filter(
            (p) =>
              chance(p === 'access_rules:global' ? 0.35 : 0.25) &&
              (all || !d23 || p !== 'access_rules:global'),
          );
          customs.push(await createTeam({ name: `Team ${seed}-${i}`, permissions, credentials }));
        }
      };
      await (d23 ? build() : withoutD23(build));
      const teamIds = [...BUILTIN_TEAM_ORDER.map((key) => `tea_${key}`), ...customs];
      // Memberships: the actor joins 0 to 3 teams, built-ins less often; others join at random.
      for (const person of people) {
        for (const team of teamIds) {
          const builtin = !customs.includes(team);
          if (chance(builtin ? 0.12 : 0.35)) await addMember(team, person.id);
        }
      }
      const world = await readWorld();
      const actor: ActorRef = actorSeed.actor;
      const userIds = [...people.map((p) => p.id), 'usr_unknown'];
      const knownTeams = [...teamIds, 'tea_01HZZZZZZZZZZZZZZZZZZZZZZZ'];

      const validLevel = () => pick([1, 2, 3]);
      const badLevel = () => pick([0, -1, 4, 1.5, '1', null, undefined, true]);
      const level = () => (chance(0.85) ? validLevel() : badLevel());
      const text = <V>(values: readonly V[]) =>
        chance(0.9) ? pick(values) : pick([undefined, null, 7]);
      const flag = () =>
        chance(0.85)
          ? pick(FLAGS)
          : pick(['view', '', null, 1, undefined, 'boundaries', 'issuer_rules']);
      const claim = (): unknown => {
        switch (Math.floor(random() * 16)) {
          case 0:
            return { k: 'read' };
          case 1:
            return {
              k: 'perm',
              p: chance(0.9) ? pick(GLOBAL_PERMISSIONS) : pick(['read', 1, undefined]),
            };
          case 2:
            return {
              k: 'member',
              t: text(knownTeams),
              p: pick(['credentials:create', 'config:export']),
            };
          case 3:
            return { k: 'credential', id: text([...CREDENTIALS, 'svc_none']), l: level() };
          case 4:
          case 5:
            return { k: 'credential_flag', id: text([...CREDENTIALS, 'svc_none']), f: flag() };
          case 6:
            return { k: 'credential_all', l: level() };
          case 7:
            return { k: 'credential_all_flag', f: flag() };
          case 8:
          case 9:
            return { k: 'dominates_team', t: text(knownTeams) };
          case 10:
          case 11:
            return { k: 'dominates_user', u: text(userIds) };
          case 12:
            return { k: 'not_member', t: text(knownTeams) };
          case 13:
            return { k: 'not_self', u: text(userIds) };
          case 14:
            return pick([
              'read',
              null,
              3,
              [],
              { k: 'superuser' },
              {},
              { k: 'dominates_members', t: customs[0] ?? 'tea_admin' },
              { k: 'token', id: 'svc_a', l: 1 },
              { k: 'consumer', id: 'svc_a', l: 1 },
              { k: 'token_all', l: 1 },
              { k: 'consumer_all', l: 1 },
              { k: 'token_reveal', id: 'svc_a' },
            ]);
          default:
            return { k: 'credential', l: validLevel() };
        }
      };

      for (let i = 0; i < CLAIM_LISTS_PER_WORLD; i++) {
        const claims = Array.from(
          { length: chance(0.05) ? 0 : 1 + Math.floor(random() * 3) },
          claim,
        );
        const who: ActorRef = chance(0.05) ? { ...actor, subject: 'sub|someone-else' } : actor;
        // The statement sees the claims through JSON, so the model does too.
        const json: unknown = JSON.parse(JSON.stringify(claims));
        const expected = evaluateClaims(world, who, json);
        const actual = await passes(who, claims);
        expect({ seed, d23, case: i, claims: json, actual }).toEqual({
          seed,
          d23,
          case: i,
          claims: json,
          actual: expected,
        });
        checked++;
        if (actual) passed++;
      }

      // The JS form (scope.ts) agrees too: dominatesTeam per team and holds per credential.
      if (world.users.find((u) => u.id === actor.userId)?.status === 'active') {
        const scope = await loadScope(db, actor.userId);
        const inOwners = scope.teams.some((team) => team.builtin === 'owner');
        for (const teamId of teamIds) {
          const powers = await getTeamPowers(db, teamId);
          if (!powers) throw new Error(`missing team ${teamId}`);
          expect({ seed, d23, teamId, js: dominatesTeam(scope, powers, inOwners) }).toEqual({
            seed,
            d23,
            teamId,
            js: await passes(actor, [{ k: 'dominates_team', t: teamId }]),
          });
        }
        for (const id of [...CREDENTIALS, 'svc_none']) {
          for (const need of ['view', 'edit', 'delete', 'reveal', 'access_rules'] as const) {
            const sqlClaim =
              need === 'reveal' || need === 'access_rules'
                ? { k: 'credential_flag', id, f: need }
                : { k: 'credential', id, l: { view: 1, edit: 2, delete: 3 }[need] };
            const js = holds(scope, { id, need: need as Need });
            expect({ seed, d23, id, need, js }).toEqual({
              seed,
              d23,
              id,
              need,
              js: await passes(actor, [sqlClaim]),
            });
            const implied =
              need === 'access_rules' && js && scope.permissions.has('access_rules:global');
            if (implied) impliedChecks++;
          }
        }
      }
    }
    expect(checked).toBe(WORLDS * CLAIM_LISTS_PER_WORLD);
    // The generator must reach both outcomes often enough to mean something.
    expect(passed).toBeGreaterThan(checked * 0.1);
    expect(passed).toBeLessThan(checked * 0.9);
    // And it must reach the implication of access_rules:global.
    expect(impliedChecks).toBeGreaterThan(0);
  }, 180_000);
});
