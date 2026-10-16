// Delivers request records: to TELEMETRY_DB (through REQUEST_LOG_QUEUE when bound, else a direct
// insert) and to the optional REQUEST_ARCHIVE stream. Runs in waitUntil; never throws. Failures are
// logged as a fixed code and the request id, never record content or error text (I-LOG-1).
import { insertRequestRecordsStatements } from '../db/requests';
import type { Deps } from '../deps';
import { TokenBucket } from '../lib/bucket';
import { toArchiveRecord } from './archive';
import type { RequestRecord } from './types';

export async function recordRequest(deps: Deps, record: RequestRecord): Promise<void> {
  await Promise.all([toRequestLog(deps, record), toArchive(deps, record)]);
}

async function toRequestLog(deps: Deps, record: RequestRecord): Promise<void> {
  const queue = deps.env.REQUEST_LOG_QUEUE;
  if (queue) {
    try {
      await queue.send(record);
      return;
    } catch {
      logSinkError('request_log_queue_send_failed', record.id);
    }
  }
  try {
    await deps.env.TELEMETRY_DB.batch(
      insertRequestRecordsStatements(deps.env.TELEMETRY_DB, [record]),
    );
  } catch {
    logSinkError('request_log_insert_failed', record.id);
  }
}

async function toArchive(deps: Deps, record: RequestRecord): Promise<void> {
  const archive = deps.env.REQUEST_ARCHIVE;
  if (!archive) return;
  try {
    await archive.send([toArchiveRecord(record)]);
  } catch {
    logSinkError('request_archive_send_failed', record.id);
  }
}

function logSinkError(code: string, requestId: string): void {
  console.error(JSON.stringify({ type: 'telemetry.sink_failed', code, request_id: requestId }));
}

// ---------------------------------------------------------------------------------------------
// Pre-trust budget. Failures before a caller is verified and tenant-pinned can be produced by
// anyone on the internet, so their records are capped per isolate. Over budget they are only
// counted, with at most one console.warn summary per minute.

export const PRETRUST_LOG_BUDGET_PER_MINUTE = 10;
const MINUTE_MS = 60_000;

let pretrustBucket = new TokenBucket(PRETRUST_LOG_BUDGET_PER_MINUTE, MINUTE_MS);
let pretrustDropped = 0;
let pretrustWarnedAt: number | null = null;

/** Whether a pre-trust record may be stored now; counts it as dropped otherwise. */
export function admitPretrustRecord(now: number): boolean {
  if (pretrustBucket.take(now)) return true;
  pretrustDropped++;
  if (pretrustWarnedAt === null || now - pretrustWarnedAt >= MINUTE_MS) {
    console.warn(
      JSON.stringify({ type: 'telemetry.pretrust_records_dropped', count: pretrustDropped }),
    );
    pretrustDropped = 0;
    pretrustWarnedAt = now;
  }
  return false;
}

/** Restores a full pre-trust budget. Tests only. */
export function resetPretrustBudgetForTests(): void {
  pretrustBucket = new TokenBucket(PRETRUST_LOG_BUDGET_PER_MINUTE, MINUTE_MS);
  pretrustDropped = 0;
  pretrustWarnedAt = null;
}
