// Keyring status, the rotation step (ADR 0027) and credential rewrap: re-seals credentials under the
// active key with the same AAD (I-CRED-2). The start request opens and re-seals every candidate in
// memory, all or nothing, and commits one audit row (I-AUDIT-1) with the job record; waitUntil then
// writes the sealed values in batches, compare-and-swap per service. Plaintext stays in memory only.
import {
  credentialAad,
  type OpenCredentialError,
  openCredential,
  sealCredential,
  sealedKid,
} from '../../crypto/envelope';
import { type KeyringError, type NextKeyStatus, loadKeyring } from '../../crypto/keyring';
import {
  credentialCountsByKid,
  listSealedCredentials,
  rewrapCredentialStatement,
} from '../../db/credentials';
import {
  confirmKeyCheckValueStatement,
  getState,
  putSettingGuardedStatement,
  putSettingStatement,
  settingValueGuard,
} from '../../db/settings';
import type { Actor } from '../../db/types';
import type { Deps } from '../../deps';
import { keyringHealthFrom, recordedKcvStatement } from '../../health';
import { parseJson } from '../../lib/json';
import { commitOrConstraintFailure, type OpFailure, opFailure } from './shared';

/** What is wrong with the keyring configuration, as a plain sentence for operators. */
export const KEYRING_ERROR_TEXT: Readonly<Record<KeyringError, string>> = {
  keyring_absent:
    'No encryption key is configured. Set the TOKENGATE_KEK secret (see docs/operations/key-rotation.md). Until then credentials cannot be saved and the proxy answers 503.',
  keyring_malformed: 'TOKENGATE_KEK is not valid. It must be 32 random bytes encoded as base64.',
  key_not_32_bytes: 'A configured key is not exactly 32 bytes encoded as base64.',
  key_not_random:
    'TOKENGATE_KEYRING is the only key and it is not random. Generate a key with openssl rand -base64 32.',
  dev_placeholder_key:
    'The keyring holds the development key from .dev.vars.example, which is public. It works only with AUTH_ACCESS_DEVELOPMENT and no Access variable. Generate a key of your own (openssl rand -base64 32) and set it as TOKENGATE_KEK.',
};

/** Why TOKENGATE_KEYRING is not used, completing "TOKENGATE_KEYRING …". */
export const NEXT_KEY_PROBLEM_TEXT: Readonly<
  Record<Exclude<NextKeyStatus, 'absent' | 'ready' | 'same'>, string>
> = {
  malformed: 'is not base64. Paste the output of openssl rand -base64 32 as it is.',
  not_32_bytes: 'is not 32 bytes. Paste the output of openssl rand -base64 32 as it is.',
  dev_placeholder:
    'is the public development key from .dev.vars.example. Anyone can read it, so it cannot protect secrets.',
  not_random:
    'is not random: it decodes to text or repeats a few byte values. A key typed or derived from a password can be guessed.',
};

/** Why a stored credential could not be opened, completing "The stored credential …". */
const OPEN_ERROR_TEXT: Readonly<Record<OpenCredentialError, string>> = {
  sealed_malformed: 'is damaged',
  keyring_missing_key: 'was encrypted with a key that is not in the keyring',
  credential_binding_mismatch:
    "does not match the service's current base URL or injection (it may have been tampered with)",
};

const NOTHING_WRITTEN = 'Nothing was re-encrypted.';
/** Credentials written per D1 batch by the background rewrap. */
const REWRAP_BATCH = 50;
/** A running job without a heartbeat for this long has stopped (waitUntil ended or failed). */
export const REWRAP_STALE_MS = 60_000;

export interface KeyringStatus {
  /** Null when the keyring loaded; otherwise why credentials cannot be stored or used. */
  error: KeyringError | null;
  activeKid: string | null;
  /** TOKENGATE_KEK: its key id and the stored credentials it opens (legacy `k1` included). */
  current: { kid: string; credentials: number } | null;
  /** TOKENGATE_KEYRING: its state, and its key id and credentials when it is used. */
  next: { status: NextKeyStatus; kid: string | null; credentials: number };
  /** Stored credentials per sealed key id, including ids missing from the keyring. */
  credentialsByKid: Record<string, number>;
  /** Key ids used by stored credentials but absent from the keyring: those cannot be opened. */
  missingKids: string[];
  /** Stored credentials whose sealed value has no readable key id. */
  unreadableCredentials: number;
  /** Stored credentials sealed under a key other than the active one. */
  needsRewrap: number;
}

