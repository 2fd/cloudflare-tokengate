// Admin teams (ADR 0023): reads and the code mirror of the built-in teams. A team is a named set of
// users that holds global permissions and a credential scope. It is not the Cloudflare Access team
// domain. The schema and its integrity rules (triggers) are in migrations/0001_initial.sql.
import type { UserStatus } from './types';

/**
 * Permissions that a team holds for the whole deployment, not for one credential. A team may hold
 * `access_rules:global` only with all-scope view (D23, the *_global_rules_scope triggers).
 */
export type GlobalPermission =
  | 'credentials:create'
  | 'config:export'
  | 'users:write'
  | 'settings:write'
  | 'keyring:rewrap'
  | 'access_rules:global';

export const GLOBAL_PERMISSIONS: readonly GlobalPermission[] = [
  'credentials:create',
  'config:export',
  'users:write',
  'settings:write',
  'keyring:rewrap',
  'access_rules:global',
];

/** Level on a credential: 1 view, 2 edit, 3 delete. Each level implies the lower ones. */
export type Level = 1 | 2 | 3;

/**
 * Flags on a credential, each implies view. `reveal`: copy the secret. `access_rules`: manage the
 * credential's credential access rules.
 */
export type CredentialFlag = 'reveal' | 'access_rules';

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

/** A team's power over one credential (an explicit row), or the union of such rows. */
export interface CredentialPowers {
  readonly level: Level;
  readonly reveal: boolean;
  readonly accessRules: boolean;
}

/**
 * What one team allows, as stored: its global permissions, its all-scope and its explicit rows. The
 * implied access_rules flag of `access_rules:global` is not included.
 */
export interface TeamPowers {
  id: string;
  builtin: BuiltinTeam | null;
  permissions: ReadonlySet<GlobalPermission>;
  /** All-scope level on credentials (current and future); 0 when the team uses a list or has none. */
  credentialsAll: 0 | Level;
  /** Reveal on every credential. Implies credentialsAll >= 1. */
  allReveal: boolean;
  /** Manage the access rules of every credential. Implies credentialsAll >= 1. */
  allAccessRules: boolean;
  /** Explicit rows by credential id (list mode). */
  credentials: ReadonlyMap<string, CredentialPowers>;
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
  scope: { all: Level; reveal?: boolean; accessRules?: boolean },
): BuiltinTeamPowers {
  return {
    id: `tea_${key}`,
    builtin: key,
    name,
    description,
    permissions: new Set(permissions),
    credentialsAll: scope.all,
    allReveal: scope.reveal ?? false,
    allAccessRules: scope.accessRules ?? false,
    credentials: new Map(),
  };
}

/**
 * The seeded built-in teams. The migration seed is the source of truth; a unit test pins this
 * table against the seeded rows. Only Owners hold reveal, so no other built-in team can extract a
 * secret. Credential managers do not manage access rules: a credential access rule is what lets a
 * workload use a credential (D21).
 */
export const BUILTIN_TEAMS: Readonly<Record<BuiltinTeam, BuiltinTeamPowers>> = Object.freeze({
  owner: builtin(
    'owner',
    'Owners',
    'Everything: people, teams, settings, keys, global access rules, and copying secrets.',
    [...GLOBAL_PERMISSIONS],
    { all: 3, reveal: true, accessRules: true },
  ),
  admin: builtin(
    'admin',
    'Admins',
    'Every credential and its access rules, global access rules, and the export.',
    ['credentials:create', 'config:export', 'access_rules:global'],
    { all: 3, accessRules: true },
  ),
  token_manager: builtin(
    'token_manager',
    'Credential managers',
    'Add, change and delete credentials. See every access rule.',
    ['credentials:create'],
    { all: 3 },
  ),
  access_manager: builtin(
    'access_manager',
    'Access managers',
    'Add, change and delete credential access rules. See every credential and global access rule.',
    [],
    { all: 1, accessRules: true },
  ),
  viewer: builtin(
    'viewer',
    'Viewers',
    'See every credential and access rule. Change nothing.',
    [],
    { all: 1 },
  ),
});

/** SQL rank that sorts built-in teams first, in privilege order. Custom teams rank last. */
export const builtinRankSql = (column: string): string =>
  `CASE ${column} ${BUILTIN_TEAM_ORDER.map((key, i) => `WHEN '${key}' THEN ${i}`).join(' ')} ELSE ${BUILTIN_TEAM_ORDER.length} END`;

export interface Team {
  id: string;
  builtin: BuiltinTeam | null;
  name: string;
  description: string;
  credentials_all: 0 | Level;
  credentials_all_reveal: boolean;
  credentials_all_access_rules: boolean;
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
    credentials_all: levelOrZero(row.credentials_all),
    credentials_all_reveal: num(row.credentials_all_reveal) === 1,
    credentials_all_access_rules: num(row.credentials_all_access_rules) === 1,
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

/** One team's powers as stored (one D1 batch), or null when the team does not exist. */
export async function getTeamPowers(db: D1Database, id: string): Promise<TeamPowers | null> {
  const [team, permissions, credentials] = await db.batch<Row>([
    db.prepare('SELECT * FROM teams WHERE id = ?').bind(id),
    db.prepare('SELECT permission FROM team_permissions WHERE team_id = ?').bind(id),
    db
      .prepare(
        'SELECT credential_id, level, reveal, access_rules FROM team_credentials WHERE team_id = ?',
      )
      .bind(id),
  ]);
  const row = team?.results[0];
  if (!row) return null;
  const decoded = teamFromRow(row);
  const rows = new Map<string, CredentialPowers>();
  for (const x of credentials?.results ?? []) {
    const level = levelOrZero(x.level);
    if (level !== 0) {
      rows.set(str(x.credential_id), {
        level,
        reveal: num(x.reveal) === 1,
        accessRules: num(x.access_rules) === 1,
      });
    }
  }
  return {
    id: decoded.id,
    builtin: decoded.builtin,
    permissions: new Set(
      (permissions?.results ?? []).map((p) => p.permission).filter(isGlobalPermission),
    ),
    credentialsAll: decoded.credentials_all,
    allReveal: decoded.credentials_all_reveal,
    allAccessRules: decoded.credentials_all_access_rules,
    credentials: rows,
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
