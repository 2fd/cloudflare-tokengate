// The model of the connections map (ui ConnectionsMap) on Issuer access rules: every credential access rule and
// token as a node, the given accesses as wires, a status line per token that says why a line needs
// attention, and the token's last 24 hours of traffic. Display only.
import type { MapAccess, MapConsumer, MapToken } from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import type { TokenTraffic } from '../access-traffic';
import type { AccessEdge, Connections } from '../connections';
import { paths } from '../paths';
import { accessTone, consumerLogo, operationsText, tokenLogo, trustLine } from './access-visuals';
import { lastUsedTime } from './format';
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

/** The map of `connections`, wiring only `accesses` (the filtered ones). */
export function mapModel(
  connections: Connections,
  accesses: readonly AccessEdge[],
  traffic: TokenTraffic,
  now: number,
): MapModel {
  const all = connections.accesses;
  const consumers: MapConsumer[] = connections.consumers.map((consumer) => {
    const own = all.filter((edge) => edge.grant.credential_access_rule_id === consumer.id);
    const quiet =
      connections.usageAvailable && own.length > 0 && own.every((e) => e.lastUsedHour === null);
    const idle = !consumer.enabled || quiet;
    const labels = connections.labels.filter((l) => l.credential_access_rule_id === consumer.id);
    const line = trustLine(consumer, labels);
    return {
      id: consumer.id,
      name: consumer.name,
      logo: consumerLogo(consumer),
      line: !consumer.enabled ? `${line} · disabled` : quiet ? `${line} · idle 30+ days` : line,
      idle,
      weight: own.length,
    };
  });
  let idleTagged = false;
  const tokens: MapToken[] = connections.tokens.map((token) => {
    const own = all.filter((edge) => edge.grant.service_id === token.id);
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

function mapAccess(edge: AccessEdge): MapAccess {
  const risky = edge.flags.some((flag) => flag.status === 'risk_accepted');
  const tone = accessTone(edge.status);
  return {
    consumer: edge.grant.credential_access_rule_id,
    token: edge.grant.service_id,
    tone: risky && tone === 'ok' ? 'warn' : tone,
    status: statusLabel(edge.status, edge.statusDetail),
    consumerLabel: `${edge.consumer?.name ?? 'Deleted credential access rule'} › ${edge.subject}`,
    context: edge.context,
    operation: operationsText(edge),
    href: paths.accessItem(edge.grant.id),
  };
}

/** The token's second line: the first reason a line to it needs attention, else its consumers. */
function tokenLine(
  token: Connections['tokens'][number],
  own: readonly AccessEdge[],
  now: number,
): { line: Child; lineTone?: 'warn' | 'bad' } {
  const consumers = new Set(own.map((edge) => edge.grant.credential_access_rule_id)).size;
  if (!token.enabled) return { line: '⏸ Disabled · its access is inactive' };
  const expires = token.credential_expires_at;
  if (expires !== null && expires > now && expires - now <= EXPIRY_WARNING_MS) {
    const days = Math.max(1, Math.ceil((expires - now) / DAY_MS));
    return { line: `⌛ Secret expires in ${plural(days, 'day', 'days')}`, lineTone: 'warn' };
  }
  const expired = own.filter((edge) => edge.status === 'expired').length;
  if (expired > 0) {
    return {
      line: `✕ ${expired} of ${plural(own.length, 'access', 'accesses')} expired`,
      lineTone: 'bad',
    };
  }
  const risky = own.filter((edge) => edge.flags.some((f) => f.status === 'risk_accepted')).length;
  if (risky > 0) {
    return { line: `⚠ Risk accepted on ${plural(risky, 'access', 'accesses')}`, lineTone: 'warn' };
  }
  const expiring = own.filter((edge) => edge.status === 'expiring');
  const first = expiring[0];
  if (first) {
    // One short line (the node is one row high): "⌛ 1 access expires in 9 days".
    return {
      line:
        expiring.length === 1
          ? `⌛ 1 access ${statusLabel('expiring', first.statusDetail).toLowerCase()}`
          : `⌛ ${expiring.length} accesses expire soon`,
      lineTone: 'warn',
    };
  }
  return {
    line:
      consumers === 0
        ? 'No consumer yet'
        : plural(consumers, 'credential access rule', 'credential access rules'),
  };
}

/**
 * The nodes the map groups into "+ N more" (its scale rule, busiest first, `maxRows` per side),
 * so `?consumers=rest` / `?tokens=rest` open the matrix filtered to them. Mirrors the ui pick.
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
