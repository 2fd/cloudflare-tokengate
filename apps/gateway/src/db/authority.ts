// Commit-time re-check of what an admin request was authorized with (I-SESS-1). A request carries a
// list of claims, each one atomic fact about the acting user's teams. The actor check runs first in
// every admin write batch: unless the identity is still linked to its active user and every claim
// still holds, it raises and the batch rolls back. This is the SQL form of the permission model.
// src/admin/auth/scope.ts is the JS form, and a property test proves that the two agree.
import type { GlobalPermission, Level } from './teams';

export type Claim =
  /** The actor is a member of at least one team. */
  | { k: 'read' }
  | { k: 'perm'; p: GlobalPermission }
  /** The actor is a member of team `t`, and `t` holds `p` (the receiving team on create). */
  | { k: 'member'; t: string; p: 'tokens:create' | 'consumers:create' }
  | { k: 'token' | 'consumer'; id: string; l: Level }
  | { k: 'token_reveal'; id: string }
  | { k: 'token_all' | 'consumer_all'; l: Level }
  | { k: 'token_all_reveal' }
  | { k: 'dominates_team'; t: string }
  /** The actor dominates every team of user `u` (user-state changes on `u`). */
  | { k: 'dominates_user'; u: string }
  /** The actor is not a member of team `t` (a raise on `t`). */
  | { k: 'not_member'; t: string }
  | { k: 'not_self'; u: string };

/** SQLite echoes an invalid JSON path in its error message; this one marks the actor check. */
export const ACTOR_CHECK_MARKER = 'tokengate:actor_not_authorized';

