// A pure JS model of the actor check (src/db/authority.ts, I-SESS-1), written from the design and
// independent of src/admin/auth/scope.ts. The property test compares it with the D1 result.
// It reads raw rows, as stored, and takes the claims as `unknown` so malformed claims can be
// modelled too. The implication of access_rules:global (the access_rules flag on every credential
// the actor can view) is written here on its own, per claim, not copied from the SQL.

export interface WorldTeam {
  id: string;
  credentialsAll: number;
  credentialsAllReveal: number;
  credentialsAllAccessRules: number;
}

export interface World {
  users: ReadonlyArray<{ id: string; status: string }>;
  /** Login identities: (login provider, subject) → user id. */
  identities: ReadonlyArray<{ loginProvider: string; subject: string; userId: string }>;
  teams: readonly WorldTeam[];
  members: ReadonlyArray<{ teamId: string; userId: string }>;
  permissions: ReadonlyArray<{ teamId: string; permission: string }>;
  teamCredentials: ReadonlyArray<{
    teamId: string;
    credentialId: string;
    level: number;
    reveal: number;
    accessRules: number;
  }>;
}

export interface ActorRef {
  userId: string;
  loginProvider: string;
  subject: string;
}

const FLAGS = ['reveal', 'access_rules'];

const isText = (value: unknown): value is string => typeof value === 'string';
/** JSON integers 1 to 3. JSON.stringify writes 1.0 as 1, so it is an integer too. */
const isLevel = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3;
const isFlag = (value: unknown): value is string => isText(value) && FLAGS.includes(value);

function actorTeams(world: World, actorId: string): WorldTeam[] {
  const ids = new Set(world.members.filter((m) => m.userId === actorId).map((m) => m.teamId));
  return world.teams.filter((team) => ids.has(team.id));
}

function holdsPermission(world: World, actorId: string, permission: string): boolean {
  const teams = new Set(actorTeams(world, actorId).map((team) => team.id));
  return world.permissions.some((p) => teams.has(p.teamId) && p.permission === permission);
}

/** Actor holds level `l` on credential `id`: an all-scope or an explicit row of one of its teams. */
function credentialLevel(world: World, actorId: string, id: string, l: number): boolean {
  return actorTeams(world, actorId).some(
    (team) =>
      team.credentialsAll >= l ||
      world.teamCredentials.some(
        (x) => x.teamId === team.id && x.credentialId === id && x.level >= l,
      ),
  );
}

/** Actor holds the all-scope flag `f`. access_rules:global with all-scope view gives access_rules. */
function allFlag(world: World, actorId: string, f: string): boolean {
  const teams = actorTeams(world, actorId);
  if (f === 'reveal') return teams.some((team) => team.credentialsAllReveal === 1);
  return (
    teams.some((team) => team.credentialsAllAccessRules === 1) ||
    (holdsPermission(world, actorId, 'access_rules:global') &&
      teams.some((team) => team.credentialsAll >= 1))
  );
}

/**
 * Actor holds flag `f` on credential `id`: an all-scope flag or the flag on a row of one of its
 * teams. access_rules:global gives access_rules on every credential the actor can view.
 */
function credentialFlag(world: World, actorId: string, id: string, f: string): boolean {
  const stored = actorTeams(world, actorId).some(
    (team) =>
      (f === 'reveal' ? team.credentialsAllReveal : team.credentialsAllAccessRules) === 1 ||
      world.teamCredentials.some(
        (x) =>
          x.teamId === team.id &&
          x.credentialId === id &&
          (f === 'reveal' ? x.reveal : x.accessRules) === 1,
      ),
  );
  if (stored) return true;
  return (
    f === 'access_rules' &&
    holdsPermission(world, actorId, 'access_rules:global') &&
    credentialLevel(world, actorId, id, 1)
  );
}

