// Credential and global access rule fixtures for the policy core tests (ADR 0026). The rows are the
// structural subsets of src/policy/limits.ts, so these tests pin policy behaviour only.
import type { Claims } from '../../../src/identity/types';
import type {
  PolicyCredentialRule,
  PolicyGlobalRule,
  RequestFacts,
} from '../../../src/policy/limits';
import type { Condition, Rule } from '../../../src/policy/types';

/** A fixed request time in milliseconds, deliberately not a whole second. */
export const NOW = 1_800_000_000_400;
export const NOW_SECONDS = Math.floor(NOW / 1000);

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
export const owner: Condition = { claim: 'repository_owner_id', match: 'exact', values: ['1000'] };
export const repo: Condition = { claim: 'repository_id', match: 'exact', values: ['2000'] };
export const postMessage: Rule = { methods: ['POST'], path: '/api/chat.postMessage' };

export function credentialRule(
  overrides: Partial<PolicyCredentialRule> = {},
): PolicyCredentialRule {
  return {
    id: 'acr_01JTESTRULE00000000000000',
    profile: 'github-actions',
    issuer: GITHUB_ISSUER,
    issuer_key: GITHUB_ISSUER,
    jwks_uri: `${GITHUB_ISSUER}/.well-known/jwks`,
    audience: 'tokengate:01JTESTAUDIENCE00000000000',
    allowed_algs: ['RS256'],
    max_token_age_seconds: 600,
    tenant_pin: [owner],
    anchor_claims: [],
    conditions: [owner, repo],
    rules: [postMessage],
    ...overrides,
  };
}

/** A global access rule of GitHub's issuer with no limit. */
export function globalRule(overrides: Partial<PolicyGlobalRule> = {}): PolicyGlobalRule {
  return {
    id: 'gar_01JTESTGLOBAL0000000000000',
    profile: 'github-actions',
    issuer: GITHUB_ISSUER,
    issuer_key: GITHUB_ISSUER,
    enabled: true,
    expires_at: null,
    jwks_uri: null,
    audience: null,
    allowed_algs: null,
    max_token_age_seconds: null,
    tenant_pin: null,
    anchor_claims: null,
    conditions: null,
    rules: null,
    ...overrides,
  };
}

/** Both canonical path forms, as proxy/path.ts returns them. */
export function at(path: string): { path: string; matchPath: string } {
  return { path, matchPath: path.replace(/%2f/gi, '/') };
}

/** A verified push to acme's main branch that posts a Slack message. */
export function facts(claims: Claims = {}, overrides: Partial<RequestFacts> = {}): RequestFacts {
  const path = overrides.path ?? overrides.matchPath ?? postMessage.path;
  return {
    claims: {
      repository_owner_id: '1000',
      repository_id: '2000',
      event_name: 'push',
      ref: 'refs/heads/main',
      iat: NOW_SECONDS - 120,
      ...claims,
    },
    alg: 'RS256',
    now: NOW,
    method: 'POST',
    ...at(path),
    revealClaims: new Set(['ref', 'event_name']),
    ...overrides,
  };
}
