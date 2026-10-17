// Admin teams (ADR 0023): reads and the code mirror of the built-in teams. A team is a named set of
// users that holds global permissions and resource scopes. It is not the Cloudflare Access team
// domain. The schema and its integrity rules (triggers) are in migrations/0001_initial.sql.
import type { UserStatus } from './types';

/** Permissions that a team holds for the whole deployment, not for one token or consumer. */
export type GlobalPermission =
  | 'tokens:create'
  | 'consumers:create'
  | 'config:export'
  | 'users:write'
  | 'settings:write'
  | 'keyring:rewrap';

export const GLOBAL_PERMISSIONS: readonly GlobalPermission[] = [
  'tokens:create',
  'consumers:create',
  'config:export',
  'users:write',
  'settings:write',
  'keyring:rewrap',
];

/** Level on a token or consumer: 1 view, 2 edit, 3 delete. Each level implies the lower ones. */
export type Level = 1 | 2 | 3;

export type BuiltinTeam = 'owner' | 'admin' | 'token_manager' | 'access_manager' | 'viewer';

/** The built-in teams in privilege order (the order the UI lists them in). */
export const BUILTIN_TEAM_ORDER: readonly BuiltinTeam[] = [
  'owner',
  'admin',
  'token_manager',
  'access_manager',
  'viewer',
];

export interface TeamRef {
  readonly id: string;
  readonly name: string;
  readonly builtin: BuiltinTeam | null;
}

/** What one team allows: its global permissions, its all-scopes and its explicit rows. */
export interface TeamPowers {
  id: string;
  builtin: BuiltinTeam | null;
  permissions: ReadonlySet<GlobalPermission>;
  /** All-scope level on tokens (current and future); 0 when the team uses a list or has none. */
  tokensAll: 0 | Level;
  /** Reveal on every token. Implies tokensAll >= 1. */
  tokensAllReveal: boolean;
  consumersAll: 0 | Level;
  tokens: ReadonlyMap<string, { level: Level; reveal: boolean }>;
  consumers: ReadonlyMap<string, { level: Level }>;
}

export interface BuiltinTeamPowers extends TeamPowers {
  builtin: BuiltinTeam;
  name: string;
  description: string;
}

function builtin(
  key: BuiltinTeam,
  name: string,
  description: string,
  permissions: GlobalPermission[],
  scopes: { tokens: Level; reveal?: boolean; consumers: Level },
): BuiltinTeamPowers {
  return {
    id: `tea_${key}`,
    builtin: key,
    name,
    description,
    permissions: new Set(permissions),
    tokensAll: scopes.tokens,
    tokensAllReveal: scopes.reveal ?? false,
    consumersAll: scopes.consumers,
    tokens: new Map(),
    consumers: new Map(),
  };
}

/**
 * The seeded built-in teams. The migration seed is the source of truth; a unit test pins this
 * table against the seeded rows. Only Owners hold reveal, so no other built-in team can extract a
 * secret.
 */
export const BUILTIN_TEAMS: Readonly<Record<BuiltinTeam, BuiltinTeamPowers>> = Object.freeze({
  owner: builtin(
    'owner',
    'Owners',
    'Everything: people, teams, settings, keys, and copying secrets.',
    [...GLOBAL_PERMISSIONS],
    { tokens: 3, reveal: true, consumers: 3 },
  ),
  admin: builtin(
    'admin',
    'Admins',
    'Every credential and consumer, issuer access rules, and the export.',
    ['tokens:create', 'consumers:create', 'config:export'],
    { tokens: 3, consumers: 3 },
  ),
  token_manager: builtin(
    'token_manager',
    'Credential managers',
    'Add, change and delete credentials. See every credential access rule.',
    ['tokens:create'],
    { tokens: 3, consumers: 1 },
  ),
  access_manager: builtin(
    'access_manager',
    'Access managers',
    'Add, change and delete consumers and their access. See every credential.',
    ['consumers:create'],
    { tokens: 1, consumers: 3 },
  ),
  viewer: builtin('viewer', 'Viewers', 'See every credential and consumer. Change nothing.', [], {
    tokens: 1,
    consumers: 1,
  }),
});

/** SQL rank that sorts built-in teams first, in privilege order. Custom teams rank last. */
export const builtinRankSql = (column: string): string =>
  `CASE ${column} ${BUILTIN_TEAM_ORDER.map((key, i) => `WHEN '${key}' THEN ${i}`).join(' ')} ELSE ${BUILTIN_TEAM_ORDER.length} END`;

export interface Team {
  id: string;
  builtin: BuiltinTeam | null;
  name: string;
  description: string;
  tokens_all: 0 | Level;
  tokens_all_reveal: boolean;
  consumers_all: 0 | Level;
  created_at: number;
  updated_at: number;
  created_by: string | null;
}

export interface TeamListEntry extends Team {
  /** Every membership row, whatever the user's status. */
  members: number;
}

export interface TeamMember {
  user_id: string;
  email: string;
  name: string | null;
  status: UserStatus;
  added_at: number;
  /** Acting user id, or 'bootstrap', 'join' or 'break-glass'. */
  added_by: string | null;
}

type Row = Record<string, unknown>;

