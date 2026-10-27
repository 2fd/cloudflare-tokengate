// Save-time validation of credentials and the shared helpers of access rule validation (docs/policies.md, docs/concepts.md); pure, no I/O.
// Enforces anchor rules (I-AUTHZ-2), tenant pins (I-TEN-1), algs/audience/token age (I-JWT-1),
// base URLs (I-SSRF-1), injection and forward-header shapes (I-INJ-1) and credential hygiene.
import { hostListed, upstreamHostAllowed } from '../config';
import type { IssuerProfile, ProfileId } from '../identity/types';
import { canonicalJson } from '../lib/json';
import { headerListed, NEVER_FORWARD, REQUEST_ALLOWLIST } from '../proxy/headers';
import { globError } from './glob';
import {
  type Condition,
  type Injection,
  PROXY_METHODS,
  type ValidationResult,
  type VerifyCheck,
} from './types';

/**
 * JWS algorithms a credential access rule may accept; never `none` or HMAC (I-JWT-1). Must equal
 * VERIFIABLE_ALGS in src/identity/jwt.ts (asserted by test/unit/policy/algs.test.ts).
 */
export const ALLOWED_ALGS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'EdDSA',
] as const;

/** One segment of a `path`-injected secret; the proxy applies the same set (src/proxy/path.ts). */
const PATH_SECRET_SEGMENT = /^[A-Za-z0-9\-._~!$&'()*+,=:@]+$/;

/**
 * Issuer hosts of public CI platforms. Every issuer on these hosts (including GitHub's
 * enterprise-slug issuers) must use the matching profile: under `generic` neither the tenant
 * claim rules (I-TEN-1) nor the event guard (I-AUTHZ-3) would apply. Duplicated from the
 * profiles on purpose so that this check does not depend on profile data.
 */
export const CI_ISSUER_HOSTS: ReadonlyMap<string, ProfileId> = new Map([
  ['token.actions.githubusercontent.com', 'github-actions'],
  ['gitlab.com', 'gitlab-ci'],
  ['oidc.vercel.com', 'vercel'],
]);

/** Events whose workflows run with base-repository secrets on attacker-influenced input. */
const PWN_REQUEST_EVENTS: readonly string[] = [
  'workflow_run',
  'issue_comment',
  'pull_request_target',
];

/**
 * GitLab pipeline sources that inherit another pipeline's trigger: a child of a (fork) merge
 * request pipeline reports `parent_pipeline`. Merge request refs are never protected, so
 * `ref_protected exact true` keeps those out.
 * https://docs.gitlab.com/ci/pipelines/downstream_pipelines/
 */
const INHERITED_TRUST_EVENTS: readonly string[] = ['parent_pipeline', 'pipeline'];

/**
 * Claims an attacker with push access can often choose freely; wide globs on them are risky.
 * docs/policies.md list plus the GitLab equivalents `ref_path` and `ci_config_ref_uri`.
 */
const WIDE_GLOB_CLAIMS: readonly string[] = [
  'ref',
  'ref_path',
  'base_ref',
  'environment',
  'job_workflow_ref',
  'workflow_ref',
  'ci_config_ref_uri',
];

/** Claims naming a ref or environment, which writers can create unless refs are protected. */
const REF_CLAIMS: readonly string[] = ['ref', 'ref_path', 'environment'];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** RFC 9110 §5.6.2 token characters, restricted to lower case. */
const HEADER_NAME_RE = /^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** RFC 3986 unreserved characters: safe to compare and remove without decoding. */
const QUERY_PARAM_RE = /^[A-Za-z0-9._~-]{1,64}$/;
const PATH_PREFIX_RE = /^(\/[A-Za-z0-9._~-]+){1,8}$/;
const ENCODED_PATH_DANGER = ['%2f', '%2e', '%5c', '%00', '%25'];

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

// ---------------------------------------------------------------------------------------------
// Services

/**
 * Validates an upstream base URL (I-SSRF-1). Also called by the proxy at request time.
 * `gatewayHosts` are `hostListed` entries for this gateway: the request host.
 * `normalized` is origin + pathname without a trailing '/', the form stored and bound into the
 * credential AAD.
 */
export function validateBaseUrl(
  raw: string,
  ctx: { gatewayHosts: readonly string[]; allowedUpstreamHosts: string[] | null },
): Result<{ normalized: string }> {
  const fail = (error: string) => ({ ok: false as const, error: `base URL ${error}` });
  if (typeof raw !== 'string') return fail('is required');
  const text = raw.trim();
  if (text.length === 0) return fail('is required');
  if (text.length > 2048) return fail('is longer than 2048 characters');
  // The URL parser silently drops tabs/newlines and rewrites '\' to '/'; refuse such input.
  if (!isVisibleAscii(text)) return fail('must be printable ASCII without spaces');
  if (!text.toLowerCase().startsWith('https://')) return fail('must start with https://');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail('is not a valid URL');
  }
  if (url.protocol !== 'https:') return fail('must use https');
  if (url.username !== '' || url.password !== '') return fail('must not contain user:password@');
  if (text.includes('?')) return fail('must not contain a query string');
  if (text.includes('#')) return fail('must not contain a fragment');

  const afterScheme = text.slice('https://'.length);
  if (afterScheme.includes('\\')) return fail('must not contain "\\"');
  if (afterScheme.includes('//')) return fail('path must not contain "//"');
  const lowered = afterScheme.toLowerCase();
  for (const encoded of ENCODED_PATH_DANGER) {
    if (lowered.includes(encoded)) return fail(`path must not contain "${encoded}"`);
  }
  if (afterScheme.split('/').some((segment) => segment === '.' || segment === '..')) {
    return fail('path must not contain "." or ".." segments');
  }

  const host = url.hostname;
  if (host.startsWith('[') || /^[0-9.]+$/.test(host)) return fail('host must not be an IP address');
  if (host.endsWith('.')) return fail('host must not end with "."');
  if (host === 'localhost' || host.endsWith('.localhost'))
    return fail('host must not be localhost');
  if (!host.includes('.')) return fail('host must be a fully qualified domain name');
  if (host === 'workers.dev' || host.endsWith('.workers.dev')) {
    return fail('host must not be a workers.dev Worker');
  }
  if (hostListed(host, ctx.gatewayHosts)) return fail('must not point at this gateway');
  if (!upstreamHostAllowed(host, ctx.allowedUpstreamHosts)) {
    return fail(`host ${host} is not in the upstream host allowlist (Settings)`);
  }

  const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  return { ok: true, normalized: url.origin + path };
}

