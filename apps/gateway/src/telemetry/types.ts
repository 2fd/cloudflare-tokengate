// Request telemetry record: at most one per proxied request (allowed requests are sampled, pre-trust
// failures capped). Built only by telemetry/record.ts, which redacts by construction (I-LOG-1).

export type Outcome = 'allowed' | 'denied' | 'error';

/** Mirrors the request_log table (migrations-telemetry/0001_initial.sql). */
export interface RequestRecord {
  id: string;
  ts: number;
  outcome: Outcome;
  reason: string | null;
  status: number;
  upstream_status: number | null;
  method: string;
  path: string;
  service_slug: string | null;
  service_id: string | null;
  credential_access_rule_id: string | null;
  grant_id: string | null;
  claims_verified: 0 | 1;
  caller_subject: string | null;
  caller_repository: string | null;
  /** JSON object of allowlisted claims. */
  caller_claims: string | null;
  jti: string | null;
  untrusted_iss: string | null;
  /** JSON TraceEntry[] for denied requests, <= 2 KB. */
  eval_trace: string | null;
  duration_ms: number;
  upstream_ms: number | null;
  weight: number;
  ip: string | null;
  user_agent: string | null;
  colo: string | null;
}

/** Column order for inserts; also the source for the Pipelines schema test. */
export const REQUEST_RECORD_COLUMNS = [
  'id',
  'ts',
  'outcome',
  'reason',
  'status',
  'upstream_status',
  'method',
  'path',
  'service_slug',
  'service_id',
  'credential_access_rule_id',
  'grant_id',
  'claims_verified',
  'caller_subject',
  'caller_repository',
  'caller_claims',
  'jti',
  'untrusted_iss',
  'eval_trace',
  'duration_ms',
  'upstream_ms',
  'weight',
  'ip',
  'user_agent',
  'colo',
] as const satisfies ReadonlyArray<keyof RequestRecord>;

/**
 * Record sent to the optional Pipelines stream: every column but eval_trace, plus schema_version
 * (pipelines/request-log.v1.schema.json).
 */
export type ArchiveRecord = Omit<RequestRecord, 'eval_trace'> & { schema_version: 1 };
