import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  grantUsageStatement,
  HOUR_MS,
  mergeIssuerAccessRuleUsage,
  type RollupRow,
} from '../../../src/db/rollups';

const H = Date.UTC(2026, 9, 14) - 10 * HOUR_MS;

async function rollup(hour: number, grantId: string, outcome: string, requests: number) {
  await env.TELEMETRY_DB.prepare(
    `INSERT INTO request_rollup_hourly (hour, service_id, grant_id, outcome, status_class, requests,
       upstream_auth_fail, duration_sum_ms)
     VALUES (?, 'svc_1', ?, ?, 2, ?, 0, 0)`,
  )
    .bind(hour, grantId, outcome, requests)
    .run();
}

beforeEach(async () => {
  await env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly').run();
  await rollup(H - 5 * HOUR_MS, 'grt_a', 'allowed', 7);
  await rollup(H, 'grt_a', 'allowed', 3);
  await rollup(H + HOUR_MS, 'grt_a', 'denied', 9);
  await rollup(H + HOUR_MS, 'grt_b', 'allowed', 1);
  await rollup(H + HOUR_MS, '', 'allowed', 4);
});

const live = (grantId: string, hour: number, requests: number, outcome = 'allowed'): RollupRow =>
  ({ hour, grant_id: grantId, outcome, requests }) as RollupRow;

describe('grant usage', () => {
  it('sums allowed requests per grant since an hour, newest hour last', async () => {
    const { results } = await grantUsageStatement(env.TELEMETRY_DB, H).all();
    const usage = mergeIssuerAccessRuleUsage(results, []);
    expect(Object.fromEntries(usage)).toEqual({
      grt_a: { grant_id: 'grt_a', last_hour: H, requests: 3 },
      grt_b: { grant_id: 'grt_b', last_hour: H + HOUR_MS, requests: 1 },
    });
  });

  it('stops before an hour and adds the live hours on top', async () => {
    const { results } = await grantUsageStatement(
      env.TELEMETRY_DB,
      H - 6 * HOUR_MS,
      H + HOUR_MS,
    ).all();
    const usage = mergeIssuerAccessRuleUsage(results, [
      live('grt_b', H + HOUR_MS, 2),
      live('grt_c', H + HOUR_MS, 1, 'denied'),
      live('', H + HOUR_MS, 5),
    ]);
    expect(Object.fromEntries(usage)).toEqual({
      grt_a: { grant_id: 'grt_a', last_hour: H, requests: 10 },
      grt_b: { grant_id: 'grt_b', last_hour: H + HOUR_MS, requests: 2 },
    });
  });
});
