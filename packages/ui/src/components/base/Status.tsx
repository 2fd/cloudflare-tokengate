import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import type { Tone } from '../../lib/props';
import { STATUS_VOCABULARY, type StatusKind } from './vocabulary';

/**
 * The word of a status: a meaning from the vocabulary (its word is the default), or the word
 * itself as children. One of the two is required, so a status never renders without a word.
 */
export type StatusWordProps =
  | {
      /** A meaning from the status vocabulary: sets the tone and the default word. */
      status: StatusKind;
      /** Replaces the vocabulary word ("Expires in 6 days"). */
      children?: Child;
    }
  | { status?: undefined; children: Child };

export type StatusProps = StatusWordProps & {
  /** Dot color; `ok` (default) is green. `off` is a hollow ring. */
  tone?: Tone;
  class?: string;
};

/**
 * Dot + text (`.st`), the status form for dense table rows. The dot is drawn by CSS and never
 * stands alone: the word is always there.
 */
export function Status({ status, tone, class: className, children }: StatusProps) {
  const preset = status ? STATUS_VOCABULARY[status] : undefined;
  const finalTone = tone ?? preset?.tone ?? 'ok';
  return (
    <span class={cx('st', finalTone !== 'ok' && finalTone, className)}>
      {children ?? preset?.word}
    </span>
  );
}

export interface DotProps {
  /** Dot color; `ok` (default) is green, `off` a hollow ring. */
  tone?: Tone;
  class?: string;
}

/**
 * A bare 8px status dot (`.dot`), decorative (`aria-hidden`). Only next to text that says the
 * same thing, such as the health line ("3 warnings to review").
 */
export function Dot({ tone = 'ok', class: className }: DotProps) {
  return <span class={cx('dot', tone !== 'ok' && tone, className)} aria-hidden="true" />;
}
