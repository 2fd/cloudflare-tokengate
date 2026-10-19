// D1 row -> domain object mappers. JSON columns are parsed defensively: a malformed stored value
// becomes an empty/neutral value that fails closed (e.g. an access rule with unparsable rules allows nothing).
import type { ProfileId } from '../identity/types';
import { parseJson } from '../lib/json';
import type { Condition, Injection, Rule, VerifyCheck } from '../policy/types';
import type { AccessRuleRow, Role, Service, User, UserStatus } from './types';

type Row = Record<string, unknown>;

// D1 cells are strings, numbers or null; String() of a number is the intended text.
// oxlint-disable-next-line typescript/no-base-to-string
const str = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));
const numOrNull = (value: unknown): number | null =>
  value == null ? null : typeof value === 'number' ? value : Number(value);
const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export function userFromRow(row: Row): User {
  return {
    id: str(row.id),
    email: str(row.email),
    name: strOrNull(row.name),
    role: str(row.role) as Role,
    status: str(row.status) as UserStatus,
    invite_expires_at: numOrNull(row.invite_expires_at),
    created_at: num(row.created_at),
    updated_at: num(row.updated_at),
    last_login_at: numOrNull(row.last_login_at),
    last_refused_at: numOrNull(row.last_refused_at),
    last_refused_subject: strOrNull(row.last_refused_subject),
  };
}

// Sentinels of access rule limits (ADR 0026, I-AUTHZ-5). A stored value that does not parse, has the
// wrong type, or (on a global access rule) is an empty list matches nothing; it never reads as "no limit".
const NO_CONDITION: Condition[] = [null as unknown as Condition];
const NO_RULE: Rule[] = [null as unknown as Rule];
const NO_ANCHOR: string[] = [''];
const NO_ALG: string[] = [];

type Limit<T> = { kind: 'null' } | { kind: 'bad' } | { kind: 'ok'; value: T };

/** A JSON list column: SQL NULL, a value that is not a list (or holds a wrong item), or the list. */
function listColumn<T>(value: unknown, item: (x: unknown) => boolean): Limit<T[]> {
  if (value === null || value === undefined) return { kind: 'null' };
  const parsed = parseJson(typeof value === 'string' ? value : null);
  if (!Array.isArray(parsed) || !parsed.every(item)) return { kind: 'bad' };
  return { kind: 'ok', value: parsed as T[] };
}

const isString = (x: unknown): boolean => typeof x === 'string';
// Conditions and rules keep malformed items: the policy refuses them one by one (fail closed).
const anyItem = (): boolean => true;

/** The kind comes from `credential_id`: NULL is a global access rule. */
export function accessRuleFromRow(row: Row): AccessRuleRow {
  const base = {
    id: str(row.id),
    name: str(row.name),
    description: str(row.description),
    profile: str(row.profile) as ProfileId,
    issuer: str(row.issuer),
    issuer_key: str(row.issuer_key),
    enabled: num(row.enabled) === 1,
    expires_at: numOrNull(row.expires_at),
    created_by: strOrNull(row.created_by),
    created_at: num(row.created_at),
    updated_at: num(row.updated_at),
  };
  const conditions = listColumn<Condition>(row.conditions, anyItem);
  const rules = listColumn<Rule>(row.rules, anyItem);
  const tenantPin = listColumn<Condition>(row.tenant_pin, anyItem);
  const anchors = listColumn<string>(row.anchor_claims, isString);
  const algs = listColumn<string>(row.allowed_algs, isString);

  if (row.credential_id !== null && row.credential_id !== undefined) {
    // Every limit is required (CHECK); an empty tenant pin or anchor list is a valid value here.
    const value = <T>(limit: Limit<T[]>, sentinel: T[]): T[] =>
      limit.kind === 'ok' ? limit.value : sentinel;
    return {
      ...base,
      kind: 'credential',
      credential_id: str(row.credential_id),
      jwks_uri: str(row.jwks_uri),
      audience: str(row.audience),
      allowed_algs: value(algs, NO_ALG),
      max_token_age_seconds: num(row.max_token_age_seconds),
      tenant_pin: value(tenantPin, NO_CONDITION),
      anchor_claims: value(anchors, NO_ANCHOR),
      conditions: value(conditions, NO_CONDITION),
      rules: value(rules, NO_RULE),
    };
  }

  // NULL is "no limit"; an empty list is as bad as a malformed one (`every` over [] is true).
  const limit = <T>(column: Limit<T[]>, sentinel: T[]): T[] | null =>
    column.kind === 'null'
      ? null
      : column.kind === 'ok' && column.value.length > 0
        ? column.value
        : sentinel;
  const age = numOrNull(row.max_token_age_seconds);
  return {
    ...base,
    kind: 'global',
    credential_id: null,
    jwks_uri: strOrNull(row.jwks_uri),
    audience: strOrNull(row.audience),
    allowed_algs: limit(algs, NO_ALG),
    max_token_age_seconds: age === null ? null : Number.isSafeInteger(age) ? age : 0,
    tenant_pin: limit(tenantPin, NO_CONDITION),
    anchor_claims: limit(anchors, NO_ANCHOR),
    conditions: limit(conditions, NO_CONDITION),
    rules: limit(rules, NO_RULE),
  };
}

export function serviceFromRow(row: Row): Service {
  const injectionJson = str(row.injection);
  const injection = parseJson(injectionJson);
  const verify = parseJson(strOrNull(row.verify));
  return {
    id: str(row.id),
    slug: str(row.slug),
    name: str(row.name),
    description: str(row.description),
    base_url: str(row.base_url),
    // An unparsable injection yields kind "invalid"; the proxy refuses to inject with it.
    injection: (injection && typeof injection === 'object'
      ? injection
      : { kind: 'invalid' }) as Injection,
    injection_json: injectionJson,
    forward_headers: stringArray(parseJson(strOrNull(row.forward_headers))),
    timeout_ms: num(row.timeout_ms),
    credential_sealed: strOrNull(row.credential_sealed),
    credential_hint: strOrNull(row.credential_hint),
    credential_updated_at: numOrNull(row.credential_updated_at),
    credential_expires_at: numOrNull(row.credential_expires_at),
    verify: verify && typeof verify === 'object' ? (verify as VerifyCheck) : null,
    template_id: strOrNull(row.template_id),
    enabled: num(row.enabled) === 1,
    created_at: num(row.created_at),
    updated_at: num(row.updated_at),
  };
}
