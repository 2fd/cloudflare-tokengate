import { cx } from '../../lib/cx';
import type { BaseProps } from '../../lib/props';

/**
 * A read-only inherited fact (`p.inherit`): “Inherited from **GitHub Actions (acme)**:
 * organization acme (1234567)”. Put the source in `<b>`.
 */
export function Inherit(props: BaseProps) {
  return <p class={cx('inherit', props.class)}>{props.children}</p>;
}
