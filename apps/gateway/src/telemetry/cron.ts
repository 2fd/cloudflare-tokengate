// Hourly maintenance: rollups, retention purge, credential-expiry notices, heartbeat. Steps run
// independently so one failure cannot stop retention; any failure is recorded in settings
// (cron_last_error/_at, shown by the dashboard) and rethrown so the invocation fails.
import { auditStatement, buildAuditEvent, emitAuditLine, SYSTEM_ACTOR } from '../db/audit';
import { getSettings, putSettingStatement } from '../db/settings';
import type { AuditEvent } from '../db/types';
import type { Deps } from '../deps';
import { canonicalJson, parseJson } from '../lib/json';
import { DEFAULT_PURGE_LIMITS, type PurgeResult, purge } from './retention';
import { ROLLUP_HOURS_PER_RUN, runRollups } from './rollup';

export { ROLLUP_HOURS_PER_RUN };

/** A `credential.expiring` audit event is written once per service per threshold crossed. */
export const EXPIRY_THRESHOLDS_DAYS = [14, 3] as const;

const DAY_MS = 86_400_000;
const MAX_ERROR_LENGTH = 500;
const SERVICE_ID = /^svc_[0-9A-Z]{26}$/;

export interface CronSummary {
  rollupRows: number;
  purge: PurgeResult;
  expiryNotices: number;
}

/**
 * UTC hour of the daily exact request_log_max_rows probe. Other hours probe only when the rollup
 * estimate reaches the cap (see src/telemetry/retention.ts); the daily run covers missing rollups.
 */
export const MAX_ROWS_CHECK_HOUR_UTC = 3;

export async function runCron(deps: Deps): Promise<CronSummary> {
  const startedAt = deps.now();
  const failures: Array<{ step: string; error: unknown }> = [];
  async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      failures.push({ step: name, error });
      return null;
    }
  }

  const rollup = await step('rollup', () => runRollups(deps, startedAt));
  const purged = await step('purge', async () =>
    purge(deps, await getSettings(deps.env.DB), {
      ...DEFAULT_PURGE_LIMITS,
      forceMaxRowsProbe: new Date(startedAt).getUTCHours() === MAX_ROWS_CHECK_HOUR_UTC,
    }),
  );
  const notices = await step('credential_expiry', () => sendCredentialExpiryNotices(deps));
  if (failures.length === 0) {
    const finishedAt = deps.now();
    await step('heartbeat', () =>
      putSettingStatement(deps.env.DB, 'cron_last_success_at', finishedAt, finishedAt, null).run(),
    );
  }

  if (failures.length > 0) {
    const message = failures
      .map(({ step: name, error }) => `${name}: ${errorText(error)}`)
      .join('; ')
      .slice(0, MAX_ERROR_LENGTH);
    try {
      const now = deps.now();
      await deps.env.DB.batch([
        putSettingStatement(deps.env.DB, 'cron_last_error', message, now, null),
        putSettingStatement(deps.env.DB, 'cron_last_error_at', now, now, null),
      ]);
    } catch {
      // The database is likely what failed; the log line and the thrown error still report it.
    }
    console.error(
      JSON.stringify({ type: 'cron.failed', steps: failures.map((f) => f.step), error: message }),
    );
    const [first] = failures;
    throw failures.length === 1 && first
      ? first.error
      : new AggregateError(
          failures.map((f) => f.error),
          message,
        );
  }

  const summary: CronSummary = {
    rollupRows: rollup?.rows ?? 0,
    // Non-null: no step failed.
    purge: purged as PurgeResult,
    expiryNotices: notices ?? 0,
  };
  console.info(
    JSON.stringify({ type: 'cron.done', duration_ms: deps.now() - startedAt, ...summary }),
  );
  return summary;
}

/** Per service: the credential expiry the notices refer to, and thresholds already notified. */
export type ExpiryNoticeState = Record<string, { expires_at: number; notified: number[] }>;

const NOTICE_STATE_KEY = 'credential_expiry_notices';
// Compare-and-swap guard: true while the stored dedupe state is still the value this run read
// (`IS` also matches NULL for "never written"). Overlapping cron invocations therefore cannot both
// write the same notice: the second batch finds the state changed and inserts nothing.
const NOTICE_STATE_UNCHANGED = `(SELECT value FROM settings WHERE key = '${NOTICE_STATE_KEY}') IS ?`;