export async function keyringStatus(deps: Pick<Deps, 'env'>): Promise<KeyringStatus> {
  const [loaded, counts] = await Promise.all([
    loadKeyring(deps.env),
    credentialCountsByKid(deps.env.DB),
  ]);
  const credentialsByKid: Record<string, number> = Object.create(null);
  let unreadableCredentials = 0;
  for (const { kid, count } of counts) {
    if (kid === null) unreadableCredentials += count;
    else credentialsByKid[kid] = count;
  }
  const keyring = loaded.ok ? loaded.keyring : null;
  const sealedKids = Object.keys(credentialsByKid);
  const under = (loadedKid: string | null) =>
    loadedKid === null
      ? 0
      : sealedKids
          .filter((kid) => keyring?.resolve(kid) === loadedKid)
          .reduce((sum, kid) => sum + (credentialsByKid[kid] ?? 0), 0);
  const nextKid = keyring?.next === 'ready' ? keyring.nextKid : null;
  return {
    error: loaded.ok ? null : loaded.error,
    activeKid: keyring?.activeKid ?? null,
    current: keyring?.currentKid
      ? { kid: keyring.currentKid, credentials: under(keyring.currentKid) }
      : null,
    next: {
      status: keyring?.next ?? 'absent',
      kid: keyring?.nextKid ?? null,
      credentials: under(nextKid),
    },
    credentialsByKid,
    missingKids: sealedKids.filter((kid) => !keyring || keyring.resolve(kid) === null),
    unreadableCredentials,
    needsRewrap: sealedKids
      .filter((kid) => !keyring || keyring.resolve(kid) !== keyring.activeKid)
      .reduce((sum, kid) => sum + (credentialsByKid[kid] ?? 0), 0),
  };
}

/** The background rewrap, as recorded in settings `keyring_rewrap`. */
export interface RewrapJob {
  state: 'running' | 'done' | 'failed';
  /** Key id the credentials are re-sealed with. */
  active_kid: string;
  started_at: number;
  /** Email of the user who started it. */
  started_by: string | null;
  /** Last progress write; a running job without one for REWRAP_STALE_MS has stopped. */
  heartbeat_at: number;
  /** Credentials to write. */
  total: number;
  /** Credentials written so far. */
  written: number;
  /** Candidates changed concurrently (e.g. a credential saved meanwhile); left as written. */
  skipped: number;
  /** Why a `failed` job stopped. */
  error?: string;
}

export async function rewrapJob(deps: Pick<Deps, 'env'>): Promise<RewrapJob | null> {
  return getState<RewrapJob>(deps.env.DB, 'keyring_rewrap');
}

/** A `running` job that still sends heartbeats. */
export function rewrapRunning(job: RewrapJob | null, now: number): boolean {
  return job?.state === 'running' && now - job.heartbeat_at < REWRAP_STALE_MS;
}

/**
 * The rotation step of Settings › Rotate encryption (ADR 0027), from the loaded secrets, the stored
 * credentials and the rewrap job. Null while the keyring does not load: the page shows the error.
 *   1  TOKENGATE_KEYRING is not set: add the new key.
 *   2  TOKENGATE_KEYRING is set but not used (`problem`).
 *   3  Credentials are sealed with another key (or a changed one): start the re-encryption.
 *   4  The re-encryption is running.
 *   5  Every credential is under the new key: move it to TOKENGATE_KEK, delete TOKENGATE_KEYRING.
 */
export type RotationStep =
  | { n: 1 }
  | { n: 2; problem: Exclude<NextKeyStatus, 'absent' | 'ready' | 'same'> }
  | { n: 3; pending: number; stopped: RewrapJob | null }
  | { n: 4; job: RewrapJob }
  | { n: 5; handover: 'move' | 'delete' | 'set_kek' };

export function rotationStep(
  status: KeyringStatus,
  changedKids: string[],
  job: RewrapJob | null,
  now: number,
): RotationStep | null {
  if (status.error !== null) return null;
  const next = status.next.status;
  if (next === 'absent') return { n: 1 };
  if (next !== 'ready' && next !== 'same') return { n: 2, problem: next };
  if (job && rewrapRunning(job, now)) return { n: 4, job };
  if (status.needsRewrap > 0 || changedKids.length > 0) {
    const stopped = job && job.state !== 'done' ? job : null;
    return { n: 3, pending: status.needsRewrap, stopped };
  }
  if (status.current === null) return { n: 5, handover: 'set_kek' };
  return { n: 5, handover: next === 'same' ? 'delete' : 'move' };
}

