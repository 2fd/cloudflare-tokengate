// Keyring status and credential rewrap: re-seals credentials under the active key with the same
// AAD (I-CRED-2), compare-and-swap per service, in one batch with one audit row (I-AUDIT-1).
// Plaintext stays in memory only.
import {
  credentialAad,
  type OpenCredentialError,
  openCredential,
  sealCredential,
  sealedKid,
} from '../../crypto/envelope';
import { type KeyringError, loadKeyring } from '../../crypto/keyring';
import {
  credentialCountsByKid,
  listSealedCredentials,
  rewrapCredentialStatement,
} from '../../db/services';
import { confirmKeyCheckValueStatement } from '../../db/settings';
import type { Actor } from '../../db/types';
import type { Deps } from '../../deps';
import { keyringHealthFrom, recordedKcvStatement } from '../../health';
import { parseJson } from '../../lib/json';
import { commitOrConstraintFailure, type OpFailure, opFailure } from './shared';

/** What is wrong with the keyring configuration, as a plain sentence for operators. */
export const KEYRING_ERROR_TEXT: Readonly<Record<KeyringError, string>> = {
  keyring_absent:
    'No encryption key is configured. Set the TOKENGATE_KEK secret (see docs/operations/key-rotation.md). Until then credentials cannot be saved and the proxy answers 503.',
  keyring_malformed:
    'TOKENGATE_KEYRING is not valid. It must be JSON like {"active":"k2","keys":{"k1":"<base64>","k2":"<base64>"}}.',
  active_kid_missing: 'TOKENGATE_KEYRING names an active key id that is not in its "keys" list.',
  key_not_32_bytes: 'A configured key is not exactly 32 bytes encoded as base64.',
  both_kek_and_keyring_set:
    'Both TOKENGATE_KEK and TOKENGATE_KEYRING are set. Keep only one of them.',
};

/** Why a stored credential could not be opened, completing "The stored credential …". */
const OPEN_ERROR_TEXT: Readonly<Record<OpenCredentialError, string>> = {
  sealed_malformed: 'is damaged',
  keyring_missing_key: 'was encrypted with a key that is not in the keyring',
  credential_binding_mismatch:
    "does not match the service's current base URL or injection (it may have been tampered with)",
};

const NOTHING_WRITTEN = 'Nothing was re-encrypted.';

export interface KeyringStatus {
  /** Null when the keyring loaded; otherwise why credentials cannot be stored or used. */
  error: KeyringError | null;
  activeKid: string | null;
  /** Loaded keys with their key check values (safe to display) and credential counts. */
  keys: Array<{ kid: string; kcv: string; active: boolean; credentials: number }>;
  /** Stored credentials per key id, including ids missing from the keyring. */
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
  const kids = keyring?.kids ?? [];
  const sealedKids = Object.keys(credentialsByKid);
  return {
    error: loaded.ok ? null : loaded.error,
    activeKid: keyring?.activeKid ?? null,
    keys: kids.map((kid) => ({
      kid,
      kcv: keyring?.kcv[kid] ?? '',
      active: kid === keyring?.activeKid,
      credentials: credentialsByKid[kid] ?? 0,
    })),
    credentialsByKid,
    missingKids: keyring ? sealedKids.filter((kid) => !kids.includes(kid)) : sealedKids,
    unreadableCredentials,
    needsRewrap: sealedKids
      .filter((kid) => kid !== keyring?.activeKid)
      .reduce((sum, kid) => sum + (credentialsByKid[kid] ?? 0), 0),
  };
}

export interface RewrapResult {
  ok: true;
  activeKid: string;
  /** Credentials re-sealed under the active key. */
  rewrapped: number;
  /** Candidates changed concurrently (e.g. a new credential was saved); left as written. */
  skipped: number;
  /** Kids whose changed key check value was accepted: every credential under them opened. */
  confirmedKids: string[];
}

/**
 * Re-seals every credential not under the active key. Also opens every credential under a kid
 * whose recorded key check value differs from the loaded key (key material replaced, see
 * src/health.ts); when all of them open, the new check value is recorded, which clears the
 * keyring alert. This is the only path that replaces a recorded check value.
 * All-or-nothing on problems: if any candidate is malformed, uses a key missing from the keyring,
 * or fails to open, nothing is written and the affected services are listed. With no candidates
 * it returns early: nothing changes, so there is nothing to audit.
 */
export async function rewrapCredentials(
  deps: Deps,
  actor: Actor,
): Promise<RewrapResult | OpFailure> {
  const loaded = await loadKeyring(deps.env);
  if (!loaded.ok) {
    return opFailure('unavailable', [KEYRING_ERROR_TEXT[loaded.error], NOTHING_WRITTEN]);
  }
  const keyring = loaded.keyring;
  const db = deps.env.DB;
  const [rows, recordedRow] = await Promise.all([
    listSealedCredentials(db),
    recordedKcvStatement(db).first<{ value: string }>(),
  ]);
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
  const candidates = rows.filter((row) => {
    const kid = sealedKid(row.credential_sealed);
    return kid !== keyring.activeKid || changedKids.includes(kid);
  });
  if (candidates.length === 0) {
    return { ok: true, activeKid: keyring.activeKid, rewrapped: 0, skipped: 0, confirmedKids: [] };
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
    // Credentials under the active kid were only checked; they stay as they are.
    if (kid === keyring.activeKid) continue;
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
  // Every credential under these kids now opens with the loaded key (changed kids were all opened
  // above; under the active kid, rows are resealed now or already matched). Compare-and-swap on the
  // value read: a concurrent rewrap may record the same kid.
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
      // Written in the same batch as the compare-and-swaps, so it states candidates, not outcomes.
      summary: `Re-encrypt ${resealed.length} credential(s) with key ${keyring.activeKid} (rows changed meanwhile are skipped)${confirmed}`,
      diff: {
        active_kid: keyring.activeKid,
        candidates: resealed.length,
        from_kids: fromKids,
        ...(changedKids.length > 0 ? { confirmed_kids: changedKids } : {}),
      },
    },
    null,
    [
      ...resealed.map((item) =>
        rewrapCredentialStatement(db, item.id, item.newSealed, item.oldSealed),
      ),
      ...kcvStatements,
    ],
  );
  if (!outcome.ok) return outcome;
  const rewrapped = outcome.results
    .slice(1, 1 + resealed.length)
    .reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
  return {
    ok: true,
    activeKid: keyring.activeKid,
    rewrapped,
    skipped: resealed.length - rewrapped,
    confirmedKids: changedKids,
  };
}
