// Data for the admin dashboard: last-24 h traffic per service from hourly rollups plus a live
// aggregate of the hours not rolled up yet, recent denials, and operational alerts. Read-only.
// Counts are weighted estimates when sampling is enabled.
import { loadKeyring } from '../crypto/keyring';
import { type SchemaState, schemaStatusByDatabase } from '../db/migrations';
import {
  aggregateRequestLogStatement,
  HOUR_MS,
  LATENCY_BUCKETS,
  listRollupsStatement,
  type RecentDenial,
  type RollupRow,
  recentDenialsStatement,
  rollupFromRow,
  type UpstreamAuthFailureRow,
  upstreamAuthFailuresStatement,
} from '../db/rollups';
import type { Deps } from '../deps';
import { SCHEMA_HEAD, type SchemaDatabase } from '../generated/schema-head';
import {
  type CronHealth,
  cronHealthFrom,
  cronSettingsStatement,
  type KeyringHealth,
  keyringHealthFrom,
  recordedKcvStatement,
  sealedKidCountsStatement,
} from '../health';
import { hourStart } from './rollup';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
// Upstream-auth alert: within the window, at least MIN_COUNT 401/403s that are also at least
// MIN_RATIO of the forwarded requests.
export const AUTH_FAILURE_WINDOW_MS = 15 * MINUTE_MS;
export const AUTH_FAILURE_MIN_COUNT = 5;
export const AUTH_FAILURE_MIN_RATIO = 0.5;
export const EXPIRY_WARNING_MS = 14 * DAY_MS;
export const RECENT_DENIALS_LIMIT = 20;

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

export interface ServiceTraffic extends TrafficStats {
  /** '' groups requests that failed before a service was resolved. */
  serviceId: string;
  /** null when the service was deleted or is unknown. */
  slug: string | null;
  name: string | null;
}

export interface ExpiringCredential {
  serviceId: string;
  slug: string;
  name: string;
  expiresAt: number;
  expired: boolean;
}

export interface DashboardData {
  generatedAt: number;
  /** Traffic covers [from, now): stored rollups for [from, liveFrom), live request_log after. */
  window: { from: number; liveFrom: number };
  totals: TrafficStats;
  services: ServiceTraffic[];
  recentDenials: RecentDenial[];
  alerts: {
    upstreamAuthFailures: UpstreamAuthFailureRow[];
    expiringCredentials: ExpiringCredential[];
    cron: CronHealth;
    keyring: KeyringHealth;
    schema: Record<SchemaDatabase, SchemaState>;
    activeOwners: number;
  };
}

