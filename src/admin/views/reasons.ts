// Plain-language text for request-log reasons and links to the project documentation.
import { GATEWAY_ERRORS } from '../../lib/errors';

export { docsUrl } from './docs';

/** Plain-language meaning of every reason the proxy records (gateway codes plus finer reasons). */
const REASON_TEXT: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(GATEWAY_ERRORS).map(([code, e]) => [code, e.message])),
  service_disabled: 'the service exists but is disabled',
  credential_missing: 'the service has no credential yet',
  credential_binding_mismatch:
    "the stored credential does not belong to this service's current destination or injection",
  credential_invalid: 'the stored credential cannot be attached to the upstream request',
  keyring_missing_key: 'the credential was encrypted with a key that is no longer in the keyring',
  sealed_malformed: 'the stored credential is damaged',
  base_url_invalid: "the service's base URL is no longer allowed",
  injection_invalid: "the service's injection settings are invalid",
  query_invalid: 'the query string is not allowed',
  upstream_invalid_status:
    'the upstream API answered with an HTTP status outside 200-599; it may have processed the request',
  profile_unknown: 'the caller provider uses an unknown profile',
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
 * reasons offer "Create grant from this request", and only they prefill the access form (I-LOG-2).
 */
export const ACCESS_FIXABLE_REASONS: readonly string[] = ['no_matching_grant', 'event_not_trusted'];

export function accessFixable(reason: string | null): boolean {
  return reason !== null && ACCESS_FIXABLE_REASONS.includes(reason);
}
