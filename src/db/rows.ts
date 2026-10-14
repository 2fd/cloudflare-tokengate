// D1 row -> domain object mappers. JSON columns are parsed defensively: a malformed stored value
// becomes an empty/neutral value that fails closed (e.g. a grant with unparsable rules allows nothing).
import type { ProfileId } from '../identity/types';
import { parseJson } from '../lib/json';
import type { Condition, Injection, Rule, VerifyCheck } from '../policy/types';
import type { CallerProvider, Grant, Role, Service, User, UserStatus } from './types';

type Row = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));
const numOrNull = (value: unknown): number | null =>
  value == null ? null : typeof value === 'number' ? value : Number(value);
const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const objectArray = <T>(value: unknown): T[] =>
  Array.isArray(value) ? value.filter((item): item is T => !!item && typeof item === 'object') : [];

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
  };
}

export function callerProviderFromRow(row: Row): CallerProvider {
  return {
    id: str(row.id),
    name: str(row.name),
    profile: str(row.profile) as ProfileId,
    issuer: str(row.issuer),
    jwks_uri: str(row.jwks_uri),
    audience: str(row.audience),
    allowed_algs: stringArray(parseJson(strOrNull(row.allowed_algs))),
    max_token_age_seconds: num(row.max_token_age_seconds),
    tenant_pin: objectArray<Condition>(parseJson(strOrNull(row.tenant_pin))),
    anchor_claims: stringArray(parseJson(strOrNull(row.anchor_claims))),
    enabled: num(row.enabled) === 1,
    created_at: num(row.created_at),
    updated_at: num(row.updated_at),
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
    enabled: num(row.enabled) === 1,
    created_at: num(row.created_at),
    updated_at: num(row.updated_at),
  };
}

export function grantFromRow(row: Row): Grant {
  return {
    id: str(row.id),
    name: str(row.name),
    description: str(row.description),
    caller_provider_id: str(row.caller_provider_id),
    service_id: str(row.service_id),
    conditions: objectArray<Condition>(parseJson(strOrNull(row.conditions))),
    rules: objectArray<Rule>(parseJson(strOrNull(row.rules))),
    enabled: num(row.enabled) === 1,
    expires_at: numOrNull(row.expires_at),
    created_by: strOrNull(row.created_by),
    created_at: num(row.created_at),
    updated_at: num(row.updated_at),
  };
}
