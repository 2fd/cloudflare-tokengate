import { describe, expect, it } from 'vitest';
import type { IssuerProfile } from '../../../src/identity/types';
import {
  credentialRuleDecision,
  globalDecision,
  type RuleDenyCode,
  type RuleTraceEntry,
  ruleMatches,
  TRACE_MAX_BYTES,
  traceJson,
  verificationGroupKey,
} from '../../../src/policy/access-rules';
import type {
  PolicyCredentialRule,
  PolicyGlobalRule,
  RequestFacts,
} from '../../../src/policy/limits';
import type { Condition, Rule } from '../../../src/policy/types';
import {
  at,
  credentialRule,
  facts,
  globalRule,
  NOW,
  owner,
  postMessage,
  repo,
} from './access-rule-fixtures';
import { genericProfile, githubProfile } from './fixtures';

function rule(id: string, extra: Condition[] = [], rules: Rule[] = [postMessage]) {
  return credentialRule({ id, conditions: [owner, repo, ...extra], rules });
}

function generic(id: string, anchorClaims: string[], conditions: Condition[] = [owner, repo]) {
  return credentialRule({
    id,
    profile: 'generic',
    anchor_claims: anchorClaims,
    tenant_pin: [],
    conditions,
  });
}

type Outcome =
  | { decision: 'allow'; rule: PolicyCredentialRule; global: PolicyGlobalRule | null }
  | { decision: 'deny'; code: RuleDenyCode };

/**
 * The policy step of the proxy handler (src/proxy/handler.ts) for candidates that all passed
 * verification and the tenant gate: the first credential access rule whose own policy matches
 * and that a global access rule of its issuer key allows wins (I-AUTHZ-1).
 */
function evaluate(
  rules: PolicyCredentialRule[],
  f: RequestFacts,
  profile: IssuerProfile = githubProfile,
  globals: PolicyGlobalRule[] = [],
): Outcome & { trace: RuleTraceEntry[] } {
  const trace: RuleTraceEntry[] = [];
  let eventOnly = false;
  for (const c of rules) {
    const own = credentialRuleDecision(c, profile, f);
    const ofIssuer = globals.filter((g) => g.issuer_key === c.issuer_key);
    if (own.result !== 'matched') {
      trace.push({ rule_id: c.id, result: own.result, detail: own.detail });
      if (own.result === 'event_not_trusted' && own.rulesMatched) {
        eventOnly ||= globalDecision(c, ofIssuer, f).ok;
      }
      continue;
    }
    const g = globalDecision(c, ofIssuer, f);
    if (g.ok) {
      const entry: RuleTraceEntry = { rule_id: c.id, result: 'matched', detail: '' };
      if (g.global !== null) entry.global_rule_id = g.global.id;
      trace.push(entry);
      return { decision: 'allow', rule: c, global: g.global, trace };
    }
    for (const failure of g.failures) {
      trace.push({ rule_id: c.id, ...failure, result: 'global_blocked' });
    }
  }
  return { decision: 'deny', code: eventOnly ? 'event_not_trusted' : 'no_matching_rule', trace };
}

describe('ruleMatches', () => {
  it('requires an explicitly listed method', () => {
    expect(ruleMatches({ methods: ['GET'], path: '/x' }, 'GET', at('/x'))).toBe(true);
    expect(ruleMatches({ methods: ['GET'], path: '/x' }, 'POST', at('/x'))).toBe(false);
    expect(ruleMatches({ methods: ['GET'], path: '/x' }, 'HEAD', at('/x'))).toBe(false);
    expect(ruleMatches({ methods: ['GET'], path: '/x' }, 'get', at('/x'))).toBe(false);
  });

  it('expands "*" to exactly the proxy methods', () => {
    const any: Rule = { methods: ['*'], path: '/**' };
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(ruleMatches(any, method, at('/a'))).toBe(true);
    }
    expect(ruleMatches(any, 'TRACE', at('/a'))).toBe(false);
    expect(ruleMatches(any, 'CONNECT', at('/a'))).toBe(false);
  });

  it('matches the path with the glob', () => {
    const r: Rule = { methods: ['GET'], path: '/repos/*/*/contents/**' };
    expect(ruleMatches(r, 'GET', at('/repos/a/b/contents/x/y'))).toBe(true);
    expect(ruleMatches(r, 'GET', at('/repos/a/b/issues'))).toBe(false);
  });
});

