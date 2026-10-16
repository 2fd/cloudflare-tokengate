import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getRequest,
  insertRequestRecordsStatements,
  listRequests,
  RECORDS_PER_INSERT,
} from '../../src/db/requests';
import { REQUEST_RECORD_COLUMNS, type RequestRecord } from '../../src/telemetry/types';

const db = () => env.TELEMETRY_DB;

function record(n: number, overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: `req_01JT${String(n).padStart(22, '0')}`,
    ts: n,
    outcome: 'allowed',
    reason: null,
    status: 200,
    upstream_status: 200,
    method: 'GET',
    path: '/a',
    service_slug: 'echo',
    service_id: 'svc_1',
    caller_provider_id: 'cpr_1',
    grant_id: 'grt_1',
    claims_verified: 1,
    caller_subject: 's',
    caller_repository: 'acme/app',
    caller_claims: '{"sub":"s"}',
    jti: 'j',
    untrusted_iss: null,
    eval_trace: null,
    duration_ms: 5,
    upstream_ms: 4,
    weight: 1.5,
    ip: '192.0.2.1',
    user_agent: 'ci/1',
    colo: 'AMS',
    ...overrides,
  };
}

beforeEach(async () => {
  await db().prepare('DELETE FROM request_log').run();
});

describe('insertRequestRecordsStatements', () => {
  it('stays within 100 bound parameters per statement', () => {
    expect(RECORDS_PER_INSERT).toBe(Math.floor(100 / REQUEST_RECORD_COLUMNS.length));
    expect(RECORDS_PER_INSERT * REQUEST_RECORD_COLUMNS.length).toBeLessThanOrEqual(100);
  });

  it('chunks records into multi-row inserts that round-trip exactly', async () => {
    const records = Array.from({ length: 9 }, (_, i) => record(i + 1));
    const statements = insertRequestRecordsStatements(db(), records);
    expect(statements).toHaveLength(Math.ceil(9 / RECORDS_PER_INSERT));
    await db().batch(statements);
    for (const r of records) expect(await getRequest(db(), r.id)).toEqual(r);
  });

  it('returns no statements for no records', () => {
    expect(insertRequestRecordsStatements(db(), [])).toEqual([]);
  });

  it('ignores duplicate ids', async () => {
    await db().batch(insertRequestRecordsStatements(db(), [record(1)]));
    await db().batch(insertRequestRecordsStatements(db(), [record(1, { status: 500 }), record(2)]));
    expect((await getRequest(db(), record(1).id))?.status).toBe(200);
    expect(await getRequest(db(), record(2).id)).not.toBeNull();
  });
});

describe('listRequests / getRequest', () => {
  beforeEach(async () => {
    await db().batch(
      insertRequestRecordsStatements(db(), [
        record(1),
        record(2, { outcome: 'denied', status: 403, service_id: 'svc_2', service_slug: 'other' }),
        record(3, { caller_repository: 'acme/other' }),
        record(4, { outcome: 'error', status: 503 }),
      ]),
    );
  });

  const ids = (records: RequestRecord[]) => records.map((r) => Number(r.id.slice(-2)));

  it('lists newest first with filters and keyset pagination', async () => {
    expect(ids(await listRequests(db()))).toEqual([4, 3, 2, 1]);
    expect(ids(await listRequests(db(), { outcome: 'denied' }))).toEqual([2]);
    expect(ids(await listRequests(db(), { service_id: 'svc_1' }))).toEqual([4, 3, 1]);
    expect(ids(await listRequests(db(), { slug: 'other' }))).toEqual([2]);
    expect(ids(await listRequests(db(), { repository: 'acme/other' }))).toEqual([3]);
    expect(ids(await listRequests(db(), { before: record(3).id, limit: 1 }))).toEqual([2]);
  });

  it('clamps the page size', async () => {
    expect(await listRequests(db(), { limit: 0 })).toHaveLength(1);
    expect(await listRequests(db(), { limit: 10_000 })).toHaveLength(4);
    expect(await listRequests(db(), { limit: Number.NaN })).toHaveLength(4);
    expect(await listRequests(db(), { limit: Number.POSITIVE_INFINITY })).toHaveLength(4);
  });

  it('binds filter values (no SQL injection through filters)', async () => {
    expect(await listRequests(db(), { slug: "x' OR '1'='1" })).toEqual([]);
    expect(await listRequests(db(), { before: "z' OR 1=1 --" })).toHaveLength(4);
  });

  it('returns null for an unknown id', async () => {
    expect(await getRequest(db(), 'req_missing')).toBeNull();
  });
});
