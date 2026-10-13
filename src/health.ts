// Liveness (/healthz, no I/O) and readiness (/readyz) for uptime monitors, plus the keyring and
// cron checks the admin dashboard reuses. /readyz is unauthenticated: it returns booleans only
// (no kids, counts or errors) and caches its answer briefly so it cannot be used to load D1.
import type { App } from './app';
import { type KeyringError, type LoadKeyringResult, loadKeyring } from './crypto/keyring';
import { schemaStatus } from './db/migrations';
import type { Deps } from './deps';
import { parseJson } from './lib/json';

/** The cron runs hourly; two missed runs mean it is not running. */
export const CRON_STALE_MS = 2 * 3_600_000;
const READINESS_CACHE_MS = 10_000;

export interface ReadinessChecks {
  db: boolean;
  telemetry_db: boolean;
  /** Keyring parses and holds, unchanged, every kid referenced by a stored credential. */
  keyring: boolean;
  /**
   * The cron is not failing and its last success is at most CRON_STALE_MS old. True before the
   * first run (a fresh deploy waits up to an hour for it); the dashboard shows "never ran".
   */
  cron: boolean;
  /** Both databases have this build's newest migration applied (newer is accepted). */
  schema: boolean;
}

export function registerHealthRoutes(app: App): void {
  app.get('/healthz', (c) => c.json({ ok: true }, 200, { 'cache-control': 'no-store' }));
  app.get('/readyz', async (c) => {
    const checks = await cachedReadiness(c.get('deps'));
    const ok = Object.values(checks).every(Boolean);
    return c.json({ ok, checks }, ok ? 200 : 503, { 'cache-control': 'no-store' });
  });
}

let readinessCache: { at: number; checks: Promise<ReadinessChecks> } | null = null;

function cachedReadiness(deps: Deps): Promise<ReadinessChecks> {
  const now = deps.now();
  if (readinessCache && now - readinessCache.at < READINESS_CACHE_MS) return readinessCache.checks;
  const checks = readinessChecks(deps);
  readinessCache = { at: now, checks };
  return checks;
}

export function resetReadinessCacheForTests(): void {
  readinessCache = null;
}

/** Runs every check independently; any error makes that check false. */
export async function readinessChecks(deps: Pick<Deps, 'env' | 'now'>): Promise<ReadinessChecks> {
  const pass = (check: Promise<boolean>) => check.catch(() => false);
  const ping = async (db: D1Database) => (await db.prepare('SELECT 1 AS ok').first()) !== null;
  const [db, telemetry_db, keyring, cron, schema] = await Promise.all([
    pass(ping(deps.env.DB)),
    pass(ping(deps.env.TELEMETRY_DB)),
    pass(keyringHealth(deps).then((health) => health.ok)),
    pass(
      cronHealth(deps).then((health) =>
        health.lastSuccessAt === null ? !health.failing : !health.stale && !health.failing,
      ),
    ),
    pass(schemaStatus(deps).then((state) => state === 'ok' || state === 'ahead')),
  ]);
  return { db, telemetry_db, keyring, cron, schema };
}

export interface KeyringHealth {
  ok: boolean;
  /** Why the keyring secret could not be loaded; null when it loaded. */
  error: KeyringError | null;
  activeKid: string | null;
  /** Kids used by stored credentials but absent from the keyring: those services fail closed. */
  missingKids: string[];
  /**
   * Kids used by stored credentials whose key check value differs from the one recorded in
   * settings `keyring_kcv` at seal time: the key behind the kid was replaced (e.g. a new
   * TOKENGATE_KEK, always kid "k1"), so those credentials cannot be opened. Cleared by sealing
   * when no other credential uses the kid (src/db/settings.ts), or by a rewrap that opens every
   * credential under it (src/admin/ops/keyring.ts).
   */
  changedKids: string[];
  /** Stored credentials sealed under a kid other than the active one (rewrap pending). */
  notActiveCount: number;
  /** Stored credential values that are not sealed JSON with a string kid. */
  malformedCount: number;
}

