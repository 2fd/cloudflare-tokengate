// Upstream host allowlist changes (owner only, enforced by RBAC; I-SSRF-1). The new list and one
// audit row are written in one db.batch (I-AUDIT-1). An owner allows a host either on Service
// tokens › Allowed hosts (updateUpstreamHosts) or from a token form (addUpstreamHost, committed as
// its own audited change before the token is saved).
import { hostListed, isUpstreamHostEntry } from '../../config';
import {
  putSettingGuardedStatement,
  settingValueGuard,
  UPSTREAM_HOSTS_KEY,
  upstreamHostsFromValue,
  upstreamHostsStatement,
} from '../../db/settings';
import type { Actor } from '../../db/types';
import type { Deps } from '../../deps';
import { commitOrConstraintFailure, type OpFailure, opFailure } from './shared';

/**
 * One entry as typed or pasted: a URL is reduced to its host (`https://api.github.com/v3` →
 * `api.github.com`), everything is lowercased. Not validated here.
 */
export function upstreamHostEntry(raw: string): string {
  const text = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      return new URL(text).hostname.toLowerCase();
    } catch {
      return text.toLowerCase();
    }
  }
  return text.toLowerCase();
}

/** Why an entry cannot be on the list, as the fix to make; null when it can. */
export function upstreamHostEntryError(
  entry: string,
  gatewayHosts: readonly string[] = [],
): string | null {
  const host = entry.startsWith('*.') ? entry.slice(2) : entry;
  if (/^[0-9.]+$/.test(host) || host.startsWith('[')) {
    return `${entry} is an IP address; enter a host name like api.example.com`;
  }
  if (host.includes(':'))
    return `${entry} has a port; enter the host name only, like api.example.com`;
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return `${entry} is not a public host; enter a host name like api.example.com`;
  }
  if (host === 'workers.dev' || host.endsWith('.workers.dev')) {
    return `${entry} is a workers.dev Worker, which tokens may not call`;
  }
  if (!isUpstreamHostEntry(entry)) {
    return `${entry} is not a host name; enter one like api.example.com, or *.example.com for every host below example.com`;
  }
  if (!entry.startsWith('*.') && hostListed(entry, gatewayHosts)) {
    return `${entry} is this gateway; tokens may not call it`;
  }
  return null;
}

/**
 * Parses an allowlist text: entries separated by new lines, commas or spaces; URLs reduced to
 * hosts; lowercased and deduplicated. Empty input means "any public https host" (null). Errors
 * name the line.
 */
export function parseUpstreamHostInput(
  raw: unknown,
  options: { gatewayHosts?: readonly string[] } = {},
): { ok: true; hosts: string[] | null } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: true, hosts: null };
  const hosts: string[] = [];
  const errors: string[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const part of line.split(/[\s,]+/)) {
      if (part.trim() === '') continue;
      const entry = upstreamHostEntry(part);
      const error = upstreamHostEntryError(entry, options.gatewayHosts);
      if (error) errors.push(lines.length > 1 ? `Line ${index + 1}: ${error}` : error);
      else if (!hosts.includes(entry)) hosts.push(entry);
    }
  });
  if (errors.length > 0) return { ok: false, error: errors.slice(0, 5).join('. ') };
  return { ok: true, hosts: hosts.length > 0 ? hosts : null };
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
  return writeUpstreamHosts(deps, actor, parsed.hosts);
}

/**
 * Adds one host (a host or a pasted URL) to the allowlist. A no-op without an audit row when any
 * public host is allowed already (no list) or the list already covers the host.
 */
export async function addUpstreamHost(
  deps: Deps,
  actor: Actor,
  raw: string,
): Promise<{ ok: true; host: string; changed: boolean } | OpFailure> {
  const host = upstreamHostEntry(raw);
  const error = upstreamHostEntryError(host);
  if (error || host.startsWith('*.'))
    return opFailure('invalid', [error ?? `${host} is not a host`]);
  const stored = (await upstreamHostsStatement(deps.env.DB).first<{ value: string }>())?.value;
  const current = upstreamHostsFromValue(stored);
  if (current === null || hostListed(host, current)) return { ok: true, host, changed: false };
  const written = await writeUpstreamHosts(deps, actor, [...current, host]);
  return written.ok ? { ok: true, host, changed: written.changed } : written;
}

async function writeUpstreamHosts(
  deps: Deps,
  actor: Actor,
  hosts: string[] | null,
): Promise<{ ok: true; hosts: string[] | null; changed: boolean } | OpFailure> {
  const db = deps.env.DB;
  const stored = (await upstreamHostsStatement(db).first<{ value: string }>())?.value ?? null;
  const before = upstreamHostsFromValue(stored);
  // A malformed stored value reads as [] (deny all): saving any list replaces it.
  if (stored !== null && JSON.stringify(before) === JSON.stringify(hosts)) {
    return { ok: true, hosts: before, changed: false };
  }
  if (stored === null && hosts === null) return { ok: true, hosts: null, changed: false };
  const guard = settingValueGuard(UPSTREAM_HOSTS_KEY, stored);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'settings.upstream_hosts',
      targetType: 'settings',
      targetId: null,
      summary:
        hosts === null
          ? 'Services may use any public https host'
          : `Upstream host allowlist set (${hosts.length} entries)`,
      diff: { before, after: hosts },
    },
    guard,
    [putSettingGuardedStatement(db, UPSTREAM_HOSTS_KEY, hosts, deps.now(), actor.id, guard)],
  );
  if (!outcome.ok) return outcome;
  if (!outcome.committed)
    return opFailure('conflict', [
      'The allowlist was changed by someone else; nothing was saved. Reload and retry.',
    ]);
  return { ok: true, hosts, changed: true };
}
