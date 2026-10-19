// Data for Monitoring › Overview: traffic for a range (hourly rollups plus a live aggregate of each
// hour not rolled up yet), top denials, recent changes, and the alert catalogue (overviewAlerts).
// Object pages get their own alerts from loadAlertData + alertsFor without loading traffic.
// Read-only. Counts are weighted estimates when sampling is enabled. Only non-secret values reach
// an alert: names, slugs, key ids, counts and variable names (I-CRED-1, I-CFG-1).
import { paths } from '../admin/paths';
import type { Alert, PendingUser } from '../admin/views/alerts';
import { formatDate, formatTime, relativeTime } from '../admin/views/format';
import { parseConfig, upstreamHostAllowed } from '../config';
import { loadKeyring } from '../crypto/keyring';
import { listAuditEvents } from '../db/audit';
import { type SchemaState, schemaStatusByDatabase } from '../db/migrations';
import {
  aggregateRequestLogStatement,
  type DenialGroup,
  DENIAL_SCAN_ROWS,
  denialGroupFromRow,
  denialGroupsStatement,
  edgeTotalsStatement,
  HOUR_MS,
  LATENCY_BUCKETS,
  type RollupRow,
  rollupFromRow,
  seriesFromRow,
  seriesStatement,
  type UpstreamAuthFailureRow,
  upstreamAuthFailuresStatement,
} from '../db/rollups';
import {
  settingsFromRows,
  settingsStatement,
  upstreamHostsFromValue,
  upstreamHostsStatement,
} from '../db/settings';
import type { AuditEvent } from '../db/types';
import { countNeedsDecision, listPendingUsers } from '../db/users';
import type { Deps } from '../deps';
import { SCHEMA_HEAD, type SchemaDatabase } from '../generated/schema-head';
import {
  type ConfigProblem,
  configErrorsForStatus,
  type CronHealth,
  cronHealthFrom,
  cronSettingsStatement,
  type KeyringHealth,
  keyringHealthFrom,
  recordedKcvStatement,
  sealedKidByServiceStatement,
} from '../health';
import {
  alignedStart,
  bucketStarts,
  type OverviewRange,
  RANGE_BUCKET_MS,
  rangeStart,
} from './ranges';
import { hourStart } from './rollup';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
// Upstream-auth alert: within the window, at least MIN_COUNT 401/403s that are also at least
// MIN_RATIO of the forwarded requests.
export const AUTH_FAILURE_WINDOW_MS = 15 * MINUTE_MS;
export const AUTH_FAILURE_MIN_COUNT = 5;
export const AUTH_FAILURE_MIN_RATIO = 0.5;
export const EXPIRY_WARNING_MS = 14 * DAY_MS;
/** Pending users the Overview can approve in place (the users_need_decision form). */
export const ALERT_PENDING_USERS = 3;
/** Tokens an alert names before "+N more". */
const ALERT_OBJECTS_SHOWN = 5;
/** Events in "Recent changes". */
export const RECENT_CHANGES_LIMIT = 5;

export interface Percentile {
  ms: number;
  /** The percentile lies in the open-ended bucket; `ms` is its lower bound. */
  overflow: boolean;
}

export interface TrafficStats {
  requests: number;
  allowed: number;
  denied: number;
  /** Gateway errors plus allowed requests the upstream answered with 5xx. */
  errors: number;
  /** errors / requests; 0 when there were no requests. */
  errorRate: number;
  upstreamAuthFailures: number;
  /** Latency percentiles of allowed requests (time to response headers). */
  p50: Percentile | null;
  p95: Percentile | null;
}

/** Sums rollup rows; percentiles come from the merged latency buckets of allowed requests. */
export function trafficStats(rows: readonly RollupRow[]): TrafficStats {
  let requests = 0;
  let allowed = 0;
  let denied = 0;
  let errors = 0;
  let upstreamAuthFailures = 0;
  const latency = LATENCY_BUCKETS.map(() => 0);
  for (const row of rows) {
    requests += row.requests;
    upstreamAuthFailures += row.upstream_auth_fail;
    if (row.outcome === 'denied') denied += row.requests;
    if (isErrorRow(row.outcome, row.status_class)) errors += row.requests;
    if (row.outcome === 'allowed') {
      allowed += row.requests;
      row.buckets.forEach((count, i) => {
        latency[i] = (latency[i] ?? 0) + count;
      });
    }
  }
  return {
    requests,
    allowed,
    denied,
    errors,
    errorRate: requests > 0 ? errors / requests : 0,
    upstreamAuthFailures,
    p50: percentile(latency, 0.5),
    p95: percentile(latency, 0.95),
  };
}

