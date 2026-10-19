import { describe, expect, it } from 'vitest';
import {
  ceilingChange,
  ceilingWithin,
  conditionsWithin,
  globalStatus,
  rulesWithin,
} from '../../../src/policy/global-status';
import type { PolicyCredentialRule, PolicyGlobalRule } from '../../../src/policy/limits';
import type { Condition, Rule } from '../../../src/policy/types';
import { credentialRule, globalRule, NOW, owner, repo } from './access-rule-fixtures';

const main: Condition = { claim: 'ref', match: 'exact', values: ['refs/heads/main'] };
const heads: Condition = { claim: 'ref', match: 'glob', values: ['refs/heads/*'] };

describe('AR-8: globalStatus', () => {
  const c = credentialRule({
    allowed_algs: ['RS256'],
    conditions: [owner, repo, main],
    rules: [{ methods: ['POST'], path: '/api/chat.postMessage' }],
  });
  const status = (overrides: Partial<PolicyGlobalRule>, rule: PolicyCredentialRule = c) =>
    globalStatus(rule, [globalRule(overrides)], NOW).kind;

  it('is not_limited when the issuer has no global access rule', () => {
    expect(globalStatus(c, [], NOW)).toEqual({ kind: 'not_limited' });
  });

  it.each<[string, Partial<PolicyGlobalRule>]>([
    ['no limit', {}],
    ['the same JWKS URI and audience', { jwks_uri: c.jwks_uri, audience: c.audience }],
    ['more algorithms', { allowed_algs: ['RS256', 'ES256'] }],
    ['a longer maximum token age', { max_token_age_seconds: 900 }],
    ['the same token age', { max_token_age_seconds: 600 }],
    ['a wider tenant pin', { tenant_pin: [{ ...owner, values: ['1000', '1001'] }] }],
    ['an anchor claim C pins', { anchor_claims: ['job_workflow_ref', 'repository_id'] }],
    ['conditions that C narrows', { conditions: [heads] }],
    ['conditions that C repeats', { conditions: [owner, main] }],
    [
      'operations with a glob that C narrows',
      { rules: [{ methods: ['POST', 'GET'], path: '/api/*' }] },
    ],
    ['any method', { rules: [{ methods: ['*'], path: '/api/chat.postMessage' }] }],
  ])('is within for %s', (_name, overrides) => {
    expect(status(overrides)).toBe('within');
  });

  it.each<[string, Partial<PolicyGlobalRule>]>([
    ['fewer algorithms', { allowed_algs: ['RS256'] }],
    ['a shorter maximum token age', { max_token_age_seconds: 300 }],
    [
      'a pin on a claim C does not pin',
      { tenant_pin: [{ claim: 'enterprise_id', match: 'exact', values: ['7'] }] },
    ],
    [
      'conditions on a claim C does not constrain',
      { conditions: [{ claim: 'environment', match: 'exact', values: ['prod'] }] },
    ],
    ['operations with another method', { rules: [{ methods: ['GET'], path: '/**' }] }],
    ['operations with another path', { rules: [{ methods: ['POST'], path: '/api/files.*' }] }],
  ])('is limited for %s', (_name, overrides) => {
    const rule = overrides.allowed_algs
      ? credentialRule({ ...c, allowed_algs: ['RS256', 'ES256'] })
      : c;
    expect(status(overrides, rule)).toBe('limited');
  });

  it.each<[string, Partial<PolicyGlobalRule>, string]>([
    ['disabled', { enabled: false }, 'The global access rule is disabled.'],
    ['expired', { expires_at: NOW }, 'The global access rule has expired.'],
    [
      'another profile (AR-6)',
      { profile: 'generic' },
      'The global access rule is for another issuer type.',
    ],
    [
      'another issuer key',
      { issuer_key: 'https://gitlab.com' },
      'The global access rule is for another issuer.',
    ],
    [
      'another JWKS URI',
      { jwks_uri: 'https://attacker.example/jwks' },
      'The JWKS URI pin differs.',
    ],
    [
      'another audience',
      { audience: 'tokengate:other-audience-0000' },
      'The audience pin differs.',
    ],
    ['no common algorithm', { allowed_algs: ['ES256'] }, 'No signing algorithm is in both rules.'],
    [
      'an anchor claim C does not pin',
      { anchor_claims: ['job_workflow_ref'] },
      'The conditions pin none of the anchor claims job_workflow_ref.',
    ],
    [
      'a tenant pin outside C’s pin',
      { tenant_pin: [{ ...owner, values: ['1001'] }] },
      'The rule allows no repository_owner_id value of the tenant pin of the global access rule.',
    ],
    [
      'a tenant pin outside C’s exact conditions',
      { tenant_pin: [{ ...repo, values: ['2001'] }] },
      'The rule allows no repository_id value of the tenant pin of the global access rule.',
    ],
    [
      'an empty condition list',
      { conditions: [] },
      'The conditions limit is empty or malformed and matches nothing.',
    ],
    [
      'the [null] sentinel',
      { conditions: [null as unknown as Condition] },
      'The conditions limit is empty or malformed and matches nothing.',
    ],
    [
      "the [''] anchor sentinel",
      { anchor_claims: [''] },
      'The anchor claim limit is empty or malformed and matches nothing.',
    ],
    [
      'a zero maximum token age',
      { max_token_age_seconds: 0 },
      'The maximum token age limit is empty or malformed and matches nothing.',
    ],
    [
      'a glob tenant pin',
      { tenant_pin: [{ ...owner, match: 'glob', values: ['*'] }] },
      'The tenant pin of the global access rule is malformed.',
    ],
    [
      'the [null] operations sentinel',
      { rules: [null as unknown as Rule] },
      'The operations limit is empty or malformed and matches nothing.',
    ],
    [
      'an empty operations list',
      { rules: [] },
      'The operations limit is empty or malformed and matches nothing.',
    ],
  ])('is blocked by %s', (_name, overrides, detail) => {
    const g = globalRule(overrides);
    expect(globalStatus(c, [g], NOW)).toEqual({
      kind: 'blocked',
      reasons: [{ global: g, detail }],
    });
  });

  it('combines several global access rules', () => {
    const blocked = globalRule({ id: 'gar_blocked', enabled: false });
    const limited = globalRule({ id: 'gar_limited', max_token_age_seconds: 300 });
    const within = globalRule({ id: 'gar_within' });
    expect(globalStatus(c, [blocked, limited, within], NOW)).toEqual({
      kind: 'within',
      global: within,
    });
    expect(globalStatus(c, [blocked, limited], NOW)).toEqual({
      kind: 'limited',
      globals: [limited],
    });
    expect(globalStatus(c, [blocked, blocked], NOW).kind).toBe('blocked');
  });
});

