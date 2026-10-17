import { cx } from '../../lib/cx';
import type { Tone } from '../../lib/props';
import type { StatusWordProps } from './Status';
import { STATUS_VOCABULARY } from './vocabulary';

export type BadgeTone = Tone | 'accent' | 'outline' | 'neutral';

/**
 * `status` is a meaning from the status vocabulary (`active`, `expiring`, `expired`,
 * `risk-accepted`, `pending`, `disabled`, `no-secret`): it sets the tone, the glyph and the default
 * word; `tone`, `glyph` and `children` still override it ("Expires in 6 days"). Without `status`
 * the word is the children, required: a badge never renders a bare glyph.
 */
export type BadgeProps = StatusWordProps & {
  /** Color of the badge; `neutral` (default) is gray. The word carries the meaning, never the color. */
  tone?: BadgeTone;
  /** Leading glyph (`✓`, `⌛`, `✕`, `◐`, `⏸`, `⚠`, `–`). Decorative: hidden from assistive tech. */
  glyph?: string;
  class?: string;
};

/**
 * A 22px status or label badge (`.badge`). Status badges use the vocabulary (`status`); labels
 * ("Owner", "Most used", "You") use the neutral, accent and outline tones.
 */
export function Badge({ status, tone, glyph, class: className, children }: BadgeProps) {
  const preset = status ? STATUS_VOCABULARY[status] : undefined;
  const finalTone = tone ?? preset?.tone ?? 'neutral';
  const finalGlyph = glyph ?? preset?.glyph;
  return (
    <span class={cx('badge', finalTone !== 'neutral' && finalTone, className)}>
      {finalGlyph ? <span aria-hidden="true">{finalGlyph}</span> : null}
      {children ?? preset?.word}
    </span>
  );
}
