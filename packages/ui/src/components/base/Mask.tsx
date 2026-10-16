import { cx } from '../../lib/cx';

export interface MaskProps {
  /**
   * The last characters of the secret, as stored for display ("9fQa"). Only the last 4 are ever
   * rendered, whatever is passed.
   */
  last4: string;
  /** `lg` (36px, 16px type): the secret block of a token page. Default 24px. */
  size?: 'md' | 'lg';
  /** Screen-reader text before the visible characters. Default "Secret ending in". */
  srLabel?: string;
  class?: string;
}

/**
 * A masked secret (`.mask`): "•••• 9fQa". Secrets are never revealed or copied in the UI; the
 * last 4 characters are only there to tell two secrets apart.
 */
export function Mask({
  last4,
  size = 'md',
  srLabel = 'Secret ending in',
  class: className,
}: MaskProps) {
  return (
    <span class={cx('mask', size === 'lg' && 'lg', className)}>
      <span aria-hidden="true">{'••••\u00a0'}</span>
      <span class="vh">{`${srLabel} `}</span>
      {last4.slice(-4)}
    </span>
  );
}
