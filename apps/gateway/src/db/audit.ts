// Audit log writes and reads (I-AUDIT-1). Every admin mutation adds `auditStatement(...)` to the
// same db.batch() as the change, so a change without its audit row cannot be committed.
import type { Deps } from '../deps';
import { idLowerBound, newId } from '../lib/ids';
import { parseJson } from '../lib/json';
import type { Actor, AuditEvent } from './types';

export interface AuditInput {
  action: string;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  diff?: AuditEvent['diff'];
}

/** Keys whose values are replaced before an object is stored in an audit diff (I-CRED-1). */
const REDACTED_KEYS = new Set(['credential_sealed', 'credential', 'secret', 'client_secret']);

export function redactForAudit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForAudit);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = REDACTED_KEYS.has(key)
        ? child == null
          ? null
          : '[redacted]'
        : redactForAudit(child);
    }
    return out;
  }
  return value;
}

export function buildAuditEvent(
  deps: Pick<Deps, 'now' | 'random'>,
  actor: Actor,
  input: AuditInput,
): AuditEvent {
  return {
    id: newId('aud', deps.now(), deps.random),
    ts: deps.now(),
    actor_type: actor.type,
    actor_id: actor.id,
    actor_email: actor.email,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    summary: input.summary,
    diff: input.diff ? (redactForAudit(input.diff) as AuditEvent['diff']) : null,
    ip: actor.ip,
    user_agent: actor.userAgent,
  };
}

/**
 * Insert statement for one audit event. With `onlyIf`, the row is inserted only while that SQL
 * guard holds, for mutations that may legitimately change nothing (e.g. bootstrapOwnerStatements).
 */
