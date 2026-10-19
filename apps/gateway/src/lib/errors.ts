// Every response the gateway generates on the proxy path goes through gatewayError().
// Codes are a public, documented contract (docs/errors.md); hints never reveal access rule details.

export const GATEWAY_ERRORS = {
  path_invalid: { status: 400, message: 'the request path is not allowed' },
  token_ambiguous: { status: 400, message: 'more than one different caller token was sent' },
  token_missing: {
    status: 401,
    message:
      'no caller token; send it in the x-tokengate-token header or as Authorization: Bearer <token>',
  },
  token_malformed: { status: 401, message: 'the caller token is not a valid JWT for this issuer' },
  issuer_unknown: {
    status: 401,
    message: 'the token issuer is not a configured credential access rule',
  },
  audience_mismatch: { status: 401, message: 'the token audience does not match' },
  token_expired: { status: 401, message: 'the token has expired; mint a fresh one' },
  token_too_old: { status: 401, message: 'the token is older than the allowed maximum age' },
  signature_invalid: { status: 401, message: 'the token signature is invalid' },
  claims_invalid: { status: 401, message: 'the token is missing required claims' },
  tenant_mismatch: { status: 401, message: 'the caller is outside the allowed tenant' },
  no_matching_rule: {
    status: 403,
    message: 'no access rule allows this caller to perform this request',
  },
  event_not_trusted: {
    status: 403,
    message: 'the triggering event requires an explicit opt-in in the credential access rule',
  },
  service_not_found: { status: 404, message: 'unknown or disabled service' },
  method_not_allowed: { status: 405, message: 'HTTP method not supported by the proxy' },
  rate_limited: { status: 429, message: 'rate limit exceeded' },
  internal_error: {
    status: 500,
    message: 'the gateway failed to process the request; retry later',
  },
  upstream_unreachable: { status: 502, message: 'the upstream API could not be reached' },
  credential_unavailable: {
    status: 503,
    message: 'the service credential is not available; contact the gateway administrators',
  },
  jwks_unavailable: { status: 503, message: 'the issuer signing keys could not be fetched' },
  not_configured: { status: 503, message: 'the gateway is not fully configured' },
  upstream_timeout: { status: 504, message: 'the upstream API did not respond in time' },
} as const satisfies Record<string, { status: number; message: string }>;

export type GatewayErrorCode = keyof typeof GATEWAY_ERRORS;

export const DOCS_BASE_URL = 'https://github.com/2fd/cloudflare-tokengate/blob/main/docs/errors.md';

export function gatewayError(
  code: GatewayErrorCode,
  requestId: string,
  options: { hint?: string; headers?: Record<string, string> } = {},
): Response {
  const { status, message: defaultText } = GATEWAY_ERRORS[code];
  const message = `tokengate: ${code}: ${options.hint ?? defaultText} (request ${requestId})`;
  const body = {
    message,
    error: {
      type: 'tokengate_error',
      code,
      message,
      request_id: requestId,
      docs: `${DOCS_BASE_URL}#${code}`,
    },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-tokengate-source': 'gateway',
      'x-tokengate-error': code,
      'x-tokengate-request-id': requestId,
      ...options.headers,
    },
  });
}
