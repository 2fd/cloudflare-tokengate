import { cx } from '../../lib/cx';
import type { BaseProps } from '../../lib/props';

/**
 * Tab row (`.tabrow`): `Tabs` on the left and a `Segmented` control on the right on one shared
 * bottom line; they wrap onto two lines on narrow screens.
 */
export function TabRow({ class: className, children }: BaseProps) {
  return <div class={cx('tabrow', className)}>{children}</div>;
}
