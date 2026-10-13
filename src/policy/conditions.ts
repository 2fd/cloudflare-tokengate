// Claim conditions: one test on one verified claim (docs/policies.md). Conditions fail closed: a missing,
// non-scalar or unmatchable claim makes the condition false even when negated (I-AUTHZ-4).
// Trace details never echo the value of a claim outside the caller's reveal allowlist (I-LOG-1).
import type { Claims } from '../identity/types';
import { GLOB_MAX_VALUE_LENGTH, globError, globMatch } from './glob';
import type { Condition } from './types';

export const CLAIM_NAME_MAX_LENGTH = 256;
export const CONDITION_MAX_VALUES = 50;
export const CONDITION_VALUE_MAX_LENGTH = 512;

/**
 * The text a condition compares, or null when the claim cannot be compared.
 * Strings as-is; booleans as "true"/"false"; safe integers as decimal text. Missing claims,
 * null, arrays, objects and unsafe numbers (which JSON.parse may have rounded) give null.
 * The lookup is a literal own-property read: "a.b" is the claim named "a.b", never nested.
 */
export function claimText(claims: Claims, name: string): string | null {
  if (!Object.hasOwn(claims, name)) return null;
  const value = claims[name];
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

/** Returns null when `c` is a well-formed condition, otherwise a reason suitable for admins. */
export function conditionShapeError(c: unknown): string | null {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return 'condition must be an object';
  const { claim, match, values, negate } = c as Record<string, unknown>;
  if (typeof claim !== 'string' || claim.length === 0 || claim.length > CLAIM_NAME_MAX_LENGTH) {
    return `claim name must be 1-${CLAIM_NAME_MAX_LENGTH} characters`;
  }
  if (hasControlChars(claim)) return 'claim name contains control characters';
  if (match !== 'exact' && match !== 'glob') return `${claim}: match must be "exact" or "glob"`;
  if (negate !== undefined && typeof negate !== 'boolean') {
    return `${claim}: negate must be true or false`;
  }
  if (!Array.isArray(values) || values.length === 0 || values.length > CONDITION_MAX_VALUES) {
    return `${claim}: values must list 1-${CONDITION_MAX_VALUES} entries`;
  }
  for (const value of values) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > CONDITION_VALUE_MAX_LENGTH
    ) {
      return `${claim}: each value must be 1-${CONDITION_VALUE_MAX_LENGTH} characters`;
    }
    if (match === 'glob') {
      const error = globError(value);
      if (error !== null) return `${claim}: invalid glob ${JSON.stringify(value)}: ${error}`;
    }
  }
  return null;
}

/**
 * Evaluates one condition against verified claims.
 * - exact: claim text equals one of `values`.
 * - glob: claim text matches one of the `values` patterns.
 * - negate: claim text is present, comparable, and matches none of `values`.
 * Malformed conditions and values the glob matcher cannot evaluate are false, negated or not.
 * `revealClaims` lists claims whose value may appear in `detail` (stored in the request log).
 */
export function evaluateCondition(
  c: Condition,
  claims: Claims,
  revealClaims: ReadonlySet<string>,
): { ok: boolean; detail: string } {
  const shapeError = conditionShapeError(c);
  if (shapeError !== null) return { ok: false, detail: `condition malformed: ${shapeError}` };

  const name = clip(c.claim, 64);
  const text = claimText(claims, c.claim);
  if (text === null) {
    const reason = Object.hasOwn(claims, c.claim)
      ? 'claim is not a string, boolean or safe integer'
      : 'claim missing';
    return { ok: false, detail: `${name}: ${reason}` };
  }
  if (c.match === 'glob' && text.length > GLOB_MAX_VALUE_LENGTH) {
    return { ok: false, detail: `${name}: claim value longer than ${GLOB_MAX_VALUE_LENGTH}` };
  }

  const matched =
    c.match === 'exact'
      ? c.values.includes(text)
      : c.values.some((pattern) => globMatch(pattern, text));
  const ok = c.negate === true ? !matched : matched;

  const shown = revealClaims.has(c.claim) ? JSON.stringify(clip(text, 128)) : '(hidden)';
  const operator = `${c.negate === true ? 'not ' : ''}${c.match}`;
  return { ok, detail: `${name}=${shown} vs ${operator} ${clip(JSON.stringify(c.values), 160)}` };
}

/**
 * I-AUTHZ-2. True when some anchor rule is non-empty and every claim it lists has a well-formed,
 * exact, non-negated condition. Shared by save-time validation and request-time evaluation.
 */
export function satisfiesAnchorRule(conditions: unknown, anchorRules: string[][]): boolean {
  if (!Array.isArray(conditions)) return false;
  const pinned = new Set(
    conditions
      .filter((c) => conditionShapeError(c) === null)
      .filter((c: Condition) => c.match === 'exact' && c.negate !== true)
      .map((c: Condition) => c.claim),
  );
  return anchorRules.some((rule) => rule.length > 0 && rule.every((claim) => pinned.has(claim)));
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
