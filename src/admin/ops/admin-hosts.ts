// Admin host allowlist changes (owner only, enforced by RBAC; I-DEPLOY-1): one host added or
// removed per change. The new list and one audit row are written in one db.batch (I-AUDIT-1), and
// the write is guarded on the stored value it was computed from.
import { hostListed, isAdminHostEntry } from '../../config';
import {
  ADMIN_HOSTS_KEY,
  adminHostsFromValue,
  adminHostsStatement,
  putSettingGuardedStatement,
  settingValueGuard,
} from '../../db/settings';
import type { Actor } from '../../db/types';
import type { Deps } from '../../deps';
import {
  commitOrConstraintFailure,
  fieldError,
  hostListEntries,
  type OpFailure,
  opFailure,
} from './shared';

export const ADMIN_HOST_MESSAGE =
  'Enter a hostname like admin.acme.com or *.acme.com. workers.dev is never allowed.';

/**
 * A pasted hostname or URL reduced to the hostname: trimmed and lowercased, without the scheme,
 * path, query, fragment, port and trailing dot. `https://Admin.Acme.com:8443/x/` → `admin.acme.com`.
 */
export function normalizeHostInput(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let host = raw.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.split(/[/?#]/, 1)[0] ?? '';
  if (host.startsWith('[')) {
    // An IPv6 literal keeps its brackets; only a port after them is dropped.
    const end = host.indexOf(']');
    host = end === -1 ? host : host.slice(0, end + 1);
  } else {
    host = host.replace(/:[0-9]*$/, '');
  }
  return host.replace(/\.$/, '');
}

/**
 * Checks a complete admin host list (entries separated by commas, spaces or new lines, or an
 * array). The list may not be empty, and must keep `currentHost` (the hostname of the request
 * saving it) so an owner cannot lock themselves out (I-DEPLOY-1).
 */
export function parseAdminHostInput(
  raw: unknown,
  currentHost: string,
): { ok: true; hosts: string[] } | { ok: false; error: string } {
  const entries = Array.isArray(raw)
    ? hostListEntries(raw.filter((entry) => typeof entry === 'string').join('\n'))
    : hostListEntries(raw);
  if (entries.length === 0) {
    return { ok: false, error: 'Keep at least one host: the admin console answers only on these.' };
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
      error: `Keep ${currentHost} covered: it is the host you are using now, and without it this page stops answering.`,
    };
  }
  return { ok: true, hosts: entries };
}

export type AdminHostsResult =
  | {
      ok: true;
      hosts: string[];
      /** `saved`: written with one audit row; otherwise nothing was written. */
      outcome: 'saved' | 'host_present' | 'host_absent';
      auditId: string | null;
    }
  | OpFailure;

/**
 * Adds or removes one admin host (exactly one of `add` and `remove`). The base list is the stored
 * one, or `[currentHost]` while none is stored, so the first change pins the console to the host in
 * use. An added URL is reduced to its hostname. The result must keep the current host covered
 * (wildcards included) and not be empty. A concurrent change to the stored list is a conflict.
 */
export async function updateAdminHosts(
  deps: Deps,
  actor: Actor,
  change: { add?: unknown; remove?: unknown },
  currentHost: string,
): Promise<AdminHostsResult> {
  const add = normalizeHostInput(change.add);
  const remove = typeof change.remove === 'string' ? change.remove.trim().toLowerCase() : '';
  if ((add === '') === (remove === '')) {
    return opFailure('invalid', [fieldError('add', ADMIN_HOST_MESSAGE)]);
  }
  if (add !== '' && !isAdminHostEntry(add)) {
    return opFailure('invalid', [fieldError('add', ADMIN_HOST_MESSAGE)]);
  }
  const db = deps.env.DB;
  const stored = (await adminHostsStatement(db).first<{ value: string }>())?.value ?? null;
  const before = adminHostsFromValue(stored);
  const base = before ?? [currentHost.toLowerCase()];
  let next: string[];
  if (add !== '') {
    // Nothing stored yet: writing the current host alone is the one-click pin, so it is a change.
    if (before !== null && before.includes(add)) {
      return { ok: true, hosts: before, outcome: 'host_present', auditId: null };
    }
    next = base.includes(add) ? base : [...base, add];
  } else {
    if (!base.includes(remove)) {
      return { ok: true, hosts: before ?? [], outcome: 'host_absent', auditId: null };
    }
    next = base.filter((host) => host !== remove);
  }
  const parsed = parseAdminHostInput(next, currentHost);
  if (!parsed.ok) {
    return opFailure('invalid', [fieldError(add !== '' ? 'add' : null, parsed.error)]);
  }
  const guard = settingValueGuard(ADMIN_HOSTS_KEY, stored);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'settings.admin_hosts',
      targetType: 'settings',
      targetId: null,
      summary:
        add !== ''
          ? `Admin host ${add} added (${parsed.hosts.length} entries)`
          : `Admin host ${remove} removed (${parsed.hosts.length} entries)`,
      diff: { before, after: parsed.hosts },
    },
    guard,
    [putSettingGuardedStatement(db, ADMIN_HOSTS_KEY, parsed.hosts, deps.now(), actor.id, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed) {
    return opFailure('conflict', [
      'The admin hosts changed meanwhile. The page shows the current list.',
    ]);
  }
  return { ok: true, hosts: parsed.hosts, outcome: 'saved', auditId: outcome.event.id };
}
