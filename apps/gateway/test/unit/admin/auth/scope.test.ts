// The JS form of the permission model (src/admin/auth/scope.ts): effective permissions, visibility,
// the SQL filters (run against D1), dominance and the team-change predicates. The property test in
// test/unit/db/authority.test.ts checks that holds and dominatesTeam agree with the SQL form.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AdminScope,
  auditScopeSql,
  canAny,
  type CredentialPowers,
  type CredentialScope,
  dominatesTeam,
  effectiveAllAccessRules,
  highestBuiltin,
  holds,
  isElevated,
  isGlobalViewer,
  isJoinSafe,
  type Level,
  loadScope,
  type Need,
  raises,
  recordScopeSql,
  recordVisible,
  scopeSql,
  type SqlGuard,
  type TeamPowers,
  visibleIds,
} from '../../../../src/admin/auth/scope';
import { BUILTIN_TEAMS, type GlobalPermission } from '../../../../src/db/teams';
import { createUser, resetControlPlane } from '../../../helpers/admin-auth';
import { addMember, createTeam } from '../../../helpers/teams';

const db = env.DB;
const T = 1_700_000_000_000;

type RowInput = Level | { level: Level; reveal?: boolean; accessRules?: boolean };

const row = (input: RowInput): CredentialPowers =>
  typeof input === 'number'
    ? { level: input, reveal: false, accessRules: false }
    : {
        level: input.level,
        reveal: input.reveal ?? false,
        accessRules: input.accessRules ?? false,
      };

function rows(explicit: Record<string, RowInput>): Map<string, CredentialPowers> {
  return new Map(Object.entries(explicit).map(([id, value]) => [id, row(value)]));
}

function credentials(
  all: 0 | Level,
  explicit: Record<string, RowInput> = {},
  flags: { reveal?: boolean; accessRules?: boolean } = {},
): CredentialScope {
  return {
    all,
    allReveal: flags.reveal ?? false,
    allAccessRules: flags.accessRules ?? false,
    explicit: rows(explicit),
  };
}

function scopeOf(input: {
  permissions?: GlobalPermission[];
  credentials?: CredentialScope;
  teams?: AdminScope['teams'];
}): AdminScope {
  return {
    userId: 'usr_me',
    teams: input.teams ?? [],
    permissions: new Set(input.permissions ?? []),
    credentials: input.credentials ?? credentials(0),
  };
}

function team(input: Partial<TeamPowers> & { id?: string }): TeamPowers {
  return {
    id: input.id ?? 'tea_01HZZZZZZZZZZZZZZZZZZZZZZZ',
    builtin: input.builtin ?? null,
    permissions: input.permissions ?? new Set(),
    credentialsAll: input.credentialsAll ?? 0,
    allReveal: input.allReveal ?? false,
    allAccessRules: input.allAccessRules ?? false,
    credentials: input.credentials ?? new Map(),
  };
}

/** A restricted viewer: credential A (edit, reveal), credential C (view, access rules). */
const RESTRICTED = scopeOf({
  credentials: credentials(0, {
    svc_a: { level: 2, reveal: true },
    svc_c: { level: 1, accessRules: true },
  }),
});
/** A global viewer, like every built-in team. */
const GLOBAL = scopeOf({ credentials: credentials(1) });
/** A team with access_rules:global and all-scope view (D23). */
const GLOBAL_RULES = scopeOf({
  permissions: ['access_rules:global'],
  credentials: credentials(1),
});

const NEEDS: readonly Need[] = ['view', 'edit', 'delete', 'reveal', 'access_rules'];

