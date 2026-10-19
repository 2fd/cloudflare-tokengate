// accessRuleFromRow (src/db/rows.ts): the kind comes from credential_id, a global limit stored as SQL NULL
// is no limit, and a value that does not parse, has the wrong type or (on a global access rule) is an
// empty list becomes a sentinel that matches nothing (I-AUTHZ-5, AR-2). The rows here are written
// as D1 would return them, including values the CHECKs refuse (a row written around them).
import { describe, expect, it } from 'vitest';
import { accessRuleFromRow } from '../../../src/db/rows';
import type { CredentialAccessRule, GlobalAccessRule } from '../../../src/db/types';
import { globalRuleHolds, pinHolds } from '../../../src/policy/limits';
import { credentialRule, facts } from '../policy/access-rule-fixtures';

const base = {
  id: 'acr_1',
  name: 'rule',
  description: '',
  profile: 'github-actions',
  issuer: 'https://token.actions.githubusercontent.com',
  issuer_key: 'https://token.actions.githubusercontent.com',
  enabled: 1,
  expires_at: null,
  created_by: null,
  created_at: 1,
  updated_at: 1,
};

const credentialRow = (over: Record<string, unknown> = {}) => ({
  ...base,
  credential_id: 'svc_1',
  jwks_uri: 'https://token.actions.githubusercontent.com/.well-known/jwks',
  audience: 'tokengate:0123456789abcdef',
  allowed_algs: '["RS256"]',
  max_token_age_seconds: 600,
  tenant_pin: '[{"claim":"repository_owner_id","match":"exact","values":["1"]}]',
  anchor_claims: '[]',
  conditions: '[{"claim":"repository_id","match":"exact","values":["2"]}]',
  rules: '[{"methods":["GET"],"path":"/**"}]',
  ...over,
});

const globalRow = (over: Record<string, unknown> = {}) => ({
  ...base,
  id: 'gar_1',
  credential_id: null,
  jwks_uri: null,
  audience: null,
  allowed_algs: null,
  max_token_age_seconds: null,
  tenant_pin: null,
  anchor_claims: null,
  conditions: null,
  rules: null,
  ...over,
});

describe('accessRuleFromRow: the kind', () => {
  it('reads a credential access rule with every field', () => {
    const rule = accessRuleFromRow(credentialRow()) as CredentialAccessRule;
    expect(rule).toMatchObject({
      kind: 'credential',
      credential_id: 'svc_1',
      allowed_algs: ['RS256'],
      max_token_age_seconds: 600,
      anchor_claims: [],
      rules: [{ methods: ['GET'], path: '/**' }],
      enabled: true,
      expires_at: null,
    });
  });

  it('reads SQL NULL limits of a global access rule as no limit', () => {
    const rule = accessRuleFromRow(globalRow()) as GlobalAccessRule;
    expect(rule.kind).toBe('global');
    expect(rule.credential_id).toBeNull();
    for (const column of [
      'jwks_uri',
      'audience',
      'allowed_algs',
      'max_token_age_seconds',
      'tenant_pin',
      'anchor_claims',
      'conditions',
      'rules',
    ] as const) {
      expect(rule[column], column).toBeNull();
    }
  });
});

describe('I-AUTHZ-5: credential access rule sentinels', () => {
  it.each([
    ['conditions', 'not json', [null]],
    ['conditions', '{"claim":"x"}', [null]],
    ['rules', 'not json', [null]],
    ['tenant_pin', 'not json', [null]],
    ['tenant_pin', '"x"', [null]],
    ['allowed_algs', 'not json', []],
    ['allowed_algs', '["RS256", 7]', []],
    ['anchor_claims', 'not json', ['']],
    ['anchor_claims', '[1]', ['']],
  ])('%s = %j becomes %j', (column, value, sentinel) => {
    const rule = accessRuleFromRow(credentialRow({ [column]: value })) as unknown as Record<
      string,
      unknown
    >;
    expect(rule[column]).toEqual(sentinel);
  });

  it('a malformed tenant pin never holds, even on a non-shared issuer', () => {
    const rule = accessRuleFromRow(credentialRow({ tenant_pin: 'oops' })) as CredentialAccessRule;
    expect(pinHolds(rule.tenant_pin, { repository_owner_id: '1' })).toBe(false);
  });
});

describe('I-AUTHZ-5: global access rule sentinels (never "no limit")', () => {
  it.each([
    ['tenant_pin', '[]', [null]],
    ['tenant_pin', 'not json', [null]],
    ['conditions', '[]', [null]],
    ['conditions', '{}', [null]],
    ['rules', '[]', [null]],
    ['rules', 'not json', [null]],
    ['anchor_claims', '[]', ['']],
    ['anchor_claims', '[1]', ['']],
    ['allowed_algs', '[]', []],
    ['allowed_algs', 'not json', []],
  ])('%s = %j becomes %j', (column, value, sentinel) => {
    const rule = accessRuleFromRow(globalRow({ [column]: value })) as unknown as Record<
      string,
      unknown
    >;
    expect(rule[column]).toEqual(sentinel);
    // A sentinel limit holds for no request.
    const global = rule as unknown as GlobalAccessRule;
    expect(globalRuleHolds(global, credentialRule(), facts()).ok).toBe(false);
  });

  it('a maximum token age that is not a safe integer holds for nothing', () => {
    const rule = accessRuleFromRow(globalRow({ max_token_age_seconds: 1.5 })) as GlobalAccessRule;
    expect(rule.max_token_age_seconds).toBe(0);
    expect(globalRuleHolds(rule, credentialRule(), facts()).ok).toBe(false);
  });
});
