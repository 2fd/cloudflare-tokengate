import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface RiskTagProps {
  /** The word. Default "Risk". */
  children?: Child;
  class?: string;
}

/** The small warn tag on a risky option or row (`.risktag`): "⚠ Risk". */
export function RiskTag({ class: className, children }: RiskTagProps) {
  return (
    <span class={cx('risktag', className)}>
      <span aria-hidden="true">⚠</span>
      {children ?? 'Risk'}
    </span>
  );
}
