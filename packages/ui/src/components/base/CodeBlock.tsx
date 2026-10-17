import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface CodeBlockProps {
  /** Accessible name of the block ("Workflow snippet"). Required: the block is focusable. */
  label: string;
  /** Visible caption above the block (`.code-cap`). */
  caption?: Child;
  /** Extra classes on the `pre`. */
  class?: string;
  /** The code. Plain text is escaped by the renderer; use `<span class="c">` / `"k"` for tones. */
  children: Child;
}

/**
 * A code snippet (`pre.code`): scrolls on its own, focusable so keyboard users can scroll it, and
 * selects as a whole on click (`user-select: all`).
 */
export function CodeBlock({ label, caption, class: className, children }: CodeBlockProps) {
  return (
    <>
      {caption ? <p class="code-cap">{caption}</p> : null}
      <pre class={cx('code', className)} tabindex={0} role="group" aria-label={label}>
        {children}
      </pre>
    </>
  );
}
