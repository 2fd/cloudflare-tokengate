// Configuration export (POST /admin/export): credential access rules, credentials, issuer_access_rules, claim labels and
// users as deterministic JSON keyed by name/slug. No row ids, no sealed values and no secrets (I-CRED-1):
// credentials appear only as hint and timestamps. Downloading an export is audited (I-AUDIT-1).
import { credentialAccessRuleFromRow, grantFromRow, serviceFromRow } from '../../db/rows';
import type { Actor, LabelledClaim, Role, UserStatus } from '../../db/types';
import type { Deps } from '../../deps';
import type { ProfileId } from '../../identity/types';
import { canonicalJson } from '../../lib/json';
import type { Condition, Injection, Rule, VerifyCheck } from '../../policy/types';
import { commitOrConstraintFailure, type OpFailure } from './shared';

/** 3: Credentials and the two access rule entities, including credential boundaries. */
export const EXPORT_SCHEMA_VERSION = 3;

export interface ExportDocument {
  schema_version: typeof EXPORT_SCHEMA_VERSION;
  credential_access_rules: Array<{
    credential: string;
    conditions: Condition[];
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
  credentials: Array<{
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
  issuer_access_rules: Array<{
    name: string;
    description: string;
    /** Credential access rule name. */
    credential_access_rule: string;
    /** Credential slug. */
    credential: string;
    conditions: Condition[];
    rules: Rule[];
    enabled: boolean;
    expires_at: number | null;
  }>;
  /** Display labels of numeric claim IDs, per credential access rule name. */
  claim_labels: Array<{
    credential_access_rule: string;
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
    db.prepare('SELECT * FROM credential_access_rules'),
    db.prepare('SELECT * FROM credentials'),
    db.prepare('SELECT * FROM issuer_access_rules'),
    db.prepare('SELECT credential_access_rule_id, claim, value, label FROM claim_labels'),
    db.prepare('SELECT email, role, status FROM users'),
  ]);
  const providers = (providerRows?.results ?? []).map(credentialAccessRuleFromRow);
  const credentials = (serviceRows?.results ?? []).map(serviceFromRow);
  const issuer_access_rules = (grantRows?.results ?? []).map(grantFromRow);
  const users = (userRows?.results ?? []).map((row) => ({
    email: String(row.email),
    role: row.role as Role,
    status: row.status as UserStatus,
  }));
  const providerNames = new Map(providers.map((p) => [p.id, p.name]));
  const serviceSlugs = new Map(credentials.map((s) => [s.id, s.slug]));

  const exportedIssuerAccessRules = issuer_access_rules
    .map((grant) => ({
      sortKey: [grant.created_at, grant.id] as const,
      value: {
        name: grant.name,
        description: grant.description,
        credential_access_rule: providerNames.get(grant.credential_access_rule_id) ?? '',
        credential: serviceSlugs.get(grant.service_id) ?? '',
        conditions: grant.conditions,
        rules: grant.rules,
        enabled: grant.enabled,
        expires_at: grant.expires_at,
      },
    }))
    // Service, credential access rule, name; ties keep evaluation order (created_at, id).
    .sort(
      (a, b) =>
        compare(a.value.credential, b.value.credential) ||
        compare(a.value.credential_access_rule, b.value.credential_access_rule) ||
        compare(a.value.name, b.value.name) ||
        a.sortKey[0] - b.sortKey[0] ||
        compare(a.sortKey[1], b.sortKey[1]),
    )
    .map((entry) => entry.value);

  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    credential_access_rules: providers
      .map((p) => ({
        credential: serviceSlugs.get(p.credential_id) ?? '',
        conditions: p.conditions,
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
    credentials: credentials
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
    issuer_access_rules: exportedIssuerAccessRules,
    claim_labels: (labelRows?.results ?? [])
      .map((row) => ({
        credential_access_rule: providerNames.get(String(row.credential_access_rule_id)) ?? '',
        claim: String(row.claim) as LabelledClaim,
        value: String(row.value),
        label: String(row.label),
      }))
      .sort(
        (a, b) =>
          compare(a.credential_access_rule, b.credential_access_rule) ||
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
          credential_access_rules: document.credential_access_rules.length,
          credentials: document.credentials.length,
          issuer_access_rules: document.issuer_access_rules.length,
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
