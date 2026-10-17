// The JS form of the permission model (src/admin/auth/scope.ts): effective permissions, visibility,
// the SQL filters (run against D1), dominance and the team-change predicates. The property test in
// test/unit/db/authority.test.ts checks that holds and dominatesTeam agree with the SQL form.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AdminScope,
  auditScopeSql,
  canAny,
  dominatesTeam,
  highestBuiltin,
  holds,
  isElevated,
  isGlobalViewer,
  isJoinSafe,
  type KindScope,
  type Level,
  loadScope,
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

function kinds(
  all: 0 | Level,
  explicit: Record<string, Level | { level: Level; reveal: boolean }> = {},
  allReveal = false,
): KindScope {
  return {
    all,
    allReveal,
    explicit: new Map(
      Object.entries(explicit).map(([id, row]) => [
        id,
        typeof row === 'number' ? { level: row, reveal: false } : row,
      ]),
    ),
  };
}

function scopeOf(input: {
  permissions?: GlobalPermission[];
  tokens?: KindScope;
  consumers?: KindScope;
  teams?: AdminScope['teams'];
}): AdminScope {
  return {
    userId: 'usr_me',
    teams: input.teams ?? [],
    permissions: new Set(input.permissions ?? []),
    tokens: input.tokens ?? kinds(0),
    consumers: input.consumers ?? kinds(0),
  };
}

function team(input: Partial<TeamPowers> & { id?: string }): TeamPowers {
  return {
    id: input.id ?? 'tea_01HZZZZZZZZZZZZZZZZZZZZZZZ',
    builtin: input.builtin ?? null,
    permissions: input.permissions ?? new Set(),
    tokensAll: input.tokensAll ?? 0,
    tokensAllReveal: input.tokensAllReveal ?? false,
    consumersAll: input.consumersAll ?? 0,
    tokens: input.tokens ?? new Map(),
    consumers: input.consumers ?? new Map(),
  };
}

/** A restricted viewer: token A (edit, reveal), consumer X (view). */
const RESTRICTED = scopeOf({
  tokens: kinds(0, { svc_a: { level: 2, reveal: true } }),
  consumers: kinds(0, { cpr_x: 1 }),
});
/** A global viewer, like every built-in team. */
const GLOBAL = scopeOf({ tokens: kinds(1), consumers: kinds(1) });

describe('holds and canAny', () => {
  it('takes the highest of the all-scope and the explicit row', () => {
    const scope = scopeOf({ tokens: kinds(1, { svc_a: 3 }), consumers: kinds(2) });
    expect(holds(scope, { kind: 'token', id: 'svc_a', need: 'delete' })).toBe(true);
    expect(holds(scope, { kind: 'token', id: 'svc_b', need: 'view' })).toBe(true);
    expect(holds(scope, { kind: 'token', id: 'svc_b', need: 'edit' })).toBe(false);
    expect(holds(scope, { kind: 'consumer', id: 'cpr_any', need: 'edit' })).toBe(true);
    expect(holds(scope, { kind: 'consumer', id: 'cpr_any', need: 'delete' })).toBe(false);
  });

  it('gives reveal on tokens only, from the flag or the all-scope reveal', () => {
    expect(holds(RESTRICTED, { kind: 'token', id: 'svc_a', need: 'reveal' })).toBe(true);
    expect(holds(RESTRICTED, { kind: 'token', id: 'svc_b', need: 'reveal' })).toBe(false);
    expect(holds(RESTRICTED, { kind: 'consumer', id: 'cpr_x', need: 'reveal' })).toBe(false);
    const owner = scopeOf({ tokens: kinds(3, {}, true), consumers: kinds(3) });
    expect(holds(owner, { kind: 'token', id: 'svc_any', need: 'reveal' })).toBe(true);
    expect(holds(GLOBAL, { kind: 'token', id: 'svc_any', need: 'reveal' })).toBe(false);
  });

  it('hides everything from a user in no team', () => {
    const none = scopeOf({});
    expect(holds(none, { kind: 'token', id: 'svc_a', need: 'view' })).toBe(false);
    expect(canAny(none, 'consumer', 'view')).toBe(false);
  });

  it('canAny looks at every row and at the all-scope', () => {
    expect(canAny(RESTRICTED, 'token', 'edit')).toBe(true);
    expect(canAny(RESTRICTED, 'token', 'delete')).toBe(false);
    expect(canAny(RESTRICTED, 'token', 'reveal')).toBe(true);
    expect(canAny(RESTRICTED, 'consumer', 'view')).toBe(true);
    expect(canAny(RESTRICTED, 'consumer', 'edit')).toBe(false);
    expect(canAny(RESTRICTED, 'consumer', 'reveal')).toBe(false);
    expect(canAny(GLOBAL, 'consumer', 'view')).toBe(true);
    expect(canAny(GLOBAL, 'token', 'reveal')).toBe(false);
  });
});

