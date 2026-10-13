// Audit log writes and reads (I-AUDIT-1). Every admin mutation adds `auditStatement(...)` to the
// same db.batch() as the change, so a change without its audit row cannot be committed.
import type { Deps } from '../deps';
import { newId } from '../lib/ids';
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

export interface AuditQuery {
  targetType?: string;
  targetId?: string;
  actor?: string;
  before?: string;
  limit?: number;
}

export async function listAuditEvents(db: D1Database, query: AuditQuery): Promise<AuditEvent[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (query.targetType) {
    where.push('target_type = ?');
    binds.push(query.targetType);
  }
  if (query.targetId) {
    where.push('target_id = ?');
    binds.push(query.targetId);
  }
  if (query.actor) {
    where.push('(actor_email = ? OR actor_id = ?)');
    binds.push(query.actor, query.actor);
  }
  if (query.before) {
    where.push('id < ?');
    binds.push(query.before);
  }
  const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  const { results } = await db
    .prepare(sql)
    .bind(...binds, query.limit ?? 50)
    .all<Record<string, unknown>>();
  return results.map(auditFromRow);
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
