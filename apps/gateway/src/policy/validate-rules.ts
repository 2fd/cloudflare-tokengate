// Save-time validation of credential and global access rules (ADR 0026, docs/policies.md); pure, no I/O.
// A credential access rule holds its token verification settings and its own policy in one row: tenant pin
// (I-TEN-1), algorithms, audience and token age (I-JWT-1), anchors (I-AUTHZ-2) and risk warnings
// (I-AUTHZ-3). A global access rule can limit each of these; NULL means no limit and an empty list is refused
// (I-AUTHZ-5). Both refuse issuers that are not in canonical form, so a ceiling reaches every spelling that
// can verify (AR-3). Containment in global access rules is a warning of the save op, never a refusal (AR-8).
import { getProfile } from '../identity/profiles';
import type { IssuerProfile, ProfileId } from '../identity/types';
import { verificationGroupKey } from './access-rules';
import { CLAIM_NAME_MAX_LENGTH, conditionShapeError, satisfiesAnchorRule } from './conditions';
import { issuerKey, type PolicyCredentialRule, type PolicyGlobalRule } from './limits';
import type { Condition, Injection, Rule } from './types';
import {
  ALLOWED_ALGS,
  audienceErrors,
  CI_ISSUER_HOSTS,
  riskWarnings,
  httpsUrlError,
  pathInjectionRuleWarnings,
  requiredTextError,
  ruleShapeError,
  tenantPinValues,
  type WarningCode,
} from './validate';

/** Same as the access_rules CHECK. */
const DESCRIPTION_MAX_LENGTH = 2000;
/** Distinct (JWKS URI, audience) pairs per credential and issuer key; the SQL triggers use the same cap (AR-10). */
export const VERIFICATION_PAIRS_MAX = 4;
/** Distinct verification group keys per credential and issuer key (AR-10). */
export const VERIFICATION_GROUPS_MAX = 8;

const EMPTY_LIMIT = 'the list is empty. Leave the box unticked for no limit.';

/** Warning codes of access rule saves. Pages compare codes, never texts. */
/** `global_limited`, `global_blocked` and `no_issuer_rule` come from the save ops (AR-8, §A4), never from the validators. */
export type AccessRuleWarningCode =
  | WarningCode
  | 'no_tenant_pin'
  | 'global_no_limit'
  | 'global_limited'
  | 'global_blocked'
  | 'no_issuer_rule';

export interface AccessRuleWarningDetail {
  code: AccessRuleWarningCode;
  message: string;
}

export interface AccessRuleValidationResult {
  errors: string[];
  warnings: string[];
  /** The warnings with their codes, in the order of `warnings`. */
  warningDetails: AccessRuleWarningDetail[];
}

export interface CredentialAccessRuleInput {
  name: string;
  description?: string;
  profile: ProfileId;
  issuer: string;
  jwks_uri: string;
  audience: string;
  allowed_algs: string[];
  max_token_age_seconds: number;
  tenant_pin: Condition[];
  anchor_claims: string[];
  conditions: Condition[];
  rules: Rule[];
}

/** A limit set to null is not a limit. */
export interface GlobalAccessRuleInput {
  name: string;
  description?: string;
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
}

/** The credential that a credential access rule belongs to. */
export interface CredentialRuleContext {
  injection: Injection;
  /** Every stored access rule of the credential. The rule being updated is skipped by id. */
  rules: readonly PolicyCredentialRule[];
}

/**
 * Null when the issuer URL is in canonical form, otherwise an error with that form: no explicit
 * default port, no dot segments, a lower-case host and percent-encoding normalized (RFC 3986
 * §6.2.2). jose compares `iss` exactly, so any other spelling never verifies; a global access rule
 * must not miss a spelling that does. Trailing slashes are allowed (issuer keys fold them).
 */
export function canonicalIssuerError(raw: string): string | null {
  let href: string;
  try {
    href = new URL(raw).href;
  } catch {
    return 'The issuer is not a valid URL.';
  }
  const canonical = href.replace(/%[0-9A-Fa-f]{2}/g, normalizeEscape).replace(/\/+$/, '');
  return raw.replace(/\/+$/, '') === canonical ? null : `Write the issuer as ${canonical}.`;
}

/** Decodes an escaped unreserved character; other escapes get upper-case hex digits. */
function normalizeEscape(escape: string): string {
  const char = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
  return /^[A-Za-z0-9\-._~]$/.test(char) ? char : escape.toUpperCase();
}

// ---------------------------------------------------------------------------------------------
// Credential access rules

/**
 * Validates a credential access rule against its profile. `existing` is the stored row on update
 * (the profile cannot change after creation). `credential` gives its injection (warnings) and
 * its other rules (the verification settings cap, AR-10).
 */
