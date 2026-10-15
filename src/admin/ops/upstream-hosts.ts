// Upstream host allowlist changes (owner only, enforced by RBAC; I-SSRF-1). The new list and one
// audit row are written in one db.batch (I-AUDIT-1).
import { isUpstreamHostEntry } from '../../config';
import {
  putSettingGuardedStatement,
  settingValueGuard,
  UPSTREAM_HOSTS_KEY,
  upstreamHostsFromValue,
  upstreamHostsStatement,
} from '../../db/settings';
import type { Actor } from '../../db/types';
import type { Deps } from '../../deps';
import { commitOrConstraintFailure, hostListEntries, type OpFailure, opFailure } from './shared';

/**
 * Parses the allowlist textarea: entries separated by commas, spaces or new lines, lowercased and
 * deduplicated. Empty input means "any public https host" (null).
 */
export function parseUpstreamHostInput(
  raw: unknown,
): { ok: true; hosts: string[] | null } | { ok: false; error: string } {
  const entries = hostListEntries(raw);
  if (entries.length === 0) return { ok: true, hosts: null };
  const invalid = entries.filter((entry) => !isUpstreamHostEntry(entry));
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Not a hostname or "*.<domain>" with at least two labels: ${invalid.slice(0, 5).join(', ')}`,
    };
  }
  return { ok: true, hosts: entries };
}

/**
 * Sets the upstream host allowlist (I-SSRF-1); one audit row in the same batch (I-AUDIT-1). The
 * write is guarded on the stored value it replaces, so a concurrent change is a conflict.
 */
export async function updateUpstreamHosts(
  deps: Deps,
  actor: Actor,
  raw: unknown,
): Promise<{ ok: true; hosts: string[] | null; changed: boolean } | OpFailure> {
  const parsed = parseUpstreamHostInput(raw);
  if (!parsed.ok) return opFailure('invalid', [parsed.error]);
  const db = deps.env.DB;
  const stored = (await upstreamHostsStatement(db).first<{ value: string }>())?.value ?? null;
  const before = upstreamHostsFromValue(stored);
  if (JSON.stringify(before) === JSON.stringify(parsed.hosts)) {
    return { ok: true, hosts: before, changed: false };
  }
  const guard = settingValueGuard(UPSTREAM_HOSTS_KEY, stored);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'settings.upstream_hosts',
      targetType: 'settings',
      targetId: null,
      summary:
        parsed.hosts === null
          ? 'Services may use any public https host'
          : `Upstream host allowlist set (${parsed.hosts.length} entries)`,
      diff: { before, after: parsed.hosts },
    },
    guard,
    [putSettingGuardedStatement(db, UPSTREAM_HOSTS_KEY, parsed.hosts, deps.now(), actor.id, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed)
    return opFailure('conflict', [
      'The allowlist was changed by someone else; nothing was saved. Reload and retry.',
    ]);
  return { ok: true, hosts: parsed.hosts, changed: true };
}
