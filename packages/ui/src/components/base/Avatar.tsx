import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface AvatarProps {
  /** The person's name: the initials come from it ("Maya Chen" → "MC"). */
  name?: string;
  /** Initials to show instead of the ones taken from `name`. */
  initials?: string;
  /** `sm` 28 (default), `md` 32, `lg` 40. */
  size?: 'sm' | 'md' | 'lg';
  /** `pending`: dashed ring, a person waiting for approval. `sys`: a square tile for system actors. */
  variant?: 'pending' | 'sys';
  class?: string;
  /** Content instead of initials: an `Icon` for system actors. */
  children?: Child;
}

/** The initials of a name, at most 2 letters: first and last word. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/**
 * A round avatar with initials (`.avatar`). Decorative (`aria-hidden`): the name is always next to
 * it. There are no photos: nothing is loaded from another origin.
 */
export function Avatar(props: AvatarProps) {
  return (
    <span
      class={cx('avatar', props.size !== 'sm' && props.size, props.variant, props.class)}
      aria-hidden="true"
    >
      {props.children ?? props.initials ?? (props.name ? initialsOf(props.name) : null)}
    </span>
  );
}
