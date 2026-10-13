import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { updateSettings } from '../../../../src/admin/ops/settings';
import { getSettings, SETTING_DEFAULTS } from '../../../../src/db/settings';
import { ACTOR, auditRows, opsDeps } from './helpers';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM settings'),
    env.DB.prepare('DELETE FROM audit_log'),
  ]);
});

describe('updateSettings', () => {
  it('stores changed values with one audit row listing only the changes', async () => {
    const result = await updateSettings(opsDeps(), ACTOR, {
      request_log_retention_days: 30,
      allowed_sample_rate: 0.25,
      audit_log_retention_days: SETTING_DEFAULTS.audit_log_retention_days,
    });
    expect(result).toMatchObject({
      ok: true,
      changed: ['request_log_retention_days', 'allowed_sample_rate'],
    });
    expect(await getSettings(env.DB)).toEqual({
      ...SETTING_DEFAULTS,
      request_log_retention_days: 30,
      allowed_sample_rate: 0.25,
    });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'settings.update',
      diff: {
        before: { request_log_retention_days: 14, allowed_sample_rate: 1 },
        after: { request_log_retention_days: 30, allowed_sample_rate: 0.25 },
      },
    });
  });

  it.each([
    [{ request_log_retention_days: 0 }],
    [{ audit_log_retention_days: 89 }],
    [{ rollup_retention_days: 29 }],
    [{ allowed_sample_rate: 1.5 }],
    [{ allowed_sample_rate: Number.NaN }],
    [{ request_log_retention_days: 1.5 }],
    [{ request_log_max_rows: 10 }],
    [{ bootstrap_completed_at: 1 }],
  ])('rejects %j without writing', async (input) => {
    const result = await updateSettings(opsDeps(), ACTOR, input as never);
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await getSettings(env.DB)).toEqual(SETTING_DEFAULTS);
    expect(await auditRows()).toHaveLength(0);
  });

  it('writes nothing when nothing changes', async () => {
    const result = await updateSettings(opsDeps(), ACTOR, { allowed_sample_rate: 1 });
    expect(result).toMatchObject({ ok: true, changed: [] });
    expect(await auditRows()).toHaveLength(0);
  });
});