/**
 * Validates an injection scheme and returns it with only the meaningful fields, plus its
 * canonical JSON (the exact text stored and bound into the credential AAD, I-CRED-2).
 */
export function normalizeInjection(raw: unknown): Result<{ injection: Injection; json: string }> {
  const fail = (error: string) => ({ ok: false as const, error: `injection: ${error}` });
  if (!isRecord(raw)) return fail('must be an object');
  let injection: Injection;
  switch (raw.kind) {
    case 'bearer':
      injection = { kind: 'bearer' };
      break;
    case 'header': {
      const { name, prefix } = raw;
      if (typeof name !== 'string' || !HEADER_NAME_RE.test(name)) {
        return fail('header name must be a lower-case HTTP token (max 64 characters)');
      }
      if (headerListed(NEVER_FORWARD, name)) return fail(`header name "${name}" is reserved`);
      const prefixError = optionalTextError(prefix, 64);
      if (prefixError !== null) return fail(`header prefix ${prefixError}`);
      injection = { kind: 'header', name };
      if (typeof prefix === 'string' && prefix !== '') injection.prefix = prefix;
      break;
    }
    case 'basic': {
      const { username } = raw;
      const usernameError = optionalTextError(username, 256);
      if (usernameError !== null) return fail(`username ${usernameError}`);
      // RFC 7617 §2: the user-id cannot contain a colon.
      if (typeof username === 'string' && username.includes(':')) {
        return fail('username must not contain ":"');
      }
      injection = { kind: 'basic' };
      if (typeof username === 'string' && username !== '') injection.username = username;
      break;
    }
    case 'query': {
      const { param } = raw;
      if (typeof param !== 'string' || !QUERY_PARAM_RE.test(param)) {
        return fail('query parameter must be 1-64 characters of A-Z a-z 0-9 . _ ~ -');
      }
      injection = { kind: 'query', param };
      break;
    }
    case 'path': {
      const { prefix } = raw;
      if (prefix !== undefined && prefix !== '') {
        if (
          typeof prefix !== 'string' ||
          !PATH_PREFIX_RE.test(prefix) ||
          prefix.split('/').some((segment) => segment === '.' || segment === '..')
        ) {
          return fail(
            'path prefix must look like "/segment" (A-Z a-z 0-9 . _ ~ -, no dot segments)',
          );
        }
      }
      injection = { kind: 'path' };
      if (typeof prefix === 'string' && prefix !== '') injection.prefix = prefix;
      break;
    }
    default:
      return fail('kind must be one of bearer, header, basic, query, path');
  }
  return { ok: true, injection, json: canonicalJson(injection) };
}

