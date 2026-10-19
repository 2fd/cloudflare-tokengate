// The model of the connections map (ui ConnectionsMap): every issuer and credential as a node, the
// credential access rules as wires, a status line per credential that says why a line needs attention,
// and the credential's last 24 hours of traffic. Display only. WP-R3 redraws it (§A7.10).
import type { MapAccess, MapConsumer, MapToken } from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import type { TokenTraffic } from '../access-traffic';
import type { Connections, RuleEdge } from '../connections';
import { paths } from '../paths';
import { accessTone, issuerLogo, operationsText, tokenLogo } from './access-visuals';
import { lastUsedTime } from './format';
import { issuerNodes } from './matrix';
import { statusLabel } from './status';

const DAY_MS = 86_400_000;
const EXPIRY_WARNING_MS = 14 * DAY_MS;

export interface MapModel {
  consumers: MapConsumer[];
  tokens: MapToken[];
  accesses: MapAccess[];
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The map of `connections`, wiring only `accesses` (the filtered rules). */
export function mapModel(
  connections: Connections,
  accesses: readonly RuleEdge[],
  traffic: TokenTraffic,
  now: number,
): MapModel {
  const all = connections.rules;
  const consumers: MapConsumer[] = issuerNodes(connections).map((issuer) => {
    const own = all.filter((edge) => edge.rule.issuer_key === issuer.id);
    const quiet =
      connections.usageAvailable && own.length > 0 && own.every((e) => e.lastUsedHour === null);
    const line = issuer.id;
    return {
      id: issuer.id,
      name: issuer.name,
      logo: issuerLogo({ ...issuer.first, enabled: true }),
      line: quiet ? `${line} · idle 30+ days` : line,
      idle: quiet,
      weight: own.length,
    };
  });
  let idleTagged = false;
  const tokens: MapToken[] = connections.credentials.map((token) => {
    const own = all.filter((edge) => edge.rule.credential_id === token.id);
    const stats = traffic.byToken.get(token.id);
    const hours = own.map((e) => e.lastUsedHour).filter((h): h is number => h !== null);
    const requests = stats?.requests ?? 0;
    const idle = !token.enabled || (requests === 0 && hours.length === 0);
    const tag = idle && !idleTagged ? '1 idle token' : undefined;
    if (tag) idleTagged = true;
    return {
      id: token.id,
      name: token.name,
      slug: token.slug,
      logo: tokenLogo(token),
      requests,
      denied: stats?.denied ?? 0,
      errors: stats?.errors ?? 0,
      hrefs: traffic.available
        ? {
            requests: paths.requests({ token: token.id }),
            denied: paths.requests({ token: token.id, outcome: 'denied' }),
            errors: paths.requests({ token: token.id, outcome: 'error' }),
          }
        : undefined,
      lastUsed: hours.length > 0 ? lastUsedTime(Math.max(...hours), now) : '—',
      idle,
      ...(tag ? { tag } : {}),
      ...tokenLine(token, own, now),
    };
  });
  return {
    consumers,
    tokens,
    accesses: accesses.map((edge) => mapAccess(edge)),
  };
}

function mapAccess(edge: RuleEdge): MapAccess {
  const risky = edge.flags.some((flag) => flag.status === 'risk_accepted');
  const tone = accessTone(edge.status);
  return {
    consumer: edge.rule.issuer_key,
    token: edge.rule.credential_id,
    tone: risky && tone === 'ok' ? 'warn' : tone,
    status: statusLabel(edge.status, edge.statusDetail),
    consumerLabel: `${edge.rule.name} › ${edge.subject}`,
    context: edge.context,
    operation: operationsText(edge),
    href: paths.accessRule(edge.rule.id),
  };
}

/** The credential's second line: the first reason a line to it needs attention, else its issuers. */
function tokenLine(
  token: Connections['credentials'][number],
  own: readonly RuleEdge[],
  now: number,
): { line: Child; lineTone?: 'warn' | 'bad' } {
  const issuers = new Set(own.map((edge) => edge.rule.issuer_key)).size;
  if (!token.enabled) return { line: '⏸ Disabled · its access rules are inactive' };
  const expires = token.credential_expires_at;
  if (expires !== null && expires > now && expires - now <= EXPIRY_WARNING_MS) {
    const days = Math.max(1, Math.ceil((expires - now) / DAY_MS));
    return { line: `⌛ Secret expires in ${plural(days, 'day', 'days')}`, lineTone: 'warn' };
  }
  const expired = own.filter((edge) => edge.status === 'expired').length;
  if (expired > 0) {
    return {
      line: `✕ ${expired} of ${plural(own.length, 'access rule', 'access rules')} expired`,
      lineTone: 'bad',
    };
  }
  const risky = own.filter((edge) => edge.flags.some((f) => f.status === 'risk_accepted')).length;
  if (risky > 0) {
    return {
      line: `⚠ Risk accepted on ${plural(risky, 'access rule', 'access rules')}`,
      lineTone: 'warn',
    };
  }
  const expiring = own.filter((edge) => edge.status === 'expiring');
  const first = expiring[0];
  if (first) {
    // One short line (the node is one row high): "⌛ 1 access rule expires in 9 days".
    return {
      line:
        expiring.length === 1
          ? `⌛ 1 access rule ${statusLabel('expiring', first.statusDetail).toLowerCase()}`
          : `⌛ ${expiring.length} access rules expire soon`,
      lineTone: 'warn',
    };
  }
  return {
    line: issuers === 0 ? 'No access rule yet' : plural(issuers, 'issuer', 'issuers'),
  };
}

/**
 * The nodes the map groups into "+ N more" (its scale rule, busiest first, `maxRows` per side),
 * so the matrix can open filtered to them. Mirrors the ui pick.
 */
export function groupedRest<T extends { id: string }>(
  sorted: readonly T[],
  maxRows: number,
  must: ReadonlySet<string> = new Set(),
): Set<string> {
  if (sorted.length <= maxRows) return new Set();
  const chosen = new Set(sorted.filter((node) => must.has(node.id)).map((node) => node.id));
  for (const node of sorted) {
    if (chosen.size >= maxRows - 1) break;
    chosen.add(node.id);
  }
  return new Set(sorted.filter((node) => !chosen.has(node.id)).map((node) => node.id));
}
