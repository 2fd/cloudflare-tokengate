import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ruleUsageStatement,
  HOUR_MS,
  mergeRuleUsage,
  type RollupRow,
} from '../../../src/db/rollups';

const H = Date.UTC(2026, 9, 14) - 10 * HOUR_MS;

async function rollup(hour: number, ruleId: string, outcome: string, requests: number) {
  await env.TELEMETRY_DB.prepare(
    `INSERT INTO request_rollup_hourly (hour, service_id, credential_access_rule_id, outcome, status_class, requests,
       upstream_auth_fail, duration_sum_ms)
     VALUES (?, 'svc_1', ?, ?, 2, ?, 0, 0)`,
  )
    .bind(hour, ruleId, outcome, requests)
    .run();
}

beforeEach(async () => {
  await env.TELEMETRY_DB.prepare('DELETE FROM request_rollup_hourly').run();
  await rollup(H - 5 * HOUR_MS, 'acr_a', 'allowed', 7);
  await rollup(H, 'acr_a', 'allowed', 3);
  await rollup(H + HOUR_MS, 'acr_a', 'denied', 9);
  await rollup(H + HOUR_MS, 'acr_b', 'allowed', 1);
  await rollup(H + HOUR_MS, '', 'allowed', 4);
});

const live = (ruleId: string, hour: number, requests: number, outcome = 'allowed'): RollupRow =>
  ({ hour, credential_access_rule_id: ruleId, outcome, requests }) as RollupRow;

describe('credential access rule usage', () => {
  it('sums allowed requests per credential access rule since an hour, newest hour last', async () => {
    const { results } = await ruleUsageStatement(env.TELEMETRY_DB, H).all();
    const usage = mergeRuleUsage(results, []);
    expect(Object.fromEntries(usage)).toEqual({
      acr_a: { credential_access_rule_id: 'acr_a', last_hour: H, requests: 3 },
      acr_b: { credential_access_rule_id: 'acr_b', last_hour: H + HOUR_MS, requests: 1 },
    });
  });

  it('stops before an hour and adds the live hours on top', async () => {
    const { results } = await ruleUsageStatement(
      env.TELEMETRY_DB,
      H - 6 * HOUR_MS,
      H + HOUR_MS,
    ).all();
    const usage = mergeRuleUsage(results, [
      live('acr_b', H + HOUR_MS, 2),
      live('acr_c', H + HOUR_MS, 1, 'denied'),
      live('', H + HOUR_MS, 5),
    ]);
    expect(Object.fromEntries(usage)).toEqual({
      acr_a: { credential_access_rule_id: 'acr_a', last_hour: H, requests: 10 },
      acr_b: { credential_access_rule_id: 'acr_b', last_hour: H + HOUR_MS, requests: 2 },
    });
  });
});