/** Name of the request header the injection writes, if any. */
function injectedHeaderName(injection: Injection): string | null {
  if (injection.kind === 'bearer' || injection.kind === 'basic') return 'authorization';
  if (injection.kind === 'header') return injection.name.toLowerCase();
  return null;
}

/** Extra caller headers a service forwards. Never reserved headers or the injected header. */
export function validateForwardHeaders(list: string[], injection: Injection): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(list)) return { errors: ['forward headers must be a list'], warnings };
  if (list.length > 32) errors.push('at most 32 forward headers');
  const injected = injectedHeaderName(injection);
  const seen = new Set<string>();
  for (const name of list) {
    if (typeof name !== 'string' || !HEADER_NAME_RE.test(name)) {
      errors.push(`forward header ${JSON.stringify(name)} must be a lower-case HTTP token`);
      continue;
    }
    if (seen.has(name)) errors.push(`forward header "${name}" is listed twice`);
    seen.add(name);
    if (headerListed(NEVER_FORWARD, name)) {
      errors.push(`forward header "${name}" is never forwarded`);
    } else if (name === injected) {
      errors.push(`forward header "${name}" carries the injected credential`);
    } else if (REQUEST_ALLOWLIST.includes(name)) {
      warnings.push(`forward header "${name}" is already forwarded by default`);
    }
  }
  return { errors, warnings };
}

/**
 * Credential input hygiene (docs/concepts.md): trims, then requires printable ASCII without whitespace.
 * The hint shows the last 4 characters only when the secret has at least 20, plus its length.
 */
export function normalizeCredential(
  raw: string,
  injection: Injection,
): Result<{ value: string; hint: string | null }> {
  const fail = (error: string) => ({ ok: false as const, error: `credential ${error}` });
  if (typeof raw !== 'string') return fail('is required');
  const value = raw.trim();
  if (value.length === 0) return fail('is empty');
  if (value.length > 8192) return fail('is longer than 8192 characters');
  if (!isVisibleAscii(value)) {
    return fail('must be printable ASCII without spaces, line breaks or control characters');
  }

  let secretPart = value;
  if (injection.kind === 'path') {
    // The secret becomes URL path segments (Slack webhooks: "T0/B0/XYZ"). Same character set as
    // the proxy's check in src/proxy/path.ts, so a saved credential can always be used.
    const segments = value.split('/');
    if (!segments.every((s) => PATH_SECRET_SEGMENT.test(s) && s !== '.' && s !== '..')) {
      return fail(
        'for path injection must be one or more "/"-separated segments of A-Z a-z 0-9 - . _ ~ ! $ & \' ( ) * + , = : @ (no empty or dot segments)',
      );
    }
  }
  if (injection.kind === 'basic' && injection.username === undefined) {
    const colon = value.indexOf(':');
    if (colon <= 0) return fail('without a configured username must be "username:password"');
    const password = value.slice(colon + 1);
    // Some APIs (e.g. Stripe) put the secret in the user part and leave the password empty.
    secretPart = password !== '' ? password : value.slice(0, colon);
  }

  const length = secretPart.length;
  const hint = length >= 20 ? `…${secretPart.slice(-4)} (${length} chars)` : `${length} chars`;
  return { ok: true, value, hint };
}

