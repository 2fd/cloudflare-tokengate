// Runtime settings changes (owner only, enforced by RBAC): retention, sampling, row cap, and the
// upstream and admin host allowlists. Values are checked against SETTING_BOUNDS (floors also
// re-applied at use time); the changed keys and one audit row are written in one db.batch (I-AUDIT-1).
import { hostListed, isAdminHostEntry, isUpstreamHostEntry } from '../../config';
import {
  ADMIN_HOSTS_KEY,
  getAdminHosts,
  getAllowedUpstreamHosts,
  getSettings,
  putSettingStatement,
  SETTING_BOUNDS,
  type Settings,
  UPSTREAM_HOSTS_KEY,
} from '../../db/settings';
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

/**
 * Parses the allowlist textarea: entries separated by commas, spaces or new lines, lowercased and
 * deduplicated. Empty input means "any public https host" (null).
 */
export function parseUpstreamHostInput(
  raw: unknown,
): { ok: true; hosts: string[] | null } | { ok: false; error: string } {
  const entries = hostListEntries(raw);
  if (entries.length === 0) return { ok: true, hosts: null };
  const invalid = entries.filter((entry) => !isUpstreamHostEntry(entry));
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Not a hostname or "*.<domain>" with at least two labels: ${invalid.slice(0, 5).join(', ')}`,
    };
  }
  return { ok: true, hosts: entries };
}

/** Sets the upstream host allowlist (I-SSRF-1); one audit row in the same batch (I-AUDIT-1). */
export async function updateUpstreamHosts(
  deps: Deps,
  actor: Actor,
  raw: unknown,
): Promise<{ ok: true; hosts: string[] | null; changed: boolean } | OpFailure> {
  const parsed = parseUpstreamHostInput(raw);
  if (!parsed.ok) return opFailure('invalid', [parsed.error]);
  const db = deps.env.DB;
  const before = await getAllowedUpstreamHosts(db);
  if (JSON.stringify(before) === JSON.stringify(parsed.hosts)) {
    return { ok: true, hosts: before, changed: false };
  }
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'settings.upstream_hosts',
      targetType: 'settings',
      targetId: null,
      summary:
        parsed.hosts === null
          ? 'Services may use any public https host'
          : `Upstream host allowlist set (${parsed.hosts.length} entries)`,
      diff: { before, after: parsed.hosts },
    },
    null,
    [putSettingStatement(db, UPSTREAM_HOSTS_KEY, parsed.hosts, deps.now(), actor.id)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed)
    return opFailure('conflict', ['the allowlist was not saved; reload and retry']);
  return { ok: true, hosts: parsed.hosts, changed: true };
}

/** Entries separated by commas, spaces or new lines, lowercased and deduplicated. */
function hostListEntries(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== ''),
    ),
  ];
}

/**
 * Parses the admin hosts textarea. The list may not be empty, and must keep `currentHost` (the
 * hostname of the request saving it) so an owner cannot lock themselves out (I-DEPLOY-1).
 */
export function parseAdminHostInput(
  raw: unknown,
  currentHost: string,
): { ok: true; hosts: string[] } | { ok: false; error: string } {
  const entries = hostListEntries(raw);
  if (entries.length === 0) {
    return { ok: false, error: 'List at least one host: the admin console answers only on these.' };
  }
  const invalid = entries.filter((entry) => !isAdminHostEntry(entry));
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Not a hostname or "*.<domain>" with at least two labels, or on workers.dev: ${invalid.slice(0, 5).join(', ')}`,
    };
  }
  if (!hostListed(currentHost, entries)) {
    return {
      ok: false,
      error: `Keep ${currentHost} in the list: it is the host you are using now, and without it this page stops answering.`,
    };
  }
  return { ok: true, hosts: entries };
}

/** Sets the admin host allowlist (I-DEPLOY-1); one audit row in the same batch (I-AUDIT-1). */
export async function updateAdminHosts(
  deps: Deps,
  actor: Actor,
  raw: unknown,
  currentHost: string,
): Promise<{ ok: true; hosts: string[]; changed: boolean } | OpFailure> {
  const parsed = parseAdminHostInput(raw, currentHost);
  if (!parsed.ok) return opFailure('invalid', [parsed.error]);
  const db = deps.env.DB;
  const before = await getAdminHosts(db);
  if (JSON.stringify(before) === JSON.stringify(parsed.hosts)) {
    return { ok: true, hosts: parsed.hosts, changed: false };
  }
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'settings.admin_hosts',
      targetType: 'settings',
      targetId: null,
      summary: `Admin hosts set (${parsed.hosts.length} entries)`,
      diff: { before, after: parsed.hosts },
    },
    null,
    [putSettingStatement(db, ADMIN_HOSTS_KEY, parsed.hosts, deps.now(), actor.id)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed)
    return opFailure('conflict', ['the admin hosts were not saved; reload and retry']);
  return { ok: true, hosts: parsed.hosts, changed: true };
}
