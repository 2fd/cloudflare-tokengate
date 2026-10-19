import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { CLOCK_TOLERANCE_SECONDS } from '../../../src/identity/jwt';
import {
  conditionsHold,
  GLOBAL_LIMITS,
  globalRuleHolds,
  globalRuleUsable,
  issuerKey,
  NON_LIMIT_COLUMNS,
  type PolicyGlobalRule,
  pinHolds,
  someRuleMatches,
} from '../../../src/policy/limits';
import type { Condition, Rule } from '../../../src/policy/types';
import {
  credentialRule,
  facts,
  globalRule,
  NOW,
  NOW_SECONDS,
  owner,
  repo,
} from './access-rule-fixtures';

describe('AR-3: issuerKey', () => {
  it.each([
    ['https://gitlab.com', 'https://gitlab.com'],
    ['https://gitlab.com/', 'https://gitlab.com'],
    ['https://GitLab.com//', 'https://gitlab.com'],
    [
      'https://token.actions.githubusercontent.com/Acme',
      'https://token.actions.githubusercontent.com/acme',
    ],
    // lower() in SQL folds ASCII only, and so does issuerKey.
    ['https://ÉCOLE.example/Ä/', 'https://École.example/Ä'],
    ['https://x.example/A%2F/', 'https://x.example/a%2f'],
    ['https://x.example/a/./', 'https://x.example/a/.'],
  ])('%s → %s', (issuer, key) => {
    expect(issuerKey(issuer)).toBe(key);
  });

  // The ops write issuerKey(issuer) and a CHECK compares it with SQL: they must agree on every
  // input, or an insert fails (a mismatch can never mis-match a ceiling).
  it.each([
    'https://gitlab.com',
    'https://GitLab.com//',
    'https://ÉCOLE.example/Ä/',
    'https://x.example/A%2F/',
    'https://x.example/a%2f%2F',
    'https://straße.example/İ/',
    'https://x.example/ǅ',
    '/',
    '',
  ])('equals lower(rtrim(issuer, "/")) on D1: %j', async (issuer) => {
    const row = await env.DB.prepare("SELECT lower(rtrim(?, '/')) AS key")
      .bind(issuer)
      .first<{ key: string }>();
    expect(issuerKey(issuer)).toBe(row?.key);
  });
});

describe('pinHolds', () => {
  it('holds when every pin condition holds exactly', () => {
    expect(pinHolds([owner], { repository_owner_id: '1000' })).toBe(true);
    expect(pinHolds([owner, { ...repo, values: ['1', '2000'] }], facts().claims)).toBe(true);
    expect(pinHolds([], {})).toBe(true);
  });

  it.each<[string, Condition[], Record<string, unknown>]>([
    ['another value', [owner], { repository_owner_id: '1001' }],
    ['a missing claim', [owner], {}],
    ['a numeric claim against text', [owner], { repository_owner_id: 1001 }],
    ['a glob pin', [{ ...owner, match: 'glob', values: ['*'] }], { repository_owner_id: '1000' }],
    ['a negated pin', [{ ...owner, values: ['9'], negate: true }], { repository_owner_id: '1000' }],
    ['the [null] sentinel', [null as unknown as Condition], { repository_owner_id: '1000' }],
  ])('fails on %s', (_name, pin, claims) => {
    expect(pinHolds(pin, claims)).toBe(false);
  });

  it('fails when the pin is not a list', () => {
    expect(pinHolds('x' as unknown as Condition[], {})).toBe(false);
  });
});

describe('conditionsHold', () => {
  it('holds when every condition holds', () => {
    expect(conditionsHold([owner, repo], facts())).toEqual({ ok: true });
  });

  it('reports the first condition that fails, hiding unrevealed claims (I-LOG-1)', () => {
    const actor: Condition = { claim: 'actor', match: 'exact', values: ['alice'] };
    expect(conditionsHold([owner, actor], facts({ actor: 'mallory' }))).toEqual({
      ok: false,
      detail: 'condition[1] actor=(hidden) vs exact ["alice"]',
    });
  });

  it('fails closed on a missing claim, a malformed condition or a value that is not a list', () => {
    expect(conditionsHold([{ ...owner, claim: 'nope' }], facts()).ok).toBe(false);
    expect(conditionsHold([null as unknown as Condition], facts()).ok).toBe(false);
    expect(conditionsHold('x' as unknown as Condition[], facts()).ok).toBe(false);
  });
});

describe('someRuleMatches', () => {
  it('holds when some rule matches both readings of the path', () => {
    const rules: Rule[] = [
      { methods: ['GET'], path: '/**' },
      { methods: ['POST'], path: '/api/*' },
    ];
    expect(someRuleMatches(rules, facts())).toEqual({ ok: true });
  });

  it('names the method and path when no rule matches', () => {
    expect(someRuleMatches([{ methods: ['GET'], path: '/**' }], facts())).toEqual({
      ok: false,
      detail: 'no rule allows POST /api/chat.postMessage',
    });
    expect(someRuleMatches(null as unknown as Rule[], facts()).ok).toBe(false);
  });
});