describe('conditionsWithin', () => {
  it.each<[string, Condition[], Condition[], boolean]>([
    ['exact values inside a glob', [main], [heads], true],
    ['an exact value outside a glob', [{ ...main, values: ['refs/tags/v1'] }], [heads], false],
    ['the same glob', [heads], [heads], true],
    ['a glob inside a wider glob (unknown)', [heads], [{ ...heads, values: ['refs/**'] }], false],
    ['a missing claim', [owner], [main], false],
    [
      'an exact value inside a negated limit',
      [main],
      [{ ...main, values: ['refs/heads/dev'], negate: true }],
      true,
    ],
    ['a malformed child', [null as unknown as Condition], [], false],
    ['no limit', [owner], [], true],
  ])('%s → %s', (_name, child, ceiling, expected) => {
    expect(conditionsWithin(child, ceiling)).toBe(expected);
  });
});

describe('rulesWithin', () => {
  const r = (methods: Rule['methods'], path: string): Rule => ({ methods, path });

  it.each<[string, Rule[], Rule[], boolean]>([
    ['the same rule', [r(['GET'], '/x/**')], [r(['GET'], '/x/**')], true],
    ['fewer methods', [r(['GET'], '/x/**')], [r(['GET', 'POST'], '/x/**')], true],
    ['more methods', [r(['GET', 'POST'], '/x/**')], [r(['GET'], '/x/**')], false],
    ['explicit methods under "*"', [r(['DELETE'], '/x')], [r(['*'], '/x')], true],
    [
      '"*" under every explicit method',
      [r(['*'], '/x')],
      [r(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], '/x')],
      true,
    ],
    ['"*" under some methods', [r(['*'], '/x')], [r(['GET'], '/x')], false],
    ['a literal path the glob matches', [r(['GET'], '/x/y')], [r(['GET'], '/x/*')], true],
    [
      'a literal trailing slash the glob refuses',
      [r(['GET'], '/x/')],
      [r(['GET'], '/x/**')],
      false,
    ],
    ['a narrower glob (unknown)', [r(['GET'], '/x/y/*')], [r(['GET'], '/x/**')], false],
    [
      'each rule within some ceiling rule',
      [r(['GET'], '/a'), r(['POST'], '/b')],
      [r(['POST'], '/b'), r(['GET'], '/*')],
      true,
    ],
    ['a malformed rule', [null as unknown as Rule], [r(['*'], '/**')], false],
  ])('%s → %s', (_name, child, ceiling, expected) => {
    expect(rulesWithin(child, ceiling)).toBe(expected);
  });
});

