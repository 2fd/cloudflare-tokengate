import { sealedKid } from '../crypto/envelope';
// Who can use which credential: every issuer access rules (grant) with its consumer, its token, a
// status from the A9 vocabulary, a summary and its last use. One loader for the Overview, the token
// and consumer lists and pages, the access matrix and the access form, so a status reads the same
// everywhere. Read-only. Monitoring data (last use) is for display only and never an autocomplete
// source; when TELEMETRY_DB cannot be read, the usage is empty and no access is called unused.
import { loadKeyring } from '../crypto/keyring';
import { listClaimLabels } from '../db/claim-labels';
import { listCredentialAccessRules } from '../db/credential-access-rules';
import { listServices } from '../db/credentials';
import { listIssuerAccessRules } from '../db/issuer_access_rules';
import {
  aggregateRequestLogStatement,
  type IssuerAccessRuleUsage,
  grantUsageStatement,
  HOUR_MS,
  mergeIssuerAccessRuleUsage,
  rollupFromRow,
} from '../db/rollups';
import { getSettings } from '../db/settings';
import type { CredentialAccessRule, ClaimLabel, IssuerAccessRule, Service } from '../db/types';
import type { Deps } from '../deps';
import {
  cronHealthFrom,
  cronSettingsStatement,
  type KeyringHealth,
  keyringHealthFrom,
  recordedKcvStatement,
} from '../health';
import { getProfile } from '../identity/profiles';
import { conditionsWithin } from '../policy/boundaries';
import { validateIssuerAccessRule } from '../policy/validate';
import { EXPIRY_WARNING_MS } from '../telemetry/dashboard';
import { hourStart } from '../telemetry/rollup';
import { accessSummary } from './access-summary';
import type { InactiveReason, StatusKey } from './views/status';

const DAY_MS = 86_400_000;
/** "Unused 30+ days": no allowed request in this window, for an access older than it. */
export const UNUSED_AFTER_MS = 30 * DAY_MS;

/** A warning shown next to the status, never instead of it. */
export interface AccessFlag {
  status: Extract<StatusKey, 'credential_expired_warning' | 'risk_accepted' | 'unused'>;
  detail?: string;
}

export interface AccessEdge {
  grant: IssuerAccessRule;
  /** Null only if the row was deleted between reads. */
  consumer: CredentialAccessRule | null;
  token: Service | null;
  /** disabled, expired, inactive, expiring or active, in that precedence. */
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
  consumerId?: string;
  tokenId?: string;
}

export interface Connections {
  /** Every credential access rule and credential, also those without accesses (the matrix axes). */
  consumers: CredentialAccessRule[];
  tokens: Service[];
  /** The accesses that match the filter, in evaluation order (created_at, id). */
  accesses: AccessEdge[];
  /** Allowed requests per grant id in the last 30 days. */
  usage: Map<string, IssuerAccessRuleUsage>;
  /** Claim labels of the filtered consumer, or of every credential access rule. */
  labels: ClaimLabel[];
  /** Ids of tokens whose stored credential the keyring cannot open (credential_unreadable). */
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
  const [consumers, tokens, issuer_access_rules, labels, settings, [cronRows, kcvRows], keyring] =
    await Promise.all([
      listCredentialAccessRules(db),
      listServices(db),
      listIssuerAccessRules(db, {
        ...(filter.consumerId === undefined
          ? {}
          : { credential_access_rule_id: filter.consumerId }),
        ...(filter.tokenId === undefined ? {} : { service_id: filter.tokenId }),
      }),
      listClaimLabels(db, filter.consumerId),
      getSettings(db),
      db.batch([cronSettingsStatement(db), recordedKcvStatement(db)]),
      loadKeyring(deps.env),
    ]);
  const cron = cronHealthFrom(rowsOf<{ key: string; value: string }>(cronRows), now);
  const health = keyringHealthFrom(
    keyring,
    kidCounts(tokens),
    rowsOf<{ value: string }>(kcvRows)[0]?.value ?? null,
  );
  const unreadableTokenIds = new Set(
    tokens.filter((token) => credentialUnreadable(token, health)).map((token) => token.id),
  );
  const { usage, available } = await loadUsage(deps, now, cron.lastSuccessAt);

  const consumerById = new Map(consumers.map((consumer) => [consumer.id, consumer]));
  const tokenById = new Map(tokens.map((token) => [token.id, token]));
  const labelsByConsumer = new Map<string, ClaimLabel[]>();
  for (const label of labels) {
    const list = labelsByConsumer.get(label.credential_access_rule_id) ?? [];
    list.push(label);
    labelsByConsumer.set(label.credential_access_rule_id, list);
  }

