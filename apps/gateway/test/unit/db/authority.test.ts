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

beforeEach(resetControlPlane);

describe('I-SESS-1: the actor check, claim by claim', () => {
  beforeEach(async () => {
    await db.batch([
      insertService('svc_a'),
      insertService('svc_b'),
      insertConsumer('cpr_x'),
      insertConsumer('cpr_y'),
    ]);
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
      permissions: ['tokens:create'],
      members: [user],
    });
    const other = await createTeam({ name: 'Other', permissions: ['consumers:create'] });
    expect(await passes(actor, [{ k: 'perm', p: 'tokens:create' }])).toBe(true);
    expect(await passes(actor, [{ k: 'perm', p: 'consumers:create' }])).toBe(false);
    expect(await passes(actor, [{ k: 'member', t: creators, p: 'tokens:create' }])).toBe(true);
    expect(await passes(actor, [{ k: 'member', t: creators, p: 'consumers:create' }])).toBe(false);
    expect(await passes(actor, [{ k: 'member', t: other, p: 'consumers:create' }])).toBe(false);
  });

  it('token, credential access rule and credential_reveal: an explicit row or an all-scope', async () => {
    const { user, actor } = await actorFor('a@example.com');
    await createTeam({
      name: 'Payments',
      tokens: { svc_a: { level: 2, reveal: true } },
      consumers: { all: 1 },
      members: [user],
    });
    expect(await passes(actor, [{ k: 'token', id: 'svc_a', l: 2 }])).toBe(true);
    expect(await passes(actor, [{ k: 'token', id: 'svc_a', l: 3 }])).toBe(false);
    expect(await passes(actor, [{ k: 'token', id: 'svc_b', l: 1 }])).toBe(false);
    expect(await passes(actor, [{ k: 'token_reveal', id: 'svc_a' }])).toBe(true);
    expect(await passes(actor, [{ k: 'token_reveal', id: 'svc_b' }])).toBe(false);
    expect(await passes(actor, [{ k: 'consumer', id: 'cpr_y', l: 1 }])).toBe(true);
    expect(await passes(actor, [{ k: 'consumer', id: 'cpr_y', l: 2 }])).toBe(false);
    // Powers combine over teams: one team gives view, another edit.
    await createTeam({ name: 'Editors', consumers: { cpr_x: { level: 2 } }, members: [user] });
    expect(await passes(actor, [{ k: 'consumer', id: 'cpr_x', l: 2 }])).toBe(true);
    expect(await passes(actor, [{ k: 'consumer', id: 'cpr_y', l: 2 }])).toBe(false);
  });

  it('token_all, consumer_all and token_all_reveal: all-scopes only', async () => {
    const { user, actor } = await actorFor('a@example.com');
    await createTeam({
      name: 'Rows',
      tokens: { svc_a: { level: 3, reveal: true } },
      members: [user],
    });
    expect(await passes(actor, [{ k: 'token_all', l: 1 }])).toBe(false);
    expect(await passes(actor, [{ k: 'token_all_reveal' }])).toBe(false);
    await addMember('tea_token_manager', user.id);
    expect(await passes(actor, [{ k: 'token_all', l: 3 }])).toBe(true);
    expect(await passes(actor, [{ k: 'consumer_all', l: 1 }])).toBe(true);
    expect(await passes(actor, [{ k: 'consumer_all', l: 2 }])).toBe(false);
    expect(await passes(actor, [{ k: 'token_all_reveal' }])).toBe(false);
    await addMember('tea_owner', user.id);
    expect(await passes(actor, [{ k: 'token_all_reveal' }])).toBe(true);
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

  it('dominates_team: every permission, all-scope and explicit row of the team', async () => {
    const { user, actor } = await actorFor('a@example.com');
    await createTeam({
      name: 'Manager',
      permissions: ['users:write', 'tokens:create'],
      tokens: { svc_a: { level: 2 } },
      consumers: { all: 1 },
      members: [user],
    });
    const weaker = await createTeam({
      name: 'Weaker',
      permissions: ['tokens:create'],
      tokens: { svc_a: { level: 1 } },
      consumers: { cpr_x: { level: 1 } },
    });
    const hiddenRow = await createTeam({ name: 'Hidden row', tokens: { svc_b: { level: 1 } } });
    const reveal = await createTeam({
      name: 'Reveal',
      tokens: { svc_a: { level: 1, reveal: true } },
    });
    const morePerms = await createTeam({ name: 'Exporters', permissions: ['config:export'] });
    const allTokens = await createTeam({ name: 'All tokens', tokens: { all: 1 } });
    // Amendment A1: a team that holds users:write is dominated like any other team.
    const managers = await createTeam({ name: 'Managers', permissions: ['users:write'] });
    const dominates = (t: string) => passes(actor, [{ k: 'dominates_team', t }]);
    expect(await dominates(weaker)).toBe(true);
    expect(await dominates(managers)).toBe(true);
    expect(await dominates(hiddenRow)).toBe(false);
    expect(await dominates(reveal)).toBe(false);
    expect(await dominates(morePerms)).toBe(false);
    expect(await dominates(allTokens)).toBe(false);
    expect(await dominates('tea_viewer')).toBe(false);
    expect(await dominates('tea_01HZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false);
  });

  it('dominates_team: only an Owners member dominates the Owners team', async () => {
    const { user, actor } = await actorFor('a@example.com');
    // A custom team with every power of Owners is still not Owners.
    await createTeam({
      name: 'Shadow owners',
      permissions: [...GLOBAL_PERMISSIONS],
      tokens: { all: 3, reveal: true },
      consumers: { all: 3 },
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
    const hidden = await createTeam({ name: 'Hidden', tokens: { svc_b: { level: 1 } } });
    expect(await passes(actor, [claim])).toBe(true);
    await addMember(hidden, target.id);
    expect(await passes(actor, [claim])).toBe(true); // admins see every token
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
    ['dominates_user without u', { k: 'dominates_user' }],
    ['dominates_user with an unknown user', { k: 'dominates_user', u: 'usr_nobody' }],
    ['dominates_user with a numeric u', { k: 'dominates_user', u: 1 }],
    ['not_self without u', { k: 'not_self' }],
    ['dominates_team without t', { k: 'dominates_team' }],
    ['not_member without t', { k: 'not_member' }],
    ['member without p', { k: 'member', t: 'tea_owner' }],
    ['perm without p', { k: 'perm' }],
    ['token without id', { k: 'token', l: 1 }],
    ['token_reveal without id', { k: 'token_reveal' }],
    ['token with level 0', { k: 'token', id: 'svc_a', l: 0 }],
    ['token with level -1', { k: 'token', id: 'svc_a', l: -1 }],
    ['token with level 4', { k: 'token', id: 'svc_a', l: 4 }],
    ['token with level 1.5', { k: 'token', id: 'svc_a', l: 1.5 }],
    ['token with level "1"', { k: 'token', id: 'svc_a', l: '1' }],
    ['token with level null', { k: 'token', id: 'svc_a', l: null }],
    ['token without level', { k: 'token', id: 'svc_a' }],
    ['consumer with level 0', { k: 'consumer', id: 'cpr_x', l: 0 }],
    ['token_all with level 0', { k: 'token_all', l: 0 }],
    ['token_all with level "1"', { k: 'token_all', l: '1' }],
    ['consumer_all with level null', { k: 'consumer_all', l: null }],
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

const SERVICES = ['svc_a', 'svc_b', 'svc_c', 'svc_d'];
const CONSUMERS = ['cpr_w', 'cpr_x', 'cpr_y', 'cpr_z'];
const WORLDS = 50;
const CLAIM_LISTS_PER_WORLD = 10;

async function readWorld(): Promise<World> {
  const all = async <R>(sql: string) => (await db.prepare(sql).all<R>()).results;
  return {
    users: await all<{ id: string; status: string }>('SELECT id, status FROM users'),
    identities: await all(
      'SELECT login_provider AS loginProvider, subject, user_id AS userId FROM user_identities',
    ),
    teams: await all(
      `SELECT id, tokens_all AS tokensAll, tokens_all_reveal AS tokensAllReveal,
         consumers_all AS consumersAll FROM teams`,
    ),
    members: await all('SELECT team_id AS teamId, user_id AS userId FROM team_members'),
    permissions: await all('SELECT team_id AS teamId, permission FROM team_permissions'),
    teamTokens: await all(
      'SELECT team_id AS teamId, service_id AS serviceId, level, reveal FROM team_tokens',
    ),
    teamConsumers: await all(
      'SELECT team_id AS teamId, credential_access_rule_id AS consumerId, level FROM team_consumers',
    ),
  };
}

describe('I-SESS-1: the actor check agrees with the JS model (property test)', () => {
  it(`${WORLDS * CLAIM_LISTS_PER_WORLD} random cases, malformed claims included`, async () => {
    let checked = 0;
    let passed = 0;
    for (let seed = 1; seed <= WORLDS; seed++) {
      const random = prng(seed);
      const pick = <V>(values: readonly V[]): V =>
        values[Math.floor(random() * values.length)] as V;
      const chance = (p: number) => random() < p;
      await resetControlPlane();
      await db.batch([...SERVICES.map(insertService), ...CONSUMERS.map(insertConsumer)]);

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

      // Custom teams: random permissions, and per kind none, all or a list.
      const customs: string[] = [];
      const teamCount = Math.floor(random() * 5);
      for (let i = 0; i < teamCount; i++) {
        const level = () => pick([1, 2, 3] as const);
        const tokens = chance(0.35)
          ? { all: level(), reveal: chance(0.3) }
          : Object.fromEntries(
              SERVICES.filter(() => chance(0.4)).map((id) => [
                id,
                { level: level(), reveal: chance(0.3) },
              ]),
            );
        const consumers = chance(0.35)
          ? { all: level() }
          : Object.fromEntries(
              CONSUMERS.filter(() => chance(0.4)).map((id) => [id, { level: level() }]),
            );
        customs.push(
          await createTeam({
            name: `Team ${seed}-${i}`,
            permissions: GLOBAL_PERMISSIONS.filter(() => chance(0.25)),
            tokens,
            consumers,
          }),
        );
      }
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
              p: pick(['tokens:create', 'consumers:create']),
            };
          case 3:
            return { k: 'token', id: text([...SERVICES, 'svc_none']), l: level() };
          case 4:
            return { k: 'consumer', id: text([...CONSUMERS, 'cpr_none']), l: level() };
          case 5:
            return { k: 'token_reveal', id: text([...SERVICES, 'svc_none']) };
          case 6:
            return { k: pick(['token_all', 'consumer_all']), l: level() };
          case 7:
            return { k: 'token_all_reveal' };
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
            ]);
          default:
            return { k: pick(['token', 'consumer']), l: validLevel() };
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
        expect({ seed, case: i, claims: json, actual }).toEqual({
          seed,
          case: i,
          claims: json,
          actual: expected,
        });
        checked++;
        if (actual) passed++;
      }

      // The JS form (scope.ts) agrees too: dominatesTeam per team and holds per resource.
      if (world.users.find((u) => u.id === actor.userId)?.status === 'active') {
        const scope = await loadScope(db, actor.userId);
        const inOwners = scope.teams.some((team) => team.builtin === 'owner');
        for (const teamId of teamIds) {
          const powers = await getTeamPowers(db, teamId);
          if (!powers) throw new Error(`missing team ${teamId}`);
          expect({ seed, teamId, js: dominatesTeam(scope, powers, inOwners) }).toEqual({
            seed,
            teamId,
            js: await passes(actor, [{ k: 'dominates_team', t: teamId }]),
          });
        }
        for (let i = 0; i < 6; i++) {
          const kind = pick(['token', 'consumer'] as const);
          const id = pick(kind === 'token' ? SERVICES : CONSUMERS);
          const need = pick(
            kind === 'token'
              ? (['view', 'edit', 'delete', 'reveal'] as const)
              : (['view', 'edit', 'delete'] as const),
          ) as Need;
          const sqlClaim =
            need === 'reveal'
              ? { k: 'token_reveal', id }
              : { k: kind, id, l: { view: 1, edit: 2, delete: 3 }[need] };
          expect({ seed, kind, id, need, js: holds(scope, { kind, id, need }) }).toEqual({
            seed,
            kind,
            id,
            need,
            js: await passes(actor, [sqlClaim]),
          });
        }
      }
    }
    expect(checked).toBe(WORLDS * CLAIM_LISTS_PER_WORLD);
    // The generator must reach both outcomes often enough to mean something.
    expect(passed).toBeGreaterThan(checked * 0.1);
    expect(passed).toBeLessThan(checked * 0.9);
  }, 120_000);
});