describe('I-AUTHZ-1: credential access rules deny by default', () => {
  it('denies with no credential access rules', () => {
    expect(evaluate([], facts())).toEqual({
      decision: 'deny',
      code: 'no_matching_rule',
      trace: [],
    });
  });

  it('allows the first matching rule and traces the ones before it', () => {
    const rules = [
      rule('acr_a', [{ claim: 'ref', match: 'exact', values: ['refs/heads/prod'] }]),
      rule('acr_b', [], [{ methods: ['GET'], path: '/**' }]),
      rule('acr_c'),
      rule('acr_d'),
    ];
    const outcome = evaluate(rules, facts());
    expect(outcome).toMatchObject({ decision: 'allow', rule: { id: 'acr_c' }, global: null });
    expect(outcome.trace.map((t) => [t.rule_id, t.result])).toEqual([
      ['acr_a', 'condition_failed'],
      ['acr_b', 'no_rule'],
      ['acr_c', 'matched'],
    ]);
    expect(outcome.trace[0]?.detail).toBe(
      'condition[2] ref="refs/heads/main" vs exact ["refs/heads/prod"]',
    );
    expect(outcome.trace[1]?.detail).toBe('no rule allows POST /api/chat.postMessage');
  });

  it('refuses a rule without conditions', () => {
    const own = credentialRuleDecision(credentialRule({ conditions: [] }), githubProfile, facts());
    expect(own).toMatchObject({ result: 'invalid_rule' });
  });

  it('refuses a rule whose profile is not the one it is evaluated with', () => {
    const c = credentialRule({ profile: 'generic', anchor_claims: ['repository_id'] });
    expect(credentialRuleDecision(c, githubProfile, facts())).toMatchObject({
      result: 'invalid_rule',
    });
  });

  it('never echoes values of claims outside the reveal set', () => {
    const outcome = evaluate(
      [rule('acr_a', [{ claim: 'actor', match: 'exact', values: ['alice'] }])],
      facts({ actor: 'mallory' }),
    );
    expect(JSON.stringify(outcome.trace)).not.toContain('mallory');
  });
});

describe('I-AUTHZ-3: untrusted events need an exact opt-in', () => {
  const pr = { event_name: 'pull_request_target' };

  it('trusted events need no event condition', () => {
    expect(evaluate([rule('acr_a')], facts()).decision).toBe('allow');
  });

  it('denies untrusted events without an opt-in', () => {
    const outcome = evaluate([rule('acr_a')], facts(pr));
    expect(outcome).toMatchObject({ decision: 'deny', code: 'event_not_trusted' });
    expect(outcome.trace[0]).toMatchObject({ result: 'event_not_trusted' });
    expect(outcome.trace[0]?.detail).toContain('"pull_request_target"');
    expect(outcome.trace[0]?.detail).toContain('the access rule needs an exact event_name');
  });

  it('allows untrusted events listed in an exact, non-negated condition', () => {
    const optIn: Condition = { claim: 'event_name', match: 'exact', values: [pr.event_name] };
    expect(evaluate([rule('acr_a', [optIn])], facts(pr)).decision).toBe('allow');
  });

  it.each<[string, Condition]>([
    ['glob matching the event', { claim: 'event_name', match: 'glob', values: ['pull*'] }],
    ['glob **', { claim: 'event_name', match: 'glob', values: ['**'] }],
    ['negated exact', { claim: 'event_name', match: 'exact', values: ['push'], negate: true }],
    ['exact on another claim', { claim: 'event', match: 'exact', values: ['pull_request_target'] }],
  ])('does not count a %s as opt-in', (_name, condition) => {
    const outcome = evaluate(
      [rule('acr_a', [condition])],
      facts({ ...pr, event: 'pull_request_target' }),
    );
    expect(outcome).toMatchObject({ decision: 'deny', code: 'event_not_trusted' });
  });

  it('fails closed when the event claim is missing or not a string', () => {
    const missing = facts();
    delete missing.claims.event_name;
    expect(evaluate([rule('acr_a')], missing)).toMatchObject({ decision: 'deny' });
    expect(evaluate([rule('acr_a')], facts({ event_name: ['push'] }))).toMatchObject({
      decision: 'deny',
    });
  });

  it('reports event_not_trusted only when fixing the event would allow the call', () => {
    const noRule = rule('acr_a', [], [{ methods: ['GET'], path: '/other' }]);
    const own = credentialRuleDecision(noRule, githubProfile, facts(pr));
    expect(own).toMatchObject({ result: 'event_not_trusted', rulesMatched: false });
    expect(evaluate([noRule], facts(pr))).toMatchObject({ code: 'no_matching_rule' });

    const conditionFails = rule('acr_b', [{ claim: 'ref', match: 'exact', values: ['x'] }]);
    expect(evaluate([conditionFails, rule('acr_c')], facts(pr))).toMatchObject({
      code: 'event_not_trusted',
    });
  });

  it('does not apply to profiles without an event claim', () => {
    expect(
      evaluate([generic('acr_a', ['repository_id'])], facts(pr), genericProfile).decision,
    ).toBe('allow');
  });
});

