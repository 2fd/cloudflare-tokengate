// Admin host allowlist changes (owner only, enforced by RBAC; I-DEPLOY-1). The new list and one
// audit row are written in one db.batch (I-AUDIT-1).
import { hostListed, isAdminHostEntry } from '../../config';
import { ADMIN_HOSTS_KEY, getAdminHosts, putSettingStatement } from '../../db/settings';
import type { Actor } from '../../db/types';
import type { Deps } from '../../deps';
import { commitOrConstraintFailure, hostListEntries, type OpFailure, opFailure } from './shared';

/**
 * Parses the admin hosts textarea. The list may not be empty, and must keep `currentHost` (the
 * hostname of the request saving it) so an owner cannot lock themselves out (I-DEPLOY-1).
 */
export function parseAdminHostInput(
  raw: unknown,
  currentHost: string,
): { ok: true; hosts: string[] } | { ok: false; error: string } {
  const entries = hostListEntries(raw);
  if (entries.length === 0) {
    return { ok: false, error: 'List at least one host: the admin console answers only on these.' };
  }
  const invalid = entries.filter((entry) => !isAdminHostEntry(entry));
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Not a hostname or "*.<domain>" with at least two labels, or on workers.dev: ${invalid.slice(0, 5).join(', ')}`,
    };
  }
  if (!hostListed(currentHost, entries)) {
    return {
      ok: false,
      error: `Keep ${currentHost} in the list: it is the host you are using now, and without it this page stops answering.`,
    };
  }
  return { ok: true, hosts: entries };
}

/** Sets the admin host allowlist (I-DEPLOY-1); one audit row in the same batch (I-AUDIT-1). */
export async function updateAdminHosts(
  deps: Deps,
  actor: Actor,
  raw: unknown,
  currentHost: string,
): Promise<{ ok: true; hosts: string[]; changed: boolean } | OpFailure> {
  const parsed = parseAdminHostInput(raw, currentHost);
  if (!parsed.ok) return opFailure('invalid', [parsed.error]);
  const db = deps.env.DB;
  const before = await getAdminHosts(db);
  if (JSON.stringify(before) === JSON.stringify(parsed.hosts)) {
    return { ok: true, hosts: parsed.hosts, changed: false };
  }
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'settings.admin_hosts',
      targetType: 'settings',
      targetId: null,
      summary: `Admin hosts set (${parsed.hosts.length} entries)`,
      diff: { before, after: parsed.hosts },
    },
    null,
    [putSettingStatement(db, ADMIN_HOSTS_KEY, parsed.hosts, deps.now(), actor.id)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed)
    return opFailure('conflict', ['the admin hosts were not saved; reload and retry']);
  return { ok: true, hosts: parsed.hosts, changed: true };
}
