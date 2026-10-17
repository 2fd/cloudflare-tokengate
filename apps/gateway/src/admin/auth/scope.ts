// Effective permissions of an admin user (ADR 0023): the union over the user's teams. This is the
// JS form of the permission model. The SQL form, which re-checks a request's claims at commit, is
// src/db/authority.ts, and a property test proves that the two agree.
//
// A token or consumer that the user cannot view is hidden everywhere (I-SCOPE-1). The SQL helpers
// here render the filters for queries that page, aggregate or scan. For a viewer whose scope is
// "all" they render no clause (or `1`), so built-in-team users get the same SQL as before teams.
import {
  type BuiltinTeam,
  BUILTIN_TEAM_ORDER,
  compareTeams,
  type GlobalPermission,
  isGlobalPermission,
  type Level,
  levelOrZero,
  type TeamPowers,
  type TeamRef,
  teamRefFromRow,
} from '../../db/teams';

export type { BuiltinTeam, GlobalPermission, Level, TeamPowers, TeamRef };

/** `read` is never stored: it means "member of at least one team". */
export type Permission = 'read' | GlobalPermission;
export type Need = 'view' | 'edit' | 'delete' | 'reveal';
export type ResourceKind = 'token' | 'consumer';

export interface KindScope {
  /** The highest all-scope level over the user's teams; 0 when none. */
  readonly all: 0 | Level;
  /** Reveal on every token (tokens only; always false for consumers). */
  readonly allReveal: boolean;
  /** The highest explicit level (and reveal) per resource id over the user's teams. */
  readonly explicit: ReadonlyMap<string, { level: Level; reveal: boolean }>;
}

export interface AdminScope {
  readonly userId: string;
  /** Built-ins first in privilege order, then A–Z. */
  readonly teams: readonly TeamRef[];
  readonly permissions: ReadonlySet<GlobalPermission>;
  readonly tokens: KindScope;
  readonly consumers: KindScope;
}

export type VisibleSet = { all: true } | { all: false; ids: readonly string[] };

/** Boolean SQL expression plus its binds (the same shape as SqlGuard in admin/ops/shared.ts). */
export type SqlGuard = { sql: string; binds: unknown[] };

const NEED_LEVEL: Record<Exclude<Need, 'reveal'>, Level> = { view: 1, edit: 2, delete: 3 };

type Row = Record<string, unknown>;

const ACTIVE_MEMBER =
  "FROM team_members m JOIN users u ON u.id = m.user_id AND u.status = 'active'";

/**
 * The effective permissions of `userId`: one D1 batch of 4 SELECTs. Only an active user's
 * memberships count, so a user who is not active holds nothing.
 */
export async function loadScope(db: D1Database, userId: string): Promise<AdminScope> {
  const [teams, permissions, tokens, consumers] = await db.batch<Row>([
    db
      .prepare(
        `SELECT t.id, t.name, t.builtin, t.tokens_all, t.tokens_all_reveal, t.consumers_all
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
        `SELECT x.service_id, MAX(x.level) AS level, MAX(x.reveal) AS reveal ${ACTIVE_MEMBER}
         JOIN team_tokens x ON x.team_id = m.team_id WHERE m.user_id = ? GROUP BY x.service_id`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT x.credential_access_rule_id, MAX(x.level) AS level ${ACTIVE_MEMBER}
         JOIN team_consumers x ON x.team_id = m.team_id WHERE m.user_id = ?
         GROUP BY x.credential_access_rule_id`,
      )
      .bind(userId),
  ]);
  const teamRows = teams?.results ?? [];
  const max = (column: string) =>
    teamRows.reduce<0 | Level>((best, row) => {
      const level = levelOrZero(row[column]);
      return level > best ? level : best;
    }, 0);
  const tokenRows = new Map<string, { level: Level; reveal: boolean }>();
  for (const row of tokens?.results ?? []) {
    const level = levelOrZero(row.level);
    if (level !== 0) tokenRows.set(String(row.service_id), { level, reveal: row.reveal === 1 });
  }
  const consumerRows = new Map<string, { level: Level; reveal: boolean }>();
  for (const row of consumers?.results ?? []) {
    const level = levelOrZero(row.level);
    if (level !== 0)
      consumerRows.set(String(row.credential_access_rule_id), { level, reveal: false });
  }
  return {
    userId,
    teams: teamRows.map(teamRefFromRow).sort(compareTeams),
    permissions: new Set(
      (permissions?.results ?? []).map((row) => row.permission).filter(isGlobalPermission),
    ),
    tokens: {
      all: max('tokens_all'),
      allReveal: teamRows.some((row) => row.tokens_all_reveal === 1),
      explicit: tokenRows,
    },
    consumers: { all: max('consumers_all'), allReveal: false, explicit: consumerRows },
  };
}