describe('holds, canAny and effectiveAllAccessRules', () => {
  it('takes the highest of the all-scope and the explicit row', () => {
    const scope = scopeOf({ credentials: credentials(1, { svc_a: 3 }) });
    expect(holds(scope, { id: 'svc_a', need: 'delete' })).toBe(true);
    expect(holds(scope, { id: 'svc_b', need: 'view' })).toBe(true);
    expect(holds(scope, { id: 'svc_b', need: 'edit' })).toBe(false);
  });

  it('gives each flag from the all-scope flag or the row flag', () => {
    expect(holds(RESTRICTED, { id: 'svc_a', need: 'reveal' })).toBe(true);
    expect(holds(RESTRICTED, { id: 'svc_a', need: 'access_rules' })).toBe(false);
    expect(holds(RESTRICTED, { id: 'svc_c', need: 'access_rules' })).toBe(true);
    expect(holds(RESTRICTED, { id: 'svc_c', need: 'reveal' })).toBe(false);
    expect(holds(RESTRICTED, { id: 'svc_b', need: 'reveal' })).toBe(false);
    const owner = scopeOf({ credentials: credentials(3, {}, { reveal: true, accessRules: true }) });
    expect(holds(owner, { id: 'svc_any', need: 'reveal' })).toBe(true);
    expect(holds(owner, { id: 'svc_any', need: 'access_rules' })).toBe(true);
    expect(holds(GLOBAL, { id: 'svc_any', need: 'reveal' })).toBe(false);
    expect(holds(GLOBAL, { id: 'svc_any', need: 'access_rules' })).toBe(false);
  });

  it('access_rules:global gives access_rules on every visible credential, and nothing else', () => {
    for (const need of NEEDS) {
      expect(holds(GLOBAL_RULES, { id: 'svc_any', need }), need).toBe(
        need === 'view' || need === 'access_rules',
      );
    }
    expect(effectiveAllAccessRules(GLOBAL_RULES)).toBe(true);
    expect(canAny(GLOBAL_RULES, 'access_rules')).toBe(true);
    // Without D23 (a list scope), only the listed credentials.
    const listed = scopeOf({
      permissions: ['access_rules:global'],
      credentials: credentials(0, { svc_a: 1 }),
    });
    expect(holds(listed, { id: 'svc_a', need: 'access_rules' })).toBe(true);
    expect(holds(listed, { id: 'svc_b', need: 'access_rules' })).toBe(false);
    expect(effectiveAllAccessRules(listed)).toBe(false);
    expect(canAny(listed, 'access_rules')).toBe(true);
    // No visible credential: nothing.
    const blind = scopeOf({ permissions: ['access_rules:global'] });
    expect(holds(blind, { id: 'svc_a', need: 'access_rules' })).toBe(false);
    expect(canAny(blind, 'access_rules')).toBe(false);
    expect(effectiveAllAccessRules(blind)).toBe(false);
  });

  it('the access_rules flag never gives access_rules:global', () => {
    const flagged = scopeOf({ credentials: credentials(1, {}, { accessRules: true }) });
    expect(effectiveAllAccessRules(flagged)).toBe(true);
    expect(flagged.permissions.has('access_rules:global')).toBe(false);
    expect(effectiveAllAccessRules(GLOBAL)).toBe(false);
  });

  it('hides everything from a user in no team', () => {
    const none = scopeOf({});
    for (const need of NEEDS) {
      expect(holds(none, { id: 'svc_a', need }), need).toBe(false);
      expect(canAny(none, need), need).toBe(false);
    }
  });

  it('canAny looks at every row and at the all-scope', () => {
    expect(canAny(RESTRICTED, 'edit')).toBe(true);
    expect(canAny(RESTRICTED, 'delete')).toBe(false);
    expect(canAny(RESTRICTED, 'reveal')).toBe(true);
    expect(canAny(RESTRICTED, 'access_rules')).toBe(true);
    expect(canAny(scopeOf({ credentials: credentials(0, { svc_a: 3 }) }), 'access_rules')).toBe(
      false,
    );
    expect(canAny(GLOBAL, 'view')).toBe(true);
    expect(canAny(GLOBAL, 'edit')).toBe(false);
    expect(canAny(GLOBAL, 'reveal')).toBe(false);
  });
});