export interface ServiceFieldsInput {
  slug: string;
  name: string;
  timeout_ms: number;
  forward_headers: string[];
  injection: Injection;
  verify: VerifyCheck | null;
}

/** Non-credential service fields. base_url is checked by validateBaseUrl. */
export function validateServiceFields(input: ServiceFieldsInput): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof input.slug !== 'string' || !SLUG_RE.test(input.slug)) {
    errors.push(
      'slug must be 1-63 characters of a-z, 0-9 and "-", starting with a letter or digit',
    );
  }
  const nameError = requiredTextError(input.name, 100);
  if (nameError !== null) errors.push(`name ${nameError}`);
  if (
    !Number.isInteger(input.timeout_ms) ||
    input.timeout_ms < 1000 ||
    input.timeout_ms > 900_000
  ) {
    errors.push('timeout must be an integer between 1000 and 900000 ms');
  }

  const injection = normalizeInjection(input.injection);
  if (!injection.ok) {
    errors.push(injection.error);
  } else {
    const headers = validateForwardHeaders(input.forward_headers, injection.injection);
    errors.push(...headers.errors);
    warnings.push(...headers.warnings);
    if (injection.injection.kind === 'query') {
      warnings.push(
        'query injection puts the credential in the URL; upstreams may echo URLs in errors or logs',
      );
    }
  }

  if (input.verify !== null && input.verify !== undefined) {
    errors.push(...verifyCheckErrors(input.verify, injection.ok ? injection.injection : null));
  }
  return { errors, warnings };
}

/** At most this many extra headers on a verify check. */
export const VERIFY_HEADERS_MAX = 4;

function verifyCheckErrors(verify: unknown, injection: Injection | null): string[] {
  if (!isRecord(verify)) return ['verify check must be an object'];
  const errors: string[] = [];
  if (verify.method !== 'GET' && verify.method !== 'POST') {
    errors.push('verify method must be GET or POST');
  }
  const path = verify.path;
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.length > 512 ||
    !isVisibleAscii(path) ||
    path.includes('//') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#') ||
    path.split('/').some((segment) => segment === '.' || segment === '..') ||
    ENCODED_PATH_DANGER.some((encoded) => path.toLowerCase().includes(encoded))
  ) {
    errors.push(
      'verify path must start with "/" and be a plain path (no query, no dot segments, no encoded "/", "." or "\\")',
    );
  }
  const status = verify.expect_status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    errors.push('verify expected status must be an HTTP status code');
  }
  if (verify.expect_ok_field !== undefined && typeof verify.expect_ok_field !== 'boolean') {
    errors.push('verify expect_ok_field must be true or false');
  }
  if (verify.headers !== undefined) errors.push(...verifyHeaderErrors(verify.headers, injection));
  return errors;
}