// D1 limits the depth of an SQL expression tree to 100, and subqueries in an expression count
// towards it. So the check is a chain of CTEs, each one a shallow query, instead of one nested
// expression. A subquery in a FROM clause (a CTE) does not add to the depth of the expression that
// reads it.
//
// ?1 marker, ?2 login provider, ?3 subject, ?4 user id (the actor), ?5 the claims as JSON.
const ACTOR_CHECK_SQL = `WITH
  -- The actor's effective powers: the union over its teams.
  actor_teams AS (SELECT team_id FROM team_members WHERE user_id = ?4),
  actor_perms AS (SELECT DISTINCT p.permission FROM actor_teams a
                  JOIN team_permissions p ON p.team_id = a.team_id),
  actor_all AS (SELECT coalesce(max(t.tokens_all), 0) AS tokens,
                       coalesce(max(t.tokens_all_reveal), 0) AS reveal,
                       coalesce(max(t.consumers_all), 0) AS consumers
                FROM actor_teams a JOIN teams t ON t.id = a.team_id),
  actor_tokens AS (SELECT x.service_id, max(x.level) AS level, max(x.reveal) AS reveal
                   FROM actor_teams a JOIN team_tokens x ON x.team_id = a.team_id GROUP BY x.service_id),
  actor_consumers AS (SELECT x.caller_provider_id, max(x.level) AS level
                      FROM actor_teams a JOIN team_consumers x ON x.team_id = a.team_id
                      GROUP BY x.caller_provider_id),
  -- Teams the actor does NOT dominate. The actor dominates team T when T exists and is not listed
  -- here: the actor holds every global permission of T, an all-scope at least T's for each kind
  -- (and all-scope reveal when T has it), and every explicit row of T (level and reveal). A team
  -- with rows on resources the actor cannot see is not dominated. Only an Owners member
  -- dominates tea_owner.
  undominated AS (
    SELECT tp.team_id AS id FROM team_permissions tp
    WHERE tp.permission NOT IN (SELECT permission FROM actor_perms)
    UNION
    SELECT t.id FROM teams t JOIN actor_all aa
    WHERE t.tokens_all > aa.tokens OR t.tokens_all_reveal > aa.reveal OR t.consumers_all > aa.consumers
    UNION
    SELECT x.team_id FROM team_tokens x JOIN actor_all aa
      LEFT JOIN actor_tokens y ON y.service_id = x.service_id
    WHERE max(aa.tokens, coalesce(y.level, 0)) < x.level
       OR (x.reveal = 1 AND aa.reveal = 0 AND coalesce(y.reveal, 0) = 0)
    UNION
    SELECT x.team_id FROM team_consumers x JOIN actor_all aa
      LEFT JOIN actor_consumers y ON y.caller_provider_id = x.caller_provider_id
    WHERE max(aa.consumers, coalesce(y.level, 0)) < x.level
    UNION
    SELECT 'tea_owner' WHERE NOT EXISTS (SELECT 1 FROM actor_teams WHERE team_id = 'tea_owner')),
  -- The claims. Fields are read only from objects: json_extract raises on a bare string element.
  claims AS (
    SELECT c.type AS type,
           CASE WHEN c.type = 'object' THEN json_extract(c.value, '$.k') END AS k,
           CASE WHEN c.type = 'object' THEN json_extract(c.value, '$.l') END AS l,
           CASE WHEN c.type = 'object' THEN json_type(c.value, '$.l') END AS l_type,
           CASE WHEN c.type = 'object' THEN json_extract(c.value, '$.id') END AS id,
           CASE WHEN c.type = 'object' THEN json_type(c.value, '$.id') END AS id_type,
           CASE WHEN c.type = 'object' THEN json_extract(c.value, '$.t') END AS t,
           CASE WHEN c.type = 'object' THEN json_type(c.value, '$.t') END AS t_type,
           CASE WHEN c.type = 'object' THEN json_extract(c.value, '$.u') END AS u,
           CASE WHEN c.type = 'object' THEN json_type(c.value, '$.u') END AS u_type,
           CASE WHEN c.type = 'object' THEN json_extract(c.value, '$.p') END AS p,
           CASE WHEN c.type = 'object' THEN json_type(c.value, '$.p') END AS p_type
    FROM json_each(?5) c),
  -- 1 when the claim holds. The shape checks run first: JSON.stringify drops undefined fields, and
  -- a missing id, team or user must never match "nothing" and pass. A result that is not exactly
  -- 1 (0 or NULL) counts as "not held", and so does an unknown kind.
  held AS (
    SELECT (CASE
      WHEN type IS NOT 'object' THEN 0
      WHEN k IN ('token', 'consumer', 'token_all', 'consumer_all')
           AND (l_type IS NOT 'integer' OR l NOT BETWEEN 1 AND 3) THEN 0
      WHEN k IN ('token', 'consumer', 'token_reveal') AND id_type IS NOT 'text' THEN 0
      WHEN k IN ('member', 'dominates_team', 'not_member') AND t_type IS NOT 'text' THEN 0
      WHEN k IN ('dominates_user', 'not_self') AND u_type IS NOT 'text' THEN 0
      WHEN k IN ('perm', 'member') AND p_type IS NOT 'text' THEN 0
      ELSE (CASE k
      WHEN 'read' THEN EXISTS (SELECT 1 FROM actor_teams)
      WHEN 'perm' THEN p IN (SELECT permission FROM actor_perms)
      WHEN 'member' THEN EXISTS (SELECT 1 FROM actor_teams a JOIN team_permissions tp ON tp.team_id = a.team_id
                                 WHERE a.team_id = t AND tp.permission = p)
      WHEN 'token' THEN max((SELECT tokens FROM actor_all),
                            coalesce((SELECT level FROM actor_tokens WHERE service_id = id), 0)) >= l
      WHEN 'token_reveal' THEN (SELECT reveal FROM actor_all) = 1
                            OR EXISTS (SELECT 1 FROM actor_tokens WHERE service_id = id AND reveal = 1)
      WHEN 'consumer' THEN max((SELECT consumers FROM actor_all),
                               coalesce((SELECT level FROM actor_consumers WHERE caller_provider_id = id), 0)) >= l
      WHEN 'token_all' THEN (SELECT tokens FROM actor_all) >= l
      WHEN 'token_all_reveal' THEN (SELECT reveal FROM actor_all) = 1
      WHEN 'consumer_all' THEN (SELECT consumers FROM actor_all) >= l
      WHEN 'not_self' THEN u <> ?4
      WHEN 'dominates_team' THEN EXISTS (SELECT 1 FROM teams WHERE teams.id = t)
                                 AND t NOT IN (SELECT id FROM undominated)
      WHEN 'dominates_user' THEN EXISTS (SELECT 1 FROM users WHERE users.id = u)
                                 AND NOT EXISTS (SELECT 1 FROM team_members um WHERE um.user_id = u
                                                 AND um.team_id IN (SELECT id FROM undominated))
      WHEN 'not_member' THEN EXISTS (SELECT 1 FROM teams WHERE teams.id = t)
                             AND NOT EXISTS (SELECT 1 FROM actor_teams WHERE team_id = t)
      ELSE 0 END) END) AS ok
    FROM claims)
SELECT json_extract('{}', ?1) WHERE NOT (
  EXISTS (SELECT 1 FROM user_identities i JOIN users u ON u.id = i.user_id
          WHERE i.login_provider = ?2 AND i.subject = ?3 AND i.user_id = ?4 AND u.status = 'active')
  AND json_array_length(?5) > 0
  AND NOT EXISTS (SELECT 1 FROM held WHERE ok IS NOT 1))`;

/**
 * The actor check: selects nothing while the identity `(loginProvider, subject)` is linked to the
 * active user `userId` and every claim holds. Otherwise it evaluates json_extract with an invalid
 * path (ACTOR_CHECK_MARKER), which raises and aborts the batch (D1 has no RAISE() outside
 * triggers). An empty claim list never holds (fail closed).
 *
 * It is a standalone statement (never composed into another one), so numbered parameters are
 * safe. Because it is the first statement of the batch, it sees the state before the batch's own
 * writes: "dominates before" plus "holds every added power" gives "dominates after".
 */
export function actorCheckStatement(
  db: D1Database,
  actor: { userId: string; loginProvider: string; subject: string; claims: readonly Claim[] },
): D1PreparedStatement {
  return db
    .prepare(ACTOR_CHECK_SQL)
    .bind(
      ACTOR_CHECK_MARKER,
      actor.loginProvider,
      actor.subject,
      actor.userId,
      JSON.stringify(Array.isArray(actor.claims) ? actor.claims : []),
    );
}
