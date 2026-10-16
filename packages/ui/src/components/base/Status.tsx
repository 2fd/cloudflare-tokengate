import { cx } from '../../lib/cx';
import type { BaseProps, Tone } from '../../lib/props';
import { STATUS_VOCABULARY, type StatusKind } from './vocabulary';

export interface StatusProps extends BaseProps {
  /** A meaning from the status vocabulary: sets the tone and the default word. */
  status?: StatusKind;
  /** Dot color; `ok` (default) is green. `off` is a hollow ring. */
  tone?: Tone;
}

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
