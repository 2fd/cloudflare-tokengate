// Policy vocabulary shared by evaluation, validation, storage and UI. See docs/policies.md.

/** HTTP methods the proxy forwards. Rule method "*" means exactly this set. */
export const PROXY_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export type ProxyMethod = (typeof PROXY_METHODS)[number];

/**
 * A test on one verified token claim.
 * `claim` is a literal top-level claim name. All conditions of an access rule must hold (AND);
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

/** Public 403 codes of a policy refusal (AR-13). Callers never learn which side refused. */
export type DenyCode = 'no_matching_rule' | 'event_not_trusted';

/** One step of request evaluation, stored in request_log.eval_trace. */
export interface TraceEntry {
  /** The credential access rule. */
  rule_id: string;
  /** The global access rule that held (`matched`) or refused (`global_blocked`). */
  global_rule_id?: string;
  /** `invalid_rule`: the stored rule does not satisfy its anchor rules (I-AUTHZ-2). */
  result:
    | 'matched'
    | 'invalid_rule'
    | 'condition_failed'
    | 'event_not_trusted'
    | 'no_rule'
    | 'global_blocked';
  detail: string;
}