function kindScope(scope: AdminScope, kind: ResourceKind): KindScope {
  return kind === 'token' ? scope.tokens : scope.consumers;
}

/** The effective level on one resource: the maximum of the all-scope and its explicit row. */
function levelOn(kinds: KindScope, id: string): 0 | Level {
  const row = kinds.explicit.get(id)?.level ?? 0;
  return row > kinds.all ? row : kinds.all;
}

/** Reveal on one token: all-scope reveal or the explicit reveal flag. It implies view. */
function revealOn(kinds: KindScope, id: string): boolean {
  return kinds.allReveal || kinds.explicit.get(id)?.reveal === true;
}

/** The user holds `need` on resource `id` of `kind`. Reveal exists for tokens only. */
export function holds(
  scope: AdminScope,
  target: { kind: ResourceKind; id: string; need: Need },
): boolean {
  const kinds = kindScope(scope, target.kind);
  if (target.need === 'reveal') return target.kind === 'token' && revealOn(kinds, target.id);
  return levelOn(kinds, target.id) >= NEED_LEVEL[target.need];
}

/** The user holds `need` on at least one resource of `kind` (or on all of them). */
export function canAny(scope: AdminScope, kind: ResourceKind, need: Need): boolean {
  const kinds = kindScope(scope, kind);
  if (need === 'reveal') {
    if (kind !== 'token') return false;
    return kinds.allReveal || [...kinds.explicit.values()].some((row) => row.reveal);
  }
  const level = NEED_LEVEL[need];
  return kinds.all >= level || [...kinds.explicit.values()].some((row) => row.level >= level);
}

/** The resources of `kind` the user can view: all of them, or a sorted list of ids. */
export function visibleIds(scope: AdminScope, kind: ResourceKind): VisibleSet {
  const kinds = kindScope(scope, kind);
  if (kinds.all >= 1) return { all: true };
  return { all: false, ids: [...kinds.explicit.keys()].sort() };
}

/**
 * All-scope view on tokens and on consumers. Only global viewers see unattributed (pre-trust)
 * telemetry and deployment-wide aggregates. Every built-in team is a global viewer.
 */
export function isGlobalViewer(scope: AdminScope): boolean {
  return scope.tokens.all >= 1 && scope.consumers.all >= 1;
}

const unset = (value: string | null): value is null => value === null || value === '';

/**
 * A telemetry record or rollup row is visible when the user is a global viewer, or when its
 * consumer is set and visible and its token is unset or visible. An empty string (rollups) counts
 * as unset, like NULL (request_log).
 */
