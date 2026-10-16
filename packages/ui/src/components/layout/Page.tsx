import { cx } from '../../lib/cx';
import type { BaseProps } from '../../lib/props';

/**
 * The centered content column inside `.main` (`.page`): at most `--w-content-max` (76rem) plus
 * the gutters, 32px between top-level blocks. A page whose direct child is a `.form-layout`
 * narrows to the form measure (CSS `:has`), so nothing here changes for form pages.
 */
export function Page({ class: className, children }: BaseProps) {
  return <div class={cx('page', className)}>{children}</div>;
}
