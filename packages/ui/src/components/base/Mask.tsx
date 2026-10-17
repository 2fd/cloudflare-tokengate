import { cx } from '../../lib/cx';
import { SrPrefix } from '../../lib/sr';

export interface MaskProps {
  /**
   * The last characters of the secret, as stored for display ("9fQa"). Only the last 4 are ever
   * rendered, whatever is passed. Missing or empty: tokengate did not keep them (secrets under 20
   * characters), and the mask is "••••" read "Secret, last characters not stored". Never pass a
   * placeholder such as `????`.
   */
  last4?: string;
  /** `lg` (36px, 16px type): the secret block of a token page. Default 24px. */
  size?: 'md' | 'lg';
  /**
   * Screen-reader text before the visible characters. Default "Secret ending in". Not used
   * without `last4`.
   */
  srPrefix?: string;
  class?: string;
}

/**
 * A masked secret (`.mask`): "•••• 9fQa". Secrets are never revealed or copied in the UI; the
 * last 4 characters are only there to tell two secrets apart. `Secret` draws its mask with it.
 */
export function Mask({
  last4,
  size = 'md',
  srPrefix = 'Secret ending in',
  class: className,
}: MaskProps) {
  const classes = cx('mask', size === 'lg' && 'lg', className);
  if (!last4) {
    return (
      <span class={classes}>
        <span aria-hidden="true">••••</span>
        <span class="vh">Secret, last characters not stored</span>
      </span>
    );
  }
  return (
    <span class={classes}>
      <span aria-hidden="true">{'•••• '}</span>
      <SrPrefix text={srPrefix} />
      {last4.slice(-4)}
    </span>
  );
}