describe('AR-21: ceilingWithin', () => {
  const before = globalRule({
    expires_at: NOW + 10_000,
    jwks_uri: 'https://token.actions.githubusercontent.com/.well-known/jwks',
    audience: 'tokengate:01JTESTAUDIENCE00000000000',
    allowed_algs: ['RS256', 'ES256'],
    max_token_age_seconds: 600,
    tenant_pin: [{ ...owner, values: ['1000', '1001'] }],
    anchor_claims: ['repository_id', 'job_workflow_ref'],
    conditions: [heads],
    rules: [{ methods: ['GET', 'POST'], path: '/api/**' }],
  });
  const within = (overrides: Partial<PolicyGlobalRule>, from = before) =>
    ceilingWithin(globalRule({ ...from, ...overrides }), from, NOW);

  it('is within when nothing changes', () => {
    expect(within({})).toBe(true);
  });

  it.each<[string, Partial<PolicyGlobalRule>]>([
    ['algorithms narrowed', { allowed_algs: ['RS256'] }],
    ['maximum token age shortened', { max_token_age_seconds: 300 }],
    ['tenant pin narrowed', { tenant_pin: [owner] }],
    ['an anchor claim removed', { anchor_claims: ['repository_id'] }],
    ['conditions narrowed', { conditions: [main] }],
    ['a condition added', { conditions: [heads, owner] }],
    ['operations narrowed', { rules: [{ methods: ['GET'], path: '/api/x' }] }],
    ['the expiry moved earlier', { expires_at: NOW + 1 }],
    ['disabled', { enabled: false }],
    ['expired', { expires_at: NOW }],
  ])('is within for %s', (_name, overrides) => {
    expect(within(overrides)).toBe(true);
  });

  it.each<[string, Partial<PolicyGlobalRule>]>([
    ['another JWKS URI', { jwks_uri: 'https://example.com/jwks' }],
    ['another audience', { audience: 'tokengate:other-audience-0000' }],
    ['an algorithm added', { allowed_algs: ['RS256', 'ES256', 'PS256'] }],
    ['maximum token age extended', { max_token_age_seconds: 900 }],
    ['tenant pin widened', { tenant_pin: [{ ...owner, values: ['1000', '1001', '1002'] }] }],
    // Each anchor claim is an alternative, so another one admits more rules.
    ['an anchor claim added', { anchor_claims: ['repository_id', 'job_workflow_ref', 'sub'] }],
    ['conditions widened', { conditions: [{ ...heads, values: ['refs/**'] }] }],
    ['operations widened', { rules: [{ methods: ['*'], path: '/api/**' }] }],
    ['the expiry moved later', { expires_at: NOW + 20_000 }],
    ['the expiry cleared', { expires_at: null }],
    ...(
      [
        'jwks_uri',
        'audience',
        'allowed_algs',
        'max_token_age_seconds',
        'tenant_pin',
        'anchor_claims',
        'conditions',
        'rules',
      ] as const
    ).map((column): [string, Partial<PolicyGlobalRule>] => [
      `${column} cleared`,
      { [column]: null },
    ]),
  ])('is not within for %s', (_name, overrides) => {
    expect(within(overrides)).toBe(false);
  });

  it('is within when a limit is set where there was none', () => {
    expect(within({ audience: 'tokengate:new-audience-00000' }, globalRule())).toBe(true);
  });

  it('is not within when a disabled or expired rule becomes usable', () => {
    expect(ceilingWithin(globalRule(), globalRule({ enabled: false }), NOW)).toBe(false);
    expect(ceilingWithin(globalRule(), globalRule({ expires_at: NOW - 1 }), NOW)).toBe(false);
  });
});

