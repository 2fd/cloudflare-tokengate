// Request records as sent to the optional Basin Pipelines stream (REQUEST_ARCHIVE), the long-term
// archive in R2. Must match pipelines/request-log.v2.schema.json: the stream silently drops
// records that do not (https://developers.cloudflare.com/basin-pipelines/streams/manage-streams/).
import { type ArchiveRecord, REQUEST_RECORD_COLUMNS, type RequestRecord } from './types';

export const ARCHIVE_SCHEMA_VERSION = 2 as const;

/**
 * Archived columns: every request_log column except the policy trace, which only makes sense next
 * to the access rules it refers to.
 */
export const ARCHIVE_COLUMNS = REQUEST_RECORD_COLUMNS.filter(
  (column): column is Exclude<(typeof REQUEST_RECORD_COLUMNS)[number], 'eval_trace'> =>
    column !== 'eval_trace',
);

/** Field names of ArchiveRecord, in schema order. */
export const ARCHIVE_FIELDS: readonly string[] = [...ARCHIVE_COLUMNS, 'schema_version'];

/** Copies only the archived columns: an allowlist, so extra properties never reach the stream. */
export function toArchiveRecord(record: RequestRecord): ArchiveRecord {
  const out: Record<string, unknown> = {};
  for (const column of ARCHIVE_COLUMNS) out[column] = record[column];
  out.schema_version = ARCHIVE_SCHEMA_VERSION;
  return out as ArchiveRecord;
}
