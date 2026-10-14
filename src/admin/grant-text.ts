// Plain-text form of grant conditions and rules for the admin UI (one per line), plus the event
// summary shown next to a grant. Parsing only checks the line syntax; shapes, anchors and
// warnings are checked by policy/validate.ts when the grant is saved.
//
//   conditions: [not] <claim> <exact|glob> <value>[, <value>...]
//   rules:      <METHOD[,METHOD...]|*> <path-glob>
//
// Claims and values that would be ambiguous as bare text (empty, surrounding spaces, control
// characters, a leading quote or `#`; commas in values; whitespace in claims, the claim `not`) are
// written as JSON strings. Blank lines and lines starting with `#` are ignored.
import type { IssuerProfile } from '../identity/types';
import type { Condition, Rule } from '../policy/types';

export type ParseFailure = { ok: false; errors: string[] };

export const CONDITION_SYNTAX = '[not] <claim> exact|glob <value>[, <value>...]';
export const RULE_SYNTAX = '<METHOD[,METHOD...]|*> /path-glob';

export function formatConditions(conditions: Condition[]): string {
  return conditions.map(formatCondition).join('\n');
}

export function formatCondition(condition: Condition): string {
  const values = condition.values.map(formatValue).join(', ');
  return `${condition.negate === true ? 'not ' : ''}${formatClaim(condition.claim)} ${condition.match} ${values}`;
}

export function parseConditions(
  text: string,
): { ok: true; conditions: Condition[] } | ParseFailure {
  const conditions: Condition[] = [];
  const errors: string[] = [];
  for (const [index, line] of contentLines(text)) {
    const parsed = parseConditionLine(line);
    if (typeof parsed === 'string') errors.push(`condition line ${index}: ${parsed}`);
    else conditions.push(parsed);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, conditions };
}

export function formatRules(rules: Rule[]): string {
  return rules.map((rule) => `${rule.methods.join(',')} ${rule.path}`).join('\n');
}

export function parseRules(text: string): { ok: true; rules: Rule[] } | ParseFailure {
  const rules: Rule[] = [];
  const errors: string[] = [];
  for (const [index, line] of contentLines(text)) {
    const match = /^(\S.*?)\s+(\/\S*)$/.exec(line);
    if (!match) {
      errors.push(`rule line ${index}: expected "${RULE_SYNTAX}", e.g. "GET /repos/**"`);
      continue;
    }
    const methods = (match[1] ?? '')
      .split(',')
      .map((method) => method.trim().toUpperCase())
      .filter((method) => method !== '');
    if (methods.length === 0) {
      errors.push(`rule line ${index}: list at least one method or *`);
      continue;
    }
    // Method names are checked by validateGrant against PROXY_METHODS.
    rules.push({ methods: methods as Rule['methods'], path: match[2] ?? '' });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, rules };
}

/** Which events a grant accepts under the event guard (I-AUTHZ-3). Null when the profile has none. */
export interface EventSummary {
  claim: string;
  /** Trusted events the grant accepts. */
  trusted: string[];
  /** Untrusted events the grant explicitly opts into (exact, non-negated). */
  optedIn: string[];
  /** True when an exact condition limits events to `trusted` + `optedIn`. */
  restricted: boolean;
}

export function eventSummary(conditions: Condition[], profile: IssuerProfile): EventSummary | null {
  const claim = profile.eventClaim;
  if (claim === undefined) return null;
  const exact = conditions.filter(
    (c) => c.claim === claim && c.match === 'exact' && c.negate !== true,
  );
  if (exact.length === 0) {
    return { claim, trusted: [...profile.trustedEvents], optedIn: [], restricted: false };
  }
  // Conditions are ANDed, so only events listed by every exact condition can match.
  const [first, ...rest] = exact;
  const allowed = (first?.values ?? []).filter((event) =>
    rest.every((c) => c.values.includes(event)),
  );
  const unique = [...new Set(allowed)];
  return {
    claim,
    trusted: unique.filter((event) => profile.trustedEvents.includes(event)),
    optedIn: unique.filter((event) => !profile.trustedEvents.includes(event)),
    restricted: true,
  };
}

