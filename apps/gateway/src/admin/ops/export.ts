// Configuration export (POST /admin/export): credentials, credential and global access rules (with the display
// labels of each rule) and users as deterministic JSON. Credentials and access rules carry their ids (a slug names a
// credential type, ADR 0031), so a request record or an audit row can be traced to them. No sealed values and no secrets
// (I-CRED-1): credentials appear only as hint and timestamps. Downloading an export is audited (I-AUDIT-1).
import { credentialRules, globalRules } from '../../db/access-rules';
import { accessRuleFromRow, serviceFromRow } from '../../db/rows';
import type { AccessRuleRow, Actor, LabelledClaim, Role, UserStatus } from '../../db/types';
import type { Deps } from '../../deps';
import type { ProfileId } from '../../identity/types';
import { canonicalJson } from '../../lib/json';
import type { Condition, Injection, Rule, VerifyCheck } from '../../policy/types';
import { commitOrConstraintFailure, type OpFailure } from './shared';

/** 4: credential and global access rules in one shape (ADR 0026); labels per rule. 5: credentials have no expiry.
 * 6: the slug names a credential type (ADR 0031), so credentials carry their id and rules point at it. */
export const EXPORT_SCHEMA_VERSION = 6;

interface ExportedLabel {
  claim: LabelledClaim;
  value: string;
  label: string;
}

/** The fields both kinds export. A global access rule exports null for a limit it does not set. */
interface ExportedRule {
  id: string;
  name: string;
  description: string;
  profile: ProfileId;
  issuer: string;
  jwks_uri: string | null;
  audience: string | null;
  allowed_algs: string[] | null;
  max_token_age_seconds: number | null;
  tenant_pin: Condition[] | null;
  anchor_claims: string[] | null;
  conditions: Condition[] | null;
  rules: Rule[] | null;
  enabled: boolean;
  expires_at: number | null;
  labels: ExportedLabel[];
}

export interface ExportDocument {
  schema_version: typeof EXPORT_SCHEMA_VERSION;
  credentials: Array<{
    id: string;
    slug: string;
    name: string;
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
    } | null;
  }>;
  /** `credential` is the credential's id. */
  credential_access_rules: Array<ExportedRule & { credential: string }>;
  global_access_rules: ExportedRule[];
  users: Array<{ email: string; role: Role; status: UserStatus }>;
}

/** Builds the export. Same database content → byte-identical `exportJson` output. */
export async function buildExport(db: D1Database): Promise<ExportDocument> {
  // One batch is one transaction: a consistent snapshot, so every rule finds its credential.
  const [ruleRows, serviceRows, labelRows, userRows] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT * FROM access_rules'),
    db.prepare('SELECT * FROM credentials'),
    db.prepare('SELECT access_rule_id, claim, value, label FROM claim_labels'),
    db.prepare('SELECT email, role, status FROM users'),
  ]);
  const rows = (ruleRows?.results ?? []).map(accessRuleFromRow);
  const credentials = (serviceRows?.results ?? []).map(serviceFromRow);
  const users = (userRows?.results ?? []).map((row) => ({
    email: String(row.email),
    role: row.role as Role,
    status: row.status as UserStatus,
  }));
  const labels = new Map<string, ExportedLabel[]>();
  for (const row of labelRows?.results ?? []) {
    const id = String(row.access_rule_id);
    const list = labels.get(id) ?? [];
    list.push({
      claim: String(row.claim) as LabelledClaim,
      value: String(row.value),
      label: String(row.label),
    });
    labels.set(id, list);
  }
  const exported = (rule: AccessRuleRow): ExportedRule => ({
    id: rule.id,
    name: rule.name,
    description: rule.description,
    profile: rule.profile,
    issuer: rule.issuer,
    jwks_uri: rule.jwks_uri,
    audience: rule.audience,
    allowed_algs: rule.allowed_algs,
    max_token_age_seconds: rule.max_token_age_seconds,
    tenant_pin: rule.tenant_pin,
    anchor_claims: rule.anchor_claims,
    conditions: rule.conditions,
    rules: rule.rules,
    enabled: rule.enabled,
    expires_at: rule.expires_at,
    labels: (labels.get(rule.id) ?? []).sort(
      (a, b) => compare(a.claim, b.claim) || compare(a.value, b.value),
    ),
  });
  // Ties keep evaluation order (created_at, id).
  const byOrder = (a: AccessRuleRow, b: AccessRuleRow) =>
    a.created_at - b.created_at || compare(a.id, b.id);

  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    credentials: credentials
      .map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
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
              },
      }))
      .sort((a, b) => compare(a.slug, b.slug) || compare(a.id, b.id)),
    credential_access_rules: credentialRules(rows)
      .sort(byOrder)
      .map((rule) => ({
        credential: rule.credential_id,
        ...exported(rule),
      }))
      // Credential, then name; the sort is stable, so ties keep evaluation order.
      .sort((a, b) => compare(a.credential, b.credential) || compare(a.name, b.name)),
    global_access_rules: globalRules(rows)
      .sort(byOrder)
      .map(exported)
      .sort((a, b) => compare(a.issuer, b.issuer) || compare(a.name, b.name)),
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
          credentials: document.credentials.length,
          credential_access_rules: document.credential_access_rules.length,
          global_access_rules: document.global_access_rules.length,
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