export function validateCredentialAccessRule(
  input: CredentialAccessRuleInput,
  profile: IssuerProfile,
  existing: Pick<PolicyCredentialRule, 'id' | 'profile'> | null,
  credential: CredentialRuleContext,
): AccessRuleValidationResult {
  const errors: string[] = [];
  const details: AccessRuleWarningDetail[] = [];

  errors.push(...nameAndDescriptionErrors(input));
  if (input.profile !== profile.id) errors.push('profile does not match the selected profile');
  if (existing !== null && existing.profile !== input.profile) {
    errors.push('profile cannot be changed after the credential access rule is created');
  }

  errors.push(...issuerErrors(input.issuer, profile));
  const jwksError = httpsUrlError(input.jwks_uri);
  if (jwksError !== null) errors.push(`JWKS URI ${jwksError}`);
  errors.push(...algorithmErrors(input.allowed_algs));
  errors.push(...audienceErrors(input.audience));

  const pin = Array.isArray(input.tenant_pin) ? input.tenant_pin : null;
  if (pin === null) {
    errors.push('tenant pin must be a list of conditions');
  } else {
    errors.push(...pinConditionErrors(pin, profile));
    const key = typeof input.issuer === 'string' ? issuerKey(input.issuer) : '';
    const shared = profile.sharedIssuers.some((issuer) => issuerKey(issuer) === key);
    if (shared && pin.length === 0) {
      errors.push('a tenant pin is required: this issuer signs tokens for every tenant (I-TEN-1)');
    } else if (profile.id === 'generic' && pin.length === 0) {
      details.push({
        code: 'no_tenant_pin',
        message:
          'no tenant pin: every token this issuer signs for this audience reaches the conditions of this access rule',
      });
    }
  }

  const anchorErrors: string[] = [];
  if (!Array.isArray(input.anchor_claims)) {
    anchorErrors.push('anchor claims must be a list');
  } else if (profile.id === 'generic') {
    if (input.anchor_claims.length === 0 || input.anchor_claims.length > 8) {
      anchorErrors.push(
        'generic credential access rules need 1-8 anchor claims (immutable identity claims)',
      );
    }
    anchorErrors.push(...claimNameErrors(input.anchor_claims));
  } else if (input.anchor_claims.length > 0) {
    anchorErrors.push(`anchor claims are defined by the ${profile.id} profile and cannot be set`);
  }
  errors.push(...anchorErrors);

  errors.push(...maxAgeErrors(input.max_token_age_seconds, profile));

  const conditions: Condition[] = [];
  if (!Array.isArray(input.conditions) || input.conditions.length === 0) {
    errors.push('at least one condition is required');
  } else if (input.conditions.length > 32) {
    errors.push('at most 32 conditions');
  } else {
    for (const [index, condition] of input.conditions.entries()) {
      const shapeError = conditionShapeError(condition);
      if (shapeError === null) conditions.push(condition);
      else errors.push(`condition ${index + 1}: ${shapeError}`);
    }
  }
  errors.push(...ruleListErrors(input.rules));

  // I-AUTHZ-2: anchored on the rule's own settings. Skipped while the anchor claims are invalid,
  // which already gives an error.
  if (anchorErrors.length === 0) {
    const anchorRules = profile.anchorRules(input);
    if (!satisfiesAnchorRule(conditions, anchorRules)) {
      const options = anchorRules.map((rule) => rule.join(' + ')).join('; or ');
      errors.push(
        `the access rule must have exact, non-negated conditions on ${options} (I-AUTHZ-2)`,
      );
    }
  }

  // Values outside the tenant pin can never match; refusing them avoids rules that look broader
  // than they are and catches owner IDs from the wrong organization.
  if (pin !== null) {
    const pinned = conditions.filter((c) => c.match === 'exact' && c.negate !== true);
    for (const claim of new Set(pin.map((c) => c.claim))) {
      const allowed = tenantPinValues(pin, claim);
      for (const condition of pinned.filter((c) => c.claim === claim)) {
        const outside = condition.values.filter((value) => !allowed.has(value));
        if (outside.length > 0) {
          errors.push(
            `${claim} values ${JSON.stringify(outside)} are outside the tenant pin of this access rule`,
          );
        }
      }
    }
  }

  errors.push(...verificationCapErrors(input, profile, existing, credential));

  details.push(...riskWarnings(conditions, profile));
  if (credential.injection.kind === 'path' && Array.isArray(input.rules)) {
    details.push(...pathInjectionRuleWarnings(input.rules));
  }
  return { errors, warnings: details.map((detail) => detail.message), warningDetails: details };
}

/**
 * AR-10: the credential's rules of one issuer key use at most VERIFICATION_PAIRS_MAX distinct
 * (JWKS URI, audience) pairs and VERIFICATION_GROUPS_MAX distinct verification group keys, so the
 * proxy never refuses a validated configuration at its per-request bounds. A rule that reuses a
 * pair or a group key that is already in use always passes.
 */
