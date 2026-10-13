// Everything the proxy needs from the control plane, read in one D1 batch per request (no caching,
// so disabling a grant, service or caller provider takes effect on the next request; I-AUTHZ-1).
import { callerProviderFromRow, grantFromRow, serviceFromRow } from './rows';
import { type Settings, settingsFromRows, settingsStatement } from './settings';
import type { CallerProvider, Grant, Service } from './types';

export interface ProxyContext {
  /** The service with this slug, or null when it does not exist or is disabled. */
  service: Service | null;
  /** The slug exists but the service is disabled. Only used for the request record reason. */
  serviceDisabled: boolean;
  /** Enabled caller providers; the handler picks one by the token's issuer. */
  callerProviders: CallerProvider[];
  /**
   * Enabled, unexpired grants of the (enabled) service whose caller provider is enabled, in
   * evaluation order (created_at, id). Empty when the service is missing or disabled.
   */
  grants: Grant[];
  settings: Settings;
}

type Row = Record<string, unknown>;

export async function loadProxyContext(
  db: D1Database,
  slug: string,
  now: number,
): Promise<ProxyContext> {
  // `enabled = 1` is written literally so the partial index grants_lookup (WHERE enabled = 1) applies.
  const [services, providers, grants, settings] = await db.batch<Row>([
    db.prepare('SELECT * FROM services WHERE slug = ?1').bind(slug),
    db.prepare('SELECT * FROM caller_providers WHERE enabled = 1 ORDER BY created_at, id'),
    db
      .prepare(
        `SELECT g.* FROM grants g
           JOIN services s ON s.id = g.service_id
           JOIN caller_providers p ON p.id = g.caller_provider_id
         WHERE s.slug = ?1 AND s.enabled = 1 AND p.enabled = 1
           AND g.enabled = 1 AND (g.expires_at IS NULL OR g.expires_at > ?2)
         ORDER BY g.created_at, g.id`,
      )
      .bind(slug, now),
    settingsStatement(db),
  ]);

  const serviceRow = services?.results[0];
  const service = serviceRow ? serviceFromRow(serviceRow) : null;
  return {
    service: service?.enabled ? service : null,
    serviceDisabled: service !== null && !service.enabled,
    callerProviders: (providers?.results ?? [])
      .map(callerProviderFromRow)
      .filter((provider) => provider.enabled),
    grants: service?.enabled
      ? (grants?.results ?? [])
          .map(grantFromRow)
          .filter((grant) => grant.enabled && grant.service_id === service.id)
      : [],
    settings: settingsFromRows((settings?.results ?? []) as Array<{ key: string; value: string }>),
  };
}
