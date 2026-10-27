// Hourly maintenance: rollups, retention purge, heartbeat. Steps run
// independently so one failure cannot stop retention; any failure is recorded in settings
// (cron_last_error/_at, shown by the dashboard) and rethrown so the invocation fails.
import { getSettings, putSettingStatement } from '../db/settings';
import type { Deps } from '../deps';
import { DEFAULT_PURGE_LIMITS, type PurgeResult, purge } from './retention';
import { ROLLUP_HOURS_PER_RUN, runRollups } from './rollup';

export { ROLLUP_HOURS_PER_RUN };

const MAX_ERROR_LENGTH = 500;

export interface CronSummary {
  rollupRows: number;
  purge: PurgeResult;
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
  };
  console.info(
    JSON.stringify({ type: 'cron.done', duration_ms: deps.now() - startedAt, ...summary }),
  );
  return summary;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