/** Template-set check headers: never a reserved header or the one carrying the credential. */
function verifyHeaderErrors(headers: unknown, injection: Injection | null): string[] {
  if (!isRecord(headers)) return ['verify headers must be an object of header names and values'];
  const entries = Object.entries(headers);
  if (entries.length > VERIFY_HEADERS_MAX) {
    return [`verify check may send at most ${VERIFY_HEADERS_MAX} extra headers`];
  }
  const injected = injection ? injectedHeaderName(injection) : null;
  const errors: string[] = [];
  for (const [name, value] of entries) {
    if (!HEADER_NAME_RE.test(name)) {
      errors.push(`verify header ${JSON.stringify(name)} must be a lower-case HTTP token`);
    } else if (headerListed(NEVER_FORWARD, name) || name === injected) {
      errors.push(`verify header "${name}" is reserved`);
    }
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 256 ||
      !/^[\x20-\x7e]+$/.test(value)
    ) {
      errors.push(`verify header "${name}" must be printable ASCII text of at most 256 characters`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// Access rule helpers (src/policy/validate-rules.ts uses them)

/**
 * The audience must be unique to this gateway so tokens minted for other relying parties
 * (cloud providers, GitHub's default owner-URL audience) cannot be replayed here.
 */
export function audienceErrors(audience: unknown): string[] {
  if (typeof audience !== 'string' || audience.trim() === '') return ['audience is required'];
  if (audience !== audience.trim() || !isVisibleAscii(audience)) {
    return ['audience must be printable ASCII without spaces'];
  }
  if (audience.length < 16) return ['audience must be at least 16 characters'];
  const lower = audience.toLowerCase();
  // GitHub's default audience is the owner URL.
  // https://docs.github.com/en/actions/reference/security/oidc
  if (lower.startsWith('https://github.com/')) {
    return ['audience must not be a GitHub owner URL (the default audience of every workflow)'];
  }
  if (
    lower === 'sts.amazonaws.com' ||
    lower === 'api://azureadtokenexchange' ||
    lower.startsWith('https://iam.googleapis.com/') ||
    lower.startsWith('//iam.googleapis.com/')
  ) {
    return ['audience must not be a cloud provider audience'];
  }
  return [];
}

/**
 * Stable codes of the risks an access rule can carry (A7.7). The validator emits all but `any_ref`, which
 * only the structured builder knows (src/policy/presets.ts). Pages compare codes, never texts.
 */
export type WarningCode =
  | 'broad_glob'
  | 'unprotected_ref'
  | 'event_glob'
  | 'pwn_request'
  | 'inherited_trust_event'
  | 'untrusted_event'
  | 'path_injection_non_post'
  | 'any_ref'
  | 'pull_request';

export interface WarningDetail {
  code: WarningCode;
  message: string;
}

/** Values every pin condition on `claim` accepts (pin conditions are ANDed). */
export function tenantPinValues(pin: Condition[], claim: string): Set<string> {
  const onClaim = pin.filter((condition) => condition.claim === claim);
  const [first, ...rest] = onClaim;
  if (first === undefined) return new Set();
  return new Set(first.values.filter((value) => rest.every((c) => c.values.includes(value))));
}

/** Risk warnings of an access rule's conditions (I-AUTHZ-3). */
export function riskWarnings(conditions: Condition[], profile: IssuerProfile): WarningDetail[] {
  const warnings: WarningDetail[] = [];
  const warn = (code: WarningCode, message: string) => warnings.push({ code, message });

  for (const c of conditions) {
    if (c.match !== 'glob' || c.negate === true || !WIDE_GLOB_CLAIMS.includes(c.claim)) continue;
    const wide = c.values.filter((v) => v.startsWith('*') || v.includes('**'));
    if (wide.length > 0) {
      warn(
        'broad_glob',
        `${c.claim} glob ${JSON.stringify(wide)} is broad; anyone who can push a branch, tag, environment or workflow with a matching name is admitted`,
      );
    }
  }

  const requiresProtected = conditions.some(
    (c) =>
      c.claim === 'ref_protected' &&
      c.match === 'exact' &&
      c.negate !== true &&
      c.values.every((v) => v === 'true'),
  );
  if (profile.id === 'github-actions' || profile.id === 'gitlab-ci') {
    const usesRefOrEnvironment = conditions.some(
      (c) => REF_CLAIMS.includes(c.claim) && c.negate !== true,
    );
    if (usesRefOrEnvironment && !requiresProtected) {
      warn(
        'unprotected_ref',
        'the grant matches on ref or environment without "ref_protected exact true"; repository writers can create matching refs',
      );
    }
  }

  const eventClaim = profile.eventClaim;
  if (eventClaim !== undefined) {
    for (const c of conditions) {
      if (c.claim !== eventClaim) continue;
      if (c.match === 'glob') {
        warn(
          'event_glob',
          `${eventClaim} uses a glob; globs never allow untrusted events, list events with exact match (I-AUTHZ-3)`,
        );
        continue;
      }
      if (c.negate === true) continue;
      for (const event of c.values) {
        if (profile.trustedEvents.includes(event)) continue;
        if (PWN_REQUEST_EVENTS.includes(event)) {
          warn(
            'pwn_request',
            `${eventClaim} "${event}" runs with base-repository privileges on input from outside contributors ("pwn request"); see https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/`,
          );
        } else if (
          profile.id === 'gitlab-ci' &&
          INHERITED_TRUST_EVENTS.includes(event) &&
          !requiresProtected
        ) {
          warn(
            'inherited_trust_event',
            `${eventClaim} "${event}" pipelines can be started by merge request pipelines, including fork merge requests; add "ref_protected exact true" to keep them out (I-AUTHZ-3)`,
          );
        } else {
          // pull_request is the one untrusted GitHub event the structured form offers (A7.7).
          warn(
            profile.id === 'github-actions' && event === 'pull_request'
              ? 'pull_request'
              : 'untrusted_event',
            `${eventClaim} "${event}" is not a trusted event; this grant opts in to it`,
          );
        }
      }
    }
  }
  return warnings;
}

/**
 * With `path` injection the credential is part of the URL, and webhook APIs answer methods other
 * than POST on that URL with the webhook object, credential included (Discord GET/PATCH
 * /webhooks/{id}/{token} return `token`:
 * https://discord.com/developers/docs/resources/webhook#get-webhook-with-token). Upstream
 * response bodies are not redacted, so every other method is flagged.
 */
export function pathInjectionRuleWarnings(rules: unknown[]): WarningDetail[] {
  const methods = new Set<string>();
  for (const rule of rules) {
    if (!isRecord(rule) || !Array.isArray(rule.methods)) continue;
    for (const method of rule.methods) {
      if (typeof method === 'string' && method !== 'POST') methods.add(method);
    }
  }
  if (methods.size === 0) return [];
  return [
    {
      code: 'path_injection_non_post',
      message: `the service injects the credential into the URL path and this access rule allows ${[...methods].join(', ')}; webhook APIs such as Discord return the credential in the response body for GET and PATCH on the webhook URL, and response bodies are not redacted; allow only POST`,
    },
  ];
}

export function ruleShapeError(rule: unknown): string | null {
  if (!isRecord(rule)) return 'rule must be an object';
  const { methods, path } = rule;
  if (!Array.isArray(methods) || methods.length === 0) return 'at least one method is required';
  for (const method of methods) {
    if (method !== '*' && !(PROXY_METHODS as readonly unknown[]).includes(method)) {
      return `method ${JSON.stringify(method)} is not one of ${PROXY_METHODS.join(', ')} or *`;
    }
  }
  if (typeof path !== 'string' || !path.startsWith('/')) return 'path must start with "/"';
  if (!isVisibleAscii(path)) return 'path must be printable ASCII without spaces';
  const error = globError(path);
  return error === null ? null : `path ${error}`;
}

// ---------------------------------------------------------------------------------------------
// Helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Characters 0x21-0x7e only: no whitespace, control or non-ASCII characters. */
export function isVisibleAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/** https URL with no user info, query or fragment; checked on the raw text too. */
export function httpsUrlError(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return 'is required';
  if (!isVisibleAscii(raw)) return 'must be printable ASCII without spaces';
  if (!raw.startsWith('https://')) return 'must start with https://';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'is not a valid URL';
  }
  if (url.username !== '' || url.password !== '') return 'must not contain user:password@';
  if (raw.includes('?')) return 'must not contain a query string';
  if (raw.includes('#')) return 'must not contain a fragment';
  return null;
}

export function requiredTextError(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.trim() === '') return 'is required';
  if (value.length > max) return `must be at most ${max} characters`;
  if (hasControlChars(value)) return 'must not contain control characters';
  return null;
}

/** Optional string field: absent or a string of printable ASCII (spaces allowed) up to `max`. */
function optionalTextError(value: unknown, max: number): string | null {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string') return 'must be text';
  if (value.length > max) return `must be at most ${max} characters`;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return 'must be printable ASCII';
  }
  return null;
}

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
