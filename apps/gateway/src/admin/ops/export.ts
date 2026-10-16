// Configuration export (POST /admin/export): caller providers, services, grants, claim labels and
// users as deterministic JSON keyed by name/slug. No row ids, no sealed values and no secrets (I-CRED-1):
// credentials appear only as hint and timestamps. Downloading an export is audited (I-AUDIT-1).
import { callerProviderFromRow, grantFromRow, serviceFromRow } from '../../db/rows';
import type { Actor, LabelledClaim, Role, UserStatus } from '../../db/types';
import type { Deps } from '../../deps';
import type { ProfileId } from '../../identity/types';
import { canonicalJson } from '../../lib/json';
import type { Condition, Injection, Rule, VerifyCheck } from '../../policy/types';
import { commitOrConstraintFailure, type OpFailure } from './shared';

/** 2: `template_id` per service, `claim_labels`, the token_manager and access_manager roles. */
export const EXPORT_SCHEMA_VERSION = 2;

export interface ExportDocument {
  schema_version: typeof EXPORT_SCHEMA_VERSION;
  caller_providers: Array<{
    name: string;
    profile: ProfileId;
    issuer: string;
    jwks_uri: string;
    audience: string;
    allowed_algs: string[];
    max_token_age_seconds: number;
    tenant_pin: Condition[];
    anchor_claims: string[];
    enabled: boolean;
  }>;
  services: Array<{
    slug: string;
    name: string;
    description: string;
    base_url: string;
    injection: Injection;
    forward_headers: string[];
    timeout_ms: number;
    verify: VerifyCheck | null;
    /** Template the service was made from; display and preset data only. */
    template_id: string | null;
    enabled: boolean;
    credential: {
      hint: string | null;
      updated_at: number | null;
      expires_at: number | null;
    } | null;
  }>;
  grants: Array<{
    name: string;
    description: string;
    /** Caller provider name. */
    caller_provider: string;
    /** Service slug. */
    service: string;
    conditions: Condition[];
    rules: Rule[];
    enabled: boolean;
    expires_at: number | null;
  }>;
  /** Display labels of numeric claim IDs, per caller provider name. */
  claim_labels: Array<{
    caller_provider: string;
    claim: LabelledClaim;
    value: string;
    label: string;
  }>;
  users: Array<{ email: string; role: Role; status: UserStatus }>;
}

/** Builds the export. Same database content → byte-identical `exportJson` output. */
export async function buildExport(db: D1Database): Promise<ExportDocument> {
  // One batch is one transaction: a consistent snapshot, so every grant finds its references.
  const [providerRows, serviceRows, grantRows, labelRows, userRows] = await db.batch<
    Record<string, unknown>
  >([
    db.prepare('SELECT * FROM caller_providers'),
    db.prepare('SELECT * FROM services'),
    db.prepare('SELECT * FROM grants'),
    db.prepare('SELECT caller_provider_id, claim, value, label FROM claim_labels'),
    db.prepare('SELECT email, role, status FROM users'),
  ]);
  const providers = (providerRows?.results ?? []).map(callerProviderFromRow);
  const services = (serviceRows?.results ?? []).map(serviceFromRow);
  const grants = (grantRows?.results ?? []).map(grantFromRow);
  const users = (userRows?.results ?? []).map((row) => ({
    email: String(row.email),
    role: row.role as Role,
    status: row.status as UserStatus,
  }));
  const providerNames = new Map(providers.map((p) => [p.id, p.name]));
  const serviceSlugs = new Map(services.map((s) => [s.id, s.slug]));

  const exportedGrants = grants
    .map((grant) => ({
      sortKey: [grant.created_at, grant.id] as const,
      value: {
        name: grant.name,
        description: grant.description,
        caller_provider: providerNames.get(grant.caller_provider_id) ?? '',
        service: serviceSlugs.get(grant.service_id) ?? '',
        conditions: grant.conditions,
        rules: grant.rules,
        enabled: grant.enabled,
        expires_at: grant.expires_at,
      },
    }))
    // Service, caller provider, name; ties keep evaluation order (created_at, id).
    .sort(
      (a, b) =>
        compare(a.value.service, b.value.service) ||
        compare(a.value.caller_provider, b.value.caller_provider) ||
        compare(a.value.name, b.value.name) ||
        a.sortKey[0] - b.sortKey[0] ||
        compare(a.sortKey[1], b.sortKey[1]),
    )
    .map((entry) => entry.value);

  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    caller_providers: providers
      .map((p) => ({
        name: p.name,
        profile: p.profile,
        issuer: p.issuer,
        jwks_uri: p.jwks_uri,
        audience: p.audience,
        allowed_algs: p.allowed_algs,
        max_token_age_seconds: p.max_token_age_seconds,
        tenant_pin: p.tenant_pin,
        anchor_claims: p.anchor_claims,
        enabled: p.enabled,
      }))
      .sort((a, b) => compare(a.name, b.name)),
    services: services
      .map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.description,
        base_url: s.base_url,
        injection: s.injection,
        forward_headers: s.forward_headers,
        timeout_ms: s.timeout_ms,
        verify: s.verify,
        template_id: s.template_id,
        enabled: s.enabled,
        credential:
          s.credential_sealed === null
            ? null
            : {
                hint: s.credential_hint,
                updated_at: s.credential_updated_at,
                expires_at: s.credential_expires_at,
              },
      }))
      .sort((a, b) => compare(a.slug, b.slug)),
    grants: exportedGrants,
    claim_labels: (labelRows?.results ?? [])
      .map((row) => ({
        caller_provider: providerNames.get(String(row.caller_provider_id)) ?? '',
        claim: String(row.claim) as LabelledClaim,
        value: String(row.value),
        label: String(row.label),
      }))
      .sort(
        (a, b) =>
          compare(a.caller_provider, b.caller_provider) ||
          compare(a.claim, b.claim) ||
          compare(a.value, b.value),
      ),
    users: users
      .map((u) => ({ email: u.email.toLowerCase(), role: u.role, status: u.status }))
      .sort((a, b) => compare(a.email, b.email)),
  };
}

/** Pretty-printed JSON with object keys sorted; arrays keep the order buildExport chose. */
export function exportJson(document: ExportDocument): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(document)), null, 2)}\n`;
}

/** Builds the export and records who downloaded it. */
export async function exportConfiguration(
  deps: Deps,
  actor: Actor,
): Promise<{ ok: true; document: ExportDocument; json: string } | OpFailure> {
  const document = await buildExport(deps.env.DB);
  const outcome = await commitOrConstraintFailure(
    deps,
    actor,
    {
      action: 'config.export',
      targetType: null,
      targetId: null,
      summary: 'Downloaded the configuration export',
      diff: {
        counts: {
          caller_providers: document.caller_providers.length,
          services: document.services.length,
          grants: document.grants.length,
          claim_labels: document.claim_labels.length,
          users: document.users.length,
        },
      },
    },
    null,
    [],
  );
  if (!outcome.ok) return outcome;
  return { ok: true, document, json: exportJson(document) };
}

/** Code-unit order: locale-independent, so output does not depend on the runtime's locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
