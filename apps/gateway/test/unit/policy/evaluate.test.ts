import { describe, expect, it } from 'vitest';
import type { Claims } from '../../../src/identity/types';
import {
  type EvaluationInput,
  evaluateIssuerAccessRules,
  ruleMatches,
  TRACE_MAX_BYTES,
  traceJson,
} from '../../../src/policy/evaluate';
import type { Condition, Rule, TraceEntry } from '../../../src/policy/types';
import { genericProfile, githubProfile } from './fixtures';

interface TestIssuerAccessRule {
  id: string;
  conditions: Condition[];
  rules: Rule[];
}

const anchor: Condition[] = [
  { claim: 'repository_owner_id', match: 'exact', values: ['1000'] },
  { claim: 'repository_id', match: 'exact', values: ['2000'] },
];
const postMessage: Rule = { methods: ['POST'], path: '/api/chat.postMessage' };

function grant(
  id: string,
  extra: Condition[] = [],
  rules: Rule[] = [postMessage],
): TestIssuerAccessRule {
  return { id, conditions: [...anchor, ...extra], rules };
}

/** Both canonical path forms, as proxy/path.ts returns them. */
function at(path: string): { path: string; matchPath: string } {
  return { path, matchPath: path.replace(/%2f/gi, '/') };
}

function input(claims: Claims = {}, overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  const path = overrides.path ?? overrides.matchPath ?? '/api/chat.postMessage';
  return {
    claims: {
      repository_owner_id: '1000',
      repository_id: '2000',
      event_name: 'push',
      ref: 'refs/heads/main',
      ...claims,
    },
    profile: githubProfile,
    method: 'POST',
    provider: { anchor_claims: [] },
    ...at(path),
    revealClaims: new Set(['ref', 'event_name']),
    ...overrides,
  };
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
    const rule: Rule = { methods: ['GET'], path: '/repos/*/*/contents/**' };
    expect(ruleMatches(rule, 'GET', at('/repos/a/b/contents/x/y'))).toBe(true);
    expect(ruleMatches(rule, 'GET', at('/repos/a/b/issues'))).toBe(false);
  });
});

describe('I-AUTHZ-1: evaluateIssuerAccessRules denies by default', () => {
  it('denies with no issuer_access_rules', () => {
    expect(evaluateIssuerAccessRules([], input())).toEqual({
      decision: 'deny',
      code: 'no_matching_grant',
      trace: [],
    });
  });

  it('allows the first matching grant and traces the ones before it', () => {
    const issuer_access_rules = [
      grant('grt_a', [{ claim: 'ref', match: 'exact', values: ['refs/heads/prod'] }]),
      grant('grt_b', [], [{ methods: ['GET'], path: '/**' }]),
      grant('grt_c'),
      grant('grt_d'),
    ];
    const decision = evaluateIssuerAccessRules(issuer_access_rules, input());
    expect(decision.decision).toBe('allow');
    if (decision.decision !== 'allow') return;
    expect(decision.grant.id).toBe('grt_c');
    expect(decision.trace.map((t) => [t.grant_id, t.result])).toEqual([
      ['grt_a', 'condition_failed'],
      ['grt_b', 'no_rule'],
      ['grt_c', 'matched'],
    ]);
    expect(decision.trace[0]?.detail).toBe(
      'condition[2] ref="refs/heads/main" vs exact ["refs/heads/prod"]',
    );
  });

  it('refuses a grant without conditions', () => {
    const decision = evaluateIssuerAccessRules(
      [{ id: 'grt_x', conditions: [], rules: [postMessage] }],
      input(),
    );
    expect(decision).toMatchObject({ decision: 'deny', code: 'no_matching_grant' });
    expect(decision.trace[0]).toMatchObject({ result: 'invalid_grant' });
  });

  it('never echoes values of claims outside the reveal set', () => {
    const decision = evaluateIssuerAccessRules(
      [grant('grt_a', [{ claim: 'actor', match: 'exact', values: ['alice'] }])],
      input({ actor: 'mallory' }),
    );
    expect(JSON.stringify(decision.trace)).not.toContain('mallory');
  });
});

