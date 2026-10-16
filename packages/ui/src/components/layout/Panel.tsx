import { cx } from '../../lib/cx';
import type { BaseProps } from '../../lib/props';

export interface PanelProps extends BaseProps {
  /** `pad`: 20px padding and 20px between children. `flush`: no padding, for tables. */
  variant?: 'pad' | 'flush';
}

/** White panel inside a tray (`.panel`). Minimal version from the docs scaffold. */
export function Panel({ variant, class: className, children }: PanelProps) {
  return <div class={cx('panel', variant, className)}>{children}</div>;
}