// ---------------------------------------------------------------------------------------------

/** Non-blank, non-comment lines with 1-based line numbers. */
function contentLines(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  text.split(/\r\n|\r|\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line !== '' && !line.startsWith('#')) out.push([index + 1, line]);
  });
  return out;
}

function needsQuotes(text: string): boolean {
  return (
    text === '' ||
    text !== text.trim() ||
    text.startsWith('"') ||
    text.startsWith('#') ||
    // oxlint-disable-next-line eslint/no-control-regex -- control characters must be escaped
    /[\u0000-\u001f\u007f]/.test(text)
  );
}

function formatClaim(claim: string): string {
  return needsQuotes(claim) || /\s/.test(claim) || claim === 'not' ? JSON.stringify(claim) : claim;
}

function formatValue(value: string): string {
  return needsQuotes(value) || value.includes(',') ? JSON.stringify(value) : value;
}

/** Cursor over one line. */
class Scanner {
  pos = 0;
  constructor(readonly text: string) {}

  skipSpace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos] ?? '')) this.pos++;
  }

  done(): boolean {
    return this.pos >= this.text.length;
  }

  /** A JSON string literal at the cursor, or null when the quoted text is malformed. */
  quoted(): string | null {
    let end = this.pos + 1;
    while (end < this.text.length) {
      const char = this.text[end];
      if (char === '\\') end += 2;
      else if (char === '"') break;
      else end++;
    }
    if (end >= this.text.length) return null;
    try {
      const value: unknown = JSON.parse(this.text.slice(this.pos, end + 1));
      this.pos = end + 1;
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  /** A whitespace-free word, or a JSON string. */
  word(): { text: string; quoted: boolean } | null {
    this.skipSpace();
    if (this.done()) return null;
    if (this.text[this.pos] === '"') {
      const text = this.quoted();
      return text === null ? null : { text, quoted: true };
    }
    const start = this.pos;
    while (this.pos < this.text.length && !/\s/.test(this.text[this.pos] ?? '')) this.pos++;
    return { text: this.text.slice(start, this.pos), quoted: false };
  }
}

function parseConditionLine(line: string): Condition | string {
  const syntax = `expected "${CONDITION_SYNTAX}"`;
  const scanner = new Scanner(line);
  let first = scanner.word();
  if (first === null) return syntax;
  // A bare leading `not` always means negation; a claim named "not" is written as "not" in quotes.
  const negate = !first.quoted && first.text === 'not';
  if (negate) {
    first = scanner.word();
    if (first === null) return syntax;
  }
  const claim = first.text;
  const match = scanner.word();
  if (match === null || match.quoted) return syntax;
  const kind = match.text.toLowerCase();
  if (kind !== 'exact' && kind !== 'glob') {
    return `match must be "exact" or "glob", not ${JSON.stringify(match.text)}`;
  }
  const values = parseValues(scanner);
  if (typeof values === 'string') return values;
  if (values.length === 0) return `${syntax}: at least one value is required`;
  const condition: Condition = { claim, match: kind, values };
  if (negate) condition.negate = true;
  return condition;
}

/** Comma-separated values; each is a JSON string or bare text without commas (trimmed). */
function parseValues(scanner: Scanner): string[] | string {
  const values: string[] = [];
  scanner.skipSpace();
  if (scanner.done()) return values;
  for (;;) {
    scanner.skipSpace();
    if (scanner.text[scanner.pos] === '"') {
      const value = scanner.quoted();
      if (value === null) return 'a quoted value is not a valid JSON string';
      values.push(value);
      scanner.skipSpace();
      if (scanner.done()) return values;
      if (scanner.text[scanner.pos] !== ',') return 'expected "," after a quoted value';
      scanner.pos++;
      continue;
    }
    const comma = scanner.text.indexOf(',', scanner.pos);
    const end = comma === -1 ? scanner.text.length : comma;
    const value = scanner.text.slice(scanner.pos, end).trim();
    if (value === '') return 'empty value (write "" for an empty string)';
    values.push(value);
    if (comma === -1) return values;
    scanner.pos = comma + 1;
  }
}
