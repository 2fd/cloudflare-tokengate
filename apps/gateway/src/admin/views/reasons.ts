// Plain-language text for request-log reasons and links to the project documentation.
import { GATEWAY_ERRORS } from '../../lib/errors';

export { docsUrl } from './docs';

/**
 * Plain-language meaning of every reason the proxy records (gateway codes plus finer reasons), in
 * the admin UI's names (credential, secret, credential and global access rules). The gateway's own
 * error messages (lib/errors.ts) are the API's wording and stay as they are.
 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(GATEWAY_ERRORS).map(([code, e]) => [code, e.message])),
  issuer_unknown: 'no credential access rule of this credential trusts the token issuer',
  no_matching_rule: 'no credential access rule allows this call',
  outside_global_rules:
    "a credential access rule allowed this call, but no global access rule of the caller's issuer did",
  event_not_trusted: 'the triggering event needs an explicit opt-in in the credential access rule',
  service_not_found: 'unknown or disabled token slug',
  credential_unavailable: "the token's secret is not available",
  service_disabled: 'the token exists but is disabled',
  credential_missing: 'the token has no secret yet',
  credential_binding_mismatch:
    "the stored secret does not belong to this token's current destination or injection",
  credential_invalid: 'the stored secret cannot be attached to the upstream request',
  keyring_missing_key: 'the secret was encrypted with a key that is no longer in the keyring',
  sealed_malformed: 'the stored secret is damaged',
  base_url_invalid: "the token's base URL is no longer allowed",
  injection_invalid: "the token's injection settings are invalid",
  query_invalid: 'the query string is not allowed',
  upstream_invalid_status:
    'the upstream API answered with an HTTP status outside 200-599; it may have processed the request',
  profile_unknown: 'the credential access rule uses an unknown issuer type',
  keyring_absent: 'no encryption key is configured (TOKENGATE_KEK)',
  keyring_malformed: 'TOKENGATE_KEK is not base64',
  key_not_32_bytes: 'a keyring key is not 32 bytes',
  key_not_random: 'the only keyring key is not random',
  // Before ADR 0027 (JSON keyring); kept for request records that hold them.
  active_kid_missing: 'the keyring has no active key',
  both_kek_and_keyring_set: 'both TOKENGATE_KEK and TOKENGATE_KEYRING are set',
  dev_placeholder_key: 'the keyring holds the development key from .dev.vars.example',
};

/** Plain-language meaning of a recorded reason, or null for unknown codes. */
export function reasonText(reason: string | null): string | null {
  return reason !== null && Object.hasOwn(REASON_TEXT, reason)
    ? (REASON_TEXT[reason] ?? null)
    : null;
}

/**
 * Denial reasons that a new credential access rule can fix. Only verified records with one of these
 * reasons offer "Give access from this request", and only they prefill the rule form (I-LOG-2).
 */
export const ACCESS_FIXABLE_REASONS: readonly string[] = ['no_matching_rule', 'event_not_trusted'];

export function accessFixable(reason: string | null): boolean {
  return reason !== null && ACCESS_FIXABLE_REASONS.includes(reason);
}

/** Every reason code the proxy records, in REASON_TEXT order (the closed set of the filters). */
export const REASON_CODES: readonly string[] = Object.freeze(Object.keys(REASON_TEXT));

export function isReasonCode(value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(REASON_TEXT, value);
}

/** The reason codes by what has to change, for the Requests reason filter (one group per code). */
export const REASON_GROUPS: ReadonlyArray<{ group: string; codes: readonly string[] }> = [
  {
    group: 'Caller token',
    codes: [
      'token_missing',
      'token_ambiguous',
      'token_malformed',
      'token_expired',
      'token_too_old',
      'signature_invalid',
      'claims_invalid',
      'audience_mismatch',
    ],
  },
  {
    group: 'Credential access rule',
    codes: ['issuer_unknown', 'tenant_mismatch', 'jwks_unavailable', 'profile_unknown'],
  },
  {
    group: 'Access rules',
    codes: ['no_matching_rule', 'outside_global_rules', 'event_not_trusted', 'rate_limited'],
  },
  {
    group: 'Token configuration',
    codes: [
      'service_not_found',
      'service_disabled',
      'credential_missing',
      'credential_binding_mismatch',
      'credential_invalid',
      'credential_unavailable',
      'sealed_malformed',
      'base_url_invalid',
      'injection_invalid',
    ],
  },
  {
    group: 'Encryption keys',
    codes: [
      'keyring_missing_key',
      'keyring_absent',
      'keyring_malformed',
      'active_kid_missing',
      'key_not_32_bytes',
      'key_not_random',
      'both_kek_and_keyring_set',
      'dev_placeholder_key',
    ],
  },
  {
    group: 'Upstream',
    codes: ['upstream_timeout', 'upstream_unreachable', 'upstream_invalid_status'],
  },
  { group: 'Caller request', codes: ['path_invalid', 'query_invalid', 'method_not_allowed'] },
  { group: 'Gateway', codes: ['internal_error', 'not_configured'] },
];

/** "no credential access rule allows this call (no_matching_rule)": the label of a reason option. */
export function reasonLabel(code: string): string {
  const text = reasonText(code);
  return text ? `${text} (${code})` : code;
}
