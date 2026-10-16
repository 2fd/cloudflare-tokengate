import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface HealthStripProps {
  /** Bold first sentence: "Keyring unavailable.". */
  title: string;
  /** Decorative glyph before the title. Default `✕`. */
  glyph?: string;
  /** What it means for the user: "Stored secrets cannot be opened, so every call fails." */
  children?: Child;
  /** The one fix, usually a link: `<a href="/admin/tokens/keys">Fix encryption keys</a>`. */
  action?: Child;
  class?: string;
}

/**
 * Error-level health strip at the top of the main column (`p.hstrip[role=alert]`). Full-width
 * background; its text lines up with the centered page column. Only for problems that break
 * every call; warnings go to the health line and Needs attention. Pass it to `AppShell`'s
 * `banner` slot.
 */
export function HealthStrip({
  title,
  glyph = '✕',
  children,
  action,
  class: className,
}: HealthStripProps) {
  return (
    <p class={cx('hstrip', className)} role="alert">
      <b>
        <span aria-hidden="true">{glyph}</span> {title}
      </b>
      {children ? <> {children}</> : null}
      {action ? <> {action}</> : null}
    </p>
  );
}