describe('visibleIds, isGlobalViewer and recordVisible', () => {
  it('lists explicit ids, sorted, unless the all-scope covers every credential', () => {
    const scope = scopeOf({ credentials: credentials(0, { svc_b: 1, svc_a: 3 }) });
    expect(visibleIds(scope)).toEqual({ all: false, ids: ['svc_a', 'svc_b'] });
    expect(visibleIds(GLOBAL)).toEqual({ all: true });
    expect(visibleIds(scopeOf({}))).toEqual({ all: false, ids: [] });
    expect(isGlobalViewer(scope)).toBe(false);
    expect(isGlobalViewer(GLOBAL)).toBe(true);
    // access_rules:global does not make a viewer global; the scope does.
    expect(isGlobalViewer(scopeOf({ permissions: ['access_rules:global'] }))).toBe(false);
  });

  it.each([
    ['visible credential', 'svc_a', true],
    ['view-only credential with a flag', 'svc_c', true],
    ['hidden credential', 'svc_b', false],
    ['no credential (pre-trust)', null, false],
    ['empty credential (rollup)', '', false],
  ])('%s → %s', (_name, service, expected) => {
    expect(recordVisible(RESTRICTED, { service_id: service })).toBe(expected);
    expect(recordVisible(GLOBAL, { service_id: service })).toBe(true);
  });
});

