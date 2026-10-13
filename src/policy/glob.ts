// Glob matcher for rule paths and claim conditions (docs/policies.md): `*` is any run without `/`, `**` any
// run including `/`, everything else is literal and case-sensitive; the whole value must match.
// No RegExp, no backtracking: one left-to-right NFA pass, O(value × pattern), both length-bounded.

export const GLOB_MAX_PATTERN_LENGTH = 512;
export const GLOB_MAX_WILDCARDS = 8;
/** Values longer than this never match (fail closed; bounds matching cost). */
export const GLOB_MAX_VALUE_LENGTH = 1024;

/** One pattern step: a literal UTF-16 code unit, `*` (segment wildcard) or `**` (any). */
type Token = { kind: 'char'; code: number } | { kind: 'star' } | { kind: 'globstar' };

const SLASH = 0x2f;
const ASTERISK = 0x2a;

/** Splits a pattern into tokens. A run of two or more `*` is one `**`. */
function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < pattern.length) {
    const code = pattern.charCodeAt(i);
    if (code !== ASTERISK) {
      tokens.push({ kind: 'char', code });
      i++;
      continue;
    }
    let run = 0;
    while (i < pattern.length && pattern.charCodeAt(i) === ASTERISK) {
      run++;
      i++;
    }
    tokens.push(run === 1 ? { kind: 'star' } : { kind: 'globstar' });
  }
  return tokens;
}

/** Returns null when `pattern` is a valid glob, otherwise a reason suitable for admins. */
export function globError(pattern: string): string | null {
  if (pattern.length === 0) return 'pattern is empty';
  if (pattern.length > GLOB_MAX_PATTERN_LENGTH) {
    return `pattern is longer than ${GLOB_MAX_PATTERN_LENGTH} characters`;
  }
  const wildcards = tokenize(pattern).filter((t) => t.kind !== 'char').length;
  if (wildcards > GLOB_MAX_WILDCARDS) {
    return `pattern has more than ${GLOB_MAX_WILDCARDS} wildcards`;
  }
  return null;
}

/**
 * True when `value` matches `pattern` in full. Invalid patterns and values longer than
 * GLOB_MAX_VALUE_LENGTH never match.
 *
 * Implementation: simulate the pattern as an NFA whose states are token positions. `active[p]`
 * means "the value consumed so far can be matched by tokens[0..p)". Wildcards may consume zero
 * characters (epsilon step to p+1) or one more character (stay at p).
 */
export function globMatch(pattern: string, value: string): boolean {
  if (globError(pattern) !== null) return false;
  if (value.length > GLOB_MAX_VALUE_LENGTH) return false;

  const tokens = tokenize(pattern);
  const end = tokens.length;
  let active = new Uint8Array(end + 1);
  active[0] = 1;
  skipWildcards(tokens, active);

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const next = new Uint8Array(end + 1);
    let any = false;
    for (let p = 0; p < end; p++) {
      if (active[p] !== 1) continue;
      const token = tokens[p] as Token;
      if (token.kind === 'char') {
        if (token.code === code) {
          next[p + 1] = 1;
          any = true;
        }
      } else if (token.kind === 'globstar' || code !== SLASH) {
        next[p] = 1;
        any = true;
      }
    }
    if (!any) return false;
    skipWildcards(tokens, next);
    active = next;
  }
  return active[end] === 1;
}

/** Epsilon closure: a wildcard at an active position may match nothing. */
function skipWildcards(tokens: Token[], active: Uint8Array): void {
  for (let p = 0; p < tokens.length; p++) {
    if (active[p] === 1 && (tokens[p] as Token).kind !== 'char') active[p + 1] = 1;
  }
}
