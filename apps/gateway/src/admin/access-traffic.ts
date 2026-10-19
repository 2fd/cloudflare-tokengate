// The last 24 hours of traffic per credential, for the connections map of credential access rules:
// requests, denied and errors per token, and the requests refused before a token was chosen.
// Stored hourly rollups up to the previous hour, then request_log aggregated live for the previous
// and the current hour, so nothing counts twice whatever the state of the cron. Monitoring data is
// display only; when TELEMETRY_DB cannot be read the map shows zeros and says nothing about it.
import {
  aggregateRequestLogStatement,
  denialGroupFromRow,
  denialGroupsStatement,
  edgeTotalsStatement,
  HOUR_MS,
  type RollupRow,
  rollupFromRow,
} from '../db/rollups';
import type { Deps } from '../deps';
import { type TrafficStats, trafficStats } from '../telemetry/dashboard';
import { hourStart } from '../telemetry/rollup';

export interface TokenTraffic {
  /** Per token id; tokens with no request in the window are missing. */
  byToken: Map<string, TrafficStats>;
  /** Requests refused before a token was chosen (no service resolved). */
  refused: number;
  /** False when TELEMETRY_DB could not be read. */
  available: boolean;
}

export async function loadTokenTraffic(deps: Pick<Deps, 'env' | 'now'>): Promise<TokenTraffic> {
  const telemetry = deps.env.TELEMETRY_DB;
  const current = hourStart(deps.now());
  const liveFrom = current - HOUR_MS;
  const from = current - 23 * HOUR_MS;
  let rows: RollupRow[];
  try {
    const results = await telemetry.batch([
      edgeTotalsStatement(telemetry, from, liveFrom),
      aggregateRequestLogStatement(telemetry, liveFrom, current),
      aggregateRequestLogStatement(telemetry, current, current + HOUR_MS),
    ]);
    rows = results.flatMap((result) =>
      ((result.results ?? []) as Array<Record<string, unknown>>).map(rollupFromRow),
    );
  } catch {
    return { byToken: new Map(), refused: 0, available: false };
  }
  const grouped = new Map<string, RollupRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.service_id) ?? [];
    list.push(row);
    grouped.set(row.service_id, list);
  }
  const byToken = new Map<string, TrafficStats>();
  for (const [serviceId, list] of grouped) {
    if (serviceId !== '') byToken.set(serviceId, trafficStats(list));
  }
  const refused = trafficStats(grouped.get('') ?? []).requests;
  return { byToken, refused, available: true };
}

/**
 * An issuer that no credential access rule names, seen on refused requests (the text is
 * unverified, I-LOG-2).
 */
export interface UnknownIssuer {
  issuer: string;
  /** Weighted count of refused requests. */
  requests: number;
  latestTs: number;
}

/**
 * The issuers of the last 24 hours' `issuer_unknown` refusals, most requests first, for the
 * unknown issuers panel of the credential access rules list. Display only: empty when
 * TELEMETRY_DB cannot be read.
 */
export async function loadUnknownIssuers(
  deps: Pick<Deps, 'env' | 'now'>,
  limit = 3,
): Promise<UnknownIssuer[]> {
  const telemetry = deps.env.TELEMETRY_DB;
  try {
    const result = await denialGroupsStatement(telemetry, deps.now() - 24 * HOUR_MS).all();
    return ((result.results ?? []) as Array<Record<string, unknown>>)
      .map(denialGroupFromRow)
      .filter(
        (group) =>
          group.reason === 'issuer_unknown' &&
          group.claims_verified === 0 &&
          group.caller_kind === 'issuer' &&
          group.caller !== null,
      )
      .slice(0, limit)
      .map((group) => ({
        issuer: group.caller ?? '',
        requests: group.requests,
        latestTs: group.latest_ts,
      }));
  } catch {
    return [];
  }
}
