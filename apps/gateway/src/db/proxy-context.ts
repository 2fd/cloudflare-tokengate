// Everything the proxy needs from the control plane, read in one D1 batch per request (no caching,
// so disabling a grant, service or credential access rule takes effect on the next request; I-AUTHZ-1).
import { credentialAccessRuleFromRow, grantFromRow, serviceFromRow } from './rows';
import {
  adminHostsFromValue,
  adminHostsStatement,
  type Settings,
  settingsFromRows,
  settingsStatement,
  upstreamHostsFromValue,
  upstreamHostsStatement,
} from './settings';
import type { CredentialAccessRule, IssuerAccessRule, Service } from './types';

export interface ProxyContext {
  /** The service with this slug, or null when it does not exist or is disabled. */
  service: Service | null;
  /** The slug exists but the service is disabled. Only used for the request record reason. */
  serviceDisabled: boolean;
  /** Enabled credential access rules; the handler picks one by the token's issuer. */
  credentialAccessRules: CredentialAccessRule[];
  /**
   * Enabled, unexpired issuer_access_rules of the (enabled) service whose credential access rule is enabled, in
   * evaluation order (created_at, id). Empty when the service is missing or disabled.
   */
  issuer_access_rules: IssuerAccessRule[];
  settings: Settings;
  /** Upstream host allowlist (I-SSRF-1); null = any public https host. */
  allowedUpstreamHosts: string[] | null;
  /** Admin host allowlist (I-DEPLOY-1); base URLs may not point at it (I-SSRF-1). */
  adminHosts: string[] | null;
}

type Row = Record<string, unknown>;

export async function loadProxyContext(
  db: D1Database,
  slug: string,
  now: number,
): Promise<ProxyContext> {
  // `enabled = 1` is written literally so the partial index grants_lookup (WHERE enabled = 1) applies.
  const [credentials, providers, issuer_access_rules, settings, upstreamHosts, adminHosts] =
    await db.batch<Row>([
      db.prepare('SELECT * FROM credentials WHERE slug = ?1').bind(slug),
      db.prepare('SELECT * FROM credential_access_rules WHERE enabled = 1 ORDER BY created_at, id'),
      db
        .prepare(
          `SELECT g.* FROM issuer_access_rules g
           JOIN credentials s ON s.id = g.service_id
           JOIN credential_access_rules p ON p.id = g.credential_access_rule_id
         WHERE s.slug = ?1 AND s.enabled = 1 AND p.enabled = 1
           AND g.enabled = 1 AND (g.expires_at IS NULL OR g.expires_at > ?2)
         ORDER BY g.created_at, g.id`,
        )
        .bind(slug, now),
      settingsStatement(db),
      upstreamHostsStatement(db),
      adminHostsStatement(db),
    ]);

  const serviceRow = credentials?.results[0];
  const service = serviceRow ? serviceFromRow(serviceRow) : null;
  return {
    service: service?.enabled ? service : null,
    serviceDisabled: service !== null && !service.enabled,
    credentialAccessRules: (providers?.results ?? [])
      .map(credentialAccessRuleFromRow)
      .filter((provider) => provider.enabled),
    issuer_access_rules: service?.enabled
      ? (issuer_access_rules?.results ?? [])
          .map(grantFromRow)
          .filter((grant) => grant.enabled && grant.service_id === service.id)
      : [],
    settings: settingsFromRows((settings?.results ?? []) as Array<{ key: string; value: string }>),
    allowedUpstreamHosts: upstreamHostsFromValue(
      upstreamHosts?.results[0]?.value as string | undefined,
    ),
    adminHosts: adminHostsFromValue(adminHosts?.results[0]?.value as string | undefined),
  };
}