/** Ids of the rows of `values` (id, service) that `guard` keeps, run in D1. */
async function kept(
  values: Array<[string, string | null]>,
  guard: SqlGuard,
  leading: unknown[] = [],
): Promise<string[]> {
  // Numbered binds first (when `leading` is given), then the VALUES rows as numbered binds too, so
  // anonymous and numbered parameters are never mixed in one statement.
  const numbered = leading.length > 0;
  const start = leading.length + guard.binds.length + 1;
  const valueSql = numbered
    ? values.map((_, i) => `(?${start + i * 2}, ?${start + i * 2 + 1})`).join(', ')
    : values.map(() => '(?, ?)').join(', ');
  const sql = `WITH r(id, service_id) AS (VALUES ${valueSql})
    SELECT id FROM r WHERE ${guard.sql} ORDER BY id`;
  const binds = numbered
    ? [...leading, ...guard.binds, ...values.flat()]
    : [...values.flat(), ...guard.binds];
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

describe('scopeSql', () => {
  it('renders `1` for all, and a json_each list otherwise', async () => {
    expect(scopeSql({ all: true }, 'service_id')).toEqual({ sql: '1', binds: [] });
    const guard = scopeSql({ all: false, ids: ['svc_a', 'svc_c'] }, 'service_id');
    expect(guard).toEqual({
      sql: 'service_id IN (SELECT value FROM json_each(?))',
      binds: ['["svc_a","svc_c"]'],
    });
    const values: Array<[string, string | null]> = [
      ['1', 'svc_a'],
      ['2', 'svc_b'],
      ['3', 'svc_c'],
      ['4', null],
    ];
    expect(await kept(values, guard)).toEqual(['1', '3']);
    expect(await kept(values, scopeSql({ all: false, ids: [] }, 'service_id'))).toEqual([]);
  });

  it('numbers its bind with `at`', async () => {
    const guard = scopeSql({ all: false, ids: ['svc_b'] }, 'service_id', { at: 2 });
    expect(guard.sql).toBe('service_id IN (SELECT value FROM json_each(?2))');
    const values: Array<[string, string | null]> = [
      ['1', 'svc_a'],
      ['2', 'svc_b'],
    ];
    expect(
      await kept(values, { sql: `?1 = 'x' AND ${guard.sql}`, binds: guard.binds }, ['x']),
    ).toEqual(['2']);
  });
});

describe('recordScopeSql', () => {
  const VALUES: Array<[string, string | null]> = [
    ['a', 'svc_a'],
    ['b', 'svc_b'],
    ['c', 'svc_c'],
    ['none', null],
  ];
  const COLS = { service: 'service_id', empty: 'NULL' } as const;

  it('renders no clause for a global viewer', () => {
    expect(recordScopeSql(GLOBAL, COLS)).toBeNull();
    expect(recordScopeSql(GLOBAL_RULES, COLS)).toBeNull();
  });

  it('applies the record rule to request_log rows (NULL is unset)', async () => {
    const guard = recordScopeSql(RESTRICTED, COLS);
    expect(guard?.binds).toEqual(['["svc_a","svc_c"]']);
    expect(await kept(VALUES, guard!)).toEqual(['a', 'c']);
  });

  it("applies the record rule to rollup rows ('' is unset)", async () => {
    const rollups = VALUES.map(([id, s]) => [id, s ?? ''] as [string, string]);
    const guard = recordScopeSql(RESTRICTED, { ...COLS, empty: "''" });
    expect(guard?.sql).toContain("service_id <> ''");
    expect(await kept(rollups, guard!)).toEqual(['a', 'c']);
  });

  it('keeps nothing for a user who sees no credential, and numbers the bind with `at`', async () => {
    expect(await kept(VALUES, recordScopeSql(scopeOf({}), COLS)!)).toEqual([]);
    const guard = recordScopeSql(RESTRICTED, COLS, { at: 3 });
    expect(guard?.sql).toContain('json_each(?3)');
    expect(await kept(VALUES, guard!, ['p1', 'p2'])).toEqual(['a', 'c']);
  });
});

describe('auditScopeSql', () => {
  beforeEach(resetControlPlane);

  const insert = (id: string, resources: string) =>
    db
      .prepare(
        `INSERT INTO audit_log (id, ts, actor_type, action, summary, resources)
         VALUES (?, ?, 'system', 'test', 'test', ?)`,
      )
      .bind(id, T, resources);

  async function visible(scope: AdminScope): Promise<string[]> {
    const guard = auditScopeSql(scope);
    const { results } = await db
      .prepare(`SELECT id FROM audit_log${guard ? ` WHERE ${guard.sql}` : ''} ORDER BY id`)
      .bind(...(guard?.binds ?? []))
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }

  it('hides a row with any hidden, unknown or malformed resource', async () => {
    await db.batch([
      // A global access rule row: global rules are not written to resources (D20).
      insert('aud_01_empty', '[]'),
      insert('aud_02_credential', '["svc_a"]'),
      insert('aud_03_both', '["svc_a","svc_c"]'),
      insert('aud_04_hidden', '["svc_b"]'),
      insert('aud_05_mixed', '["svc_a","svc_b"]'),
      insert('aud_06_rule', '["acr_1"]'),
      insert('aud_07_global_rule', '["gar_1"]'),
      insert('aud_08_sentinel', '["*"]'),
      insert('aud_09_null', '[null]'),
      insert('aud_10_number', '[5]'),
      insert('aud_11_nested', '[["svc_a"]]'),
    ]);
    expect(await visible(RESTRICTED)).toEqual(['aud_01_empty', 'aud_02_credential', 'aud_03_both']);
    expect(await visible(scopeOf({}))).toEqual(['aud_01_empty']);
    expect(auditScopeSql(GLOBAL)).toBeNull();
    expect(await visible(GLOBAL)).toHaveLength(11);
  });

  it('takes a table alias', () => {
    expect(auditScopeSql(RESTRICTED, 'a')?.sql).toContain('json_each(a.resources)');
  });
});

describe('dominatesTeam', () => {
  const actor = scopeOf({
    permissions: ['credentials:create', 'users:write'],
    credentials: credentials(0, {
      svc_a: { level: 2, reveal: true },
      svc_c: { level: 1, accessRules: true },
    }),
  });

  it('needs every permission, the all-scope and every explicit row of the team', () => {
    const dominates = (input: Partial<TeamPowers>) => dominatesTeam(actor, team(input), false);
    expect(dominates({ permissions: new Set(['credentials:create']) })).toBe(true);
    // Amendment A1: users:write is a permission like any other.
    expect(dominates({ permissions: new Set(['users:write']) })).toBe(true);
    expect(dominates({ permissions: new Set(['config:export']) })).toBe(false);
    expect(dominates({ credentialsAll: 1 })).toBe(false);
    expect(dominates({ credentials: rows({ svc_a: { level: 2, reveal: true } }) })).toBe(true);
    expect(dominates({ credentials: rows({ svc_a: 3 }) })).toBe(false);
    expect(dominates({ credentials: rows({ svc_a: { level: 1, accessRules: true } }) })).toBe(
      false,
    );
    expect(dominates({ credentials: rows({ svc_c: { level: 1, accessRules: true } }) })).toBe(true);
    expect(dominates({ credentials: rows({ svc_c: { level: 1, reveal: true } }) })).toBe(false);
    // A row on a credential the actor cannot see is never dominated.
    expect(dominates({ credentials: rows({ svc_b: 1 }) })).toBe(false);
  });

  it('compares the all-scope level and each all-scope flag', () => {
    const all = scopeOf({ credentials: credentials(2, {}, { accessRules: true }) });
    const dominates = (input: Partial<TeamPowers>) => dominatesTeam(all, team(input), false);
    expect(dominates({ credentialsAll: 2, allAccessRules: true })).toBe(true);
    expect(dominates({ credentialsAll: 3 })).toBe(false);
    expect(dominates({ credentialsAll: 1, allReveal: true })).toBe(false);
    expect(dominates({ credentials: rows({ svc_any: { level: 2, accessRules: true } }) })).toBe(
      true,
    );
    expect(dominates({ permissions: new Set(['access_rules:global']), credentialsAll: 1 })).toBe(
      false,
    );
  });

  it('counts the access_rules flag implied by access_rules:global', () => {
    const globalTeam = team({ permissions: new Set(['access_rules:global']), credentialsAll: 1 });
    expect(
      dominatesTeam(GLOBAL_RULES, team({ credentialsAll: 1, allAccessRules: true }), false),
    ).toBe(true);
    expect(
      dominatesTeam(
        GLOBAL_RULES,
        team({ credentials: rows({ svc_a: { level: 1, accessRules: true } }) }),
        false,
      ),
    ).toBe(true);
    expect(dominatesTeam(GLOBAL_RULES, globalTeam, false)).toBe(true);
    // The flag alone does not dominate a team that holds the permission.
    const flagged = scopeOf({ credentials: credentials(3, {}, { accessRules: true }) });
    expect(dominatesTeam(flagged, globalTeam, false)).toBe(false);
  });

  it('lets only an Owners member dominate the Owners team', () => {
    const shadow = scopeOf({
      permissions: [
        'credentials:create',
        'config:export',
        'users:write',
        'settings:write',
        'keyring:rewrap',
        'access_rules:global',
      ],
      credentials: credentials(3, {}, { reveal: true, accessRules: true }),
    });
    expect(dominatesTeam(shadow, BUILTIN_TEAMS.owner, false)).toBe(false);
    expect(dominatesTeam(shadow, BUILTIN_TEAMS.owner, true)).toBe(true);
    expect(dominatesTeam(shadow, BUILTIN_TEAMS.admin, false)).toBe(true);
    expect(dominatesTeam(GLOBAL, BUILTIN_TEAMS.viewer, false)).toBe(true);
    expect(dominatesTeam(GLOBAL, BUILTIN_TEAMS.token_manager, false)).toBe(false);
    expect(dominatesTeam(GLOBAL, BUILTIN_TEAMS.access_manager, false)).toBe(false);
    expect(dominatesTeam(GLOBAL_RULES, BUILTIN_TEAMS.access_manager, false)).toBe(true);
  });
});

describe('isJoinSafe, raises and isElevated', () => {
  it('isJoinSafe refuses Owners, owner-grade permissions and reveal', () => {
    expect(isJoinSafe(BUILTIN_TEAMS.viewer)).toBe(true);
    expect(isJoinSafe(BUILTIN_TEAMS.admin)).toBe(true);
    expect(isJoinSafe(BUILTIN_TEAMS.access_manager)).toBe(true);
    expect(isJoinSafe(BUILTIN_TEAMS.owner)).toBe(false);
    for (const permission of ['users:write', 'settings:write', 'keyring:rewrap'] as const) {
      expect(isJoinSafe(team({ permissions: new Set([permission]) })), permission).toBe(false);
    }
    expect(isJoinSafe(team({ credentialsAll: 1, allReveal: true }))).toBe(false);
    expect(isJoinSafe(team({ credentials: rows({ svc_a: { level: 1, reveal: true } }) }))).toBe(
      false,
    );
    expect(
      isJoinSafe(team({ credentials: rows({ svc_a: { level: 3, accessRules: true } }) })),
    ).toBe(true);
    expect(
      isJoinSafe(team({ permissions: new Set(['access_rules:global']), credentialsAll: 1 })),
    ).toBe(true);
  });

  it('raises: a power added or raised, never a power lowered', () => {
    const before = team({
      permissions: new Set(['credentials:create']),
      credentials: rows({ svc_a: 2 }),
    });
    const change = (patch: Partial<TeamPowers>) => team({ ...before, ...patch });
    expect(raises(before, before)).toBe(false);
    expect(raises(before, change({ permissions: new Set() }))).toBe(false);
    expect(raises(before, change({ credentials: new Map() }))).toBe(false);
    expect(raises(before, change({ credentials: rows({ svc_a: 1 }) }))).toBe(false);
    for (const permission of ['config:export', 'access_rules:global'] as const) {
      expect(
        raises(before, change({ permissions: new Set(['credentials:create', permission]) })),
        permission,
      ).toBe(true);
    }
    expect(raises(before, change({ credentials: rows({ svc_a: 3 }) }))).toBe(true);
    expect(
      raises(before, change({ credentials: rows({ svc_a: { level: 2, reveal: true } }) })),
    ).toBe(true);
    expect(
      raises(before, change({ credentials: rows({ svc_a: { level: 2, accessRules: true } }) })),
    ).toBe(true);
    expect(raises(before, change({ credentials: rows({ svc_a: 2, svc_b: 1 }) }))).toBe(true);
    // Removing a flag is a lowering.
    const flagged = change({ credentials: rows({ svc_a: { level: 2, accessRules: true } }) });
    expect(raises(flagged, before)).toBe(false);
    // List → all is a raise, even at a lower level: it covers credentials the list did not.
    expect(raises(before, change({ credentials: new Map(), credentialsAll: 1 }))).toBe(true);
    const all = change({ credentials: new Map(), credentialsAll: 1 });
    expect(raises(all, team({ ...all, allReveal: true }))).toBe(true);
    expect(raises(all, team({ ...all, allAccessRules: true }))).toBe(true);
    expect(raises(team({ ...all, allAccessRules: true }), all)).toBe(false);
    expect(raises(all, team({ ...all, credentialsAll: 2 }))).toBe(true);
  });

  it('isElevated (D6): create, export, global rules, a level above view, an access_rules flag', () => {
    expect(isElevated(BUILTIN_TEAMS.viewer)).toBe(false);
    expect(isElevated(team({ credentialsAll: 1 }))).toBe(false);
    expect(isElevated(team({ credentials: rows({ svc_a: 1 }) }))).toBe(false);
    for (const key of ['owner', 'admin', 'token_manager', 'access_manager'] as const) {
      expect(isElevated(BUILTIN_TEAMS[key]), key).toBe(true);
    }
    for (const permission of ['credentials:create', 'config:export'] as const) {
      expect(isElevated(team({ permissions: new Set([permission]) })), permission).toBe(true);
    }
    expect(
      isElevated(team({ permissions: new Set(['access_rules:global']), credentialsAll: 1 })),
    ).toBe(true);
    expect(isElevated(team({ credentialsAll: 2 }))).toBe(true);
    expect(isElevated(team({ credentialsAll: 1, allAccessRules: true }))).toBe(true);
    expect(isElevated(team({ credentials: rows({ svc_a: 2 }) }))).toBe(true);
    expect(
      isElevated(team({ credentials: rows({ svc_a: { level: 1, accessRules: true } }) })),
    ).toBe(true);
    // Not join-safe counts too.
    expect(isElevated(team({ permissions: new Set(['users:write']) }))).toBe(true);
    expect(isElevated(team({ credentials: rows({ svc_a: { level: 1, reveal: true } }) }))).toBe(
      true,
    );
  });
});

describe('highestBuiltin', () => {
  it('returns the most privileged built-in team, or null', () => {
    const ref = (id: string, builtin: TeamPowers['builtin']) => ({ id, name: id, builtin });
    expect(highestBuiltin({ teams: [] })).toBeNull();
    expect(highestBuiltin({ teams: [ref('tea_01HZZZZZZZZZZZZZZZZZZZZZZZ', null)] })).toBeNull();
    expect(
      highestBuiltin({ teams: [ref('tea_viewer', 'viewer'), ref('tea_admin', 'admin')] }),
    ).toBe('admin');
  });
});

describe('loadScope', () => {
  beforeEach(resetControlPlane);

  const insertCredential = (id: string) => {
    const slug = id.replace('_', '-');
    return db
      .prepare(
        `INSERT INTO credentials (id, slug, name, base_url, injection, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{"kind":"bearer"}', ?, ?)`,
      )
      .bind(id, slug, id, `https://${slug}.example.com`, T, T);
  };

  it('unions the teams of an active user, built-ins first', async () => {
    await db.batch([insertCredential('svc_a'), insertCredential('svc_b')]);
    const user = await createUser({ email: 'u@example.com', role: 'viewer' });
    await createTeam({
      name: 'Payments',
      permissions: ['credentials:create'],
      credentials: { svc_a: { level: 2, reveal: true }, svc_b: { level: 1 } },
      members: [user],
    });
    await createTeam({
      name: 'Audit',
      credentials: { svc_a: { level: 1, accessRules: true } },
      members: [user],
    });
    await addMember('tea_viewer', user.id);
    const scope = await loadScope(db, user.id);
    expect(scope.teams.map((t) => t.name)).toEqual(['Viewers', 'Audit', 'Payments']);
    expect([...scope.permissions]).toEqual(['credentials:create']);
    expect(scope.credentials).toEqual(
      credentials(1, {
        svc_a: { level: 2, reveal: true, accessRules: true },
        svc_b: 1,
      }),
    );
    expect(highestBuiltin(scope)).toBe('viewer');
  });

  it('gives nothing to a user who is not active', async () => {
    const user = await createUser({ email: 's@example.com', role: 'viewer', status: 'suspended' });
    await addMember('tea_owner', user.id);
    const scope = await loadScope(db, user.id);
    expect(scope.teams).toEqual([]);
    expect(scope.permissions.size).toBe(0);
    expect(scope.credentials).toEqual(credentials(0));
  });

  it('reads the built-in powers from the seed', async () => {
    const owner = await createUser({ email: 'o@example.com', role: 'viewer' });
    await addMember('tea_owner', owner.id);
    const scope = await loadScope(db, owner.id);
    expect(scope.permissions).toEqual(BUILTIN_TEAMS.owner.permissions);
    expect(scope.credentials).toEqual(credentials(3, {}, { reveal: true, accessRules: true }));
    expect(isGlobalViewer(scope)).toBe(true);
    const admin = await createUser({ email: 'a@example.com', role: 'viewer' });
    await addMember('tea_admin', admin.id);
    const adminScope = await loadScope(db, admin.id);
    expect(adminScope.credentials).toEqual(credentials(3, {}, { accessRules: true }));
    expect(holds(adminScope, { id: 'svc_any', need: 'reveal' })).toBe(false);
  });
});