export function auditStatement(
  db: D1Database,
  event: AuditEvent,
  onlyIf?: { sql: string; binds: unknown[] },
): D1PreparedStatement {
  const columns = [
    event.id,
    event.ts,
    event.actor_type,
    event.actor_id,
    event.actor_email,
    event.action,
    event.target_type,
    event.target_id,
    event.summary,
    event.diff ? JSON.stringify(event.diff) : null,
    event.ip,
    event.user_agent,
  ];
  const insert =
    'INSERT INTO audit_log (id, ts, actor_type, actor_id, actor_email, action, target_type, target_id, summary, diff, ip, user_agent)';
  if (!onlyIf) {
    return db.prepare(`${insert} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...columns);
  }
  return db
    .prepare(`${insert} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${onlyIf.sql}`)
    .bind(...columns, ...onlyIf.binds);
}

/**
 * Copies a committed audit event to Workers Logs as one JSON line, so operators can ship it to a
 * SIEM (docs/observability.md). Call after the batch succeeds.
 */
export function emitAuditLine(event: AuditEvent): void {
  console.info(JSON.stringify({ type: 'audit.event', ...event }));
}

/** Actions as exact names and `service.`-style prefixes (each prefix is an index range). */
export interface AuditActionSet {
  prefixes: readonly string[];
  exact: readonly string[];
}

export interface AuditQuery {
  targetType?: string;
  targetId?: string;
  /** Events by this user id (index audit_log_actor). */
  actorId?: string;
  /** Events written by the system (the hourly job). Ignored when actorId is set. */
  systemActor?: boolean;
  /** Only these actions (index audit_log_action). An empty set matches nothing. */
  actions?: AuditActionSet;
  /** Only events at or after this time (ms); an id bound, like the list order. */
  since?: number;
  before?: string;
  /** Keyset pagination towards newer events; wins over `before`. */
  after?: string;
  limit?: number;
}

/** The first string after every string that starts with `prefix` ('service.' → 'service/'). */
export function prefixSuccessor(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}

/** Newest first; with `after`, the oldest `limit` events above it, still newest first. */
export async function listAuditEvents(db: D1Database, query: AuditQuery): Promise<AuditEvent[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const add = (sql: string, ...values: unknown[]) => {
    where.push(sql);
    binds.push(...values);
  };
  if (query.targetType) add('target_type = ?', query.targetType);
  if (query.targetId) add('target_id = ?', query.targetId);
  if (query.actorId) add('actor_id = ?', query.actorId);
  else if (query.systemActor) where.push("actor_type = 'system'");
  if (query.actions) {
    const terms = [
      ...query.actions.prefixes.map((prefix) => {
        binds.push(prefix, prefixSuccessor(prefix));
        return '(action >= ? AND action < ?)';
      }),
      ...(query.actions.exact.length > 0
        ? [
            `action IN (${query.actions.exact
              .map((action) => {
                binds.push(action);
                return '?';
              })
              .join(', ')})`,
          ]
        : []),
    ];
    where.push(terms.length > 0 ? `(${terms.join(' OR ')})` : '0');
  }
  if (query.since !== undefined) add('id >= ?', idLowerBound('aud', query.since));
  if (query.after) add('id > ?', query.after);
  else if (query.before) add('id < ?', query.before);
  const order = query.after ? 'ASC' : 'DESC';
  const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id ${order} LIMIT ?`;
  const { results } = await db
    .prepare(sql)
    .bind(...binds, query.limit ?? 50)
    .all<Record<string, unknown>>();
  const events = results.map(auditFromRow);
  return query.after ? events.reverse() : events;
}

/** One audit event by id (a primary-key read). */
export async function getAuditEvent(db: D1Database, id: string): Promise<AuditEvent | null> {
  const row = await db
    .prepare('SELECT * FROM audit_log WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  return row ? auditFromRow(row) : null;
}

export function auditFromRow(row: Record<string, unknown>): AuditEvent {
  return {
    id: String(row.id),
    ts: Number(row.ts),
    actor_type: row.actor_type === 'system' ? 'system' : 'user',
    actor_id: (row.actor_id as string | null) ?? null,
    actor_email: (row.actor_email as string | null) ?? null,
    action: String(row.action),
    target_type: (row.target_type as string | null) ?? null,
    target_id: (row.target_id as string | null) ?? null,
    summary: String(row.summary),
    diff: (parseJson(row.diff as string | null) as AuditEvent['diff']) ?? null,
    ip: (row.ip as string | null) ?? null,
    user_agent: (row.user_agent as string | null) ?? null,
  };
}

export const SYSTEM_ACTOR: Actor = {
  type: 'system',
  id: null,
  email: null,
  ip: null,
  userAgent: null,
};

/** Audit events written by each user since `since` (People: the "Changes" column). */
export async function auditCountByActor(
  db: D1Database,
  since: number,
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT actor_id, count(*) AS n FROM audit_log
       WHERE actor_type = 'user' AND actor_id IS NOT NULL AND ts >= ? GROUP BY actor_id`,
    )
    .bind(since)
    .all<{ actor_id: string; n: number }>();
  return new Map(results.map((row) => [row.actor_id, Number(row.n)]));
}

/**
 * What one user changed since `since`, counted per audit category (the Audit log's categories:
 * tokens, consumers, access, users, system). Sign-in events (user.bootstrap, user.join, user.link)
 * are the user's own sign-ins, not changes, and are left out.
 */
export async function auditCountByActorAndCategory(
  db: D1Database,
  actorId: string,
  since: number,
): Promise<Record<'tokens' | 'consumers' | 'access' | 'users' | 'system', number>> {
  const { results } = await db
    .prepare(
      `SELECT action, count(*) AS n FROM audit_log
       WHERE actor_type = 'user' AND actor_id = ? AND ts >= ? GROUP BY action`,
    )
    .bind(actorId, since)
    .all<{ action: string; n: number }>();
  const counts = { tokens: 0, consumers: 0, access: 0, users: 0, system: 0 };
  for (const row of results) {
    const category = changeCategory(row.action);
    if (category) counts[category] += Number(row.n);
  }
  return counts;
}

function changeCategory(
  action: string,
): keyof Awaited<ReturnType<typeof auditCountByActorAndCategory>> | null {
  if (
    action.startsWith('service.') ||
    action.startsWith('credential.') ||
    action.startsWith('keyring.') ||
    action === 'settings.upstream_hosts'
  ) {
    return 'tokens';
  }
  if (action.startsWith('credential_access_rule.')) return 'consumers';
  if (action.startsWith('grant.')) return 'access';
  if (['user.bootstrap', 'user.join', 'user.link'].includes(action)) return null;
  if (action.startsWith('user.') || action === 'settings.admin_hosts') return 'users';
  return 'system';
}