describe('AR-21: ceilingChange per op', () => {
  const a = globalRule({ id: 'gar_a', rules: [{ methods: ['GET', 'POST'], path: '/api/**' }] });
  const b = globalRule({ id: 'gar_b', conditions: [heads] });
  const change = (before: PolicyGlobalRule[], after: PolicyGlobalRule[]) =>
    ceilingChange(before, after, NOW);
  const edit = (overrides: Partial<PolicyGlobalRule>) => [globalRule({ ...a, ...overrides })];

  it.each<[string, PolicyGlobalRule[], PolicyGlobalRule[], string]>([
    ['nothing', [], [], 'none'],
    ['first create', [], [a], 'tightening'],
    ['first create, disabled', [], [globalRule({ ...a, enabled: false })], 'tightening'],
    ['sibling create', [a], [a, b], 'widening'],
    ['sibling create, disabled', [a], [a, globalRule({ ...b, enabled: false })], 'none'],
    ['sibling create, expired', [a], [a, globalRule({ ...b, expires_at: NOW })], 'none'],
    ['enable', [globalRule({ ...a, enabled: false })], [a], 'widening'],
    ['disable', [a], edit({ enabled: false }), 'tightening'],
    ['expiry set', [a], edit({ expires_at: NOW + 1 }), 'tightening'],
    [
      'expiry later',
      [globalRule({ ...a, expires_at: NOW + 1 })],
      edit({ expires_at: NOW + 2 }),
      'widening',
    ],
    ['expiry cleared', [globalRule({ ...a, expires_at: NOW + 1 })], [a], 'widening'],
    ['limit cleared', [a], edit({ rules: null }), 'widening'],
    ['limit relaxed', [a], edit({ rules: [{ methods: ['*'], path: '/api/**' }] }), 'widening'],
    ['limit narrowed', [a], edit({ rules: [{ methods: ['GET'], path: '/api/**' }] }), 'tightening'],
    ['limit added', [a], edit({ audience: 'tokengate:new-audience-00000' }), 'tightening'],
    [
      'one limit narrowed and another relaxed',
      [a],
      edit({
        rules: [{ methods: ['*'], path: '/api/**' }],
        audience: 'tokengate:new-audience-00000',
      }),
      'mixed',
    ],
    ['last delete', [a], [], 'widening'],
    ['last delete, disabled', [globalRule({ ...a, enabled: false })], [], 'widening'],
    ['non-last delete', [a, b], [b], 'tightening'],
    ['a description or name change', [a], [globalRule({ ...a })], 'none'],
    [
      'one widening and one tightening',
      [a, b],
      [globalRule({ ...a, rules: null }), globalRule({ ...b, enabled: false })],
      'mixed',
    ],
    [
      'a widening next to an unchanged rule',
      [a, b],
      [a, globalRule({ ...b, conditions: null })],
      'widening',
    ],
  ])('%s → %s', (_name, before, after, expected) => {
    expect(change(before, after)).toBe(expected);
  });
});