describe('AR-19: the limit registry', () => {
  it('lists the limit columns in the order globalRuleHolds checks them', () => {
    expect(GLOBAL_LIMITS.map((limit) => [limit.column, limit.side])).toEqual([
      ['jwks_uri', 'trust'],
      ['audience', 'trust'],
      ['allowed_algs', 'trust'],
      ['max_token_age_seconds', 'trust'],
      ['tenant_pin', 'identity'],
      ['anchor_claims', 'identity'],
      ['conditions', 'identity'],
      ['rules', 'target'],
    ]);
  });

  it('keeps limits and non-limits apart and covers every policy field', () => {
    const limits = GLOBAL_LIMITS.map((limit) => limit.column as string);
    expect(limits.filter((column) => NON_LIMIT_COLUMNS.includes(column))).toEqual([]);
    expect(new Set([...limits, ...NON_LIMIT_COLUMNS]).size).toBe(
      limits.length + NON_LIMIT_COLUMNS.length,
    );
    const known = new Set([...limits, ...NON_LIMIT_COLUMNS]);
    expect(Object.keys(globalRule()).filter((field) => !known.has(field))).toEqual([]);
  });

  // A future column must be a limit or a named non-limit: pragma_table_xinfo also lists generated
  // and hidden columns, which table_info leaves out.
  it('matches the access_rules columns in both directions', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM pragma_table_xinfo('access_rules')",
    ).all<{ name: string }>();
    const columns = results.map((row) => row.name).sort();
    const registry = [...GLOBAL_LIMITS.map((limit) => limit.column), ...NON_LIMIT_COLUMNS].sort();
    expect(columns.filter((column) => !registry.includes(column))).toEqual([]);
    expect(registry.filter((column) => !columns.includes(column))).toEqual([]);
  });
});

describe('globalRuleUsable', () => {
  it('needs enabled and an expiry after now', () => {
    expect(globalRuleUsable(globalRule(), NOW)).toBe(true);
    expect(globalRuleUsable(globalRule({ expires_at: NOW + 1 }), NOW)).toBe(true);
    expect(globalRuleUsable(globalRule({ expires_at: NOW }), NOW)).toBe(false);
    expect(globalRuleUsable(globalRule({ enabled: false }), NOW)).toBe(false);
    expect(globalRuleUsable(globalRule({ expires_at: Number.NaN }), NOW)).toBe(false);
    const malformed = globalRule({ expires_at: '9999999999999' as unknown as number });
    expect(globalRuleUsable(malformed, NOW)).toBe(false);
  });
});

