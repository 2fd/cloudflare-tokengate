import { sealedKid } from '../crypto/envelope';
// Who can use which credential: every credential access rule with its credential, its status against
// the global access rules of its issuer (ADR 0026), a status from the A9 vocabulary, a summary and its
// last use. One loader for the Overview, the credential and rule lists and pages, the map and matrix
// and the rule form, so a status reads the same everywhere. Read-only. Monitoring data (last use) is
// for display only and never an autocomplete source; when TELEMETRY_DB cannot be read, the usage is
// empty and no rule is called unused.
import { loadKeyring } from '../crypto/keyring';
import { listCredentialAccessRules, listGlobalAccessRules } from '../db/access-rules';
import { listClaimLabels } from '../db/claim-labels';
import { listServices } from '../db/credentials';
import {
  aggregateRequestLogStatement,
  HOUR_MS,
  mergeRuleUsage,
  type RuleUsage,
  rollupFromRow,
  ruleUsageStatement,
} from '../db/rollups';
import { getSettings } from '../db/settings';
import type { ClaimLabel, CredentialAccessRule, GlobalAccessRule, Service } from '../db/types';
import type { Deps } from '../deps';
import {
  cronHealthFrom,
  cronSettingsStatement,
  type KeyringHealth,
  keyringHealthFrom,
  recordedKcvStatement,
} from '../health';
import { getProfile } from '../identity/profiles';
import { type GlobalStatus, globalStatus } from '../policy/global-status';
import { validateCredentialAccessRule } from '../policy/validate-rules';
import { EXPIRY_WARNING_MS } from '../telemetry/dashboard';
import { hourStart } from '../telemetry/rollup';
import { accessSummary } from './access-summary';
import type { InactiveReason, StatusKey } from './views/status';

const DAY_MS = 86_400_000;
/** "Unused 30+ days": no allowed request in this window, for a rule older than it. */
export const UNUSED_AFTER_MS = 30 * DAY_MS;

/** A warning shown next to the status, never instead of it. */
export interface AccessFlag {
  status: Extract<StatusKey, 'risk_accepted' | 'unused' | 'global_limited'>;
  detail?: string;
}

export interface RuleEdge {
  rule: CredentialAccessRule;
  /** Null only if the row was deleted between reads. */
  credential: Service | null;
  /** The rule against the global access rules of its issuer key, now (AR-8). */
  globalStatus: GlobalStatus<GlobalAccessRule>;
  /** disabled, expired, inactive, global_blocked, expiring or active, in that precedence. */
  status: StatusKey;
  /** The day count of `expiring`, the InactiveReason of `inactive`. */
  statusDetail?: string;
  flags: AccessFlag[];
  subject: string;
  context: string;
  operations: string[];
  /** Newest hour with an allowed request in the last 30 days, or null. */
  lastUsedHour: number | null;
}

export interface ConnectionsFilter {
  credentialId?: string;
  /** An issuer key. */
  issuerKey?: string;
}

export interface Connections {
  /** Every credential, also those without rules (the matrix axes). */
  credentials: Service[];
  /** The credential access rules that match the filter, in evaluation order (created_at, id). */
  rules: RuleEdge[];
  /** Every global access rule, in every state, in evaluation order. */
  globals: GlobalAccessRule[];
  /** Allowed requests per credential access rule id in the last 30 days. */
  usage: Map<string, RuleUsage>;
  /** Claim labels of every access rule (the filter does not narrow them). */
  labels: ClaimLabel[];
  /** Ids of credentials whose stored secret the keyring cannot open (credential_unreadable). */
  unreadableTokenIds: Set<string>;
  /** False when TELEMETRY_DB could not be read: lastUsedHour is null and nothing is unused. */
  usageAvailable: boolean;
  sampleRate: number;
}

