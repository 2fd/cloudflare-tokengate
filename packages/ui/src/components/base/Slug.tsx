import { cx } from '../../lib/cx';

export interface SlugProps {
  class?: string;
  /** The slug (`slack`, `slack-legacy`): the path segment of the proxy URL. */
  children: string;
}

/** A token or consumer slug (`.slug`): 12px mono, muted, next to the name it belongs to. */
export function Slug({ class: className, children }: SlugProps) {
  return <span class={cx('slug', className)}>{children}</span>;
}
