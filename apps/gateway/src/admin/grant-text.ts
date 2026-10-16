// Text forms of consumer access (grant) conditions and rules for the admin UI: the read-only
// "Exact conditions" copy, the comma-separated value lists of the rows editor, and the event
// summary shown next to an access. The UI has no condition or rule text syntax to type: values
// are parsed one field at a time (parseValueList); shapes, anchors and warnings are checked by
// policy/validate.ts when the access is saved.
//
//   conditions (display only): [not] <claim> <exact|glob> <value>[, <value>...]
//   rules (display only):      <METHOD[,METHOD...]|*> <path-glob>
//
// Values that would be ambiguous as bare text (empty, surrounding spaces, control characters, a
// leading quote or `#`, commas) are written as JSON strings, in both directions.
import type { IssuerProfile } from '../identity/types';
import type { Condition, Rule } from '../policy/types';

export function formatConditions(conditions: Condition[]): string {
  return conditions.map(formatCondition).join('\n');
}

export function formatCondition(condition: Condition): string {
  return `${condition.negate === true ? 'not ' : ''}${formatClaim(condition.claim)} ${condition.match} ${formatValueList(condition.values)}`;
}

export function formatRules(rules: Rule[]): string {
  return rules.map((rule) => `${rule.methods.join(',')} ${rule.path}`).join('\n');
}

/** Values as the rows editor shows them: `a, b`, with JSON quotes where a value needs them. */
export function formatValueList(values: readonly string[]): string {
  return values.map(formatValue).join(', ');
}

/**
 * The comma-separated alternatives of one rows-editor value field: bare text without commas
 * (trimmed), or JSON strings (`"a,b"`, `""`). Inverse of formatValueList.
 */
export function parseValueList(text: string): { ok: true; values: string[] } | ParseFailure {
  const scanner = new Scanner(text);
  const values: string[] = [];
  scanner.skipSpace();
  if (scanner.done()) return { ok: true, values };
  for (;;) {
    scanner.skipSpace();
    if (scanner.text[scanner.pos] === '"') {
      const value = scanner.quoted();
      if (value === null) {
        return fail('A quoted value is not complete: close it with ", like "a,b".');
      }
      values.push(value);
      scanner.skipSpace();
      if (scanner.done()) return { ok: true, values };
      if (scanner.text[scanner.pos] !== ',') {
        return fail('Put a comma after the quoted value, like "a,b", c.');
      }
      scanner.pos++;
      continue;
    }
    const comma = scanner.text.indexOf(',', scanner.pos);
    const end = comma === -1 ? scanner.text.length : comma;
    const value = scanner.text.slice(scanner.pos, end).trim();
    if (value === '') return fail('Remove the empty value between the commas (write "" for one).');
    values.push(value);
    if (comma === -1) return { ok: true, values };
    scanner.pos = comma + 1;
  }
}

export interface ParseFailure {
  ok: false;
  error: string;
}

function fail(error: string): ParseFailure {
  return { ok: false, error };
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
}
