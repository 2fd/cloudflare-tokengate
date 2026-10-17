import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { SrPrefix } from '../../lib/sr';

export interface HealthStripProps {
  /** Bold first sentence: "Keyring unavailable.". */
  title: string;
  /** Decorative glyph before the title. Default `✕`. */
  glyph?: string;
  /**
   * Visually hidden text read before the title, after the glyph ("Error:"): the word the glyph
   * stands for. The separating space is added.
   */
  srPrefix?: string;
  /**
   * `'alert'` (default) announces the strip when it appears. `null` leaves out the role: for a
   * strip that is part of every page load (the admin shell), which must not be announced each time.
   */
  role?: 'alert' | null;
  /** What it means for the user: "Stored secrets cannot be opened, so every call fails." */
  children?: Child;
  /** The one fix, usually a link: `<a href="/admin/credentials/keys">Fix encryption keys</a>`. */
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
  srPrefix,
  role = 'alert',
  children,
  action,
  class: className,
}: HealthStripProps) {
  return (
    <p class={cx('hstrip', className)} role={role ?? undefined}>
      <b>
        <span aria-hidden="true">{glyph}</span> <SrPrefix text={srPrefix} />
        {title}
      </b>
      {children ? <> {children}</> : null}
      {action ? <> {action}</> : null}
    </p>
  );
}