  const accesses = issuer_access_rules.map((grant): AccessEdge => {
    const consumer = consumerById.get(grant.credential_access_rule_id) ?? null;
    const token = tokenById.get(grant.service_id) ?? null;
    const lastUsedHour = usage.get(grant.id)?.last_hour ?? null;
    const { status, detail } = accessStatus(grant, consumer, token, unreadableTokenIds, now);
    const flags: AccessFlag[] = [];
    if (
      token?.credential_sealed != null &&
      token.credential_expires_at !== null &&
      token.credential_expires_at <= now
    ) {
      flags.push({ status: 'credential_expired_warning' });
    }
    if (consumer && hasWarnings(grant, consumer, token)) flags.push({ status: 'risk_accepted' });
    if (
      available &&
      settings.allowed_sample_rate > 0 &&
      (status === 'active' || status === 'expiring' || status === 'inactive') &&
      lastUsedHour === null &&
      grant.created_at <= now - UNUSED_AFTER_MS
    ) {
      flags.push(
        settings.allowed_sample_rate < 1
          ? { status: 'unused', detail: 'sampled' }
          : { status: 'unused' },
      );
    }
    return {
      grant,
      consumer,
      token,
      status,
      ...(detail === undefined ? {} : { statusDetail: detail }),
      flags,
      ...accessSummary(grant, labelsByConsumer.get(grant.credential_access_rule_id) ?? []),
      lastUsedHour,
    };
  });

  return {
    consumers,
    tokens,
    accesses,
    usage,
    labels,
    unreadableTokenIds,
    usageAvailable: available,
    sampleRate: settings.allowed_sample_rate,
  };
}

/** The A9 status of one access. Credential expiry is a flag, not a state (D24). */
export function accessStatus(
  grant: Pick<IssuerAccessRule, 'enabled' | 'expires_at'> &
    Partial<Pick<IssuerAccessRule, 'conditions'>>,
  consumer:
    | (Pick<CredentialAccessRule, 'enabled'> &
        Partial<Pick<CredentialAccessRule, 'conditions' | 'credential_id'>>)
    | null,
  token: Pick<Service, 'id' | 'enabled' | 'credential_sealed'> | null,
  unreadableTokenIds: ReadonlySet<string>,
  now: number,
): { status: StatusKey; detail?: string } {
  if (!grant.enabled) return { status: 'disabled' };
  if (grant.expires_at !== null && grant.expires_at <= now) return { status: 'expired' };
  const inactive = inactiveReason(consumer, token, unreadableTokenIds);
  if (inactive !== null) return { status: 'inactive', detail: inactive };
  if (
    consumer &&
    token &&
    ((consumer.credential_id !== undefined && consumer.credential_id !== token.id) ||
      (grant.conditions &&
        consumer.conditions &&
        !conditionsWithin(grant.conditions, consumer.conditions)))
  ) {
    return { status: 'inactive', detail: 'outside credential access limits' };
  }
  if (grant.expires_at !== null && grant.expires_at - now <= EXPIRY_WARNING_MS) {
    return { status: 'expiring', detail: String(Math.ceil((grant.expires_at - now) / DAY_MS)) };
  }
  return { status: 'active' };
}

function inactiveReason(
  consumer: Pick<CredentialAccessRule, 'enabled'> | null,
  token: Pick<Service, 'id' | 'enabled' | 'credential_sealed'> | null,
  unreadableTokenIds: ReadonlySet<string>,
): InactiveReason | null {
  if (token === null || !token.enabled) return 'credential disabled';
  if (consumer === null || !consumer.enabled) return 'credential access rule disabled';
  if (token.credential_sealed === null) return 'token has no credential';
  if (unreadableTokenIds.has(token.id)) return 'credential unreadable';
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

/** Stored conditions that save with warnings were saved with those risks acknowledged. */
function hasWarnings(
  grant: IssuerAccessRule,
  consumer: CredentialAccessRule,
  token: Service | null,
): boolean {
  const profile = getProfile(consumer.profile);
  if (!profile) return false;
  const result = validateIssuerAccessRule(
    { conditions: grant.conditions, rules: grant.rules },
    profile,
    consumer,
    token,
  );
  return result.warnings.length > 0;
}

async function loadUsage(
  deps: Pick<Deps, 'env'>,
  now: number,
  cronLastSuccessAt: number | null,
): Promise<{ usage: Map<string, IssuerAccessRuleUsage>; available: boolean }> {
  const telemetry = deps.env.TELEMETRY_DB;
  // Same split as the dashboard: until the cron has rolled up the previous hour, it is live too.
  const currentHour = hourStart(now);
  const liveFrom =
    cronLastSuccessAt !== null && cronLastSuccessAt >= currentHour
      ? currentHour
      : currentHour - HOUR_MS;
  try {
    const [stored, live] = await telemetry.batch([
      grantUsageStatement(telemetry, hourStart(now - UNUSED_AFTER_MS), liveFrom),
      aggregateRequestLogStatement(telemetry, liveFrom, currentHour + HOUR_MS),
    ]);
    return {
      usage: mergeIssuerAccessRuleUsage(
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