/** Actor dominates team `teamId` (the undominated CTE in src/db/authority.ts, amendment A1). */
export function modelDominates(world: World, actorId: string, teamId: string): boolean {
  const team = world.teams.find((t) => t.id === teamId);
  if (!team) return false;
  for (const p of world.permissions) {
    if (p.teamId === teamId && !holdsPermission(world, actorId, p.permission)) return false;
  }
  const mine = actorTeams(world, actorId);
  if (team.credentialsAll > Math.max(0, ...mine.map((t) => t.credentialsAll))) return false;
  if (team.credentialsAllReveal === 1 && !allFlag(world, actorId, 'reveal')) return false;
  if (team.credentialsAllAccessRules === 1 && !allFlag(world, actorId, 'access_rules')) {
    return false;
  }
  for (const x of world.teamCredentials) {
    if (x.teamId !== teamId) continue;
    if (!credentialLevel(world, actorId, x.credentialId, x.level)) return false;
    if (x.reveal !== 0 && !credentialFlag(world, actorId, x.credentialId, 'reveal')) return false;
    if (x.accessRules !== 0 && !credentialFlag(world, actorId, x.credentialId, 'access_rules')) {
      return false;
    }
  }
  return (
    teamId !== 'tea_owner' ||
    world.members.some((m) => m.teamId === 'tea_owner' && m.userId === actorId)
  );
}

/** One claim holds for the actor. Anything malformed does not hold. */
export function modelClaimHolds(world: World, actorId: string, claim: unknown): boolean {
  if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) return false;
  const c = claim as Record<string, unknown>;
  const k = c.k as string;
  if (['credential', 'credential_all'].includes(k) && !isLevel(c.l)) return false;
  if (['credential', 'credential_flag'].includes(k) && !isText(c.id)) return false;
  if (['credential_flag', 'credential_all_flag'].includes(k) && !isFlag(c.f)) return false;
  if (['member', 'dominates_team', 'not_member'].includes(k) && !isText(c.t)) return false;
  if (['dominates_user', 'not_self'].includes(k) && !isText(c.u)) return false;
  if (['perm', 'member'].includes(k) && !isText(c.p)) return false;
  const l = c.l as number;
  switch (k) {
    case 'read':
      return world.members.some((m) => m.userId === actorId);
    case 'perm':
      return holdsPermission(world, actorId, c.p as string);
    case 'member':
      return (
        world.members.some((m) => m.userId === actorId && m.teamId === c.t) &&
        world.permissions.some((p) => p.teamId === c.t && p.permission === c.p)
      );
    case 'credential':
      return credentialLevel(world, actorId, c.id as string, l);
    case 'credential_flag':
      return credentialFlag(world, actorId, c.id as string, c.f as string);
    case 'credential_all':
      return actorTeams(world, actorId).some((team) => team.credentialsAll >= l);
    case 'credential_all_flag':
      return allFlag(world, actorId, c.f as string);
    case 'not_self':
      return c.u !== actorId;
    case 'dominates_team':
      return modelDominates(world, actorId, c.t as string);
    case 'dominates_user':
      return (
        world.users.some((u) => u.id === c.u) &&
        world.members
          .filter((m) => m.userId === c.u)
          .every((m) => modelDominates(world, actorId, m.teamId))
      );
    case 'not_member':
      return (
        world.teams.some((team) => team.id === c.t) &&
        !world.members.some((m) => m.teamId === c.t && m.userId === actorId)
      );
    default:
      return false;
  }
}

/**
 * The actor check passes: the identity is linked to the actor, the actor is active, the claim
 * list is a non-empty array and every claim holds.
 */
export function evaluateClaims(world: World, actor: ActorRef, claims: unknown): boolean {
  const linked = world.identities.some(
    (i) =>
      i.loginProvider === actor.loginProvider &&
      i.subject === actor.subject &&
      i.userId === actor.userId,
  );
  const active = world.users.some((u) => u.id === actor.userId && u.status === 'active');
  if (!linked || !active) return false;
  if (!Array.isArray(claims) || claims.length === 0) return false;
  return claims.every((claim) => modelClaimHolds(world, actor.userId, claim));
}