describe('ruleMatches: trailing slash and %2F', () => {
  it.each<[string, string, boolean]>([
    ['/x/**', '/x/', false],
    ['/x/*', '/x/', false],
    ['/x/', '/x/', true],
    ['/x/**', '/x/y/', true],
    ['/**', '/x/', true],
    ['/x/*/', '/x/y/', true],
    ['/**', '/', true],
  ])('%s vs %s → %s', (pattern, path, expected) => {
    expect(ruleMatches({ methods: ['GET'], path: pattern }, 'GET', at(path))).toBe(expected);
  });

  it.each<[string, string, boolean]>([
    ['/projects/*/pipelines/*', '/projects/grp%2Fpipelines%2Fx', false],
    ['/projects/*/pipelines/*', '/projects/7/pipelines/9', true],
    ['/repos/o/r/contents/**', '/repos/o/r/contents/dir%2Ffile', true],
    ['/repos/o/r/contents/*', '/repos/o/r/contents/dir%2Ffile', false],
    ['/repos/o/r/contents/dir/file', '/repos/o/r/contents/dir%2Ffile', false],
  ])('%s vs %s → %s (both readings must match)', (pattern, path, expected) => {
    expect(ruleMatches({ methods: ['GET'], path: pattern }, 'GET', at(path))).toBe(expected);
  });
});

describe('credentialRuleDecision: anchor rules at request time', () => {
  it('refuses a generic rule that does not satisfy its own anchor_claims', () => {
    const conditions = [{ claim: 'email', match: 'exact', values: ['a@x.com'] } as Condition];
    const claims = { email: 'a@x.com', oid: 'o-1' };
    const anchored = generic('acr_email', ['email'], conditions);
    expect(evaluate([anchored], facts(claims), genericProfile).decision).toBe('allow');
    const unanchored = generic('acr_email', ['oid'], conditions);
    const outcome = evaluate([unanchored], facts(claims), genericProfile);
    expect(outcome).toMatchObject({ decision: 'deny', code: 'no_matching_rule' });
    expect(outcome.trace).toEqual([
      {
        rule_id: 'acr_email',
        result: 'invalid_rule',
        detail: 'the access rule does not satisfy the anchor rules of its issuer type (I-AUTHZ-2)',
      },
    ]);
  });

  it('refuses a rule whose anchor is negated or a glob', () => {
    const negated = credentialRule({
      id: 'acr_n',
      conditions: [owner, { ...repo, values: ['9'], negate: true }],
    });
    const globbed = credentialRule({
      id: 'acr_g',
      conditions: [owner, { claim: 'repository_id', match: 'glob', values: ['*'] }],
    });
    const outcome = evaluate([negated, globbed], facts());
    expect(outcome.trace.map((t) => t.result)).toEqual(['invalid_rule', 'invalid_rule']);
  });

  it('refuses a malformed generic anchor list without throwing', () => {
    const c = generic('acr_x', [''], [owner, repo]);
    expect(credentialRuleDecision(c, genericProfile, facts())).toMatchObject({
      result: 'invalid_rule',
    });
    const notAList = generic('acr_y', 'x' as unknown as string[]);
    expect(credentialRuleDecision(notAList, genericProfile, facts())).toMatchObject({
      result: 'invalid_rule',
    });
  });
});

