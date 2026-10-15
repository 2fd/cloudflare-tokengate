// Policy vocabulary shared by evaluation, validation, storage and UI. See docs/policies.md.

/** HTTP methods the proxy forwards. Rule method "*" means exactly this set. */
export const PROXY_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export type ProxyMethod = (typeof PROXY_METHODS)[number];

/**
 * A test on one verified token claim.
 * `claim` is a literal top-level claim name. All conditions of a grant must hold (AND);
 * `values` are alternatives (OR). Missing or non-scalar claims never match, even negated.
 */
export interface Condition {
  claim: string;
  match: 'exact' | 'glob';
  values: string[];
  negate?: boolean;
}

/** One allowed operation: method set + path glob relative to the service base URL. */
export interface Rule {
  methods: Array<ProxyMethod | '*'>;
  path: string;
}

/** How the credential is attached to the upstream request. See src/proxy/inject.ts. */
export type Injection =
  | { kind: 'bearer' }
  | { kind: 'header'; name: string; prefix?: string }
  | { kind: 'basic'; username?: string }
  | { kind: 'query'; param: string }
  | { kind: 'path'; prefix?: string };

/** Optional request used to check a credential when it is saved or tested. */
export interface VerifyCheck {
  method: 'GET' | 'POST';
  path: string;
  expect_status: number;
  /** Slack-style APIs report failures as 200 with {"ok": false}. */
  expect_ok_field?: boolean;
  /**
   * Extra request headers of the check (at most 4), e.g. `anthropic-version`. Set by templates
   * only. Lower-case names that are never forwarded headers or the injected header; the
   * credential is injected after them, so they can never replace it.
   */
  headers?: Record<string, string>;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export type DenyCode = 'no_matching_grant' | 'event_not_trusted';

export interface TraceEntry {
  grant_id: string;
  /** `invalid_grant`: the stored grant does not satisfy the provider's anchor rules (I-AUTHZ-2). */
  result: 'matched' | 'invalid_grant' | 'condition_failed' | 'event_not_trusted' | 'no_rule';
  detail: string;
}

export type Decision<G> =
  | { decision: 'allow'; grant: G; trace: TraceEntry[] }
  | { decision: 'deny'; code: DenyCode; trace: TraceEntry[] };