/** The "Errors" definition shared by the KPIs and the Requests `outcome=error` filter. */
function isErrorRow(outcome: string, statusClass: number): boolean {
  return outcome === 'error' || (outcome === 'allowed' && statusClass === 5);
}

/**
 * Quantile `q` (0..1) of a LATENCY_BUCKETS histogram, interpolated linearly inside the bucket
 * that holds the target rank. Null for an empty histogram.
 */
export function percentile(buckets: readonly number[], q: number): Percentile | null {
  const total = buckets.reduce((sum, count) => sum + count, 0);
  if (!(total > 0)) return null;
  const rank = Math.min(Math.max(q, 0), 1) * total;
  let below = 0;
  let last: Percentile | null = null;
  for (const [i, bucket] of LATENCY_BUCKETS.entries()) {
    const count = buckets[i] ?? 0;
    if (count <= 0) continue;
    const lower = LATENCY_BUCKETS[i - 1]?.upper ?? 0;
    if (bucket.upper === null) return { ms: lower, overflow: true };
    last = { ms: bucket.upper, overflow: false };
    if (below + count >= rank) {
      return { ms: lower + ((rank - below) / count) * (bucket.upper - lower), overflow: false };
    }
    below += count;
  }
  return last;
}

// ---------------------------------------------------------------------------------------------
// Alert data (cheap: no traffic series), shared by the Overview and the object pages

export interface AlertService {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  base_url: string;
  credential_expires_at: number | null;
  has_credential: boolean;
}

/** A credential access rule, for the expiry and missing-secret alerts. */
export interface AlertAccessRule {
  id: string;
  name: string;
  credential_id: string;
  enabled: boolean;
  expires_at: number | null;
}

export interface AlertData {
  now: number;
  credentials: AlertService[];
  access_rules: AlertAccessRule[];
  /** Sealed kid per token with a credential; null for a value that is not sealed JSON. */
  sealedKids: Array<{ id: string; slug: string; name: string; kid: string | null }>;
  keyring: KeyringHealth;
  /** Number of keys the keyring holds (0 when it did not load). */
  keyCount: number;
  schema: Record<SchemaDatabase, SchemaState>;
  cron: CronHealth;
  config: ConfigProblem[];
  activeOwners: number;
  /** People an owner should decide on (countNeedsDecision). */
  needsDecision: number;
  /** The first ALERT_PENDING_USERS pending users, oldest first. */
  pendingUsers: PendingUser[];
  upstreamAuthFailures: UpstreamAuthFailureRow[];
  /** The upstream host allowlist; null = any public https host. */
  allowedHosts: string[] | null;
  sampleRate: number;
}