export async function loadDashboard(deps: Pick<Deps, 'env' | 'now'>): Promise<DashboardData> {
  const now = deps.now();
  const db = deps.env.DB;
  const telemetry = deps.env.TELEMETRY_DB;

  const [[cronRows, kidRows, kcvRows, serviceRows, ownerRows], keyringLoaded, schema] =
    await Promise.all([
      db.batch([
        cronSettingsStatement(db),
        sealedKidCountsStatement(db),
        recordedKcvStatement(db),
        db.prepare(
          `SELECT id, slug, name, credential_expires_at, credential_sealed IS NOT NULL AS has_credential
         FROM services`,
        ),
        db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND status = 'active'`),
      ]),
      loadKeyring(deps.env),
      schemaStatusByDatabase(deps),
    ]);
  const cron = cronHealthFrom(rowsOf<{ key: string; value: string }>(cronRows), now);
  const services = rowsOf<{
    id: string;
    slug: string;
    name: string;
    credential_expires_at: number | null;
    has_credential: number;
  }>(serviceRows);

  // The cron rolls up the previous hour a few minutes past each hour; until it has succeeded in
  // the current hour, the previous hour is aggregated live as well.
  const currentHour = hourStart(now);
  const from = currentHour - 23 * HOUR_MS;
  const liveFrom =
    cron.lastSuccessAt !== null && cron.lastSuccessAt >= currentHour
      ? currentHour
      : currentHour - HOUR_MS;
  const [rollupRows, liveRows, authRows, denialRows] = await telemetry.batch([
    listRollupsStatement(telemetry, from, liveFrom),
    aggregateRequestLogStatement(telemetry, liveFrom, currentHour + HOUR_MS),
    upstreamAuthFailuresStatement(
      telemetry,
      now - AUTH_FAILURE_WINDOW_MS,
      AUTH_FAILURE_MIN_COUNT,
      AUTH_FAILURE_MIN_RATIO,
    ),
    recentDenialsStatement(telemetry, now - DAY_MS, RECENT_DENIALS_LIMIT),
  ]);

  const rollups = [
    ...rowsOf<Record<string, unknown>>(rollupRows),
    ...rowsOf<Record<string, unknown>>(liveRows),
  ].map(rollupFromRow);
  const byService = new Map<string, RollupRow[]>();
  for (const row of rollups) {
    const list = byService.get(row.service_id) ?? [];
    list.push(row);
    byService.set(row.service_id, list);
  }
  const serviceById = new Map(services.map((service) => [service.id, service]));
  const traffic: ServiceTraffic[] = [...byService].map(([serviceId, rows]) => ({
    serviceId,
    slug: serviceById.get(serviceId)?.slug ?? null,
    name: serviceById.get(serviceId)?.name ?? null,
    ...trafficStats(rows),
  }));
  traffic.sort((a, b) => b.requests - a.requests || (a.slug ?? '').localeCompare(b.slug ?? ''));

  return {
    generatedAt: now,
    window: { from, liveFrom },
    totals: trafficStats(rollups),
    services: traffic,
    recentDenials: rowsOf<RecentDenial>(denialRows),
    alerts: {
      upstreamAuthFailures: rowsOf<UpstreamAuthFailureRow>(authRows),
      expiringCredentials: services
        .filter(
          (service) =>
            service.has_credential === 1 &&
            service.credential_expires_at !== null &&
            service.credential_expires_at <= now + EXPIRY_WARNING_MS,
        )
        .map((service) => ({
          serviceId: service.id,
          slug: service.slug,
          name: service.name,
          expiresAt: service.credential_expires_at as number,
          expired: (service.credential_expires_at as number) <= now,
        }))
        .sort((a, b) => a.expiresAt - b.expiresAt),
      cron,
      keyring: keyringHealthFrom(
        keyringLoaded,
        rowsOf<{ kid: string | null; n: number }>(kidRows),
        rowsOf<{ value: string }>(kcvRows)[0]?.value ?? null,
      ),
      schema,
      activeOwners: Number(rowsOf<{ n: number }>(ownerRows)[0]?.n ?? 0),
    },
  };
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
    if (row.outcome === 'error' || (row.outcome === 'allowed' && row.status_class === 5)) {
      errors += row.requests;
    }
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

/**
 * A dashboard message. Declared here, not imported from views/legacy.tsx (which goes away once
 * every section is rewritten); it stays assignable to the shell's legacy banner.
 */
export interface Banner {
  level: 'info' | 'warning' | 'error';
  text: string;
}

/** Banner texts for the dashboard, most severe first. Values shown are non-secret. */
export function dashboardBanners(data: DashboardData): Banner[] {
  const { alerts } = data;
  const banners: Banner[] = [];
  const { keyring } = alerts;
  if (keyring.error) {
    banners.push({
      level: 'error',
      text: `Keyring unavailable (${keyring.error}): the proxy cannot decrypt credentials and credential changes are refused. Set TOKENGATE_KEK or TOKENGATE_KEYRING.`,
    });
  }
  if (keyring.missingKids.length > 0) {
    banners.push({
      level: 'error',
      text: `Credentials are sealed with key ids missing from the keyring (${keyring.missingKids.join(', ')}); those services answer credential_unavailable.`,
    });
  }
  if (keyring.changedKids.length > 0) {
    banners.push({
      level: 'error',
      text: `Key id(s) ${keyring.changedKids.join(', ')} now hold a different key than the one stored credentials were sealed with (key check value changed); credentials sealed with the previous key answer credential_unavailable. Restore the previous key value, or set those credentials again and then run "Re-encrypt credentials" in Service tokens › Encryption keys to accept the new key.`,
    });
  }
  if (keyring.malformedCount > 0) {
    banners.push({
      level: 'error',
      text: `${keyring.malformedCount} stored credential(s) are not valid sealed values; re-enter them.`,
    });
  }
  for (const database of ['DB', 'TELEMETRY_DB'] as const) {
    const state = alerts.schema[database];
    if (state === 'behind') {
      banners.push({
        level: 'error',
        text: `Database ${database} is missing migration ${SCHEMA_HEAD[database]}. Run: wrangler d1 migrations apply ${database} --remote`,
      });
    } else if (state === 'ahead') {
      banners.push({
        level: 'warning',
        text: `Database ${database} has migrations newer than this deployment (rolled back?).`,
      });
    } else if (state === 'unknown') {
      banners.push({
        level: 'warning',
        text: `Could not read the applied migrations of ${database}.`,
      });
    }
  }
  const { cron } = alerts;
  if (cron.failing) {
    banners.push({
      level: 'error',
      text: `The hourly maintenance job failed at ${iso(cron.lastErrorAt)}: ${cron.lastError ?? 'unknown error'}`,
    });
  } else if (cron.lastSuccessAt === null) {
    banners.push({ level: 'info', text: 'The hourly maintenance job has not run yet.' });
  } else if (cron.stale) {
    banners.push({
      level: 'warning',
      text: `The hourly maintenance job last succeeded at ${iso(cron.lastSuccessAt)}; rollups and retention are not running.`,
    });
  }
  for (const row of alerts.upstreamAuthFailures) {
    banners.push({
      level: 'warning',
      text: `Upstream rejected the credential of service ${row.service_slug ?? row.service_id}: ${Math.round(row.auth_failures)} of ${Math.round(row.forwarded)} requests got 401/403 in the last 15 minutes. The credential may be revoked or expired.`,
    });
  }
  for (const credential of alerts.expiringCredentials) {
    banners.push({
      level: credential.expired ? 'error' : 'warning',
      text: credential.expired
        ? `The credential of service ${credential.slug} expired at ${iso(credential.expiresAt)}.`
        : `The credential of service ${credential.slug} expires at ${iso(credential.expiresAt)}.`,
    });
  }
  if (keyring.notActiveCount > 0 && !keyring.error) {
    banners.push({
      level: 'info',
      text: `${keyring.notActiveCount} credential(s) are sealed with a key other than the active key ${keyring.activeKid}. Re-encrypt them in Service tokens › Encryption keys.`,
    });
  }
  if (alerts.activeOwners === 1) {
    banners.push({
      level: 'info',
      text: 'There is only one active owner. Invite a second owner so the deployment stays manageable if that account is lost.',
    });
  }
  const severity = { error: 0, warning: 1, info: 2 } as const;
  return banners.sort((a, b) => severity[a.level] - severity[b.level]);
}

function rowsOf<T>(result: D1Result | undefined): T[] {
  return (result?.results ?? []) as T[];
}

function iso(ms: number | null): string {
  return ms === null ? 'unknown time' : new Date(ms).toISOString();
}