export async function loadConnections(
  deps: Pick<Deps, 'env' | 'now'>,
  filter: ConnectionsFilter = {},
): Promise<Connections> {
  const now = deps.now();
  const db = deps.env.DB;
  const [credentials, rules, globals, labels, settings, [cronRows, kcvRows], keyring] =
    await Promise.all([
      listServices(db),
      listCredentialAccessRules(db, {
        ...(filter.credentialId === undefined ? {} : { credential_id: filter.credentialId }),
        ...(filter.issuerKey === undefined ? {} : { issuer_key: filter.issuerKey }),
      }),
      listGlobalAccessRules(db),
      listClaimLabels(db),
      getSettings(db),
      db.batch([cronSettingsStatement(db), recordedKcvStatement(db)]),
      loadKeyring(deps.env),
    ]);
  const cron = cronHealthFrom(rowsOf<{ key: string; value: string }>(cronRows), now);
  const health = keyringHealthFrom(
    keyring,
    kidCounts(credentials),
    rowsOf<{ value: string }>(kcvRows)[0]?.value ?? null,
  );
  const unreadableTokenIds = new Set(
    credentials.filter((token) => credentialUnreadable(token, health)).map((token) => token.id),
  );
  const { usage, available } = await loadUsage(deps, now, cron.lastSuccessAt);

  const credentialById = new Map(credentials.map((credential) => [credential.id, credential]));
  const labelsByRule = labelsByRuleId(labels);
  const globalsByKey = new Map<string, GlobalAccessRule[]>();
  for (const global of globals) {
    const list = globalsByKey.get(global.issuer_key) ?? [];
    list.push(global);
    globalsByKey.set(global.issuer_key, list);
  }

  const edges = rules.map((rule): RuleEdge => {
    const credential = credentialById.get(rule.credential_id) ?? null;
    const lastUsedHour = usage.get(rule.id)?.last_hour ?? null;
    const global = globalStatus(rule, globalsByKey.get(rule.issuer_key) ?? [], now);
    const { status, detail } = accessStatus(rule, credential, unreadableTokenIds, now, global);
    const flags: AccessFlag[] = [];
    if (global.kind === 'limited') flags.push({ status: 'global_limited' });
    if (hasWarnings(rule, credential)) flags.push({ status: 'risk_accepted' });
    if (
      available &&
      settings.allowed_sample_rate > 0 &&
      (status === 'active' || status === 'expiring' || status === 'inactive') &&
      lastUsedHour === null &&
      rule.created_at <= now - UNUSED_AFTER_MS
    ) {
      flags.push(
        settings.allowed_sample_rate < 1
          ? { status: 'unused', detail: 'sampled' }
          : { status: 'unused' },
      );
    }
    return {
      rule,
      credential,
      globalStatus: global,
      status,
      ...(detail === undefined ? {} : { statusDetail: detail }),
      flags,
      ...accessSummary(rule, labelsByRule.get(rule.id) ?? []),
      lastUsedHour,
    };
  });

  return {
    credentials,
    rules: edges,
    globals,
    usage,
    labels,
    unreadableTokenIds,
    usageAvailable: available,
    sampleRate: settings.allowed_sample_rate,
  };
}

/** Claim labels grouped by their access rule. */
export function labelsByRuleId(labels: readonly ClaimLabel[]): Map<string, ClaimLabel[]> {
  const byRule = new Map<string, ClaimLabel[]>();
  for (const label of labels) {
    const list = byRule.get(label.access_rule_id) ?? [];
    list.push(label);
    byRule.set(label.access_rule_id, list);
  }
  return byRule;
}

/**
 * The A9 status of one credential access rule. Credential expiry is a flag, not a state (D24).
 * `global` blocks the rule when no global access rule of its issuer can ever hold for it.
 */
