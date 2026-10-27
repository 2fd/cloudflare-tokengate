// Everything the proxy needs from the control plane, read in one D1 batch of 5 statements per request
// (no caching, so disabling an access rule, a global access rule or a credential takes effect on the next
// request; I-AUTHZ-1). Every statement is indexed and bounded (docs/architecture.md, "Query budget").
import { credentialRules, globalRules } from './access-rules';
import { accessRuleFromRow, serviceFromRow } from './rows';
import {
  type Settings,
  settingsFromRows,
  settingsStatement,
  upstreamHostsFromValue,
  upstreamHostsStatement,
} from './settings';
import type { CredentialAccessRule, GlobalAccessRule, Service } from './types';

/** Credential access rules of other credentials read for an unknown or disabled slug (AR-11). */
export const OTHER_CANDIDATES_MAX = 64;

export interface ProxyContext {
  /** The service with this slug, or null when it does not exist or is disabled. */
  service: Service | null;
  /** The slug exists but the service is disabled. Only used for the request record reason. */
  serviceDisabled: boolean;
  /** The id of the disabled credential with this slug, or null. Its own rules are tried first. */
  disabledServiceId: string | null;
  /**
   * Enabled, unexpired credential access rules: every rule of the enabled credential (any issuer),
   * or, for an unknown or disabled slug, the rules that trust the token's issuer (the disabled
   * credential's own rules, then at most OTHER_CANDIDATES_MAX of other credentials). The handler
   * filters by issuer and orders them.
   */
  candidateRules: CredentialAccessRule[];
  /**
   * Global access rules in every state (existence decides "not limited", AR-4) of every issuer key
   * a candidate can have, in evaluation order (created_at, id).
   */
  globalRules: GlobalAccessRule[];
  settings: Settings;
  /** Upstream host allowlist (I-SSRF-1); null = any public https host. */
  allowedUpstreamHosts: string[] | null;
}

type Row = Record<string, unknown>;

/**
 * Binds: ?1 slug, ?2 now, ?3 the unverified issuer of a standard-header token (or null), ?4 1 when the
 * standard headers carried a token. The standard-header token always wins over the injection header,
 * so (3b) runs only when the token can come from the injection header.
 */
export const CANDIDATE_RULES_SQL = `SELECT r.* FROM access_rules r JOIN credentials s ON s.id = r.credential_id
 WHERE s.slug = ?1 AND s.enabled = 1 AND r.enabled = 1
   AND (r.expires_at IS NULL OR r.expires_at > ?2)
UNION ALL
SELECT r.* FROM access_rules r JOIN credentials s ON s.id = r.credential_id
 WHERE ?3 IS NOT NULL AND s.slug = ?1 AND s.enabled = 0 AND r.enabled = 1 AND r.issuer = ?3
   AND (r.expires_at IS NULL OR r.expires_at > ?2)
UNION ALL
SELECT * FROM (
  SELECT r.* FROM access_rules r
   WHERE ?3 IS NOT NULL AND r.issuer = ?3 AND r.enabled = 1 AND r.credential_id IS NOT NULL
     AND (r.expires_at IS NULL OR r.expires_at > ?2)
     AND NOT EXISTS (SELECT 1 FROM credentials WHERE slug = ?1 AND enabled = 1)
     AND r.credential_id IS NOT (SELECT id FROM credentials WHERE slug = ?1)
   ORDER BY r.created_at, r.id LIMIT ${OTHER_CANDIDATES_MAX})`;

/**
 * No LIMIT: a truncated read could drop every global row of an issuer and read as "not limited"
 * (fail open). The caps bound it (AR-12): at most 20 rows for (3a), 100 keys x 20 rows for (3b).
 */
export const GLOBAL_RULES_SQL = `SELECT g.* FROM access_rules g
 WHERE g.credential_id IS NULL AND ?3 IS NOT NULL AND g.issuer_key = lower(rtrim(?3, '/'))
UNION ALL
SELECT g.* FROM access_rules g
 WHERE g.credential_id IS NULL AND ?3 IS NULL AND ?4 = 0
   AND g.issuer_key IN (SELECT r.issuer_key FROM access_rules r JOIN credentials s ON s.id = r.credential_id
                         WHERE s.slug = ?1 AND s.enabled = 1 AND r.enabled = 1)`;

export async function loadProxyContext(
  db: D1Database,
  slug: string,
  now: number,
  token: { preIss: string | null; standard: boolean },
): Promise<ProxyContext> {
  const binds = [slug, now, token.preIss, token.standard ? 1 : 0];
  const [credentials, candidates, globals, settings, upstreamHosts] = await db.batch<Row>([
    db.prepare('SELECT * FROM credentials WHERE slug = ?1').bind(slug),
    // A statement takes exactly as many binds as its highest parameter number.
    db.prepare(CANDIDATE_RULES_SQL).bind(...binds.slice(0, 3)),
    db.prepare(GLOBAL_RULES_SQL).bind(...binds),
    settingsStatement(db),
    upstreamHostsStatement(db),
  ]);

  const serviceRow = credentials?.results[0];
  const service = serviceRow ? serviceFromRow(serviceRow) : null;
  const byOrder = <T extends { created_at: number; id: string }>(a: T, b: T) =>
    a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    service: service?.enabled ? service : null,
    serviceDisabled: service !== null && !service.enabled,
    disabledServiceId: service !== null && !service.enabled ? service.id : null,
    candidateRules: credentialRules((candidates?.results ?? []).map(accessRuleFromRow)).filter(
      (rule) => rule.enabled,
    ),
    globalRules: globalRules((globals?.results ?? []).map(accessRuleFromRow)).sort(byOrder),
    settings: settingsFromRows((settings?.results ?? []) as Array<{ key: string; value: string }>),
    allowedUpstreamHosts: upstreamHostsFromValue(
      upstreamHosts?.results[0]?.value as string | undefined,
    ),
  };
}