/**
 * Writes one system `credential.expiring` audit event per service whose credential crossed an
 * EXPIRY_THRESHOLDS_DAYS threshold since the last notice. Dedupe state lives in settings
 * (`credential_expiry_notices`) and is swapped in the same batch as the events, conditioned on the
 * value read (SQL-enforced, see NOTICE_STATE_UNCHANGED). Entering a new expiry date resets the
 * state for that service. Returns the number of events written.
 */
export async function sendCredentialExpiryNotices(deps: Deps): Promise<number> {
  const db = deps.env.DB;
  const now = deps.now();
  const horizon = now + Math.max(...EXPIRY_THRESHOLDS_DAYS) * DAY_MS;
  const [{ results: credentials }, stored] = await Promise.all([
    db
      .prepare(
        `SELECT id, slug, credential_expires_at FROM credentials
         WHERE credential_sealed IS NOT NULL AND credential_expires_at IS NOT NULL
           AND credential_expires_at <= ?`,
      )
      .bind(horizon)
      .all<{ id: string; slug: string; credential_expires_at: number }>(),
    db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .bind(NOTICE_STATE_KEY)
      .first<{ value: string }>(),
  ]);
  const storedRaw = stored?.value ?? null;
  const previous = parseNoticeState(parseJson(storedRaw));

  const next: ExpiryNoticeState = {};
  const events: AuditEvent[] = [];
  for (const service of credentials) {
    const expiresAt = service.credential_expires_at;
    const crossed = EXPIRY_THRESHOLDS_DAYS.filter((days) => expiresAt - now <= days * DAY_MS);
    const prior = previous[service.id];
    const already = prior?.expires_at === expiresAt ? prior.notified : [];
    const fresh = crossed.filter((days) => !already.includes(days));
    next[service.id] = {
      expires_at: expiresAt,
      notified: [...new Set([...already, ...crossed])].sort((a, b) => b - a),
    };
    if (fresh.length === 0) continue;
    // Several thresholds crossed at once (e.g. expiry entered late): one event, most urgent.
    const threshold = Math.min(...fresh);
    const when = new Date(expiresAt).toISOString();
    events.push(
      buildAuditEvent(deps, SYSTEM_ACTOR, {
        action: 'credential.expiring',
        targetType: 'service',
        targetId: service.id,
        summary:
          expiresAt <= now
            ? `Credential of service "${service.slug}" expired at ${when}`
            : `Credential of service "${service.slug}" expires within ${threshold} days (${when})`,
        diff: { threshold_days: threshold, expires_at: expiresAt },
      }),
    );
  }

  // Entries for credentials that left the horizon (rotated, deleted, expiry cleared) are dropped.
  const nextRaw = canonicalJson(next);
  if (events.length === 0 && nextRaw === canonicalJson(previous)) return 0;
  const guard = { sql: NOTICE_STATE_UNCHANGED, binds: [storedRaw] };
  const results = await db.batch([
    ...events.map((event) => auditStatement(db, event, guard)),
    // Last in the batch: the audit inserts above see the state this run read.
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at, updated_by)
         SELECT ?, ?, ?, NULL WHERE ${NOTICE_STATE_UNCHANGED}
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .bind(NOTICE_STATE_KEY, nextRaw, now, storedRaw),
  ]);
  const written = events.filter((_, i) => results[i]?.meta.changes === 1);
  for (const event of written) emitAuditLine(event);
  return written.length;
}

function parseNoticeState(raw: unknown): ExpiryNoticeState {
  const state: ExpiryNoticeState = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;
  for (const [id, entry] of Object.entries(raw)) {
    if (!SERVICE_ID.test(id) || !entry || typeof entry !== 'object') continue;
    const { expires_at, notified } = entry as Record<string, unknown>;
    if (typeof expires_at !== 'number' || !Array.isArray(notified)) continue;
    state[id] = {
      expires_at,
      notified: notified.filter((days): days is number => typeof days === 'number'),
    };
  }
  return state;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
