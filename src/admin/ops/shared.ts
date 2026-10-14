// Commit path and result shape shared by admin ops. Each op writes its change and exactly one audit
// row in one db.batch (I-AUDIT-1); a guarded change and its audit row depend on the same predicate.
// An admin request's batch also re-checks the acting identity and role at commit (I-SESS-1).
import { type AuditInput, auditStatement, buildAuditEvent, emitAuditLine } from '../../db/audit';
import type { Actor, AuditEvent } from '../../db/types';
import { liveIdentityGuard } from '../../db/users';
import type { Deps } from '../../deps';
import type { Condition, Rule } from '../../policy/types';
import { rolesWith } from '../auth/rbac';
import type { ActorAuthority } from '../auth/types';

/** Boolean SQL expression plus its binds (same shape as auditStatement's `onlyIf`). */
export type SqlGuard = { sql: string; binds: unknown[] };

export type OpFailureReason =
  /** Input failed validation; `errors` say why. */
  | 'invalid'
  | 'not_found'
  /** Refused because of other rows (e.g. grants still reference it) or a concurrent change. */
  | 'conflict'
  /** Valid, but has warnings; re-submit with `acknowledge_warnings`. */
  | 'acknowledgement_required'
  /** Changes trust of enabled grants; re-submit with `confirm_trust_change`. */
  | 'confirmation_required'
  /** The credential check failed; re-submit with `save_anyway` to store it regardless. */
  | 'verify_failed'
  /** The keyring is missing or invalid, or a stored credential cannot be opened. */
  | 'unavailable';

export interface OpFailure {
  ok: false;
  reason: OpFailureReason;
  errors: string[];
  warnings: string[];
}

export function opFailure(
  reason: OpFailureReason,
  errors: string[],
  warnings: string[] = [],
): OpFailure {
  return { ok: false, reason, errors, warnings };
}

export interface CommitOutcome {
  ok: true;
  /** False when `guard` did not hold: nothing was written. */
  committed: boolean;
  event: AuditEvent;
  results: D1Result[];
}

/** Thrown by commitAudited when the acting user, identity or role no longer allows the write. */
export class ActorNotAuthorizedError extends Error {
  constructor() {
    super('the user lost access or the role changed before the change was saved');
    this.name = 'ActorNotAuthorizedError';
  }
}

/** SQLite echoes an invalid JSON path in its error message; this one marks the actor check. */
const ACTOR_CHECK_MARKER = 'tokengate:actor_not_authorized';

/**
 * Runs `[audit row, ...statements]` as one db.batch (one transaction). With a `guard`, the audit
 * row is inserted only if the guard holds and every statement must carry the same guard: the
 * audit row runs first, so both see the same database state and either all apply or none do.
 * The audit line is emitted to Workers Logs only after the batch commits.
 *
 * When `actor` carries an authority (every admin request, see AdminActor), an actor check runs
 * first in the same batch. Unless the request's login identity is still linked to its active user
 * and that user's current role still holds the route's permission, the check raises an SQL error,
 * the whole batch rolls back and ActorNotAuthorizedError is thrown. So a disable, demotion or login
 * reset that commits while the request is in flight (e.g. during a credential check) stops its write.
 */
export async function commitAudited(
  deps: Pick<Deps, 'env' | 'now' | 'random'>,
  actor: Actor,
  audit: AuditInput,
  guard: SqlGuard | null,
  statements: D1PreparedStatement[],
): Promise<CommitOutcome> {
  const db = deps.env.DB;
  const event = buildAuditEvent(deps, actor, audit);
  const batch = [auditStatement(db, event, guard ?? undefined), ...statements];
  const authority = actorAuthority(actor);
  if (authority) batch.unshift(actorCheckStatement(db, authority));
  let results: D1Result[];
  try {
    results = await db.batch(batch);
  } catch (error) {
    if (authority && errorText(error).includes(ACTOR_CHECK_MARKER)) {
      throw new ActorNotAuthorizedError();
    }
    throw error;
  }
  if (authority) results = results.slice(1);
  const committed = results[0]?.meta.changes === 1;
  if (committed) emitAuditLine(event);
  return { ok: true, committed, event, results };
}

/**
 * Selects nothing while the authority holds; otherwise evaluates json_extract with an invalid
 * path, which raises and aborts the batch (D1 has no RAISE() outside triggers).
 */
function actorCheckStatement(db: D1Database, authority: ActorAuthority): D1PreparedStatement {
  const live = liveIdentityGuard({
    userId: authority.userId,
    loginProvider: authority.loginProvider,
    subject: authority.subject,
    roles: rolesWith(authority.permission),
  });
  return db
    .prepare(`SELECT json_extract('{}', ?) WHERE NOT (${live.sql})`)
    .bind(ACTOR_CHECK_MARKER, ...live.binds);
}

function actorAuthority(actor: Actor): ActorAuthority | null {
  const authority = (actor as { authority?: ActorAuthority }).authority;
  return authority && typeof authority.subject === 'string' ? authority : null;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return `${error.message} ${error.cause instanceof Error ? error.cause.message : ''}`;
}

/** Failure for ActorNotAuthorizedError (HTTP 409): nothing was written. */
export function actorNotAuthorized(): OpFailure {
  return opFailure('conflict', [
    'nothing was saved: your access or your role changed while the request ran; reload the page',
  ]);
}

