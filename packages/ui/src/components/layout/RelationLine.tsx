import { cx } from '../../lib/cx';
import type { BaseProps } from '../../lib/props';

/**
 * Relationship line under a detail header (`p.relline`): one sentence that says what the object
 * is connected to, with the counts as links ("2 consumers can use Slack through 3 accesses.").
 * Links and `b` read in the body color, medium weight.
 */
export function RelationLine({ class: className, children }: BaseProps) {
  return <p class={cx('relline', className)}>{children}</p>;
}
