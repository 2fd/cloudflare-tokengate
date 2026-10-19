// Effective permissions of an admin user (ADR 0023): the union over the user's teams. This is the
// JS form of the permission model. The SQL form, which re-checks a request's claims at commit, is
// src/db/authority.ts, and a property test proves that the two agree.
//
// A team's scope is on credentials only. A credential that the user cannot view is hidden
// everywhere, with everything that belongs to it (I-SCOPE-1). The SQL helpers here render the
// filters for queries that page, aggregate or scan. For a viewer whose scope is "all" they render
// no clause (or `1`), so built-in-team users get the same SQL as before teams.
//
// The permission access_rules:global implies the access_rules flag on every credential the user
// can view. Stored values (TeamPowers, CredentialScope) never include it: only holds, canAny,
// effectiveAllAccessRules and dominatesTeam apply it.
import {
  type BuiltinTeam,
  BUILTIN_TEAM_ORDER,
  compareTeams,
  type CredentialFlag,
  type CredentialPowers,
  type GlobalPermission,
  isGlobalPermission,
  type Level,
  levelOrZero,
  type TeamPowers,
  type TeamRef,
  teamRefFromRow,
} from '../../db/teams';

export type {
  BuiltinTeam,
  CredentialFlag,
  CredentialPowers,
  GlobalPermission,
  Level,
  TeamPowers,
  TeamRef,
};

/** `read` is never stored: it means "member of at least one team". */
export type Permission = 'read' | GlobalPermission;
export type Need = 'view' | 'edit' | 'delete' | CredentialFlag;

/** The union over the user's teams, as stored (without the implied access_rules flag). */
export interface CredentialScope {
  /** The highest all-scope level over the user's teams; 0 when none. */
  readonly all: 0 | Level;
  /** Reveal on every credential, from a team with all-scope reveal. */
  readonly allReveal: boolean;
  /** Manage the access rules of every credential, from a team with the all-scope flag. */
  readonly allAccessRules: boolean;
  /** The highest explicit level, and the OR of each flag, per credential id over the user's teams. */
  readonly explicit: ReadonlyMap<string, CredentialPowers>;
}

export interface AdminScope {
  readonly userId: string;
  /** Built-ins first in privilege order, then A–Z. */
  readonly teams: readonly TeamRef[];
  readonly permissions: ReadonlySet<GlobalPermission>;
  readonly credentials: CredentialScope;
}

export type VisibleSet = { all: true } | { all: false; ids: readonly string[] };

/** Boolean SQL expression plus its binds (the same shape as SqlGuard in admin/ops/shared.ts). */
export type SqlGuard = { sql: string; binds: unknown[] };

const NEED_LEVEL: Record<Exclude<Need, CredentialFlag>, Level> = { view: 1, edit: 2, delete: 3 };

type Row = Record<string, unknown>;

const ACTIVE_MEMBER =
  "FROM team_members m JOIN users u ON u.id = m.user_id AND u.status = 'active'";

/**
 * The effective permissions of `userId`: one D1 batch of 3 SELECTs. Only an active user's
 * memberships count, so a user who is not active holds nothing.
 */
