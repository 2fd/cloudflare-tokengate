import type { Claims } from '../identity/types';
import { conditionShapeError, evaluateCondition } from './conditions';
import type { Condition } from './types';

const HIDDEN = new Set<string>();

/** Conservative containment: exact values can narrow a pattern; patterns must be identical.
 * Unknown containment is refused instead of treating a glob string as a concrete claim value.
 */
export function conditionsWithin(child: Condition[], boundary: Condition[]): boolean {
  if (!Array.isArray(child) || !Array.isArray(boundary)) return false;
  if ([...child, ...boundary].some((condition) => conditionShapeError(condition) !== null)) {
    return false;
  }
  return boundary.every((limit) =>
    child.some((condition) => {
      if (condition.claim !== limit.claim) return false;
      if (condition.match === 'exact' && condition.negate !== true) {
        return condition.values.every(
          (value) => evaluateCondition(limit, { [limit.claim]: value }, HIDDEN).ok,
        );
      }
      return (
        condition.match === limit.match &&
        (condition.negate === true) === (limit.negate === true) &&
        condition.values.every((value) => limit.values.includes(value)) &&
        limit.values.every((value) => condition.values.includes(value))
      );
    }),
  );
}

export function boundaryHolds(boundary: Condition[], claims: Claims): boolean {
  return (
    Array.isArray(boundary) &&
    boundary.every((condition) => evaluateCondition(condition, claims, HIDDEN).ok)
  );
}