export interface RewrapStarted {
  ok: true;
  activeKid: string;
  /** Credentials queued for the background writer; 0 when nothing needed re-encryption. */
  queued: number;
  /** Kids whose changed key check value was accepted: every credential under them opened. */
  confirmedKids: string[];
  /** Settles when the background writer is done (also handed to waitUntil). */
  finished: Promise<RewrapJob | null>;
}

/**
 * Starts a rewrap: re-seals in memory every credential not under the active key, and opens every
 * credential under a kid whose recorded key check value differs from the loaded key (key material
 * replaced, see src/health.ts); when all of them open, the new check value is recorded, which
 * clears the keyring alert. This is the only path that replaces a recorded check value.
 * All-or-nothing on problems: if any candidate is malformed, uses a key missing from the keyring,
 * or fails to open, nothing is written and the affected credentials are listed. With no candidates
 * it returns early: nothing changes, so there is nothing to audit. Otherwise it commits the audit
 * row and the job record, unless a job is running, and writes the sealed values in the background.
 */
export async function rewrapCredentials(
  deps: Deps,
  actor: Actor,
): Promise<RewrapStarted | OpFailure> {
  const loaded = await loadKeyring(deps.env);
  if (!loaded.ok) {
    return opFailure('unavailable', [KEYRING_ERROR_TEXT[loaded.error], NOTHING_WRITTEN]);
  }
  const keyring = loaded.keyring;
  const db = deps.env.DB;
  const [rows, recordedRow, jobRow] = await Promise.all([
    listSealedCredentials(db),
    recordedKcvStatement(db).first<{ value: string }>(),
    db
      .prepare("SELECT value FROM settings WHERE key = 'keyring_rewrap'")
      .first<{ value: string }>(),
  ]);
  const jobRaw = jobRow?.value ?? null;
  if (rewrapRunning(parseJson(jobRaw) as RewrapJob | null, deps.now())) {
    return opFailure('conflict', ['A re-encryption is already running. Wait for it to finish.']);
  }
  const kidCounts = new Map<string | null, number>();
  for (const row of rows) {
    const kid = sealedKid(row.credential_sealed);
    kidCounts.set(kid, (kidCounts.get(kid) ?? 0) + 1);
  }
  const recordedJson = recordedRow?.value ?? null;
  const changedKids = keyringHealthFrom(
    loaded,
    [...kidCounts].map(([kid, n]) => ({ kid, n })),
    recordedJson,
  ).changedKids;
  const underActive = (kid: string | null) =>
    kid !== null && keyring.resolve(kid) === keyring.activeKid;
  const candidates = rows.filter((row) => {
    const kid = sealedKid(row.credential_sealed);
    return !underActive(kid) || (kid !== null && changedKids.includes(kid));
  });
  const nothing = { ok: true as const, activeKid: keyring.activeKid, queued: 0 };
  if (candidates.length === 0) {
    return { ...nothing, confirmedKids: [], finished: Promise.resolve(null) };
  }

  const problems: string[] = [];
  const resealed: Array<{ id: string; oldSealed: string; newSealed: string }> = [];
  const fromKids: Record<string, number> = Object.create(null);
  for (const row of candidates) {
    const kid = sealedKid(row.credential_sealed);
    if (kid === null) {
      problems.push(
        `The stored credential of service ${row.slug} ${OPEN_ERROR_TEXT.sealed_malformed}. Set it again on the service page.`,
      );
      continue;
    }
    if (!keyring.key(kid)) {
      problems.push(
        `The credential of service ${row.slug} was encrypted with key "${kid}", which is not in the keyring. Add the key back, or set the credential again.`,
      );
      continue;
    }
    const aad = credentialAad(row.id, row.base_url, row.injection_json);
    const opened = await openCredential(keyring, row.credential_sealed, aad);
    if (!opened.ok) {
      problems.push(
        changedKids.includes(kid)
          ? `The stored credential of service ${row.slug} was encrypted with an earlier key "${kid}". Restore that key, or set the credential again on the service page.`
          : `The stored credential of service ${row.slug} cannot be opened: it ${OPEN_ERROR_TEXT[opened.error]}. Set it again on the service page.`,
      );
      continue;
    }
    // Credentials under the active key were only checked; they stay as they are.
    if (underActive(kid)) continue;
    resealed.push({
      id: row.id,
      oldSealed: row.credential_sealed,
      newSealed: await sealCredential(keyring, opened.plaintext, aad, deps.random),
    });
    fromKids[kid] = (fromKids[kid] ?? 0) + 1;
  }
  if (problems.length > 0) {
    return opFailure('unavailable', [...problems, NOTHING_WRITTEN]);
  }

  const now = deps.now();
  // Every credential under these kids opens with the loaded key (changed kids were all opened
  // above; the active key seals every rewrap). Compare-and-swap on the value read: a concurrent
  // rewrap may record the same kid.
  const recorded = parseJson(recordedJson);
  const previous = (kid: string): string | null => {
    const value =
      recorded && typeof recorded === 'object' ? (recorded as Record<string, unknown>)[kid] : null;
    return typeof value === 'string' ? value : null;
  };
  const kcvKids = new Set([...changedKids, ...(resealed.length > 0 ? [keyring.activeKid] : [])]);
  const kcvStatements = [...kcvKids].flatMap((kid) => {
    const kcv = keyring.kcv[kid];
    return kcv ? [confirmKeyCheckValueStatement(db, kid, kcv, previous(kid), now)] : [];
  });
  const job: RewrapJob = {
    state: resealed.length > 0 ? 'running' : 'done',
    active_kid: keyring.activeKid,
    started_at: now,
    started_by: actor.email,
    heartbeat_at: now,
    total: resealed.length,
    written: 0,
    skipped: 0,
  };
  const guard = settingValueGuard('keyring_rewrap', jobRaw);
  const confirmed =
    changedKids.length > 0
      ? `; accept the current key check value of ${changedKids.join(', ')}`
      : '';
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'keyring.rewrap',
      targetType: 'keyring',
      targetId: keyring.activeKid,
      // Written before the background writes, so it states candidates, not outcomes.
      summary: `Re-encrypt ${resealed.length} credential(s) with key ${keyring.activeKid} (rows changed meanwhile are skipped)${confirmed}`,
      diff: {
        active_kid: keyring.activeKid,
        candidates: resealed.length,
        from_kids: fromKids,
        ...(changedKids.length > 0 ? { confirmed_kids: changedKids } : {}),
      },
    },
    guard,
    [putSettingGuardedStatement(db, 'keyring_rewrap', job, now, actor.id, guard), ...kcvStatements],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) {
    return opFailure('conflict', ['A re-encryption started meanwhile. Reload the page.']);
  }
  const finished = resealed.length > 0 ? writeRewrap(deps, job, resealed) : Promise.resolve(job);
  deps.waitUntil(finished);
  return { ...nothing, queued: resealed.length, confirmedKids: changedKids, finished };
}

