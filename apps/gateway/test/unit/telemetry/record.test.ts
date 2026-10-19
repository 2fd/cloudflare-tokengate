import { describe, expect, it } from 'vitest';
import { githubActionsProfile } from '../../../src/identity/profiles/github-actions';
import {
  buildRequestRecord,
  isRequestRecord,
  PRETRUST_TEXT_LIMITS,
  RECORD_TEXT_LIMITS,
  type RequestRecordInput,
} from '../../../src/telemetry/record';
import { REQUEST_RECORD_COLUMNS } from '../../../src/telemetry/types';
import { githubClaims } from '../../helpers/jwt';

const REQUEST_ID = 'req_01JT0000000000000000000000';

function input(overrides: Partial<RequestRecordInput> = {}): RequestRecordInput {
  const claims = githubClaims({ jti: 'jti-1' });
  return {
    requestId: REQUEST_ID,
    ts: 1_700_000_000_000,
    durationMs: 12.6,
    request: new Request('https://gw.test/proxy/echo/a?x=1', {
      method: 'POST',
      headers: {
        'user-agent': 'ci/1',
        'cf-connecting-ip': '192.0.2.1',
        authorization: 'Bearer caller-token',
        cookie: 'c=d',
      },
    }),
    path: '/a',
    slug: 'echo',
    outcome: 'allowed',
    reason: null,
    status: 200,
    serviceId: 'svc_1',
    credentialAccessRuleId: 'acr_1',
    globalAccessRuleId: 'gar_1',
    untrustedIss: 'https://token.actions.githubusercontent.com',
    caller: {
      claims,
      display: githubActionsProfile.display(claims),
      logClaims: githubActionsProfile.logClaimAllowlist({ anchor_claims: [], tenant_pin: [] }),
    },
    trace: null,
    upstream: { status: 200, ms: 7.4 },
    weight: 1,
    ...overrides,
  };
}

