// REQUEST_LOG_QUEUE consumer: writes a batch of request records to TELEMETRY_DB in one D1 batch.
// Invalid messages are acknowledged and dropped (retrying cannot fix them); a D1 failure retries
// the whole batch, which is safe because inserts are INSERT OR IGNORE and rollups are idempotent.
// Records older than the cron's rollup window (DLQ replays) have their hours rolled up here.
import { insertRequestRecordsStatements } from '../db/requests';
import type { Deps } from '../deps';
import { isRequestRecord } from './record';
import { lateRecordHours, rollupHours } from './rollup';
import type { RequestRecord } from './types';

export const RETRY_DELAY_SECONDS = 30;

export async function consumeRequestLogBatch(
  batch: MessageBatch<unknown>,
  deps: Deps,
): Promise<void> {
  const records: RequestRecord[] = [];
  for (const message of batch.messages) {
    if (isRequestRecord(message.body)) {
      records.push(message.body);
    } else {
      message.ack();
      console.error(
        JSON.stringify({ type: 'telemetry.invalid_queue_message', message_id: message.id }),
      );
    }
  }
  if (records.length === 0) return;

  const db = deps.env.TELEMETRY_DB;
  try {
    await db.batch(insertRequestRecordsStatements(db, records));
  } catch {
    console.error(JSON.stringify({ type: 'telemetry.queue_batch_failed', count: records.length }));
    batch.retryAll({ delaySeconds: RETRY_DELAY_SECONDS });
    return;
  }
  const late = lateRecordHours(
    records.map((record) => record.id),
    deps.now(),
  );
  if (late.length > 0) {
    try {
      await rollupHours(deps, late);
    } catch {
      // The records are stored; the retry re-inserts nothing and rolls the hours up again.
      console.error(JSON.stringify({ type: 'telemetry.late_rollup_failed', hours: late.length }));
      batch.retryAll({ delaySeconds: RETRY_DELAY_SECONDS });
      return;
    }
  }
  batch.ackAll();
}
