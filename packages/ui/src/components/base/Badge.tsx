import { cx } from '../../lib/cx';
import type { BaseProps, Tone } from '../../lib/props';

export type BadgeTone = Tone | 'accent' | 'outline' | 'neutral';

export interface BadgeProps extends BaseProps {
  /** Status tone; `neutral` (default) is gray. The word carries the meaning, never the color. */
  tone?: BadgeTone;
  /** Leading glyph (`✓`, `⌛`, `✕`, `◐`, `⏸`, `⚠`). Decorative: hidden from assistive tech. */
  glyph?: string;
}

/**
 * A 22px status or label badge (`.badge`). Minimal version from the docs scaffold; the base group
 * completes it (status presets from the vocabulary table).
 */
export function Badge({ tone = 'neutral', glyph, class: className, children }: BadgeProps) {
  return (
    <span class={cx('badge', tone !== 'neutral' && tone, className)}>
      {glyph ? <span aria-hidden="true">{glyph}</span> : null}
      {children}
    </span>
  );
}