describe('buildRequestRecord', () => {
  it('produces exactly the request_log columns', () => {
    const record = buildRequestRecord(input());
    expect(Object.keys(record).sort()).toEqual([...REQUEST_RECORD_COLUMNS].sort());
    expect(isRequestRecord(record)).toBe(true);
  });

  it('copies verified caller fields and only allowlisted scalar claims', () => {
    const record = buildRequestRecord(
      input({
        caller: {
          claims: { ...githubClaims({ jti: 'jti-1' }), nested: { a: 1 }, extra: 'drop-me' },
          display: { subject: 'repo:acme/app:ref:refs/heads/main', repository: 'acme/app' },
          logClaims: ['sub', 'repository', 'nested', 'run_attempt', 'missing'],
        },
      }),
    );
    expect(record).toMatchObject({
      claims_verified: 1,
      caller_subject: 'repo:acme/app:ref:refs/heads/main',
      caller_repository: 'acme/app',
      jti: 'jti-1',
      untrusted_iss: null,
      duration_ms: 13,
      upstream_ms: 7,
      method: 'POST',
      ip: '192.0.2.1',
      user_agent: 'ci/1',
      colo: null,
    });
    expect(JSON.parse(record.caller_claims ?? '')).toEqual({
      sub: 'repo:acme/app:ref:refs/heads/main',
      repository: 'acme/app',
      run_attempt: '1',
    });
  });

  it('treats prototype-looking claim names as plain data', () => {
    const claims = JSON.parse('{"sub":"s","__proto__":"p","constructor":"c"}') as Record<
      string,
      unknown
    >;
    const record = buildRequestRecord(
      input({
        caller: {
          claims,
          display: { subject: 's' },
          logClaims: ['sub', '__proto__', 'constructor', 'toString'],
        },
      }),
    );
    expect(record.caller_claims).toBe('{"sub":"s","__proto__":"p","constructor":"c"}');
  });

  it('stores no caller fields for pre-trust failures, only the untrusted issuer', () => {
    const record = buildRequestRecord(
      input({
        caller: null,
        outcome: 'denied',
        reason: 'tenant_mismatch',
        status: 401,
        upstream: null,
      }),
    );
    expect(record).toMatchObject({
      claims_verified: 0,
      caller_subject: null,
      caller_repository: null,
      caller_claims: null,
      jti: null,
      untrusted_iss: 'https://token.actions.githubusercontent.com',
      upstream_status: null,
      upstream_ms: null,
    });
  });

  it('never copies request headers other than user-agent and cf-connecting-ip', () => {
    const text = JSON.stringify(buildRequestRecord(input()));
    expect(text).not.toContain('caller-token');
    expect(text).not.toContain('c=d');
  });

  it('truncates long text to the column limits and keeps the result well-formed', () => {
    const long = (n: number) => 'x'.repeat(n);
    const record = buildRequestRecord(
      input({
        path: `/${long(5000)}`,
        request: new Request('https://gw.test/', { headers: { 'user-agent': long(1000) } }),
      }),
    );
    expect(record.path).toHaveLength(RECORD_TEXT_LIMITS.path);
    expect(record.user_agent).toHaveLength(RECORD_TEXT_LIMITS.user_agent);
  });

  it('keeps less attacker-chosen text in pre-trust records: short path and issuer, no user-agent', () => {
    const long = (n: number) => 'x'.repeat(n);
    const record = buildRequestRecord(
      input({
        caller: null,
        outcome: 'denied',
        reason: 'issuer_unknown',
        status: 401,
        path: `/${long(5000)}`,
        untrustedIss: `${long(127)}\u{1F600}`,
        request: new Request('https://gw.test/', { headers: { 'user-agent': long(1000) } }),
      }),
    );
    expect(PRETRUST_TEXT_LIMITS).toEqual({ path: 256, untrusted_iss: 128 });
    expect(record.path).toHaveLength(PRETRUST_TEXT_LIMITS.path);
    expect(record.untrusted_iss).toHaveLength(PRETRUST_TEXT_LIMITS.untrusted_iss);
    expect(record.untrusted_iss?.isWellFormed()).toBe(true);
    expect(record.user_agent).toBeNull();
    expect(isRequestRecord(record)).toBe(true);
  });

  it('caps the policy trace at 2 KB', () => {
    const trace = Array.from({ length: 50 }, (_, i) => ({
      rule_id: `acr_${i}`,
      result: 'condition_failed' as const,
      detail: 'd'.repeat(300),
    }));
    const record = buildRequestRecord(input({ trace, outcome: 'denied', status: 403 }));
    expect(new TextEncoder().encode(record.eval_trace ?? '').length).toBeLessThanOrEqual(2048);
  });

  it('records an empty path as "/" and reads the colo from request.cf', () => {
    const request = new Request('https://gw.test/proxy/echo');
    Object.defineProperty(request, 'cf', { value: { colo: 'AMS' } });
    const record = buildRequestRecord(input({ path: '', request }));
    expect(record.path).toBe('/');
    expect(record.colo).toBe('AMS');
  });
});

describe('isRequestRecord', () => {
  const valid = buildRequestRecord(input());

  it.each([
    ['null', null],
    ['array', []],
    ['bad id', { ...valid, id: 'req_x' }],
    ['bad outcome', { ...valid, outcome: 'maybe' }],
    ['claims_verified 2', { ...valid, claims_verified: 2 }],
    ['missing column', (({ colo: _c, ...rest }) => rest)(valid)],
    ['non-integer ts', { ...valid, ts: 1.5 }],
    ['negative duration', { ...valid, duration_ms: -1 }],
    ['status out of range', { ...valid, status: 42 }],
    ['upstream_status above int32', { ...valid, upstream_status: 2 ** 31 }],
    ['upstream_status below int32', { ...valid, upstream_status: -(2 ** 31) - 1 }],
    ['non-integer upstream_status', { ...valid, upstream_status: 200.5 }],
    ['string upstream_status', { ...valid, upstream_status: '200' }],
    ['zero weight', { ...valid, weight: 0 }],
    ['infinite weight', { ...valid, weight: Number.POSITIVE_INFINITY }],
    ['numeric text column', { ...valid, reason: 5 }],
    ['oversized path', { ...valid, path: 'x'.repeat(1025) }],
    ['oversized trace', { ...valid, eval_trace: 'x'.repeat(2049) }],
  ])('rejects %s', (_label, value) => {
    expect(isRequestRecord(value)).toBe(false);
  });

  it.each([0, 42, 1000, -1, 2 ** 31 - 1, -(2 ** 31)])('accepts upstream_status %i', (status) => {
    expect(isRequestRecord({ ...valid, upstream_status: status })).toBe(true);
  });

  it('accepts nullable columns as null', () => {
    expect(isRequestRecord({ ...valid, upstream_status: null, upstream_ms: null, ip: null })).toBe(
      true,
    );
  });
});