describe('traceJson', () => {
  it('serializes small traces unchanged', () => {
    const trace: RuleTraceEntry[] = [{ rule_id: 'acr_a', result: 'no_rule', detail: 'x' }];
    expect(JSON.parse(traceJson(trace))).toEqual(trace);
  });

  it('writes rule_id and global_rule_id, clipped to 64 characters', () => {
    const trace: RuleTraceEntry[] = [
      { rule_id: 'acr_a', global_rule_id: 'gar_b', result: 'global_blocked', detail: 'x' },
      {
        rule_id: `acr_${'r'.repeat(100)}`,
        global_rule_id: `gar_${'g'.repeat(100)}`,
        result: 'matched',
        detail: '',
      },
    ];
    expect(traceJson(trace.slice(0, 1))).toBe(
      '[{"rule_id":"acr_a","global_rule_id":"gar_b","result":"global_blocked","detail":"x"}]',
    );
    const parsed = JSON.parse(traceJson(trace)) as RuleTraceEntry[];
    expect(parsed[1]?.rule_id).toHaveLength(65);
    expect(parsed[1]?.global_rule_id).toHaveLength(65);
  });

  it(`stays under ${TRACE_MAX_BYTES} bytes and counts omitted entries`, () => {
    const trace: RuleTraceEntry[] = Array.from({ length: 40 }, (_, i) => ({
      rule_id: `acr_${i}`,
      result: 'condition_failed',
      detail: 'é'.repeat(500),
    }));
    const json = traceJson(trace);
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(TRACE_MAX_BYTES);
    const parsed = JSON.parse(json) as Array<Record<string, unknown>>;
    const last = parsed.at(-1) as { omitted: number };
    expect(parsed.length - 1 + last.omitted).toBe(40);
    expect(String(parsed[0]?.detail).length).toBeLessThanOrEqual(301);
  });

  it('keeps the last entry when only it is left', () => {
    const trace: RuleTraceEntry[] = [{ rule_id: 'r', result: 'matched', detail: '' }];
    expect(traceJson(trace)).toBe('[{"rule_id":"r","result":"matched","detail":""}]');
  });
});