function verificationCapErrors(
  input: CredentialAccessRuleInput,
  profile: IssuerProfile,
  existing: Pick<PolicyCredentialRule, 'id'> | null,
  credential: CredentialRuleContext,
): string[] {
  if (typeof input.issuer !== 'string') return [];
  const key = issuerKey(input.issuer);
  const others = credential.rules.filter(
    (rule) => rule.issuer_key === key && (existing === null || rule.id !== existing.id),
  );

  const pair = (rule: Pick<PolicyCredentialRule, 'jwks_uri' | 'audience'>) =>
    JSON.stringify([rule.jwks_uri, rule.audience]);
  const pairs = new Set(others.map(pair));
  if (!pairs.has(pair(input)) && pairs.size + 1 > VERIFICATION_PAIRS_MAX) {
    return [
      `The access rules of this credential already use ${VERIFICATION_PAIRS_MAX} different JWKS URI and audience pairs for this issuer. Reuse one of them.`,
    ];
  }

  if (
    !Array.isArray(input.allowed_algs) ||
    !Array.isArray(input.anchor_claims) ||
    !Array.isArray(input.tenant_pin)
  ) {
    return [];
  }
  const groups = new Set<string>();
  for (const rule of others) {
    // A rule of an unknown profile is refused before verification, so it uses no group.
    const ruleProfile = rule.profile === profile.id ? profile : getProfile(rule.profile);
    if (ruleProfile !== null) groups.add(verificationGroupKey(rule, ruleProfile));
  }
  const own = verificationGroupKey({ ...input, id: existing?.id ?? '', issuer_key: key }, profile);
  if (!groups.has(own) && groups.size + 1 > VERIFICATION_GROUPS_MAX) {
    return [
      `The access rules of this credential already use ${VERIFICATION_GROUPS_MAX} different token verification settings for this issuer. Reuse the settings of one of them.`,
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// Global access rules

/**
 * Validates a global access rule. Every set limit has the shape rules of the credential side;
 * conditions need no anchor. `existing` is the stored row on update: its issuer and profile
 * cannot change (AR-5).
 */
export function validateGlobalAccessRule(
  input: GlobalAccessRuleInput,
  profile: IssuerProfile,
  existing: Pick<PolicyGlobalRule, 'profile' | 'issuer'> | null,
): AccessRuleValidationResult {
  const errors: string[] = [];
  const details: AccessRuleWarningDetail[] = [];

  errors.push(...nameAndDescriptionErrors(input));
  if (input.profile !== profile.id) errors.push('profile does not match the selected profile');
  if (
    existing !== null &&
    (existing.profile !== input.profile || existing.issuer !== input.issuer)
  ) {
    errors.push(
      'The issuer and the issuer type of a global access rule cannot change. Add a new global access rule and delete this one.',
    );
  }
  errors.push(...issuerErrors(input.issuer, profile));

  if (input.jwks_uri !== null) {
    const jwksError = httpsUrlError(input.jwks_uri);
    if (jwksError !== null) errors.push(`JWKS URI ${jwksError}`);
  }
  if (input.audience !== null) errors.push(...audienceErrors(input.audience));
  if (input.allowed_algs !== null) {
    errors.push(
      ...listErrors('signing algorithms', input.allowed_algs, 0, (algs) => algorithmErrors(algs)),
    );
  }
  if (input.max_token_age_seconds !== null) {
    errors.push(...maxAgeErrors(input.max_token_age_seconds, profile));
  }
  if (input.tenant_pin !== null) {
    errors.push(
      ...listErrors('tenant pin', input.tenant_pin, 0, (pin) => pinConditionErrors(pin, profile)),
    );
  }
  if (input.anchor_claims !== null) {
    errors.push(...listErrors('anchor claims', input.anchor_claims, 8, claimNameErrors));
  }
  if (input.conditions !== null) {
    errors.push(
      ...listErrors('conditions', input.conditions, 32, (conditions) =>
        conditions.flatMap((condition, index) => {
          const shapeError = conditionShapeError(condition);
          return shapeError === null ? [] : [`condition ${index + 1}: ${shapeError}`];
        }),
      ),
    );
  }
  if (input.rules !== null) errors.push(...listErrors('operations', input.rules, 50, ruleErrors));

  const limits = [
    input.jwks_uri,
    input.audience,
    input.allowed_algs,
    input.max_token_age_seconds,
    input.tenant_pin,
    input.anchor_claims,
    input.conditions,
    input.rules,
  ];
  if (limits.every((limit) => limit === null)) {
    details.push({
      code: 'global_no_limit',
      message:
        'This global access rule limits nothing. While it is enabled, the credential access rules of this issuer are not limited. While it is disabled or expired, and no other global access rule of the issuer holds, they admit nothing.',
    });
  }
  return { errors, warnings: details.map((detail) => detail.message), warningDetails: details };
}

/** A set list limit: a non-empty list of at most `max` entries (0: no maximum), then `check`. */
function listErrors<T>(
  label: string,
  value: T[],
  max: number,
  check: (items: T[]) => string[],
): string[] {
  if (!Array.isArray(value)) return [`${label} must be a list`];
  if (value.length === 0) return [`${label}: ${EMPTY_LIMIT}`];
  if (max > 0 && value.length > max) return [`${label}: at most ${max} entries`];
  return check(value);
}

// ---------------------------------------------------------------------------------------------
// Shared checks

function nameAndDescriptionErrors(input: { name: string; description?: string }): string[] {
  const errors: string[] = [];
  const nameError = requiredTextError(input.name, 100);
  if (nameError !== null) errors.push(`name ${nameError}`);
  const description: unknown = input.description;
  if (description !== undefined) {
    if (typeof description !== 'string') {
      errors.push('description must be text');
    } else if (description.length > DESCRIPTION_MAX_LENGTH) {
      errors.push(`description must be at most ${DESCRIPTION_MAX_LENGTH} characters`);
    } else if (hasControlChars(description)) {
      errors.push('description must not contain control characters');
    }
  }
  return errors;
}

/** https URL in canonical form, on the host of its CI platform's profile. */
function issuerErrors(issuer: string, profile: IssuerProfile): string[] {
  // OpenID Connect Discovery 1.0 §3: issuer is https with no query or fragment.
  // https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata
  const issuerError = httpsUrlError(issuer);
  if (issuerError !== null) return [`issuer ${issuerError}`];
  const errors: string[] = [];
  const canonicalError = canonicalIssuerError(issuer);
  if (canonicalError !== null) errors.push(canonicalError);
  const issuerHost = new URL(issuer).hostname;
  const requiredProfile = CI_ISSUER_HOSTS.get(issuerHost);
  if (requiredProfile !== undefined && requiredProfile !== profile.id) {
    errors.push(`issuers on ${issuerHost} must use the ${requiredProfile} profile`);
  }
  return errors;
}

function algorithmErrors(algs: unknown): string[] {
  if (!Array.isArray(algs) || algs.length === 0) {
    return ['at least one signing algorithm is required'];
  }
  const errors: string[] = [];
  for (const alg of algs) {
    if (!(ALLOWED_ALGS as readonly unknown[]).includes(alg)) {
      errors.push(`signing algorithm ${JSON.stringify(alg)} is not allowed`);
    }
  }
  if (new Set(algs).size !== algs.length) errors.push('signing algorithms are listed twice');
  return errors;
}

/** Exact, non-negated conditions on the profile's tenant claims (I-TEN-1). */
function pinConditionErrors(pin: Condition[], profile: IssuerProfile): string[] {
  const errors: string[] = [];
  for (const condition of pin) {
    const shapeError = conditionShapeError(condition);
    if (shapeError !== null) {
      errors.push(`tenant pin: ${shapeError}`);
      continue;
    }
    if (condition.match !== 'exact' || condition.negate === true) {
      errors.push(`tenant pin: ${condition.claim} must be an exact, non-negated condition`);
    }
    if (profile.tenantClaims.length > 0 && !profile.tenantClaims.includes(condition.claim)) {
      errors.push(
        `tenant pin: claim ${condition.claim} is not allowed; use ${profile.tenantClaims.join(' or ')}`,
      );
    }
  }
  return errors;
}

/** Control characters other than tab and line breaks, which descriptions may contain. */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function claimNameErrors(claims: string[]): string[] {
  const errors: string[] = [];
  for (const claim of claims) {
    const claimError = requiredTextError(claim, CLAIM_NAME_MAX_LENGTH);
    if (claimError !== null) errors.push(`anchor claim ${claimError}`);
  }
  if (new Set(claims).size !== claims.length) errors.push('anchor claims are listed twice');
  return errors;
}

function maxAgeErrors(maxAge: unknown, profile: IssuerProfile): string[] {
  const limit = profile.defaults.maxTokenAgeLimitSeconds;
  if (typeof maxAge !== 'number' || !Number.isInteger(maxAge) || maxAge < 60 || maxAge > limit) {
    return [`maximum token age must be an integer between 60 and ${limit} seconds`];
  }
  return [];
}

function ruleListErrors(rules: unknown): string[] {
  if (!Array.isArray(rules) || rules.length === 0) return ['at least one rule is required'];
  if (rules.length > 50) return ['at most 50 rules'];
  return ruleErrors(rules);
}

function ruleErrors(rules: unknown[]): string[] {
  return rules.flatMap((rule, index) => {
    const ruleError = ruleShapeError(rule);
    return ruleError === null ? [] : [`rule ${index + 1}: ${ruleError}`];
  });
}