describe('I-AUTHZ-3: untrusted events need an exact opt-in', () => {
  const pr = { event_name: 'pull_request_target' };

  it('trusted events need no event condition', () => {
    expect(evaluateIssuerAccessRules([grant('grt_a')], input()).decision).toBe('allow');
  });

  it('denies untrusted events without an opt-in', () => {
    const decision = evaluateIssuerAccessRules([grant('grt_a')], input(pr));
    expect(decision).toMatchObject({ decision: 'deny', code: 'event_not_trusted' });
    expect(decision.trace[0]).toMatchObject({ result: 'event_not_trusted' });
    expect(decision.trace[0]?.detail).toContain('"pull_request_target"');
  });

  it('allows untrusted events listed in an exact, non-negated condition', () => {
    const optIn: Condition = {
      claim: 'event_name',
      match: 'exact',
      values: ['pull_request_target'],
    };
    expect(evaluateIssuerAccessRules([grant('grt_a', [optIn])], input(pr)).decision).toBe('allow');
  });

  it.each<[string, Condition]>([
    ['glob matching the event', { claim: 'event_name', match: 'glob', values: ['pull*'] }],
    ['glob **', { claim: 'event_name', match: 'glob', values: ['**'] }],
    ['negated exact', { claim: 'event_name', match: 'exact', values: ['push'], negate: true }],
    ['exact on another claim', { claim: 'event', match: 'exact', values: ['pull_request_target'] }],
  ])('does not count a %s as opt-in', (_name, condition) => {
    const decision = evaluateIssuerAccessRules(
      [grant('grt_a', [condition])],
      input({ ...pr, event: 'pull_request_target' }),
    );
    expect(decision).toMatchObject({ decision: 'deny', code: 'event_not_trusted' });
  });

  it('fails closed when the event claim is missing or not a string', () => {
    const missing = input();
    delete missing.claims.event_name;
    expect(evaluateIssuerAccessRules([grant('grt_a')], missing)).toMatchObject({
      decision: 'deny',
    });
    expect(
      evaluateIssuerAccessRules([grant('grt_a')], input({ event_name: ['push'] })),
    ).toMatchObject({
      decision: 'deny',
    });
  });

  it('reports event_not_trusted only when fixing the event would allow the call', () => {
    const noRule = grant('grt_a', [], [{ methods: ['GET'], path: '/other' }]);
    expect(evaluateIssuerAccessRules([noRule], input(pr))).toMatchObject({
      code: 'no_matching_grant',
    });

    const conditionFails = grant('grt_b', [{ claim: 'ref', match: 'exact', values: ['x'] }]);
    expect(evaluateIssuerAccessRules([conditionFails, grant('grt_c')], input(pr))).toMatchObject({
      code: 'event_not_trusted',
    });
  });

  it('does not apply to profiles without an event claim', () => {
    const generic = input(pr, {
      profile: genericProfile,
      provider: { anchor_claims: ['repository_id'] },
    });
    expect(evaluateIssuerAccessRules([grant('grt_a')], generic).decision).toBe('allow');
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

describe('evaluateIssuerAccessRules: anchor rules at request time', () => {
  it('skips a generic grant that no longer satisfies anchor_claims', () => {
    const emailOnly = {
      id: 'grt_email',
      conditions: [{ claim: 'email', match: 'exact', values: ['a@x.com'] } as Condition],
      rules: [postMessage],
    };
    const claims = { email: 'a@x.com', oid: 'o-1' };
    const before = evaluateIssuerAccessRules(
      [emailOnly],
      input(claims, { profile: genericProfile, provider: { anchor_claims: ['email'] } }),
    );
    expect(before.decision).toBe('allow');
    const after = evaluateIssuerAccessRules(
      [emailOnly],
      input(claims, { profile: genericProfile, provider: { anchor_claims: ['oid'] } }),
    );
    expect(after).toMatchObject({ decision: 'deny', code: 'no_matching_grant' });
    expect(after.trace).toEqual([
      {
        grant_id: 'grt_email',
        result: 'invalid_grant',
        detail: "grant does not satisfy the credential access rule's anchor rules (I-AUTHZ-2)",
      },
    ]);
  });

  it('skips a grant whose anchor is negated or a glob', () => {
    const negated = grant('grt_n');
    negated.conditions = [
      { claim: 'repository_owner_id', match: 'exact', values: ['1000'] },
      { claim: 'repository_id', match: 'exact', values: ['9'], negate: true },
    ];
    const globbed = grant('grt_g');
    globbed.conditions = [
      { claim: 'repository_owner_id', match: 'exact', values: ['1000'] },
      { claim: 'repository_id', match: 'glob', values: ['*'] },
    ];
    const decision = evaluateIssuerAccessRules([negated, globbed], input());
    expect(decision.trace.map((t) => t.result)).toEqual(['invalid_grant', 'invalid_grant']);
  });
});

describe('traceJson', () => {
  it('serializes small traces unchanged', () => {
    const trace: TraceEntry[] = [{ grant_id: 'grt_a', result: 'no_rule', detail: 'x' }];
    expect(JSON.parse(traceJson(trace))).toEqual(trace);
  });

  it(`stays under ${TRACE_MAX_BYTES} bytes and counts omitted entries`, () => {
    const trace: TraceEntry[] = Array.from({ length: 40 }, (_, i) => ({
      grant_id: `grt_${i}`,
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
    const trace: TraceEntry[] = [{ grant_id: 'g', result: 'matched', detail: '' }];
    expect(traceJson(trace)).toBe('[{"grant_id":"g","result":"matched","detail":""}]');
  });
});

describe('I-AUTHZ-1: stored data that bypassed validation fails closed', () => {
  it('a rule never allows a method outside PROXY_METHODS, even when listed explicitly', () => {
    const rule = { methods: ['TRACE', 'CONNECT', 'get'], path: '/**' } as unknown as Rule;
    for (const method of ['TRACE', 'CONNECT', 'get', '']) {
      expect(ruleMatches(rule, method, at('/x'))).toBe(false);
    }
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', '/**'],
    ['methods not a list', { methods: '*', path: '/**' }],
    ['path not a string', { methods: ['*'], path: null }],
    ['invalid path glob', { methods: ['*'], path: '/*/*/*/*/*/*/*/*/*' }],
  ])('a malformed rule (%s) matches nothing and does not throw', (_name, rule) => {
    expect(ruleMatches(rule as Rule, 'GET', at('/x'))).toBe(false);
    const decision = evaluateIssuerAccessRules(
      [{ id: 'grt_a', conditions: anchor, rules: [rule as Rule] }],
      input({}, { method: 'GET', matchPath: '/x' }),
    );
    expect(decision).toMatchObject({ decision: 'deny', code: 'no_matching_grant' });
  });

  it.each<[string, unknown]>([
    ['conditions not a list', { conditions: 'x', rules: [postMessage] }],
    ['null condition', { conditions: [...anchor, null], rules: [postMessage] }],
    ['empty values', { conditions: [{ ...anchor[0], values: [] }], rules: [postMessage] }],
    ['rules not a list', { conditions: anchor, rules: null }],
  ])('a malformed grant (%s) is skipped', (_name, shape) => {
    const malformed = { id: 'grt_bad', ...(shape as object) } as TestIssuerAccessRule;
    const decision = evaluateIssuerAccessRules([malformed, grant('grt_ok')], input());
    expect(decision).toMatchObject({ decision: 'allow', grant: { id: 'grt_ok' } });
    expect(decision.trace[0]?.result).not.toBe('matched');
  });

  it('an untrusted event never matches through a glob, even on a rule-matching grant', () => {
    const globOnly = grant('grt_a', [{ claim: 'event_name', match: 'glob', values: ['*'] }]);
    const decision = evaluateIssuerAccessRules([globOnly], input({ event_name: 'workflow_run' }));
    expect(decision).toMatchObject({ decision: 'deny', code: 'event_not_trusted' });
  });
});

describe('I-LOG-1: traces never echo claims outside the reveal set', () => {
  const secret = 'S3CR3T-claim-value';

  it.each<[string, Condition]>([
    ['exact', { claim: 'actor', match: 'exact', values: ['alice'] }],
    ['glob', { claim: 'actor', match: 'glob', values: ['al*'] }],
    ['negated glob', { claim: 'actor', match: 'glob', values: ['S3*'], negate: true }],
  ])('%s condition', (_name, condition) => {
    const decision = evaluateIssuerAccessRules(
      [grant('grt_a', [condition])],
      input({ actor: secret }),
    );
    expect(decision.decision).toBe('deny');
    expect(traceJson(decision.trace)).not.toContain('S3CR3T');
  });

  it('event guard', () => {
    const decision = evaluateIssuerAccessRules(
      [grant('grt_a')],
      input({ event_name: secret }, { revealClaims: new Set() }),
    );
    expect(decision).toMatchObject({ code: 'event_not_trusted' });
    expect(traceJson(decision.trace)).not.toContain('S3CR3T');
  });
});

describe('traceJson bounds', () => {
  const utf8Length = (text: string) => new TextEncoder().encode(text).length;

  it('keeps entries whose details are full of lone surrogates or escapes', () => {
    const trace: TraceEntry[] = [
      { grant_id: 'grt_a', result: 'condition_failed', detail: '\ud800'.repeat(400) },
      { grant_id: 'grt_b', result: 'condition_failed', detail: '"\\'.repeat(400) },
      { grant_id: 'grt_c', result: 'matched', detail: '' },
    ];
    const parsed = JSON.parse(traceJson(trace)) as TraceEntry[];
    expect(parsed[0]?.grant_id).toBe('grt_a');
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
      const trace: TraceEntry[] = Array.from({ length: next(30) }, (_, i) => ({
        grant_id: `grt_${i}`,
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