describe('I-AUTHZ-5: globalRuleHolds per limit column', () => {
  const c = credentialRule();
  const holds = (overrides: Partial<PolicyGlobalRule>, f = facts()) =>
    globalRuleHolds(globalRule(overrides), c, f);

  it('holds for a global access rule with no limit', () => {
    expect(holds({})).toEqual({ ok: true });
  });

  it.each<[string, Partial<PolicyGlobalRule>, string]>([
    ['disabled', { enabled: false }, 'global access rule disabled'],
    ['expired', { expires_at: NOW - 1 }, 'global access rule expired'],
    ['another profile (AR-6)', { profile: 'generic' }, 'issuer type differs'],
    ['another stored issuer key (AR-3)', { issuer_key: 'https://gitlab.com' }, 'issuer differs'],
  ])('fails when %s', (_name, overrides, detail) => {
    expect(holds(overrides)).toEqual({ ok: false, detail });
  });

  type Vector = [string, Partial<PolicyGlobalRule>];
  const holding: Vector[] = [
    ['jwks_uri', { jwks_uri: c.jwks_uri }],
    ['audience', { audience: c.audience }],
    ['allowed_algs', { allowed_algs: ['ES256', 'RS256'] }],
    ['max_token_age_seconds', { max_token_age_seconds: 600 }],
    ['tenant_pin', { tenant_pin: [owner, { ...repo, values: ['2000', '2001'] }] }],
    ['anchor_claims', { anchor_claims: ['job_workflow_ref', 'repository_id'] }],
    ['conditions', { conditions: [{ claim: 'ref', match: 'glob', values: ['refs/heads/*'] }] }],
    ['rules', { rules: [{ methods: ['*'], path: '/api/**' }] }],
  ];
  const failing: Array<[...Vector, string]> = [
    ['jwks_uri', { jwks_uri: 'https://attacker.example/jwks' }, 'JWKS URI pin differs'],
    ['audience', { audience: 'tokengate:other-audience-0000' }, 'audience pin differs'],
    ['allowed_algs', { allowed_algs: ['ES256'] }, 'signing algorithm "RS256" is not allowed'],
    ['max_token_age_seconds', { max_token_age_seconds: 60 }, 'token older than 60 s'],
    [
      'tenant_pin',
      { tenant_pin: [{ ...owner, values: ['1001'] }] },
      'tenant_pin[0] repository_owner_id=(hidden) vs exact ["1001"]',
    ],
    [
      'anchor_claims',
      { anchor_claims: ['job_workflow_ref'] },
      'conditions pin none of the anchor claims ["job_workflow_ref"]',
    ],
    [
      'conditions',
      { conditions: [{ claim: 'ref', match: 'exact', values: ['refs/heads/prod'] }] },
      'condition[0] ref="refs/heads/main" vs exact ["refs/heads/prod"]',
    ],
    [
      'rules',
      { rules: [{ methods: ['GET'], path: '/**' }] },
      'no rule allows POST /api/chat.postMessage',
    ],
  ];
  // Values that db/rows.ts maps a malformed or empty column to, and the empty lists themselves.
  const malformed: Vector[] = [
    ['jwks_uri', { jwks_uri: 42 as unknown as string }],
    ['allowed_algs', { allowed_algs: [] }],
    ['max_token_age_seconds', { max_token_age_seconds: 0 }],
    ['max_token_age_seconds', { max_token_age_seconds: 1.5 }],
    ['tenant_pin', { tenant_pin: [] }],
    ['tenant_pin', { tenant_pin: [null as unknown as Condition] }],
    ['anchor_claims', { anchor_claims: [] }],
    ['anchor_claims', { anchor_claims: [''] }],
    ['conditions', { conditions: [] }],
    ['conditions', { conditions: [null as unknown as Condition] }],
    ['rules', { rules: [] }],
    ['rules', { rules: [null as unknown as Rule] }],
    ['rules', { rules: 'x' as unknown as Rule[] }],
  ];

  it.each(holding)('%s: a holding value holds', (_column, overrides) => {
    expect(holds(overrides)).toEqual({ ok: true });
  });

  it.each(failing)('%s: a failing value fails', (_column, overrides, detail) => {
    expect(holds(overrides)).toEqual({ ok: false, detail });
  });

  it.each(malformed)('%s: a malformed or empty value %j matches nothing', (_column, overrides) => {
    expect(holds(overrides).ok).toBe(false);
  });

  it('checks every set limit, in registry order', () => {
    const result = holds({
      audience: 'tokengate:other-audience-0000',
      rules: [{ methods: ['GET'], path: '/**' }],
    });
    expect(result).toEqual({ ok: false, detail: 'audience pin differs' });
  });

  describe('maximum token age (now in ms, iat in s)', () => {
    const max = 300;
    const at = (iat: unknown) => holds({ max_token_age_seconds: max }, facts({ iat }));

    it('holds at the boundary and fails one second later', () => {
      expect(NOW % 1000).not.toBe(0);
      expect(at(NOW_SECONDS - max - CLOCK_TOLERANCE_SECONDS)).toEqual({ ok: true });
      expect(at(NOW_SECONDS - max - CLOCK_TOLERANCE_SECONDS - 1)).toEqual({
        ok: false,
        detail: 'token older than 300 s',
      });
    });

    it.each<[string, unknown]>([
      ['missing', undefined],
      ['text', String(NOW_SECONDS)],
      ['fractional', NOW_SECONDS - 0.5],
      ['unsafe', 2 ** 60],
    ])('fails on a %s iat', (_name, iat) => {
      expect(at(iat)).toEqual({ ok: false, detail: 'iat: claim missing or not an integer' });
    });
  });

  it('AR-9: a failing global tenant pin is a limit result, not a gate result', () => {
    const result = holds({
      tenant_pin: [{ claim: 'enterprise_id', match: 'exact', values: ['7'] }],
    });
    expect(result).toEqual({ ok: false, detail: 'tenant_pin[0] enterprise_id: claim missing' });
  });

  it('reveals claims in details only when C allows it (I-LOG-1)', () => {
    const pin: Condition[] = [{ ...owner, values: ['1001'] }];
    const revealed = holds(
      { tenant_pin: pin },
      facts({}, { revealClaims: new Set(['repository_owner_id']) }),
    );
    expect(revealed).toEqual({
      ok: false,
      detail: 'tenant_pin[0] repository_owner_id="1000" vs exact ["1001"]',
    });
  });

  it('never reads the event guard: a global event condition is an ordinary limit', () => {
    const event: Condition = { claim: 'event_name', match: 'exact', values: ['pull_request'] };
    expect(holds({ conditions: [event] }, facts({ event_name: 'pull_request' }))).toEqual({
      ok: true,
    });
  });
});
