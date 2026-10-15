// Runtime settings changes (owner only, enforced by RBAC): retention, sampling and row cap. Values
// are checked against SETTING_BOUNDS (floors also re-applied at use time); the changed keys and one
// audit row are written in one db.batch (I-AUDIT-1). The host allowlists live in upstream-hosts.ts
// and admin-hosts.ts.
import { getSettings, putSettingStatement, SETTING_BOUNDS, type Settings } from '../../db/settings';
import type { Actor } from '../../db/types';
import type { Deps } from '../../deps';
import { commitOrConstraintFailure, type OpFailure, opFailure, pick } from './shared';

export const SETTING_LABELS: Record<keyof Settings, string> = {
  request_log_retention_days: 'Request log retention (days)',
  audit_log_retention_days: 'Audit log retention (days)',
  rollup_retention_days: 'Traffic summary retention (days)',
  allowed_sample_rate: 'Share of allowed requests to record',
  request_log_max_rows: 'Maximum request log rows',
};

export const EDITABLE_SETTINGS: ReadonlyArray<keyof Settings> = [
  'request_log_retention_days',
  'audit_log_retention_days',
  'rollup_retention_days',
  'allowed_sample_rate',
  'request_log_max_rows',
];

/** Settings that must be whole numbers; the others accept fractions. */
const INTEGER_SETTINGS: ReadonlySet<keyof Settings> = new Set([
  'request_log_retention_days',
  'audit_log_retention_days',
  'rollup_retention_days',
  'request_log_max_rows',
]);

export function settingErrors(key: keyof Settings, value: unknown): string[] {
  const { min, max } = SETTING_BOUNDS[key];
  const label = SETTING_LABELS[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return [`${label} must be a number.`];
  if (INTEGER_SETTINGS.has(key) && !Number.isSafeInteger(value)) {
    return [`${label} must be a whole number.`];
  }
  if (value < min || value > max) return [`${label} must be between ${min} and ${max}.`];
  return [];
}

export async function updateSettings(
  deps: Deps,
  actor: Actor,
  input: Partial<Settings>,
): Promise<{ ok: true; settings: Settings; changed: Array<keyof Settings> } | OpFailure> {
  const keys = Object.keys(input) as Array<keyof Settings>;
  const unknown = keys.filter((key) => !EDITABLE_SETTINGS.includes(key));
  if (unknown.length > 0) return opFailure('invalid', [`unknown settings: ${unknown.join(', ')}`]);
  const errors = keys.flatMap((key) => settingErrors(key, input[key]));
  if (errors.length > 0) return opFailure('invalid', errors);

  const db = deps.env.DB;
  const before = await getSettings(db);
  const after: Settings = { ...before, ...input };
  const changed = keys.filter((key) => after[key] !== before[key]);
  if (changed.length === 0) return { ok: true, settings: before, changed };

  const now = deps.now();
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'settings.update',
      targetType: 'settings',
      targetId: null,
      summary: `Updated settings (${changed.join(', ')})`,
      diff: { before: pick(before, changed), after: pick(after, changed) },
    },
    null,
    changed.map((key) => putSettingStatement(db, key, after[key], now, actor.id)),
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) {
    return opFailure('conflict', ['the settings were not saved; reload and retry']);
  }
  return { ok: true, settings: after, changed };
}