describe('I-AUTHZ-1: stored data that bypassed validation fails closed', () => {
  it('a rule never allows a method outside PROXY_METHODS, even when listed explicitly', () => {
    const r = { methods: ['TRACE', 'CONNECT', 'get'], path: '/**' } as unknown as Rule;
    for (const method of ['TRACE', 'CONNECT', 'get', '']) {
      expect(ruleMatches(r, method, at('/x'))).toBe(false);
    }
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', '/**'],
    ['methods not a list', { methods: '*', path: '/**' }],
    ['path not a string', { methods: ['*'], path: null }],
    ['invalid path glob', { methods: ['*'], path: '/*/*/*/*/*/*/*/*/*' }],
  ])('a malformed operation (%s) matches nothing and does not throw', (_name, r) => {
    expect(ruleMatches(r as Rule, 'GET', at('/x'))).toBe(false);
    const outcome = evaluate(
      [credentialRule({ rules: [r as Rule] })],
      facts({}, { method: 'GET', matchPath: '/x' }),
    );
    expect(outcome).toMatchObject({ decision: 'deny', code: 'no_matching_rule' });
  });

  it.each<[string, Partial<PolicyCredentialRule>]>([
    ['conditions not a list', { conditions: 'x' as unknown as Condition[] }],
    ['null condition', { conditions: [owner, repo, null as unknown as Condition] }],
    ['the [null] sentinel', { conditions: [null as unknown as Condition] }],
    ['empty values', { conditions: [{ ...owner, values: [] }, repo] }],
    ['rules not a list', { rules: null as unknown as Rule[] }],
    ['the [null] rules sentinel', { rules: [null as unknown as Rule] }],
  ])('a malformed rule (%s) is skipped', (_name, shape) => {
    const malformed = credentialRule({ id: 'acr_bad', ...shape });
    const outcome = evaluate([malformed, rule('acr_ok')], facts());
    expect(outcome).toMatchObject({ decision: 'allow', rule: { id: 'acr_ok' } });
    expect(outcome.trace[0]?.result).not.toBe('matched');
  });

  it('an untrusted event never matches through a glob, even on a rule-matching rule', () => {
    const globOnly = rule('acr_a', [{ claim: 'event_name', match: 'glob', values: ['*'] }]);
    const outcome = evaluate([globOnly], facts({ event_name: 'workflow_run' }));
    expect(outcome).toMatchObject({ decision: 'deny', code: 'event_not_trusted' });
  });
});

describe('I-LOG-1: traces never echo claims outside the reveal set', () => {
  const secret = 'S3CR3T-claim-value';

  it.each<[string, Condition]>([
    ['exact', { claim: 'actor', match: 'exact', values: ['alice'] }],
    ['glob', { claim: 'actor', match: 'glob', values: ['al*'] }],
    ['negated glob', { claim: 'actor', match: 'glob', values: ['S3*'], negate: true }],
  ])('%s condition', (_name, condition) => {
    const outcome = evaluate([rule('acr_a', [condition])], facts({ actor: secret }));
    expect(outcome.decision).toBe('deny');
    expect(traceJson(outcome.trace)).not.toContain('S3CR3T');
  });

  it('event guard', () => {
    const outcome = evaluate(
      [rule('acr_a')],
      facts({ event_name: secret }, { revealClaims: new Set() }),
    );
    expect(outcome).toMatchObject({ code: 'event_not_trusted' });
    expect(traceJson(outcome.trace)).not.toContain('S3CR3T');
  });

  it('global access rule conditions', () => {
    const g = globalRule({ conditions: [{ claim: 'actor', match: 'exact', values: ['alice'] }] });
    const outcome = evaluate([rule('acr_a')], facts({ actor: secret }), githubProfile, [g]);
    expect(outcome).toMatchObject({ decision: 'deny', code: 'no_matching_rule' });
    expect(outcome.trace[0]).toMatchObject({ result: 'global_blocked', global_rule_id: g.id });
    expect(outcome.trace[0]?.detail).toContain('actor=(hidden)');
    expect(traceJson(outcome.trace)).not.toContain('S3CR3T');
  });
});

describe('traceJson bounds', () => {
  const utf8Length = (text: string) => new TextEncoder().encode(text).length;

  it('keeps entries whose details are full of lone surrogates or escapes', () => {
    const trace: RuleTraceEntry[] = [
      { rule_id: 'acr_a', result: 'condition_failed', detail: '\ud800'.repeat(400) },
      { rule_id: 'acr_b', result: 'condition_failed', detail: '"\\'.repeat(400) },
      { rule_id: 'acr_c', result: 'matched', detail: '' },
    ];
    const parsed = JSON.parse(traceJson(trace)) as RuleTraceEntry[];
    expect(parsed[0]?.rule_id).toBe('acr_a');
    expect(utf8Length(traceJson(trace))).toBeLessThanOrEqual(TRACE_MAX_BYTES);
  });

  it('stays valid JSON within the limit for random traces', () => {
    let state = 3;
    const next = (n: number) => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % n;
    };
    const alphabet = ['a', 'é', '😀', '\ud800', '"', '\\', '\n'];
    for (let round = 0; round < 200; round++) {
      const trace: RuleTraceEntry[] = Array.from({ length: next(30) }, (_, i) => ({
        rule_id: `acr_${i}`,
        ...(next(2) === 0 ? { global_rule_id: `gar_${i}` } : {}),
        result: 'condition_failed',
        detail: Array.from({ length: next(600) }, () => alphabet[next(alphabet.length)]).join(''),
      }));
      const json = traceJson(trace);
      expect(utf8Length(json)).toBeLessThanOrEqual(TRACE_MAX_BYTES);
      const parsed = JSON.parse(json) as Array<Record<string, unknown>>;
      const last = parsed.at(-1);
      const omitted = last !== undefined && 'omitted' in last ? Number(last.omitted) : 0;
      expect(parsed.length - (omitted > 0 ? 1 : 0) + omitted).toBe(trace.length);
    }
  });
});

describe('U5, AR-4: global access rules cap the credential access rules of their issuer', () => {
  const c = rule('acr_a');

  it('allows with global null when the issuer has no global access rule', () => {
    expect(globalDecision(c, [], facts())).toEqual({ ok: true, global: null });
    expect(evaluate([c], facts())).toMatchObject({ decision: 'allow', global: null });
  });

  it('allows with the global access rule that held', () => {
    const g = globalRule();
    expect(globalDecision(c, [g], facts())).toEqual({ ok: true, global: g });
    const outcome = evaluate([c], facts(), githubProfile, [g]);
    expect(outcome.trace).toEqual([
      { rule_id: 'acr_a', global_rule_id: g.id, result: 'matched', detail: '' },
    ]);
  });

  it.each<[string, Partial<PolicyGlobalRule>, string]>([
    ['disabled', { enabled: false }, 'global access rule disabled'],
    ['expired', { expires_at: NOW - 1 }, 'global access rule expired'],
    ['expiring now', { expires_at: NOW }, 'global access rule expired'],
  ])('refuses when the only global access rule is %s', (_name, overrides, detail) => {
    const g = globalRule(overrides);
    expect(globalDecision(c, [g], facts())).toEqual({
      ok: false,
      failures: [{ global_rule_id: g.id, detail }],
    });
    expect(evaluate([c], facts(), githubProfile, [g])).toMatchObject({
      decision: 'deny',
      code: 'no_matching_rule',
      trace: [{ rule_id: 'acr_a', global_rule_id: g.id, result: 'global_blocked', detail }],
    });
  });

  it('allows with an unexpired global access rule', () => {
    expect(globalDecision(c, [globalRule({ expires_at: NOW + 1 })], facts()).ok).toBe(true);
  });

  it('allows with the second global access rule when only it holds', () => {
    const first = globalRule({ id: 'gar_first', enabled: false });
    const second = globalRule({ id: 'gar_second' });
    expect(globalDecision(c, [first, second], facts())).toEqual({ ok: true, global: second });
  });

  it('lists every failure when no global access rule holds', () => {
    const first = globalRule({ id: 'gar_first', enabled: false });
    const second = globalRule({ id: 'gar_second', rules: [{ methods: ['GET'], path: '/**' }] });
    expect(globalDecision(c, [first, second], facts())).toEqual({
      ok: false,
      failures: [
        { global_rule_id: 'gar_first', detail: 'global access rule disabled' },
        { global_rule_id: 'gar_second', detail: 'no rule allows POST /api/chat.postMessage' },
      ],
    });
  });

  it('AR-6: refuses when the global access rule has another profile', () => {
    const g = globalRule({ profile: 'generic' });
    expect(globalDecision(c, [g], facts())).toMatchObject({
      ok: false,
      failures: [{ detail: 'issuer type differs' }],
    });
  });

  it('AR-3: a global access rule of another stored issuer key never holds', () => {
    const g = globalRule({ issuer_key: 'https://gitlab.com' });
    expect(globalDecision(c, [g], facts()).ok).toBe(false);
  });

  it('caps the operations: refuses POST and allows GET', () => {
    const g = globalRule({ rules: [{ methods: ['GET'], path: '/api/**' }] });
    const both = rule('acr_both', [], [{ methods: ['GET', 'POST'], path: '/api/**' }]);
    expect(evaluate([both], facts(), githubProfile, [g])).toMatchObject({ decision: 'deny' });
    expect(evaluate([both], facts({}, { method: 'GET' }), githubProfile, [g])).toMatchObject({
      decision: 'allow',
      global: g,
    });
  });

  it('caps the identity and fails closed on a missing claim (I-AUTHZ-4)', () => {
    const g = globalRule({
      conditions: [{ claim: 'environment', match: 'exact', values: ['production'] }],
    });
    expect(evaluate([c], facts({ environment: 'production' }), githubProfile, [g]).decision).toBe(
      'allow',
    );
    expect(evaluate([c], facts({ environment: 'staging' }), githubProfile, [g]).decision).toBe(
      'deny',
    );
    const outcome = evaluate([c], facts(), githubProfile, [g]);
    expect(outcome).toMatchObject({ decision: 'deny', code: 'no_matching_rule' });
    expect(outcome.trace[0]?.detail).toBe('condition[0] environment: claim missing');
  });

  it('I-AUTHZ-3: a global condition listing an untrusted event does not opt the rule in', () => {
    const g = globalRule({
      conditions: [{ claim: 'event_name', match: 'exact', values: ['push', 'pull_request'] }],
    });
    const outcome = evaluate([c], facts({ event_name: 'pull_request' }), githubProfile, [g]);
    expect(outcome).toMatchObject({ decision: 'deny', code: 'event_not_trusted' });
    expect(outcome.trace[0]).toMatchObject({ rule_id: 'acr_a', result: 'event_not_trusted' });
  });

  it('reports event_not_trusted only when a global access rule would also allow the call', () => {
    const blocking = globalRule({ rules: [{ methods: ['GET'], path: '/**' }] });
    const outcome = evaluate([c], facts({ event_name: 'pull_request' }), githubProfile, [blocking]);
    expect(outcome).toMatchObject({ decision: 'deny', code: 'no_matching_rule' });
  });

  it('falls through to a later credential access rule that the global access rule allows', () => {
    const g = globalRule({ audience: credentialRule().audience });
    const other = credentialRule({ id: 'acr_other', audience: 'tokengate:other-audience-0000' });
    const outcome = evaluate([other, c], facts(), githubProfile, [g]);
    expect(outcome).toMatchObject({ decision: 'allow', rule: { id: 'acr_a' }, global: g });
    expect(outcome.trace.map((t) => [t.rule_id, t.result, t.detail])).toEqual([
      ['acr_other', 'global_blocked', 'audience pin differs'],
      ['acr_a', 'matched', ''],
    ]);
  });
});

describe('AR-10: verificationGroupKey', () => {
  const key = (overrides: Partial<PolicyCredentialRule>, profile = githubProfile) =>
    verificationGroupKey(credentialRule(overrides), profile);

  it('is the same for rules that verify the same way, whatever their policy', () => {
    expect(key({ id: 'acr_a', conditions: [owner], rules: [] })).toBe(key({ id: 'acr_b' }));
    expect(key({ allowed_algs: ['ES256', 'RS256'] })).toBe(
      key({ allowed_algs: ['RS256', 'ES256'] }),
    );
  });

  it.each<[string, Partial<PolicyCredentialRule>]>([
    ['issuer', { issuer: `${credentialRule().issuer}/` }],
    ['JWKS URI', { jwks_uri: 'https://example.com/jwks' }],
    ['audience', { audience: 'tokengate:other-audience-0000' }],
    ['algorithms', { allowed_algs: ['ES256'] }],
    ['maximum token age', { max_token_age_seconds: 300 }],
    ['profile', { profile: 'gitlab-ci' }],
  ])('differs by %s', (_name, overrides) => {
    expect(key(overrides)).not.toBe(key({}));
  });

  it('differs by the claims jose requires', () => {
    const a = key({ profile: 'generic', anchor_claims: ['a'] }, genericProfile);
    const b = key({ profile: 'generic', anchor_claims: ['b'] }, genericProfile);
    expect(a).not.toBe(b);
  });
});