/** Credentials per sealed kid; kid is NULL for values that are not JSON or lack a string kid. */
export function sealedKidCountsStatement(db: D1Database): D1PreparedStatement {
  // Nested CASE: SQLite evaluates CASE lazily, and json_type() raises on malformed JSON.
  return db.prepare(
    `SELECT CASE WHEN json_valid(credential_sealed) THEN
              CASE WHEN json_type(credential_sealed, '$.kid') = 'text'
                   THEN json_extract(credential_sealed, '$.kid') END
            END AS kid,
            COUNT(*) AS n
     FROM services WHERE credential_sealed IS NOT NULL GROUP BY 1`,
  );
}

/** The kid → key check value map recorded when credentials were sealed (zero or one row). */
export function recordedKcvStatement(db: D1Database): D1PreparedStatement {
  return db.prepare("SELECT value FROM settings WHERE key = 'keyring_kcv'");
}

export function keyringHealthFrom(
  loaded: LoadKeyringResult,
  kidCounts: Array<{ kid: string | null; n: number }>,
  /** Raw `keyring_kcv` settings value; absent or malformed means nothing to compare. */
  recordedKcvJson: string | null = null,
): KeyringHealth {
  const keyring = loaded.ok ? loaded.keyring : null;
  const recorded = parseJson(recordedKcvJson);
  const recordedKcv = (kid: string): unknown =>
    recorded && typeof recorded === 'object' && Object.hasOwn(recorded, kid)
      ? (recorded as Record<string, unknown>)[kid]
      : undefined;
  const missingKids: string[] = [];
  const changedKids: string[] = [];
  let notActiveCount = 0;
  let malformedCount = 0;
  for (const { kid, n } of kidCounts) {
    if (kid === null) {
      malformedCount += n;
      continue;
    }
    if (kid !== keyring?.activeKid) notActiveCount += n;
    if (!keyring) continue;
    if (!keyring.kids.includes(kid)) {
      missingKids.push(kid);
      continue;
    }
    const expected = recordedKcv(kid);
    if (typeof expected === 'string' && expected !== keyring.kcv[kid]) changedKids.push(kid);
  }
  missingKids.sort();
  changedKids.sort();
  return {
    ok:
      keyring !== null &&
      missingKids.length === 0 &&
      changedKids.length === 0 &&
      malformedCount === 0,
    error: loaded.ok ? null : loaded.error,
    activeKid: keyring?.activeKid ?? null,
    missingKids,
    changedKids,
    notActiveCount,
    malformedCount,
  };
}

export async function keyringHealth(deps: Pick<Deps, 'env'>): Promise<KeyringHealth> {
  const db = deps.env.DB;
  const [loaded, [kidCounts, recordedKcv]] = await Promise.all([
    loadKeyring(deps.env),
    db.batch([sealedKidCountsStatement(db), recordedKcvStatement(db)]),
  ]);
  return keyringHealthFrom(
    loaded,
    (kidCounts?.results ?? []) as Array<{ kid: string | null; n: number }>,
    (recordedKcv?.results[0] as { value: string } | undefined)?.value ?? null,
  );
}

export interface CronHealth {
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  /** Never succeeded, or last success older than CRON_STALE_MS. */
  stale: boolean;
  /** The most recent run failed (error newer than the last success). */
  failing: boolean;
}

const CRON_KEYS = ['cron_last_success_at', 'cron_last_error', 'cron_last_error_at'] as const;

export function cronSettingsStatement(db: D1Database): D1PreparedStatement {
  return db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?, ?)').bind(...CRON_KEYS);
}

export function cronHealthFrom(
  rows: Array<{ key: string; value: string }>,
  now: number,
): CronHealth {
  const values = new Map(rows.map((row) => [row.key, parseJson(row.value)]));
  const time = (key: string) => {
    const value = values.get(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const lastSuccessAt = time('cron_last_success_at');
  const lastErrorAt = time('cron_last_error_at');
  const lastError = values.get('cron_last_error');
  return {
    lastSuccessAt,
    lastErrorAt,
    lastError: typeof lastError === 'string' ? lastError : null,
    stale: lastSuccessAt === null || now - lastSuccessAt > CRON_STALE_MS,
    failing: lastErrorAt !== null && (lastSuccessAt === null || lastErrorAt > lastSuccessAt),
  };
}

export async function cronHealth(deps: Pick<Deps, 'env' | 'now'>): Promise<CronHealth> {
  const { results } = await cronSettingsStatement(deps.env.DB).all<{
    key: string;
    value: string;
  }>();
  return cronHealthFrom(results, deps.now());
}
