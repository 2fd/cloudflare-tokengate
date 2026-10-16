import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface DeltaProps {
  /** Change against the previous period. The glyph is decorative; the word is read. */
  direction: 'up' | 'down' | 'none';
  /** `bad` (red) or `warn` (outlined) when the change is bad news; neutral gray by default. */
  tone?: 'bad' | 'warn';
  /** Extra classes on the span. */
  class?: string;
  /** The amount, already formatted: `6 %`, `41 %`. */
  children: Child;
}

const GLYPH = { up: '▲', down: '▼', none: '' } as const;
const WORD = { up: 'up', down: 'down', none: 'no change,' } as const;

/**
 * A change chip (`.delta`): `▲ 6 %`. Screen readers hear "up 6 %". Use the tone only when the
 * change needs attention (denials up), never to celebrate.
 */
export function Delta({ direction, tone, class: className, children }: DeltaProps) {
  return (
    <span class={cx('delta', tone, className)}>
      {direction !== 'none' ? <span aria-hidden="true">{`${GLYPH[direction]} `}</span> : null}
      <span class="vh">{`${WORD[direction]} `}</span>
      {children}
    </span>
  );
}