export function recordVisible(
  scope: AdminScope,
  record: { service_id: string | null; credential_access_rule_id: string | null },
): boolean {
  if (isGlobalViewer(scope)) return true;
  const consumer = record.credential_access_rule_id;
  if (unset(consumer) || !holds(scope, { kind: 'consumer', id: consumer, need: 'view' })) {
    return false;
  }
  const token = record.service_id;
  return unset(token) || holds(scope, { kind: 'token', id: token, need: 'view' });
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
 * The recordVisible rule in SQL, for request_log (`empty: 'NULL'`) and rollups (`empty: "''"`).
 * Null for global viewers: no clause, the same SQL as before teams. With `at: n`, the binds are
 * numbered from `?n` in the order they are returned.
 */
export function recordScopeSql(
  scope: AdminScope,
  cols: { service: string; consumer: string; empty: 'NULL' | "''" },
  opts: { at?: number } = {},
): SqlGuard | null {
  if (isGlobalViewer(scope)) return null;
  const isSet = (column: string) =>
    cols.empty === 'NULL' ? `${column} IS NOT NULL` : `${column} <> ''`;
  const isUnset = (column: string) =>
    cols.empty === 'NULL' ? `${column} IS NULL` : `${column} = ''`;
  const binds: unknown[] = [];
  const member = (set: VisibleSet, column: string) => {
    if (set.all) return '1';
    const sql = `${column} IN (SELECT value FROM json_each(${bind(opts.at, binds.length)}))`;
    binds.push(JSON.stringify(set.ids));
    return sql;
  };
  const consumer = member(visibleIds(scope, 'consumer'), cols.consumer);
  const token = member(visibleIds(scope, 'token'), cols.service);
  return {
    sql: `(${isSet(cols.consumer)} AND ${consumer} AND (${isUnset(cols.service)} OR ${token}))`,
    binds,
  };
}

/**
 * audit_log rows a restricted viewer may see: every id in `resources` is a visible token or
 * consumer. A row with a hidden id, an unknown prefix (a `grt_` id, the `"*"` sentinel) or a
 * malformed element is hidden whole, so summaries and diffs never need per-viewer redaction.
 * Null for global viewers.
 */
export function auditScopeSql(scope: AdminScope, alias = 'audit_log'): SqlGuard | null {
  if (isGlobalViewer(scope)) return null;
  const binds: unknown[] = [];
  const member = (set: VisibleSet) => {
    if (set.all) return '1';
    binds.push(JSON.stringify(set.ids));
    return 'r.value IN (SELECT value FROM json_each(?))';
  };
  const tokens = member(visibleIds(scope, 'token'));
  const consumers = member(visibleIds(scope, 'consumer'));
  return {
    sql: `NOT EXISTS (SELECT 1 FROM json_each(${alias}.resources) r WHERE (CASE
    WHEN substr(r.value, 1, 4) = 'svc_' THEN ${tokens}
    WHEN substr(r.value, 1, 4) = 'cpr_' THEN ${consumers}
    ELSE 0 END) IS NOT 1)`,
    binds,
  };
}

/**
 * The actor dominates `team`: it holds every global permission of the team, an all-scope at
 * least the team's for each kind (and all-scope reveal when the team has it), and every explicit
 * row of the team (level and reveal). Only an Owners member dominates tea_owner. The JS form of
 * dominatesSql (src/db/authority.ts).
 */
export function dominatesTeam(
  scope: AdminScope,
  team: TeamPowers,
  actorInOwners: boolean,
): boolean {
  for (const permission of team.permissions) {
    if (!scope.permissions.has(permission)) return false;
  }
  if (team.tokensAll > scope.tokens.all) return false;
  if (team.tokensAllReveal && !scope.tokens.allReveal) return false;
  if (team.consumersAll > scope.consumers.all) return false;
  for (const [id, row] of team.tokens) {
    if (levelOn(scope.tokens, id) < row.level) return false;
    if (row.reveal && !revealOn(scope.tokens, id)) return false;
  }
  for (const [id, row] of team.consumers) {
    if (levelOn(scope.consumers, id) < row.level) return false;
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
    !team.tokensAllReveal &&
    ![...team.tokens.values()].some((row) => row.reveal)
  );
}

/**
 * The change gives the team a power it did not have: a permission added, an all-scope set or
 * raised (including list → all), all-scope reveal set, or an explicit row added, raised or given
 * reveal. Lowering is never a raise.
 */
export function raises(before: TeamPowers, after: TeamPowers): boolean {
  for (const permission of after.permissions) {
    if (!before.permissions.has(permission)) return true;
  }
  if (after.tokensAll > before.tokensAll || after.consumersAll > before.consumersAll) return true;
  if (after.tokensAllReveal && !before.tokensAllReveal) return true;
  for (const [id, row] of after.tokens) {
    const old = before.tokens.get(id);
    if (!old || row.level > old.level || (row.reveal && !old.reveal)) return true;
  }
  for (const [id, row] of after.consumers) {
    const old = before.consumers.get(id);
    if (!old || row.level > old.level) return true;
  }
  return false;
}

/**
 * The team can change something: a create permission, `config:export`, or any level above view.
 * A team that is not join-safe also counts. An elevated default team needs a confirmation.
 */
export function isElevated(team: TeamPowers): boolean {
  if (!isJoinSafe(team)) return true;
  if (
    team.permissions.has('tokens:create') ||
    team.permissions.has('consumers:create') ||
    team.permissions.has('config:export')
  ) {
    return true;
  }
  if (team.tokensAll >= 2 || team.consumersAll >= 2) return true;
  return (
    [...team.tokens.values()].some((row) => row.level >= 2) ||
    [...team.consumers.values()].some((row) => row.level >= 2)
  );
}

/** The most privileged built-in team the user is a member of, or null. */
export function highestBuiltin(scope: Pick<AdminScope, 'teams'>): BuiltinTeam | null {
  for (const key of BUILTIN_TEAM_ORDER) {
    if (scope.teams.some((team) => team.builtin === key)) return key;
  }
  return null;
}
