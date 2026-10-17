import { conditionShapeError } from '../policy/conditions';
import type { Condition } from '../policy/types';
import { parseValueList } from './grant-text';

/** One filter per line: environment exact production. Values use the existing value-list syntax. */
export function parseBoundaryFilters(
  text: string,
): { ok: true; conditions: Condition[] } | { ok: false; error: string } {
  const conditions: Condition[] = [];
  for (const line of text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    const match = /^(not\s+)?("(?:[^"\\]|\\.)*"|\S+)\s+(exact|glob)\s+(.+)$/.exec(line);
    if (!match)
      return { ok: false, error: 'Use one filter per line, such as environment exact production.' };
    const values = parseValueList(match[4] ?? '');
    if (!values.ok) return values;
    let claim = match[2]!;
    if (claim.startsWith('"')) {
      try {
        claim = JSON.parse(claim) as string;
      } catch {
        return { ok: false, error: 'Use a valid JSON string for a quoted claim name.' };
      }
    }
    const condition: Condition = {
      claim,
      match: match[3] as 'exact' | 'glob',
      values: values.values,
    };
    if (match[1]) condition.negate = true;
    const error = conditionShapeError(condition);
    if (error) return { ok: false, error };
    conditions.push(condition);
  }
  if (conditions.length > 32) return { ok: false, error: 'Use at most 32 filters.' };
  return { ok: true, conditions };
}