export async function loadScope(db: D1Database, userId: string): Promise<AdminScope> {
  const [teams, permissions, credentials] = await db.batch<Row>([
    db
      .prepare(
        `SELECT t.id, t.name, t.builtin, t.credentials_all, t.credentials_all_reveal,
           t.credentials_all_access_rules
         ${ACTIVE_MEMBER} JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT DISTINCT p.permission ${ACTIVE_MEMBER}
         JOIN team_permissions p ON p.team_id = m.team_id WHERE m.user_id = ?`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT x.credential_id, MAX(x.level) AS level, MAX(x.reveal) AS reveal,
           MAX(x.access_rules) AS access_rules ${ACTIVE_MEMBER}
         JOIN team_credentials x ON x.team_id = m.team_id WHERE m.user_id = ?
         GROUP BY x.credential_id`,
      )
      .bind(userId),
  ]);
  const teamRows = teams?.results ?? [];
  const all = teamRows.reduce<0 | Level>((best, row) => {
    const level = levelOrZero(row.credentials_all);
    return level > best ? level : best;
  }, 0);
  const explicit = new Map<string, CredentialPowers>();
  for (const row of credentials?.results ?? []) {
    const level = levelOrZero(row.level);
    if (level !== 0) {
      explicit.set(String(row.credential_id), {
        level,
        reveal: row.reveal === 1,
        accessRules: row.access_rules === 1,
      });
    }
  }
  return {
    userId,
    teams: teamRows.map(teamRefFromRow).sort(compareTeams),
    permissions: new Set(
      (permissions?.results ?? []).map((row) => row.permission).filter(isGlobalPermission),
    ),
    credentials: {
      all,
      allReveal: teamRows.some((row) => row.credentials_all_reveal === 1),
      allAccessRules: teamRows.some((row) => row.credentials_all_access_rules === 1),
      explicit,
    },
  };
}

/** The effective level on one credential: the maximum of the all-scope and its explicit row. */
function levelOn(scope: AdminScope, id: string): 0 | Level {
  const row = scope.credentials.explicit.get(id)?.level ?? 0;
  return row > scope.credentials.all ? row : scope.credentials.all;
}

/**
 * The all-scope access_rules flag, with the implication: a stored all-scope flag, or
 * access_rules:global with all-scope view.
 */
export function effectiveAllAccessRules(scope: AdminScope): boolean {
  return (
    scope.credentials.allAccessRules ||
    (scope.permissions.has('access_rules:global') && scope.credentials.all >= 1)
  );
}

/**
 * The user holds `need` on credential `id`. A level need compares max(all-scope, row level).
 * `reveal`: all-scope reveal or the row's flag. `access_rules`: the all-scope flag, the row's flag,
 * or access_rules:global with view on the credential. Each flag implies view.
 */
export function holds(scope: AdminScope, target: { id: string; need: Need }): boolean {
  const { credentials } = scope;
  const row = credentials.explicit.get(target.id);
  switch (target.need) {
    case 'reveal':
      return credentials.allReveal || row?.reveal === true;
    case 'access_rules':
      return (
        credentials.allAccessRules ||
        row?.accessRules === true ||
        (scope.permissions.has('access_rules:global') && levelOn(scope, target.id) >= 1)
      );
    default:
      return levelOn(scope, target.id) >= NEED_LEVEL[target.need];
  }
}

/** The user holds `need` on at least one credential (or on all of them). */
export function canAny(scope: AdminScope, need: Need): boolean {
  const { credentials } = scope;
  const rows = [...credentials.explicit.values()];
  switch (need) {
    case 'reveal':
      return credentials.allReveal || rows.some((row) => row.reveal);
    case 'access_rules':
      return (
        effectiveAllAccessRules(scope) ||
        rows.some((row) => row.accessRules) ||
        (scope.permissions.has('access_rules:global') && rows.length > 0)
      );
    default: {
      const level = NEED_LEVEL[need];
      return credentials.all >= level || rows.some((row) => row.level >= level);
    }
  }
}

/** The credentials the user can view: all of them, or a sorted list of ids. */
export function visibleIds(scope: AdminScope): VisibleSet {
  if (scope.credentials.all >= 1) return { all: true };
  return { all: false, ids: [...scope.credentials.explicit.keys()].sort() };
}

/**
 * All-scope view on credentials. Only global viewers see pre-trust telemetry (no credential) and
 * deployment-wide aggregates. Every built-in team is a global viewer.
 */
export function isGlobalViewer(scope: AdminScope): boolean {
  return scope.credentials.all >= 1;
}

/**
 * A telemetry record or rollup row is visible when the user is a global viewer, or when its
 * credential is set and visible (D7). An empty string (rollups) counts as unset, like NULL
 * (request_log). The record's credential access rule never decides it.
 */
export function recordVisible(scope: AdminScope, record: { service_id: string | null }): boolean {
  if (isGlobalViewer(scope)) return true;
  const id = record.service_id;
  return id !== null && id !== '' && holds(scope, { id, need: 'view' });
}

const bind = (at: number | undefined, offset: number) =>
  at === undefined ? '?' : `?${at + offset}`;

/**
 * `1` when the set is all; else `${column} IN (SELECT value FROM json_each(?))` with one JSON
 * bind. Fragments use anonymous `?`. `at: n` renders `?n` instead, for statements that already use
 * numbered parameters (db/rollups.ts).
 */
export function scopeSql(set: VisibleSet, column: string, opts: { at?: number } = {}): SqlGuard {
  if (set.all) return { sql: '1', binds: [] };
  return {
    sql: `${column} IN (SELECT value FROM json_each(${bind(opts.at, 0)}))`,
    binds: [JSON.stringify(set.ids)],
  };
}

/**
 * The recordVisible rule in SQL, for request_log (`empty: 'NULL'`) and rollups (`empty: "''"`):
 * the credential column is set and visible. Null for global viewers: no clause, the same SQL as
 * before teams. With `at: n`, the bind is `?n`.
 */
export function recordScopeSql(
  scope: AdminScope,
  cols: { service: string; empty: 'NULL' | "''" },
  opts: { at?: number } = {},
): SqlGuard | null {
  if (isGlobalViewer(scope)) return null;
  const isSet = cols.empty === 'NULL' ? `${cols.service} IS NOT NULL` : `${cols.service} <> ''`;
  const visible = scopeSql(visibleIds(scope), cols.service, opts);
  return { sql: `(${isSet} AND ${visible.sql})`, binds: visible.binds };
}

/**
 * audit_log rows a restricted viewer may see: every id in `resources` is a visible credential. A
 * row with a hidden id, another prefix (an `acr_` id, the `"*"` sentinel) or a malformed element is
 * hidden whole, so summaries and diffs never need per-viewer redaction. Global access rule rows
 * carry `[]` and stay visible. Null for global viewers.
 */
export function auditScopeSql(scope: AdminScope, alias = 'audit_log'): SqlGuard | null {
  if (isGlobalViewer(scope)) return null;
  const visible = scopeSql(visibleIds(scope), 'r.value');
  return {
    sql: `NOT EXISTS (SELECT 1 FROM json_each(${alias}.resources) r WHERE (CASE
    WHEN substr(r.value, 1, 4) = 'svc_' THEN ${visible.sql}
    ELSE 0 END) IS NOT 1)`,
    binds: visible.binds,
  };
}

/**
 * The actor dominates `team` (amendment A1): it holds every global permission of the team, an
 * effective all-scope at least the team's (level and each flag), and effectively every explicit
 * row of the team (level and each flag). A row on a credential the actor cannot see is never
 * dominated. Only an Owners member dominates tea_owner. The JS form of the undominated CTE
 * (src/db/authority.ts).
 */
export function dominatesTeam(
  scope: AdminScope,
  team: TeamPowers,
  actorInOwners: boolean,
): boolean {
  for (const permission of team.permissions) {
    if (!scope.permissions.has(permission)) return false;
  }
  if (team.credentialsAll > scope.credentials.all) return false;
  if (team.allReveal && !scope.credentials.allReveal) return false;
  if (team.allAccessRules && !effectiveAllAccessRules(scope)) return false;
  for (const [id, row] of team.credentials) {
    if (levelOn(scope, id) < row.level) return false;
    if (row.reveal && !holds(scope, { id, need: 'reveal' })) return false;
    if (row.accessRules && !holds(scope, { id, need: 'access_rules' })) return false;
  }
  return team.id !== 'tea_owner' || actorInOwners;
}

/** Permissions a default team must not hold (the join-safe rule, I-LINK-1). */
const OWNER_GRADE: readonly GlobalPermission[] = [
  'users:write',
  'settings:write',
  'keyring:rewrap',
];

/**
 * The team can be the default team for new people: not Owners, no owner-grade permission and no
 * reveal anywhere. The JS form of the settings_join_team_* triggers.
 */
export function isJoinSafe(team: TeamPowers): boolean {
  return (
    team.id !== 'tea_owner' &&
    team.builtin !== 'owner' &&
    !OWNER_GRADE.some((permission) => team.permissions.has(permission)) &&
    !team.allReveal &&
    ![...team.credentials.values()].some((row) => row.reveal)
  );
}

/**
 * The change gives the team a power it did not have: a permission added, the all-scope set or
 * raised (including list → all), an all-scope flag set, or an explicit row added, raised or given a
 * flag. Lowering is never a raise. It compares stored values.
 */
export function raises(before: TeamPowers, after: TeamPowers): boolean {
  for (const permission of after.permissions) {
    if (!before.permissions.has(permission)) return true;
  }
  if (after.credentialsAll > before.credentialsAll) return true;
  if (after.allReveal && !before.allReveal) return true;
  if (after.allAccessRules && !before.allAccessRules) return true;
  for (const [id, row] of after.credentials) {
    const old = before.credentials.get(id);
    if (
      !old ||
      row.level > old.level ||
      (row.reveal && !old.reveal) ||
      (row.accessRules && !old.accessRules)
    ) {
      return true;
    }
  }
  return false;
}

/** Global permissions that make a team elevated (D6). */
const ELEVATED: readonly GlobalPermission[] = [
  'credentials:create',
  'config:export',
  'access_rules:global',
];

/**
 * The team can change something (D6): `credentials:create`, `config:export`,
 * `access_rules:global`, any level above view, or any access_rules flag. A team that is not
 * join-safe also counts. An elevated default team needs a confirmation.
 */
export function isElevated(team: TeamPowers): boolean {
  if (!isJoinSafe(team)) return true;
  if (ELEVATED.some((permission) => team.permissions.has(permission))) return true;
  if (team.credentialsAll >= 2 || team.allAccessRules) return true;
  return [...team.credentials.values()].some((row) => row.level >= 2 || row.accessRules);
}

/** The most privileged built-in team the user is a member of, or null. */
export function highestBuiltin(scope: Pick<AdminScope, 'teams'>): BuiltinTeam | null {
  for (const key of BUILTIN_TEAM_ORDER) {
    if (scope.teams.some((team) => team.builtin === key)) return key;
  }
  return null;
}