export function accessStatus(
  rule: Pick<CredentialAccessRule, 'enabled' | 'expires_at'>,
  credential: Pick<Service, 'id' | 'enabled' | 'credential_sealed'> | null,
  unreadableTokenIds: ReadonlySet<string>,
  now: number,
  global?: Pick<GlobalStatus, 'kind'>,
): { status: StatusKey; detail?: string } {
  if (!rule.enabled) return { status: 'disabled' };
  if (rule.expires_at !== null && rule.expires_at <= now) return { status: 'expired' };
  const inactive = inactiveReason(credential, unreadableTokenIds);
  if (inactive !== null) return { status: 'inactive', detail: inactive };
  if (global?.kind === 'blocked') return { status: 'global_blocked' };
  if (rule.expires_at !== null && rule.expires_at - now <= EXPIRY_WARNING_MS) {
    return { status: 'expiring', detail: String(Math.ceil((rule.expires_at - now) / DAY_MS)) };
  }
  return { status: 'active' };
}

function inactiveReason(
  credential: Pick<Service, 'id' | 'enabled' | 'credential_sealed'> | null,
  unreadableTokenIds: ReadonlySet<string>,
): InactiveReason | null {
  if (credential === null || !credential.enabled) return 'credential disabled';
  if (credential.credential_sealed === null) return 'credential has no secret';
  if (unreadableTokenIds.has(credential.id)) return 'credential unreadable';
  return null;
}

/**
 * True when the keyring cannot open the token's stored credential: no keyring, a malformed sealed
 * value, a key id absent from the keyring, or a key replaced behind its id (KCV). An AAD mismatch
 * is only found when the credential is opened, so it is not detected here.
 */
export function credentialUnreadable(
  token: Pick<Service, 'credential_sealed'>,
  health: KeyringHealth,
): boolean {
  if (token.credential_sealed === null) return false;
  const kid = sealedKid(token.credential_sealed);
  if (kid === null || health.error !== null) return true;
  return health.missingKids.includes(kid) || health.changedKids.includes(kid);
}

/** Stored conditions that save with risk warnings were saved with those risks acknowledged. */
function hasWarnings(rule: CredentialAccessRule, credential: Service | null): boolean {
  const profile = getProfile(rule.profile);
  if (!profile || credential === null) return false;
  const result = validateCredentialAccessRule(rule, profile, rule, {
    injection: credential.injection,
    rules: [],
  });
  return result.warningDetails.some((detail) => detail.code !== 'no_tenant_pin');
}

async function loadUsage(
  deps: Pick<Deps, 'env'>,
  now: number,
  cronLastSuccessAt: number | null,
): Promise<{ usage: Map<string, RuleUsage>; available: boolean }> {
  const telemetry = deps.env.TELEMETRY_DB;
  // Same split as the dashboard: until the cron has rolled up the previous hour, it is live too.
  const currentHour = hourStart(now);
  const liveFrom =
    cronLastSuccessAt !== null && cronLastSuccessAt >= currentHour
      ? currentHour
      : currentHour - HOUR_MS;
  try {
    const [stored, live] = await telemetry.batch([
      ruleUsageStatement(telemetry, hourStart(now - UNUSED_AFTER_MS), liveFrom),
      aggregateRequestLogStatement(telemetry, liveFrom, currentHour + HOUR_MS),
    ]);
    return {
      usage: mergeRuleUsage(
        rowsOf<Record<string, unknown>>(stored),
        rowsOf<Record<string, unknown>>(live).map(rollupFromRow),
      ),
      available: true,
    };
  } catch {
    return { usage: new Map(), available: false };
  }
}

function kidCounts(tokens: readonly Service[]): Array<{ kid: string | null; n: number }> {
  const counts = new Map<string | null, number>();
  for (const token of tokens) {
    if (token.credential_sealed === null) continue;
    const kid = sealedKid(token.credential_sealed);
    counts.set(kid, (counts.get(kid) ?? 0) + 1);
  }
  return [...counts].map(([kid, n]) => ({ kid, n }));
}

function rowsOf<T>(result: D1Result | undefined): T[] {
  return (result?.results ?? []) as T[];
}
