// A pure JS model of the actor check (src/db/authority.ts, I-SESS-1), written from the design and
// independent of src/admin/auth/scope.ts. The property test compares it with the D1 result.
// It reads raw rows, as stored, and takes the claims as `unknown` so malformed claims can be
// modelled too.

export interface WorldTeam {
  id: string;
  tokensAll: number;
  tokensAllReveal: number;
  consumersAll: number;
}

export interface World {
  users: ReadonlyArray<{ id: string; status: string }>;
  /** Login identities: (login provider, subject) → user id. */
  identities: ReadonlyArray<{ loginProvider: string; subject: string; userId: string }>;
  teams: readonly WorldTeam[];
  members: ReadonlyArray<{ teamId: string; userId: string }>;
  permissions: ReadonlyArray<{ teamId: string; permission: string }>;
  teamTokens: ReadonlyArray<{ teamId: string; serviceId: string; level: number; reveal: number }>;
  teamConsumers: ReadonlyArray<{ teamId: string; consumerId: string; level: number }>;
}

export interface ActorRef {
  userId: string;
  loginProvider: string;
  subject: string;
}

const isText = (value: unknown): value is string => typeof value === 'string';
/** JSON integers 1 to 3. JSON.stringify writes 1.0 as 1, so it is an integer too. */
const isLevel = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3;

function actorTeams(world: World, actorId: string): WorldTeam[] {
  const ids = new Set(world.members.filter((m) => m.userId === actorId).map((m) => m.teamId));
  return world.teams.filter((team) => ids.has(team.id));
}

/** Actor holds level `l` on token `id`: an all-scope or an explicit row of one of its teams. */
function tokenLevel(world: World, actorId: string, id: string, l: number): boolean {
  return actorTeams(world, actorId).some(
    (team) =>
      team.tokensAll >= l ||
      world.teamTokens.some((x) => x.teamId === team.id && x.serviceId === id && x.level >= l),
  );
}

function tokenReveal(world: World, actorId: string, id: string): boolean {
  return actorTeams(world, actorId).some(
    (team) =>
      team.tokensAllReveal === 1 ||
      world.teamTokens.some((x) => x.teamId === team.id && x.serviceId === id && x.reveal === 1),
  );
}

function consumerLevel(world: World, actorId: string, id: string, l: number): boolean {
  return actorTeams(world, actorId).some(
    (team) =>
      team.consumersAll >= l ||
      world.teamConsumers.some((x) => x.teamId === team.id && x.consumerId === id && x.level >= l),
  );
}

function holdsPermission(world: World, actorId: string, permission: string): boolean {
  const teams = new Set(actorTeams(world, actorId).map((team) => team.id));
  return world.permissions.some((p) => teams.has(p.teamId) && p.permission === permission);
}

/** Actor dominates team `teamId` (DOMINATES in src/db/authority.ts, with amendment A1). */
export function modelDominates(world: World, actorId: string, teamId: string): boolean {
  const team = world.teams.find((t) => t.id === teamId);
  if (!team) return false;
  for (const p of world.permissions) {
    if (p.teamId === teamId && !holdsPermission(world, actorId, p.permission)) return false;
  }
  const mine = actorTeams(world, actorId);
  const max = (pick: (t: WorldTeam) => number) => Math.max(0, ...mine.map(pick));
  if (team.tokensAll > max((t) => t.tokensAll)) return false;
  if (team.tokensAllReveal > max((t) => t.tokensAllReveal)) return false;
  if (team.consumersAll > max((t) => t.consumersAll)) return false;
  for (const x of world.teamTokens) {
    if (x.teamId !== teamId) continue;
    if (!tokenLevel(world, actorId, x.serviceId, x.level)) return false;
    if (x.reveal !== 0 && !tokenReveal(world, actorId, x.serviceId)) return false;
  }
  for (const x of world.teamConsumers) {
    if (x.teamId !== teamId) continue;
    if (!consumerLevel(world, actorId, x.consumerId, x.level)) return false;
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
  const { k } = c;
  if (['token', 'consumer', 'token_all', 'consumer_all'].includes(k as string) && !isLevel(c.l)) {
    return false;
  }
  if (['token', 'consumer', 'token_reveal'].includes(k as string) && !isText(c.id)) return false;
  if (['member', 'dominates_team', 'not_member'].includes(k as string) && !isText(c.t)) {
    return false;
  }
  if (['dominates_user', 'not_self'].includes(k as string) && !isText(c.u)) return false;
  if (['perm', 'member'].includes(k as string) && !isText(c.p)) return false;
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
    case 'token':
      return tokenLevel(world, actorId, c.id as string, l);
    case 'token_reveal':
      return tokenReveal(world, actorId, c.id as string);
    case 'consumer':
      return consumerLevel(world, actorId, c.id as string, l);
    case 'token_all':
      return actorTeams(world, actorId).some((team) => team.tokensAll >= l);
    case 'token_all_reveal':
      return actorTeams(world, actorId).some((team) => team.tokensAllReveal === 1);
    case 'consumer_all':
      return actorTeams(world, actorId).some((team) => team.consumersAll >= l);
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
