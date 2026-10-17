import { describe, expect, it } from 'vitest';
import schema from '../../../../../pipelines/request-log.v1.schema.json';
import { ARCHIVE_FIELDS, toArchiveRecord } from '../../../src/telemetry/archive';
import {
  type ArchiveRecord,
  REQUEST_RECORD_COLUMNS,
  type RequestRecord,
} from '../../../src/telemetry/types';

/** Every column non-null, so each schema type can be checked against a value. */
const record: RequestRecord = {
  id: 'req_01JT0000000000000000000000',
  ts: 1_700_000_000_000,
  outcome: 'allowed',
  reason: 'credential_missing',
  status: 200,
  upstream_status: 200,
  method: 'GET',
  path: '/a',
  service_slug: 'echo',
  service_id: 'svc_1',
  credential_access_rule_id: 'cpr_1',
  grant_id: 'grt_1',
  claims_verified: 1,
  caller_subject: 'repo:acme/app:ref:refs/heads/main',
  caller_repository: 'acme/app',
  caller_claims: '{"sub":"x"}',
  jti: 'j',
  untrusted_iss: 'https://issuer.example',
  eval_trace: '[]',
  duration_ms: 10,
  upstream_ms: 8,
  weight: 1,
  ip: '192.0.2.1',
  user_agent: 'ci/1',
  colo: 'AMS',
};

type SchemaField = { name: string; type: string; required: boolean };
const fields = (schema as { fields: SchemaField[] }).fields;

/** Pipelines schema type accepting a JS value of this kind. */
function schemaTypeOf(value: unknown): string[] {
  if (typeof value === 'string') return ['string'];
  if (typeof value === 'number') {
    return Number.isInteger(value) ? ['int32', 'int64', 'float64'] : ['float64'];
  }
  return [];
}

describe('pipelines/request-log.v1.schema.json', () => {
  it('lists exactly the ArchiveRecord fields, derived from REQUEST_RECORD_COLUMNS', () => {
    const expected = [
      ...REQUEST_RECORD_COLUMNS.filter((c) => c !== 'eval_trace'),
      'schema_version',
    ];
    expect(fields.map((f) => f.name)).toEqual(expected);
    expect(ARCHIVE_FIELDS).toEqual(expected);
    expect(Object.keys(toArchiveRecord(record))).toEqual(expected);
  });

  it('types every field consistently with the record values', () => {
    const archived = toArchiveRecord(record) as Record<string, unknown>;
    for (const field of fields) {
      expect(schemaTypeOf(archived[field.name]), field.name).toContain(field.type);
    }
  });

  it('requires exactly the NOT NULL request_log columns', () => {
    const required = fields.filter((f) => f.required).map((f) => f.name);
    expect(required).toEqual([
      'id',
      'ts',
      'outcome',
      'status',
      'method',
      'path',
      'claims_verified',
      'duration_ms',
      'weight',
      'schema_version',
    ]);
  });
});

describe('toArchiveRecord', () => {
  it('drops eval_trace and properties that are not columns', () => {
    const archived: ArchiveRecord = toArchiveRecord({
      ...record,
      ...({ secret: 'x' } as object),
    } as RequestRecord);
    expect(archived).not.toHaveProperty('eval_trace');
    expect(archived).not.toHaveProperty('secret');
    expect(archived.schema_version).toBe(1);
  });
});