/**
 * Writes the re-sealed values in batches, each with the job's progress and heartbeat. Never
 * throws: a failure is recorded on the job, and starting again continues with what is left.
 */
async function writeRewrap(
  deps: Pick<Deps, 'env' | 'now'>,
  job: RewrapJob,
  resealed: Array<{ id: string; oldSealed: string; newSealed: string }>,
): Promise<RewrapJob> {
  const db = deps.env.DB;
  let current = job;
  try {
    for (let start = 0; start < resealed.length; start += REWRAP_BATCH) {
      const batch = resealed.slice(start, start + REWRAP_BATCH);
      const statements = batch.map((item) =>
        rewrapCredentialStatement(db, item.id, item.newSealed, item.oldSealed),
      );
      const results = await db.batch(statements);
      const written = results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
      const done = start + batch.length >= resealed.length;
      current = {
        ...current,
        state: done ? 'done' : 'running',
        heartbeat_at: deps.now(),
        written: current.written + written,
        skipped: current.skipped + batch.length - written,
      };
      await putSettingStatement(db, 'keyring_rewrap', current, current.heartbeat_at, null).run();
    }
  } catch (error) {
    current = {
      ...current,
      state: 'failed',
      heartbeat_at: deps.now(),
      error: error instanceof Error ? error.message : String(error),
    };
    await putSettingStatement(db, 'keyring_rewrap', current, current.heartbeat_at, null)
      .run()
      .catch(() => {});
  }
  return current;
}
