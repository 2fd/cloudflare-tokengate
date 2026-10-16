// Schema guard: compares each D1 database's applied migrations (wrangler's `d1_migrations` table)
// with this build's SCHEMA_HEAD. 'ok' and 'ahead' are cached for the isolate's lifetime; 'behind'
// and 'unknown' are re-read after RECHECK_MS, since operators apply migrations without redeploying.
import type { Deps } from '../deps';
import { SCHEMA_HEAD, type SchemaDatabase } from '../generated/schema-head';

/**
 * ok: head applied, nothing newer. behind: head not applied (run `wrangler d1 migrations apply`).
 * ahead: a newer migration is applied than this code knows (typical after `wrangler rollback`).
 * unknown: the migrations table could not be read.
 */
export type SchemaState = 'ok' | 'behind' | 'ahead' | 'unknown';

const RECHECK_MS = 60_000;
const MIGRATION_NAME = /^(\d+)_/;

/** Pure comparison by the numeric prefix wrangler orders migrations by. */
export function schemaStateFromNames(applied: readonly string[], head: string): SchemaState {
  const headNumber = migrationNumber(head);
  if (headNumber === null) return 'unknown';
  let newest = -1;
  for (const name of applied) {
    const n = migrationNumber(name);
    if (n !== null && n > newest) newest = n;
  }
  if (newest > headNumber) return 'ahead';
  return applied.includes(head) ? 'ok' : 'behind';
}

/** Worst state across databases, in the order operators must act on them. */
export function combineSchemaStates(states: readonly SchemaState[]): SchemaState {
  for (const state of ['behind', 'unknown', 'ahead'] as const) {
    if (states.includes(state)) return state;
  }
  return 'ok';
}

const cache = new Map<SchemaDatabase, { at: number; state: Promise<SchemaState> }>();

export async function schemaStatusByDatabase(
  deps: Pick<Deps, 'env' | 'now'>,
): Promise<Record<SchemaDatabase, SchemaState>> {
  const [db, telemetry] = await Promise.all([
    cachedState(deps, 'DB'),
    cachedState(deps, 'TELEMETRY_DB'),
  ]);
  return { DB: db, TELEMETRY_DB: telemetry };
}

export async function schemaStatus(deps: Pick<Deps, 'env' | 'now'>): Promise<SchemaState> {
  const byDb = await schemaStatusByDatabase(deps);
  return combineSchemaStates([byDb.DB, byDb.TELEMETRY_DB]);
}

export function resetSchemaStatusCacheForTests(): void {
  cache.clear();
}

async function cachedState(
  deps: Pick<Deps, 'env' | 'now'>,
  database: SchemaDatabase,
): Promise<SchemaState> {
  const now = deps.now();
  const hit = cache.get(database);
  if (hit) {
    const state = await hit.state;
    if (state === 'ok' || state === 'ahead' || now - hit.at < RECHECK_MS) return state;
  }
  // The promise is cached before it settles so concurrent first requests share one query.
  const state = readState(deps.env[database], SCHEMA_HEAD[database]);
  cache.set(database, { at: now, state });
  return state;
}

async function readState(db: D1Database, head: string): Promise<SchemaState> {
  try {
    const { results } = await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
    return schemaStateFromNames(
      results.map((row) => row.name),
      head,
    );
  } catch {
    return 'unknown';
  }
}

function migrationNumber(name: string): number | null {
  const match = MIGRATION_NAME.exec(name);
  return match?.[1] ? Number(match[1]) : null;
}