describe('visibleIds, isGlobalViewer and recordVisible', () => {
  it('lists explicit ids, sorted, unless the all-scope covers the kind', () => {
    const scope = scopeOf({ tokens: kinds(0, { svc_b: 1, svc_a: 3 }), consumers: kinds(1) });
    expect(visibleIds(scope, 'token')).toEqual({ all: false, ids: ['svc_a', 'svc_b'] });
    expect(visibleIds(scope, 'consumer')).toEqual({ all: true });
    expect(isGlobalViewer(scope)).toBe(false);
    expect(isGlobalViewer(GLOBAL)).toBe(true);
  });

  it.each([
    ['visible consumer, no token', null, 'cpr_x', true],
    ['visible consumer, visible token', 'svc_a', 'cpr_x', true],
    ['visible consumer, hidden token', 'svc_b', 'cpr_x', false],
    ['hidden consumer, visible token', 'svc_a', 'cpr_y', false],
    ['no consumer (pre-trust)', 'svc_a', null, false],
    ['empty consumer (rollup)', 'svc_a', '', false],
    ['visible consumer, empty token (rollup)', '', 'cpr_x', true],
  ])('%s → %s', (_name, service, consumer, expected) => {
    expect(
      recordVisible(RESTRICTED, { service_id: service, credential_access_rule_id: consumer }),
    ).toBe(expected);
    expect(
      recordVisible(GLOBAL, { service_id: service, credential_access_rule_id: consumer }),
    ).toBe(true);
  });
});

