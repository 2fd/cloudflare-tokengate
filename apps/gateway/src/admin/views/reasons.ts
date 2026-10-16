// Plain-language text for request-log reasons and links to the project documentation.
import { GATEWAY_ERRORS } from '../../lib/errors';

export { docsUrl } from './docs';

/**
 * Plain-language meaning of every reason the proxy records (gateway codes plus finer reasons), in
 * the admin UI's names (token, secret, service consumer, consumer access). The gateway's own
 * error messages (lib/errors.ts) are the API's wording and stay as they are.
 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(GATEWAY_ERRORS).map(([code, e]) => [code, e.message])),
  issuer_unknown: 'the token issuer is not a configured service consumer',
  no_matching_grant: 'no consumer access allows this call',
  event_not_trusted: 'the triggering event needs an explicit opt-in in the consumer access',
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
  profile_unknown: 'the service consumer uses an unknown consumer type',
  keyring_absent: 'no keyring is configured (TOKENGATE_KEK or TOKENGATE_KEYRING)',
  keyring_malformed: 'the keyring secret is malformed',
  active_kid_missing: 'the keyring has no active key',
  key_not_32_bytes: 'a keyring key is not 32 bytes',
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
 * Denial reasons that a new consumer access can fix. Only verified records with one of these
 * reasons offer "Give access from this request", and only they prefill the access form (I-LOG-2).
 */
export const ACCESS_FIXABLE_REASONS: readonly string[] = ['no_matching_grant', 'event_not_trusted'];

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
    group: 'Service consumer',
    codes: ['issuer_unknown', 'tenant_mismatch', 'jwks_unavailable', 'profile_unknown'],
  },
  { group: 'Consumer access', codes: ['no_matching_grant', 'event_not_trusted', 'rate_limited'] },
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

/** "no consumer access allows this call (no_matching_grant)": the label of a reason option. */
export function reasonLabel(code: string): string {
  const text = reasonText(code);
  return text ? `${text} (${code})` : code;
}