/** Known D1 constraint errors: unique clashes with another row are conflicts (HTTP 409). */
const CONSTRAINT_FAILURES: ReadonlyArray<[RegExp, OpFailureReason, string]> = [
  [
    /UNIQUE constraint failed: services\.slug/,
    'conflict',
    'another service already uses this slug; choose a different slug',
  ],
  [
    /UNIQUE constraint failed: caller_providers\.name/,
    'conflict',
    'another caller provider already uses this name; choose a different name',
  ],
  [
    /UNIQUE constraint failed: caller_providers\.issuer/,
    'conflict',
    'another caller provider already has this issuer; edit that caller provider instead',
  ],
  [
    /FOREIGN KEY constraint failed/,
    'invalid',
    'the referenced caller provider or service no longer exists',
  ],
];

/**
 * Admin-facing failure for a known D1 constraint error or ActorNotAuthorizedError, or null (the
 * caller rethrows).
 */
export function constraintFailure(error: unknown): OpFailure | null {
  if (error instanceof ActorNotAuthorizedError) return actorNotAuthorized();
  const text = error instanceof Error ? error.message : String(error);
  for (const [pattern, reason, message] of CONSTRAINT_FAILURES) {
    if (pattern.test(text)) return opFailure(reason, [message]);
  }
  return null;
}

/** commitAudited that turns known constraint violations into failures (see CONSTRAINT_FAILURES). */
export async function commitOrConstraintFailure(
  deps: Pick<Deps, 'env' | 'now' | 'random'>,
  actor: Actor,
  audit: AuditInput,
  guard: SqlGuard | null,
  statements: D1PreparedStatement[],
): Promise<CommitOutcome | OpFailure> {
  try {
    return await commitAudited(deps, actor, audit, guard, statements);
  } catch (error) {
    const failure = constraintFailure(error);
    if (failure === null) throw error;
    return failure;
  }
}

/** Failure returned when a guarded change found the row changed or gone since it was read. */
export function concurrentChange(what: string): OpFailure {
  return opFailure('conflict', [
    `${what} was changed or deleted by someone else; reload and retry`,
  ]);
}

/**
 * Optimistic-concurrency check for edit forms. `expected` is the `updated_at` the form was opened
 * at (undefined: not checked). When it matches the row just read, the op's version guard on that
 * row makes the write conditional on the same version.
 */
export function staleEdit(what: string, expected: unknown, current: number): OpFailure | null {
  if (expected === undefined) return null;
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected)) {
    return opFailure('invalid', ['expected_updated_at must be a timestamp in milliseconds']);
  }
  if (expected === current) return null;
  return opFailure('conflict', [
    `${what} was changed by someone else since you opened this page; reload it and apply your change again`,
  ]);
}

/**
 * `updated_at` after a write. Repositories store `MAX(now, updated_at + 1)`, so every write
 * changes the value and `updated_at` works as a version for optimistic concurrency even when
 * two writes happen in the same millisecond. Same formula as the SQL, for op results.
 */
export function nextVersion(previous: number, now: number): number {
  return Math.max(now, previous + 1);
}

// ---------------------------------------------------------------------------------------------
// Input checks shared by ops (policy/validate.ts covers the security-relevant fields).

export const DESCRIPTION_MAX_LENGTH = 2000;
export const NAME_MAX_LENGTH = 100;

/** Required single-line display name. */
export function nameErrors(name: unknown): string[] {
  if (typeof name !== 'string' || name.trim() === '') return ['name is required'];
  if (name.length > NAME_MAX_LENGTH) return [`name must be at most ${NAME_MAX_LENGTH} characters`];
  if (hasControlChars(name, false)) return ['name must not contain control characters'];
  return [];
}

/** Optional free text; line breaks and tabs allowed. */
export function descriptionErrors(description: unknown): string[] {
  if (description === undefined) return [];
  if (typeof description !== 'string') return ['description must be text'];
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    return [`description must be at most ${DESCRIPTION_MAX_LENGTH} characters`];
  }
  if (hasControlChars(description, true)) {
    return ['description must not contain control characters'];
  }
  return [];
}

/** Trimmed text; other types pass through unchanged so validation reports them. */
export function trimmed<T>(value: T): T {
  return (typeof value === 'string' ? value.trim() : value) as T;
}

/** Optional flag: only real booleans, so "false" from a form never counts as true. */
export function booleanErrors(label: string, value: unknown): string[] {
  return value === undefined || typeof value === 'boolean'
    ? []
    : [`${label} must be true or false`];
}

/** Optional timestamp in ms since the epoch (null/undefined = none). */
export function timestampErrors(label: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return [`${label} must be a timestamp in milliseconds`];
  }
  return [];
}

function hasControlChars(text: string, allowWhitespace: boolean): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (allowWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Keeps only the condition fields; `negate` is stored only when true. Shapes are checked by the validators. */
export function normalizeConditions(conditions: Condition[]): Condition[] {
  if (!Array.isArray(conditions)) return conditions;
  return conditions.map((condition) => {
    if (typeof condition !== 'object' || condition === null) return condition;
    const out: Condition = {
      claim: condition.claim,
      match: condition.match,
      values: condition.values,
    };
    // Non-boolean negate values are kept so validation rejects them instead of dropping them.
    if (condition.negate !== undefined && condition.negate !== false) out.negate = condition.negate;
    return out;
  });
}

/** Rules reduced to their fields. */
export function normalizeRules(rules: Rule[]): Rule[] {
  if (!Array.isArray(rules)) return rules;
  return rules.map((rule) =>
    typeof rule === 'object' && rule !== null ? { methods: rule.methods, path: rule.path } : rule,
  );
}

/** Subset of `value` with `keys`, for before/after audit diffs of changed fields. */
export function pick<T extends object>(value: T, keys: Array<keyof T>): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) out[key] = value[key];
  return out;
}

/** Conjunction of guards. */
export function allOf(...guards: SqlGuard[]): SqlGuard {
  return {
    sql: guards.map((guard) => `(${guard.sql})`).join(' AND '),
    binds: guards.flatMap((guard) => guard.binds),
  };
}
