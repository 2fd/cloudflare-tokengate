import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface MonoProps {
  class?: string;
  /** A machine value in running text: a repository, a path, a claim. */
  children: Child;
}

/**
 * A machine value in mono type (`.mono`) inside running text: `acme/api`, `/proxy/slack`. For a
 * full object ID use `IdChip`; for a slug next to a name use `Slug`; for code use `code`.
 */
export function Mono({ class: className, children }: MonoProps) {
  return <span class={cx('mono', className)}>{children}</span>;
}