// D1 cells are strings, numbers or null; String() of a number is the intended text.
// oxlint-disable-next-line typescript/no-base-to-string
const str = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));
const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** An out-of-range stored level reads as 0 (none): fail closed. */
export function levelOrZero(value: unknown): 0 | Level {
  const n = num(value);
  return n === 1 || n === 2 || n === 3 ? n : 0;
}

export function isBuiltinTeam(value: unknown): value is BuiltinTeam {
  return (BUILTIN_TEAM_ORDER as readonly unknown[]).includes(value);
}

export function isGlobalPermission(value: unknown): value is GlobalPermission {
  return (GLOBAL_PERMISSIONS as readonly unknown[]).includes(value);
}

export function teamFromRow(row: Row): Team {
  return {
    id: str(row.id),
    builtin: isBuiltinTeam(row.builtin) ? row.builtin : null,
    name: str(row.name),
    description: str(row.description),
    tokens_all: levelOrZero(row.tokens_all),
    tokens_all_reveal: num(row.tokens_all_reveal) === 1,
    consumers_all: levelOrZero(row.consumers_all),
    created_at: num(row.created_at),
    updated_at: num(row.updated_at),
    created_by: strOrNull(row.created_by),
  };
}

export function teamRefFromRow(row: Row): TeamRef {
  return {
    id: str(row.id),
    name: str(row.name),
    builtin: isBuiltinTeam(row.builtin) ? row.builtin : null,
  };
}

/** Built-ins first in privilege order, then custom teams A–Z. */
export function compareTeams(a: TeamRef, b: TeamRef): number {
  const rank = (team: TeamRef) =>
    team.builtin ? BUILTIN_TEAM_ORDER.indexOf(team.builtin) : BUILTIN_TEAM_ORDER.length;
  return (
    rank(a) - rank(b) ||
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export async function getTeam(db: D1Database, id: string): Promise<Team | null> {
  const row = await db.prepare('SELECT * FROM teams WHERE id = ?').bind(id).first<Row>();
  return row ? teamFromRow(row) : null;
}

/** One team's powers (one D1 batch), or null when the team does not exist. */
export async function getTeamPowers(db: D1Database, id: string): Promise<TeamPowers | null> {
  const [team, permissions, tokens, consumers] = await db.batch<Row>([
    db.prepare('SELECT * FROM teams WHERE id = ?').bind(id),
    db.prepare('SELECT permission FROM team_permissions WHERE team_id = ?').bind(id),
    db.prepare('SELECT service_id, level, reveal FROM team_tokens WHERE team_id = ?').bind(id),
    db
      .prepare('SELECT credential_access_rule_id, level FROM team_consumers WHERE team_id = ?')
      .bind(id),
  ]);
  const row = team?.results[0];
  if (!row) return null;
  const decoded = teamFromRow(row);
  const tokenRows = new Map<string, { level: Level; reveal: boolean }>();
  for (const x of tokens?.results ?? []) {
    const level = levelOrZero(x.level);
    if (level !== 0) tokenRows.set(str(x.service_id), { level, reveal: num(x.reveal) === 1 });
  }
  const consumerRows = new Map<string, { level: Level }>();
  for (const x of consumers?.results ?? []) {
    const level = levelOrZero(x.level);
    if (level !== 0) consumerRows.set(str(x.credential_access_rule_id), { level });
  }
  return {
    id: decoded.id,
    builtin: decoded.builtin,
    permissions: new Set(
      (permissions?.results ?? []).map((p) => p.permission).filter(isGlobalPermission),
    ),
    tokensAll: decoded.tokens_all,
    tokensAllReveal: decoded.tokens_all_reveal,
    consumersAll: decoded.consumers_all,
    tokens: tokenRows,
    consumers: consumerRows,
  };
}

/** Every team with its member count: built-ins first in privilege order, then A–Z. */
export async function listTeams(db: D1Database): Promise<TeamListEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS members
       FROM teams t ORDER BY ${builtinRankSql('t.builtin')}, t.name COLLATE NOCASE, t.id`,
    )
    .all<Row>();
  return results.map((row) => ({ ...teamFromRow(row), members: num(row.members) }));
}

/** The members of one team, whatever their status, by email. */
export async function listMembers(db: D1Database, teamId: string): Promise<TeamMember[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id AS user_id, u.email, u.name, u.status, m.added_at, m.added_by
       FROM team_members m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ? ORDER BY u.email COLLATE NOCASE, u.id`,
    )
    .bind(teamId)
    .all<Row>();
  return results.map((row) => ({
    user_id: str(row.user_id),
    email: str(row.email),
    name: strOrNull(row.name),
    status: str(row.status) as UserStatus,
    added_at: num(row.added_at),
    added_by: strOrNull(row.added_by),
  }));
}

/**
 * The teams a user is a member of, whatever the user's status: built-ins first in privilege
 * order, then A–Z. Effective permissions come from loadScope (src/admin/auth/scope.ts), which
 * counts active users only.
 */
export async function teamsOfUser(db: D1Database, userId: string): Promise<TeamRef[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.name, t.builtin FROM team_members m JOIN teams t ON t.id = m.team_id
       WHERE m.user_id = ? ORDER BY ${builtinRankSql('t.builtin')}, t.name COLLATE NOCASE, t.id`,
    )
    .bind(userId)
    .all<Row>();
  return results.map(teamRefFromRow);
}