export async function loadAlertData(deps: Pick<Deps, 'env' | 'now'>): Promise<AlertData> {
  const now = deps.now();
  const db = deps.env.DB;
  const telemetry = deps.env.TELEMETRY_DB;
  const [
    [cronRows, kidRows, kcvRows, serviceRows, ruleRows, ownerRows, hostRows, settingRows],
    loaded,
    schema,
    needsDecision,
    pending,
    authRows,
  ] = await Promise.all([
    db.batch([
      cronSettingsStatement(db),
      sealedKidByServiceStatement(db),
      recordedKcvStatement(db),
      db.prepare(
        `SELECT id, slug, name, enabled, base_url, credential_expires_at,
           credential_sealed IS NOT NULL AS has_credential
         FROM credentials ORDER BY name, id`,
      ),
      db.prepare(
        'SELECT id, name, credential_id, enabled, expires_at FROM access_rules WHERE credential_id IS NOT NULL ORDER BY name, id',
      ),
      db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND status = 'active'`),
      upstreamHostsStatement(db),
      settingsStatement(db),
    ]),
    loadKeyring(deps.env),
    schemaStatusByDatabase(deps),
    countNeedsDecision(db, now),
    listPendingUsers(db, ALERT_PENDING_USERS),
    upstreamAuthFailuresStatement(
      telemetry,
      now - AUTH_FAILURE_WINDOW_MS,
      AUTH_FAILURE_MIN_COUNT,
      AUTH_FAILURE_MIN_RATIO,
    )
      .all<UpstreamAuthFailureRow>()
      .then((result) => result.results)
      .catch(() => [] as UpstreamAuthFailureRow[]),
  ]);
  const sealedKids = rowsOf<{ id: string; slug: string; name: string; kid: string | null }>(
    kidRows,
  );
  const kidCounts = new Map<string | null, number>();
  for (const row of sealedKids) kidCounts.set(row.kid, (kidCounts.get(row.kid) ?? 0) + 1);
  return {
    now,
    credentials: rowsOf<Record<string, unknown>>(serviceRows).map((row) => ({
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
      enabled: Number(row.enabled) === 1,
      base_url: String(row.base_url),
      credential_expires_at:
        row.credential_expires_at == null ? null : Number(row.credential_expires_at),
      has_credential: Number(row.has_credential) === 1,
    })),
    access_rules: rowsOf<Record<string, unknown>>(ruleRows).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      credential_id: String(row.credential_id),
      enabled: Number(row.enabled) === 1,
      expires_at: row.expires_at == null ? null : Number(row.expires_at),
    })),
    sealedKids,
    keyring: keyringHealthFrom(
      loaded,
      [...kidCounts].map(([kid, n]) => ({ kid, n })),
      rowsOf<{ value: string }>(kcvRows)[0]?.value ?? null,
    ),
    keyCount: loaded.ok ? loaded.keyring.kids.length : 0,
    schema,
    cron: cronHealthFrom(rowsOf<{ key: string; value: string }>(cronRows), now),
    config: configErrorsForStatus(parseConfig(deps.env)),
    activeOwners: Number(rowsOf<{ n: number }>(ownerRows)[0]?.n ?? 0),
    needsDecision,
    pendingUsers: pending.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      updated_at: user.updated_at,
    })),
    upstreamAuthFailures: authRows,
    allowedHosts: upstreamHostsFromValue(rowsOf<{ value: string }>(hostRows)[0]?.value),
    sampleRate: settingsFromRows(rowsOf<{ key: string; value: string }>(settingRows))
      .allowed_sample_rate,
  };
}

/** True when the token's base URL host is refused by the upstream host allowlist. */
export function outsideAllowedHosts(baseUrl: string, allowed: string[] | null): boolean {
  if (allowed === null) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return true;
  }
  return !upstreamHostAllowed(host, allowed);
}

const LEVEL_ORDER = { error: 0, warning: 1, info: 2 } as const;

/**
 * The row of one check in the Overview's "All checks" table (`id="check-<name>"`). Same-section
 * link: paths.overview only types the section fragments, so the check fragment is appended here.
 */
export function checkHref(check: 'schema' | 'telemetry-schema' | 'maintenance'): string {
  return `${paths.overview()}#check-${check}`;
}

interface Ranked {
  alert: Alert;
  /** Name of the first object the alert concerns, for the order within a level. */
  name: string;
}

/**
 * The alert catalogue (A11.1): every problem the deployment has, one item per code, errors
 * first, then warnings, then notes; within a level by object name. Every item links to the
 * objects it concerns; the fix link is shown only to holders of its permission (AlertList).
 */
export function overviewAlerts(data: AlertData): Alert[] {
  const ranked: Ranked[] = [];
  const add = (name: string, alert: Alert) => ranked.push({ alert, name });
  const { keyring, now } = data;
  const tokenLink = (s: { id: string; name: string }) => ({
    href: paths.token(s.id),
    label: s.name,
  });
  const tokenLinks = (list: Array<{ id: string; name: string }>, more: () => string) => {
    const shown = list.slice(0, ALERT_OBJECTS_SHOWN).map(tokenLink);
    const rest = list.length - shown.length;
    return rest > 0 ? [...shown, { href: more(), label: `+${rest} more` }] : shown;
  };
  const names = (list: Array<{ name: string }>) => list.map((s) => s.name).join(', ');

  if (keyring.error) {
    add('', {
      code: 'keyring_unavailable',
      level: 'error',
      title: `Encryption keys are not loaded (${keyring.error}): credential requests fail with 503 and secrets cannot change.`,
      detail: 'Set TOKENGATE_KEK or TOKENGATE_KEYRING.',
      objects: [
        { href: paths.tokenKeys(), label: 'Encryption keys' },
        { href: paths.docs('operations/key-rotation.md'), label: 'Key rotation guide' },
      ],
    });
  }
  if (keyring.missingKids.length > 0) {
    const affected = data.sealedKids.filter(
      (s) => s.kid !== null && keyring.missingKids.includes(s.kid),
    );
    const kids = keyring.missingKids.join(', ');
    add(affected[0]?.name ?? '', {
      code: 'key_missing',
      level: 'error',
      title: `${count(affected.length, 'credential uses', 'credentials use')} ${keyring.missingKids.length === 1 ? 'key' : 'keys'} ${kids}, which the keyring no longer has: ${names(affected)}.`,
      detail: 'Restore the key in the keyring.',
      objects: [
        ...tokenLinks(affected, () => paths.tokens({ status: 'credential_unreadable' })),
        { href: paths.tokenKeys(), label: 'Encryption keys' },
      ],
    });
  }
  if (keyring.changedKids.length > 0) {
    const kids = keyring.changedKids.join(', ');
    add('', {
      code: 'key_changed',
      level: 'error',
      title: `${keyring.changedKids.length === 1 ? 'Key' : 'Keys'} ${kids} now ${keyring.changedKids.length === 1 ? 'holds' : 'hold'} a different key than the one stored secrets were sealed with.`,
      detail:
        'Restore the previous key value, or set those secrets again and then accept the new key.',
      objects: [{ href: paths.tokenKeys(), label: 'Encryption keys' }],
      fix: {
        href: paths.tokenKeys('rewrap'),
        label: 'Accept the new key',
        permission: 'keyring:rewrap',
      },
    });
  }
  const malformed = data.sealedKids.filter((s) => s.kid === null);
  const [firstMalformed] = malformed;
  if (firstMalformed) {
    add(firstMalformed.name, {
      code: 'credential_malformed',
      level: 'error',
      title: `${count(malformed.length, 'stored secret is', 'stored secrets are')} damaged: ${names(malformed)}.`,
      detail: 'Check the base URL against an out-of-band source before you enter it again.',
      objects: tokenLinks(malformed, () => paths.tokens({ status: 'credential_unreadable' })),
      fix: {
        href: paths.token(firstMalformed.id, { open: 'destination', hash: 'destination' }),
        label: `Set the secret of ${firstMalformed.name} again`,
        short: { label: 'Set secret again', srSuffix: `for ${firstMalformed.name}` },
        permission: 'tokens:write',
      },
    });
  }
  if (keyring.notActiveCount > 0 && !keyring.error) {
    add('', {
      code: 'key_not_active',
      level: 'info',
      title: `${count(keyring.notActiveCount, 'secret uses', 'secrets use')} an older key.`,
      detail: keyring.activeKid ? `The active key is ${keyring.activeKid}.` : '',
      objects: [{ href: paths.tokenKeys(), label: 'Encryption keys' }],
      form: { kind: 'rewrap', count: keyring.notActiveCount },
    });
  }

  const withCredential = data.credentials.filter(
    (s) => s.has_credential && s.credential_expires_at !== null,
  );
  const expired = withCredential.filter((s) => (s.credential_expires_at as number) <= now);
  const expiring = withCredential.filter(
    (s) =>
      (s.credential_expires_at as number) > now &&
      (s.credential_expires_at as number) <= now + EXPIRY_WARNING_MS,
  );
  const byExpiry = (a: AlertService, b: AlertService) =>
    (a.credential_expires_at as number) - (b.credential_expires_at as number);
  const [firstExpired] = expired.sort(byExpiry);
  if (firstExpired) {
    add(firstExpired.name, {
      code: 'credential_expired',
      level: 'error',
      title:
        expired.length === 1
          ? `The secret of ${firstExpired.name} expired on ${formatDate(firstExpired.credential_expires_at as number)}.`
          : `The secrets of ${expired.length} credentials expired: ${expired.map((s) => `${s.name} (${formatDate(s.credential_expires_at as number)})`).join(', ')}.`,
      detail: '',
      objects: tokenLinks(expired, () => paths.tokens({ status: 'expiring' })),
      fix: {
        href: paths.token(firstExpired.id, { hash: 'secret' }),
        label: `Replace the secret of ${firstExpired.name}`,
        short: { label: 'Replace secret', srSuffix: `of ${firstExpired.name}` },
        permission: 'tokens:write',
      },
    });
  }
  const [firstExpiring] = expiring.sort(byExpiry);
  if (firstExpiring) {
    const days = (s: AlertService) =>
      Math.ceil(((s.credential_expires_at as number) - now) / DAY_MS);
    add(firstExpiring.name, {
      code: 'credential_expiring',
      level: 'warning',
      title:
        expiring.length === 1
          ? `The secret of ${firstExpiring.name} expires on ${formatDate(firstExpiring.credential_expires_at as number)} (in ${count(days(firstExpiring), 'day', 'days')}).`
          : `The secrets of ${expiring.length} credentials expire soon: ${expiring.map((s) => `${s.name} (${formatDate(s.credential_expires_at as number)})`).join(', ')}.`,
      detail: '',
      objects: tokenLinks(expiring, () => paths.tokens({ status: 'expiring' })),
      fix: {
        href: paths.token(firstExpiring.id, { hash: 'secret' }),
        label: `Replace the secret of ${firstExpiring.name}`,
        short: { label: 'Replace secret', srSuffix: `of ${firstExpiring.name}` },
        permission: 'tokens:write',
      },
    });
  }
  const accessCount = new Map<string, number>();
  for (const rule of data.access_rules) {
    if (rule.enabled)
      accessCount.set(rule.credential_id, (accessCount.get(rule.credential_id) ?? 0) + 1);
  }
  const missing = data.credentials.filter(
    (s) => !s.has_credential && (accessCount.get(s.id) ?? 0) > 0,
  );
  const [firstMissing] = missing;
  if (firstMissing) {
    const accesses = (s: AlertService) =>
      count(accessCount.get(s.id) ?? 0, 'access rule', 'access rules');
    add(firstMissing.name, {
      code: 'credential_missing_used',
      level: 'warning',
      title:
        missing.length === 1
          ? `Token ${firstMissing.name} has no secret, so its ${accesses(firstMissing)} cannot work.`
          : `${missing.length} credentials have no secret, so their access rules cannot work: ${missing.map((s) => `${s.name} (${accesses(s)})`).join(', ')}.`,
      detail: '',
      objects: tokenLinks(missing, () => paths.tokens({ status: 'no_credential' })),
      fix: {
        href: paths.token(firstMissing.id, { open: 'destination', hash: 'destination' }),
        label: `Add the secret of ${firstMissing.name}`,
        short: { label: 'Add secret', srSuffix: `of ${firstMissing.name}` },
        permission: 'tokens:write',
      },
    });
  }
  const serviceById = new Map(data.credentials.map((s) => [s.id, s]));
  const rejected = data.upstreamAuthFailures.filter((row) => row.service_id !== '');
  const [firstRejected] = rejected;
  if (firstRejected) {
    const label = (row: UpstreamAuthFailureRow) =>
      serviceById.get(row.service_id)?.name ?? row.service_slug ?? row.service_id;
    const text = (row: UpstreamAuthFailureRow) =>
      `${Math.round(row.auth_failures)} of ${Math.round(row.forwarded)} requests`;
    add(label(firstRejected), {
      code: 'upstream_auth',
      level: 'warning',
      title:
        rejected.length === 1
          ? `The upstream rejected credential ${label(firstRejected)}: ${text(firstRejected)} got 401/403 in 15 min.`
          : `The upstream rejected ${rejected.length} credentials in the last 15 min: ${rejected.map((row) => `${label(row)} (${text(row)})`).join(', ')}.`,
      detail: 'The secret may be revoked or expired.',
      objects: rejected.flatMap((row) => [
        { href: paths.token(row.service_id), label: label(row) },
        {
          href: paths.requests({ token: row.service_id, outcome: 'allowed', range: '1h' }),
          label: `Requests to ${label(row)}`,
        },
      ]),
      fix: {
        href: paths.token(firstRejected.service_id, { hash: 'secret' }),
        label: `Replace the secret of ${label(firstRejected)}`,
        short: { label: 'Replace secret', srSuffix: `of ${label(firstRejected)}` },
        permission: 'tokens:write',
      },
    });
  }
  const outside = data.credentials.filter((s) =>
    outsideAllowedHosts(s.base_url, data.allowedHosts),
  );
  const [firstOutside] = outside;
  if (firstOutside) {
    add(firstOutside.name, {
      code: 'outside_hosts',
      level: 'warning',
      title: `${count(outside.length, 'credential points', 'credentials point')} at hosts that Allowed hosts refuses: ${names(outside)}.`,
      detail: '',
      objects: [
        ...tokenLinks(outside, () => paths.tokens({ status: 'outside_hosts' })),
        {
          href: paths.tokens({ status: 'outside_hosts' }),
          label: 'Tokens outside the allowed hosts',
        },
      ],
      fix: {
        href: paths.tokenHosts(),
        label: 'Change the allowed hosts',
        permission: 'settings:write',
      },
    });
  }

  for (const database of ['DB', 'TELEMETRY_DB'] as const) {
    const state = data.schema[database];
    const check = {
      href: checkHref(database === 'DB' ? 'schema' : 'telemetry-schema'),
      label: `${database} schema check`,
    };
    const docs = { href: paths.docs('operations/upgrades.md'), label: 'Upgrade guide' };
    if (state === 'behind') {
      add(database, {
        code: 'schema_behind',
        level: 'error',
        title: `Database ${database} is missing migration ${SCHEMA_HEAD[database]}.`,
        detail: `Run: wrangler d1 migrations apply ${database} --remote`,
        objects: [check, docs],
      });
    } else if (state === 'ahead') {
      add(database, {
        code: 'schema_ahead',
        level: 'warning',
        title: `Database ${database} has migrations newer than this deployment (rolled back?).`,
        detail: '',
        objects: [check, docs],
      });
    } else if (state === 'unknown') {
      add(database, {
        code: 'schema_unknown',
        level: 'warning',
        title: `Could not read the applied migrations of ${database}.`,
        detail: '',
        objects: [check, docs],
      });
    }
  }
  const [firstProblem] = data.config;
  if (firstProblem) {
    add(firstProblem.variable, {
      code: 'config_problem',
      level: 'error',
      title: data.config.map((problem) => `${problem.variable}: ${problem.message}`).join(' '),
      detail: '',
      objects: data.config.map((problem) => ({
        href: paths.docs(`configuration.md#${problem.anchor}`),
        label: `${problem.variable} reference`,
      })),
    });
  }
  const { cron } = data;
  const cronObjects = [
    { href: checkHref('maintenance'), label: 'Hourly job check' },
    { href: paths.docs('observability.md#rollups'), label: 'Rollups and retention' },
  ];
  if (cron.failing) {
    add('', {
      code: 'cron_failing',
      level: 'error',
      title: `The hourly job failed at ${cron.lastErrorAt === null ? 'an unknown time' : formatTime(cron.lastErrorAt)}: ${cron.lastError ?? 'unknown error'}.`,
      detail: '',
      objects: cronObjects,
    });
  } else if (cron.lastSuccessAt === null) {
    add('', {
      code: 'cron_never',
      level: 'info',
      title: 'The hourly job has not run yet; it starts within the hour.',
      detail: '',
      objects: cronObjects,
    });
  } else if (cron.stale) {
    add('', {
      code: 'cron_stale',
      level: 'warning',
      title: `The hourly job last succeeded ${relativeTime(cron.lastSuccessAt, now)}; rollups and retention are paused.`,
      detail: '',
      objects: cronObjects,
    });
  }

  const expiringAccess = data.access_rules
    .filter(
      (g) =>
        g.enabled &&
        g.expires_at !== null &&
        g.expires_at > now &&
        g.expires_at <= now + EXPIRY_WARNING_MS,
    )
    .sort((a, b) => (a.expires_at as number) - (b.expires_at as number));
  const [firstAccess] = expiringAccess;
  if (firstAccess) {
    add(firstAccess.name, {
      code: 'access_expiring',
      level: 'warning',
      title:
        expiringAccess.length === 1
          ? `Credential access rule "${firstAccess.name}" expires on ${formatDate(firstAccess.expires_at as number)}.`
          : `${expiringAccess.length} credential access rules expire soon: ${expiringAccess.map((g) => `"${g.name}" (${formatDate(g.expires_at as number)})`).join(', ')}.`,
      detail: '',
      objects: expiringAccess
        .slice(0, ALERT_OBJECTS_SHOWN)
        .map((g) => ({ href: paths.accessRule(g.id), label: g.name })),
      fix: {
        href: paths.accessRule(firstAccess.id, { open: 'edit' }),
        label: `Extend "${firstAccess.name}"`,
        short: { label: 'Extend', srSuffix: `"${firstAccess.name}"` },
        permission: 'access:write',
      },
    });
  }
  if (data.needsDecision > 0) {
    add('', {
      code: 'users_need_decision',
      level: 'warning',
      title: `${count(data.needsDecision, 'person needs', 'people need')} a decision.`,
      detail: '',
      objects: [{ href: paths.users({ hash: 'decide' }), label: 'People' }],
      form:
        data.pendingUsers.length > 0 ? { kind: 'approve-pending', users: data.pendingUsers } : null,
    });
  }
  if (data.activeOwners === 1) {
    add('', {
      code: 'single_owner',
      level: 'info',
      title:
        'Only one active owner. Invite a second owner so the deployment stays manageable if that account is lost.',
      detail: '',
      objects: [],
      fix: {
        href: paths.users({ hash: 'invite' }),
        label: 'Invite a second owner',
        short: { label: 'Invite', srSuffix: 'a second owner' },
        permission: 'users:write',
      },
    });
  }
  return ranked
    .sort(
      (a, b) =>
        LEVEL_ORDER[a.alert.level] - LEVEL_ORDER[b.alert.level] || a.name.localeCompare(b.name),
    )
    .map((entry) => entry.alert);
}

/**
 * The alerts of one object page: a token's own secret, key and host problems (plus a keyring that
 * did not load, when it holds a secret), or the expiry of one credential access rule. Deployment-
 * wide problems stay on the Overview and the health strip.
 */
export function alertsFor(
  data: AlertData,
  target: { tokenId: string } | { ruleId: string },
): Alert[] {
  const quiet: AlertData = {
    ...data,
    credentials: [],
    access_rules: [],
    sealedKids: [],
    keyring: {
      ...data.keyring,
      error: null,
      missingKids: [],
      changedKids: [],
      notActiveCount: 0,
      malformedCount: 0,
    },
    schema: { DB: 'ok', TELEMETRY_DB: 'ok' },
    cron: {
      ...data.cron,
      failing: false,
      stale: false,
      lastSuccessAt: data.cron.lastSuccessAt ?? data.now,
    },
    config: [],
    activeOwners: 0,
    needsDecision: 0,
    pendingUsers: [],
    upstreamAuthFailures: [],
  };
  if ('tokenId' in target) {
    const sealed = data.sealedKids.filter((s) => s.id === target.tokenId);
    const kid = sealed[0]?.kid;
    const has = sealed.length > 0;
    return overviewAlerts({
      ...quiet,
      credentials: data.credentials.filter((s) => s.id === target.tokenId),
      access_rules: data.access_rules.filter((g) => g.credential_id === target.tokenId),
      sealedKids: sealed,
      keyring: {
        ...data.keyring,
        error: has ? data.keyring.error : null,
        missingKids: data.keyring.missingKids.filter((k) => k === kid),
        changedKids: data.keyring.changedKids.filter((k) => k === kid),
        notActiveCount: has && kid !== null && kid !== data.keyring.activeKid ? 1 : 0,
        malformedCount: has && kid === null ? 1 : 0,
      },
      upstreamAuthFailures: data.upstreamAuthFailures.filter(
        (r) => r.service_id === target.tokenId,
      ),
    }).filter((alert) => alert.code !== 'access_expiring');
  }
  const access_rules = data.access_rules.filter((g) => g.id === target.ruleId);
  return overviewAlerts({ ...quiet, access_rules }).filter(
    (alert) => alert.code === 'access_expiring',
  );
}

// ---------------------------------------------------------------------------------------------
// The Overview

export interface SeriesBucket {
  start: number;
  /** Allowed requests not answered with 5xx. */
  allowed: number;
  denied: number;
  /** Gateway errors plus allowed requests answered with 5xx. */
  errors: number;
  /** The current, partial bucket. */
  partial: boolean;
}

export interface TokenTraffic extends TrafficStats {
  /** '' groups requests refused before a token was resolved. */
  serviceId: string;
}

export interface OverviewData {
  generatedAt: number;
  range: OverviewRange;
  /** Traffic covers [from, now): stored rollups for [from, liveFrom), live request_log after. */
  window: { from: number; liveFrom: number };
  totals: TrafficStats;
  series: SeriesBucket[];
  /** Per token (and '' for requests refused before a token was chosen), by requests. */
  tokens: TokenTraffic[];
  /** Requests per credential access rule in the range. */
  accessRequests: Map<string, number>;
  denials: { groups: DenialGroup[]; bounded: boolean };
  recentChanges: AuditEvent[];
  alertData: AlertData;
  /** False when TELEMETRY_DB could not be read: traffic is empty, not zero. */
  telemetryAvailable: boolean;
}

export async function loadOverview(
  deps: Pick<Deps, 'env' | 'now'>,
  range: OverviewRange,
): Promise<OverviewData> {
  const now = deps.now();
  const telemetry = deps.env.TELEMETRY_DB;
  const [alertData, recentChanges] = await Promise.all([
    loadAlertData(deps),
    listAuditEvents(deps.env.DB, { limit: RECENT_CHANGES_LIMIT }),
  ]);
  // The cron rolls up the previous hour a few minutes past each hour; until it has succeeded in
  // the current hour, the previous hour is aggregated live as well. Each live hour is its own
  // aggregate, so it lands in its own chart bucket.
  const currentHour = hourStart(now);
  const from = rangeStart(range, now);
  const { lastSuccessAt } = alertData.cron;
  const liveFrom = Math.max(
    from,
    lastSuccessAt !== null && lastSuccessAt >= currentHour ? currentHour : currentHour - HOUR_MS,
  );
  const liveHours: number[] = [];
  for (let hour = liveFrom; hour <= currentHour; hour += HOUR_MS) liveHours.push(hour);
  const bucketMs = RANGE_BUCKET_MS[range];

  let rollups: RollupRow[] = [];
  let seriesRows: Array<{
    bucket: number;
    outcome: string;
    status_class: number;
    requests: number;
  }> = [];
  let groups: DenialGroup[] = [];
  let scanned = 0;
  let telemetryAvailable = true;
  try {
    const [edgeRows, storedSeries, denialRows, ...liveRows] = await telemetry.batch([
      edgeTotalsStatement(telemetry, from, liveFrom),
      seriesStatement(telemetry, from, liveFrom, bucketMs),
      denialGroupsStatement(telemetry, from),
      ...liveHours.map((hour) => aggregateRequestLogStatement(telemetry, hour, hour + HOUR_MS)),
    ]);
    const live = liveRows.flatMap((result) =>
      rowsOf<Record<string, unknown>>(result).map(rollupFromRow),
    );
    rollups = [...rowsOf<Record<string, unknown>>(edgeRows).map(rollupFromRow), ...live];
    seriesRows = [
      ...rowsOf<Record<string, unknown>>(storedSeries).map(seriesFromRow),
      ...live.map((row) => ({
        bucket: alignedStart(row.hour, bucketMs),
        outcome: row.outcome,
        status_class: row.status_class,
        requests: row.requests,
      })),
    ];
    const denial = rowsOf<Record<string, unknown>>(denialRows);
    groups = denial.map(denialGroupFromRow);
    scanned = Number(denial[0]?.scanned ?? 0);
  } catch {
    telemetryAvailable = false;
  }

  const starts = bucketStarts(range, now);
  const byStart = new Map<number, SeriesBucket>(
    starts.map((start, i) => [
      start,
      { start, allowed: 0, denied: 0, errors: 0, partial: i === starts.length - 1 },
    ]),
  );
  for (const row of seriesRows) {
    const bucket = byStart.get(row.bucket);
    if (!bucket) continue;
    if (isErrorRow(row.outcome, row.status_class)) bucket.errors += row.requests;
    else if (row.outcome === 'denied') bucket.denied += row.requests;
    else if (row.outcome === 'allowed') bucket.allowed += row.requests;
  }

  const byService = new Map<string, RollupRow[]>();
  const accessRequests = new Map<string, number>();
  for (const row of rollups) {
    const list = byService.get(row.service_id) ?? [];
    list.push(row);
    byService.set(row.service_id, list);
    if (row.credential_access_rule_id !== '') {
      const id = row.credential_access_rule_id;
      accessRequests.set(id, (accessRequests.get(id) ?? 0) + row.requests);
    }
  }
  const tokens: TokenTraffic[] = [...byService]
    .map(([serviceId, rows]) => ({ serviceId, ...trafficStats(rows) }))
    .sort((a, b) => b.requests - a.requests || a.serviceId.localeCompare(b.serviceId));

  return {
    generatedAt: now,
    range,
    window: { from, liveFrom },
    totals: trafficStats(rollups),
    series: [...byStart.values()],
    tokens,
    accessRequests,
    denials: { groups, bounded: scanned >= DENIAL_SCAN_ROWS },
    recentChanges,
    alertData,
    telemetryAvailable,
  };
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function rowsOf<T>(result: D1Result | undefined): T[] {
  return (result?.results ?? []) as T[];
}