/** Ids of the rows of `values` (id, service, consumer) that `guard` keeps, run in D1. */
async function kept(
  values: Array<[string, string | null, string | null]>,
  guard: SqlGuard,
  leading: unknown[] = [],
): Promise<string[]> {
  const rows = values.map(() => '(?, ?, ?)').join(', ');
  // Numbered binds first (when `leading` is given), then the VALUES rows as numbered binds too, so
  // anonymous and numbered parameters are never mixed in one statement.
  const numbered = leading.length > 0;
  const start = leading.length + guard.binds.length + 1;
  const valueSql = numbered
    ? values
        .map((_, i) => `(?${start + i * 3}, ?${start + i * 3 + 1}, ?${start + i * 3 + 2})`)
        .join(', ')
    : rows;
  const sql = `WITH r(id, service_id, credential_access_rule_id) AS (VALUES ${valueSql})
    SELECT id FROM r WHERE ${guard.sql} ORDER BY id`;
  const binds = numbered
    ? [...leading, ...guard.binds, ...values.flat()]
    : [...values.flat(), ...guard.binds];
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

describe('scopeSql', () => {
  it('renders `1` for all, and a json_each list otherwise', async () => {
    expect(scopeSql({ all: true }, 'service_id')).toEqual({ sql: '1', binds: [] });
    const guard = scopeSql({ all: false, ids: ['svc_a', 'svc_c'] }, 'service_id');
    expect(guard).toEqual({
      sql: 'service_id IN (SELECT value FROM json_each(?))',
      binds: ['["svc_a","svc_c"]'],
    });
    const values: Array<[string, string | null, string | null]> = [
      ['1', 'svc_a', null],
      ['2', 'svc_b', null],
      ['3', 'svc_c', null],
      ['4', null, null],
    ];
    expect(await kept(values, guard)).toEqual(['1', '3']);
    expect(await kept(values, scopeSql({ all: false, ids: [] }, 'service_id'))).toEqual([]);
  });

  it('numbers its bind with `at`', async () => {
    const guard = scopeSql({ all: false, ids: ['svc_b'] }, 'service_id', { at: 2 });
    expect(guard.sql).toBe('service_id IN (SELECT value FROM json_each(?2))');
    const values: Array<[string, string | null, string | null]> = [
      ['1', 'svc_a', null],
      ['2', 'svc_b', null],
    ];
    expect(
      await kept(values, { sql: `?1 = 'x' AND ${guard.sql}`, binds: guard.binds }, ['x']),
    ).toEqual(['2']);
  });
});

describe('recordScopeSql', () => {
  const VALUES: Array<[string, string | null, string | null]> = [
    ['a-x', 'svc_a', 'cpr_x'],
    ['b-x', 'svc_b', 'cpr_x'],
    ['a-y', 'svc_a', 'cpr_y'],
    ['none-x', null, 'cpr_x'],
    ['a-none', 'svc_a', null],
    ['none-none', null, null],
  ];
  const COLS = {
    service: 'service_id',
    consumer: 'credential_access_rule_id',
    empty: 'NULL',
  } as const;

  it('renders no clause for a global viewer', () => {
    expect(recordScopeSql(GLOBAL, COLS)).toBeNull();
  });

  it('applies the record rule to request_log rows (NULL is unset)', async () => {
    const guard = recordScopeSql(RESTRICTED, COLS);
    expect(guard?.binds).toEqual(['["cpr_x"]', '["svc_a"]']);
    expect(await kept(VALUES, guard!)).toEqual(['a-x', 'none-x']);
  });

  it("applies the record rule to rollup rows ('' is unset)", async () => {
    const rollups = VALUES.map(([id, s, c]) => [id, s ?? '', c ?? ''] as [string, string, string]);
    const guard = recordScopeSql(RESTRICTED, { ...COLS, empty: "''" });
    expect(guard?.sql).toContain("credential_access_rule_id <> ''");
    expect(await kept(rollups, guard!)).toEqual(['a-x', 'none-x']);
  });

  it('renders `1` for a kind with all-scope, and numbers the binds with `at`', async () => {
    const allConsumers = scopeOf({ tokens: kinds(0, { svc_a: 1 }), consumers: kinds(1) });
    const guard = recordScopeSql(allConsumers, COLS, { at: 3 });
    expect(guard?.binds).toEqual(['["svc_a"]']);
    expect(guard?.sql).toContain('json_each(?3)');
    expect(await kept(VALUES, guard!, ['p1', 'p2'])).toEqual(['a-x', 'a-y', 'none-x']);
    const both = recordScopeSql(RESTRICTED, COLS, { at: 4 });
    expect(both?.sql).toMatch(/json_each\(\?4\).*json_each\(\?5\)/s);
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
    return results.map((row) => row.id);
  }

  it('hides a row with any hidden, unknown or malformed resource', async () => {
    await db.batch([
      insert('aud_01_empty', '[]'),
      insert('aud_02_token', '["svc_a"]'),
      insert('aud_03_both', '["svc_a","cpr_x"]'),
      insert('aud_04_hidden_token', '["svc_b"]'),
      insert('aud_05_mixed', '["svc_a","cpr_y"]'),
      insert('aud_06_grant', '["grt_1"]'),
      insert('aud_07_sentinel', '["*"]'),
      insert('aud_08_null', '[null]'),
      insert('aud_09_number', '[5]'),
      insert('aud_10_nested', '[["svc_a"]]'),
    ]);
    expect(await visible(RESTRICTED)).toEqual(['aud_01_empty', 'aud_02_token', 'aud_03_both']);
    expect(auditScopeSql(GLOBAL)).toBeNull();
    expect(await visible(GLOBAL)).toHaveLength(10);
    // All tokens but some consumers: every token id passes, consumers still filter.
    const allTokens = scopeOf({ tokens: kinds(1), consumers: kinds(0, { cpr_x: 1 }) });
    expect(auditScopeSql(allTokens)?.binds).toEqual(['["cpr_x"]']);
    expect(await visible(allTokens)).toEqual([
      'aud_01_empty',
      'aud_02_token',
      'aud_03_both',
      'aud_04_hidden_token',
    ]);
  });

  it('takes a table alias', () => {
    expect(auditScopeSql(RESTRICTED, 'a')?.sql).toContain('json_each(a.resources)');
  });
});

describe('dominatesTeam', () => {
  const actor = scopeOf({
    permissions: ['tokens:create', 'users:write'],
    tokens: kinds(1, { svc_a: { level: 2, reveal: true } }),
    consumers: kinds(0, { cpr_x: 3 }),
  });

  it('needs every permission, all-scope and explicit row of the team', () => {
    expect(dominatesTeam(actor, team({ permissions: new Set(['tokens:create']) }), false)).toBe(
      true,
    );
    // Amendment A1: users:write is a permission like any other.
    expect(dominatesTeam(actor, team({ permissions: new Set(['users:write']) }), false)).toBe(true);
    expect(dominatesTeam(actor, team({ permissions: new Set(['config:export']) }), false)).toBe(
      false,
    );
    expect(dominatesTeam(actor, team({ tokensAll: 1 }), false)).toBe(true);
    expect(dominatesTeam(actor, team({ tokensAll: 2 }), false)).toBe(false);
    expect(dominatesTeam(actor, team({ tokensAll: 1, tokensAllReveal: true }), false)).toBe(false);
    expect(dominatesTeam(actor, team({ consumersAll: 1 }), false)).toBe(false);
    const rows = (tokens: [string, { level: Level; reveal: boolean }][]) =>
      team({ tokens: new Map(tokens) });
    expect(dominatesTeam(actor, rows([['svc_a', { level: 2, reveal: true }]]), false)).toBe(true);
    expect(dominatesTeam(actor, rows([['svc_b', { level: 1, reveal: false }]]), false)).toBe(true);
    expect(dominatesTeam(actor, rows([['svc_b', { level: 2, reveal: false }]]), false)).toBe(false);
    expect(dominatesTeam(actor, rows([['svc_b', { level: 1, reveal: true }]]), false)).toBe(false);
    expect(
      dominatesTeam(actor, team({ consumers: new Map([['cpr_x', { level: 3 as Level }]]) }), false),
    ).toBe(true);
    expect(
      dominatesTeam(actor, team({ consumers: new Map([['cpr_y', { level: 1 as Level }]]) }), false),
    ).toBe(false);
  });

  it('lets only an Owners member dominate the Owners team', () => {
    const shadow = scopeOf({
      permissions: [
        'tokens:create',
        'consumers:create',
        'config:export',
        'users:write',
        'settings:write',
        'keyring:rewrap',
      ],
      tokens: kinds(3, {}, true),
      consumers: kinds(3),
    });
    expect(dominatesTeam(shadow, BUILTIN_TEAMS.owner, false)).toBe(false);
    expect(dominatesTeam(shadow, BUILTIN_TEAMS.owner, true)).toBe(true);
    expect(dominatesTeam(shadow, BUILTIN_TEAMS.admin, false)).toBe(true);
    expect(dominatesTeam(GLOBAL, BUILTIN_TEAMS.viewer, false)).toBe(true);
    expect(dominatesTeam(GLOBAL, BUILTIN_TEAMS.token_manager, false)).toBe(false);
  });
});

describe('isJoinSafe, raises and isElevated', () => {
  it('isJoinSafe refuses Owners, owner-grade permissions and reveal', () => {
    expect(isJoinSafe(BUILTIN_TEAMS.viewer)).toBe(true);
    expect(isJoinSafe(BUILTIN_TEAMS.admin)).toBe(true);
    expect(isJoinSafe(BUILTIN_TEAMS.owner)).toBe(false);
    for (const permission of ['users:write', 'settings:write', 'keyring:rewrap'] as const) {
      expect(isJoinSafe(team({ permissions: new Set([permission]) })), permission).toBe(false);
    }
    expect(isJoinSafe(team({ tokensAll: 1, tokensAllReveal: true }))).toBe(false);
    expect(isJoinSafe(team({ tokens: new Map([['svc_a', { level: 1, reveal: true }]]) }))).toBe(
      false,
    );
    expect(isJoinSafe(team({ tokens: new Map([['svc_a', { level: 3, reveal: false }]]) }))).toBe(
      true,
    );
  });

  it('raises: a power added or raised, never a power lowered', () => {
    const before = team({
      permissions: new Set(['tokens:create']),
      tokens: new Map([['svc_a', { level: 2, reveal: false }]]),
      consumersAll: 2,
    });
    const change = (patch: Partial<TeamPowers>) => team({ ...before, ...patch });
    expect(raises(before, before)).toBe(false);
    expect(raises(before, change({ permissions: new Set() }))).toBe(false);
    expect(raises(before, change({ consumersAll: 1 }))).toBe(false);
    expect(raises(before, change({ tokens: new Map() }))).toBe(false);
    expect(
      raises(before, change({ tokens: new Map([['svc_a', { level: 1, reveal: false }]]) })),
    ).toBe(false);
    expect(
      raises(before, change({ permissions: new Set(['tokens:create', 'config:export']) })),
    ).toBe(true);
    expect(raises(before, change({ consumersAll: 3 }))).toBe(true);
    expect(
      raises(before, change({ tokens: new Map([['svc_a', { level: 3, reveal: false }]]) })),
    ).toBe(true);
    expect(
      raises(before, change({ tokens: new Map([['svc_a', { level: 2, reveal: true }]]) })),
    ).toBe(true);
    expect(
      raises(
        before,
        change({
          tokens: new Map([
            ['svc_a', { level: 2, reveal: false }],
            ['svc_b', { level: 1, reveal: false }],
          ]),
        }),
      ),
    ).toBe(true);
    // List → all is a raise, even at a lower level: it covers resources the list did not.
    expect(raises(before, change({ tokens: new Map(), tokensAll: 1 }))).toBe(true);
    expect(raises(change({ tokensAll: 1 }), change({ tokensAll: 1, tokensAllReveal: true }))).toBe(
      true,
    );
    expect(raises(before, change({ consumers: new Map([['cpr_x', { level: 1 }]]) }))).toBe(true);
  });

  it('isElevated: a create permission, export, a level above view, or not join-safe', () => {
    expect(isElevated(BUILTIN_TEAMS.viewer)).toBe(false);
    expect(isElevated(team({ tokensAll: 1, consumersAll: 1 }))).toBe(false);
    expect(isElevated(BUILTIN_TEAMS.token_manager)).toBe(true);
    expect(isElevated(BUILTIN_TEAMS.access_manager)).toBe(true);
    expect(isElevated(team({ permissions: new Set(['config:export']) }))).toBe(true);
    expect(isElevated(team({ consumers: new Map([['cpr_x', { level: 2 }]]) }))).toBe(true);
    expect(isElevated(team({ tokens: new Map([['svc_a', { level: 1, reveal: false }]]) }))).toBe(
      false,
    );
    expect(isElevated(team({ permissions: new Set(['users:write']) }))).toBe(true);
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

  it('unions the teams of an active user, built-ins first', async () => {
    await db.batch([
      db
        .prepare(
          `INSERT INTO credentials (id, slug, name, base_url, injection, created_at, updated_at)
           VALUES ('svc_a', 'a', 'A', 'https://api.example.com', '{"kind":"bearer"}', ?, ?)`,
        )
        .bind(T, T),
      db
        .prepare(
          `INSERT INTO credential_access_rules (id, credential_id, name, profile, issuer, jwks_uri, audience, allowed_algs,
             max_token_age_seconds, created_at, updated_at)
           VALUES ('cpr_x', (SELECT id FROM credentials ORDER BY id LIMIT 1), 'X', 'generic', 'https://x.example.com', 'https://x.example.com/jwks',
             'tokengate:0123456789abcdef', '["RS256"]', 900, ?, ?)`,
        )
        .bind(T, T),
    ]);
    const user = await createUser({ email: 'u@example.com', role: 'viewer' });
    await createTeam({
      name: 'Payments',
      permissions: ['tokens:create'],
      tokens: { svc_a: { level: 2, reveal: true } },
      consumers: { cpr_x: { level: 3 } },
      members: [user],
    });
    await createTeam({ name: 'Audit', tokens: { svc_a: { level: 1 } }, members: [user] });
    await addMember('tea_viewer', user.id);
    const scope = await loadScope(db, user.id);
    expect(scope.teams.map((t) => t.name)).toEqual(['Viewers', 'Audit', 'Payments']);
    expect([...scope.permissions]).toEqual(['tokens:create']);
    expect(scope.tokens).toEqual(kinds(1, { svc_a: { level: 2, reveal: true } }));
    expect(scope.consumers).toEqual(kinds(1, { cpr_x: { level: 3, reveal: false } }));
    expect(highestBuiltin(scope)).toBe('viewer');
  });

  it('gives nothing to a user who is not active', async () => {
    const user = await createUser({ email: 's@example.com', role: 'viewer', status: 'suspended' });
    await addMember('tea_owner', user.id);
    const scope = await loadScope(db, user.id);
    expect(scope.teams).toEqual([]);
    expect(scope.permissions.size).toBe(0);
    expect(scope.tokens).toEqual(kinds(0));
  });

  it('reads the owner powers from the seed', async () => {
    const user = await createUser({ email: 'o@example.com', role: 'viewer' });
    await addMember('tea_owner', user.id);
    const scope = await loadScope(db, user.id);
    expect(scope.permissions).toEqual(BUILTIN_TEAMS.owner.permissions);
    expect(scope.tokens).toEqual(kinds(3, {}, true));
    expect(scope.consumers).toEqual(kinds(3));
    expect(isGlobalViewer(scope)).toBe(true);
  });
});
