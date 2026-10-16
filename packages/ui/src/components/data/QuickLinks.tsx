import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface QuickLink {
  href: string;
  /** The status or group ("Denied", "Expiring", "Owners"). */
  label: Child;
  /** Rows in it ("241"). */
  count?: number | string;
  /** `warn` / `bad` tint the glyph only; the word carries the meaning. */
  tone?: 'warn' | 'bad';
  /** Leading glyph (✕ ⚠ ⌛ ⏸ ◐), decorative. */
  glyph?: string;
  /** This link is the filter in use (`aria-current`): accent-soft fill. */
  current?: boolean;
}

export interface QuickLinksProps {
  /** Accessible name of the navigation ("Filter tokens by status"). Unique on the page. */
  label: string;
  links: readonly QuickLink[];
  /** Visible lead text before the links ("Needs attention"). */
  lead?: Child;
  class?: string;
}

/**
 * Quick filter links with counts (`nav.qlinks` > `a.ql`): status filters above a list, or the
 * focus switch of the connections map. One link is current.
 */
export function QuickLinks(props: QuickLinksProps) {
  return (
    <nav class={cx('qlinks', props.class)} aria-label={props.label}>
      {props.lead !== undefined ? <span class="meta">{props.lead}</span> : null}
      {props.links.map((link) => (
        <a
          class={cx('ql', link.tone)}
          href={link.href}
          aria-current={link.current ? 'true' : undefined}
        >
          {link.glyph ? (
            <span class="g" aria-hidden="true">
              {link.glyph}
            </span>
          ) : null}
          {link.label}
          {link.count !== undefined ? (
            <>
              {' '}
              <span class="n">{link.count}</span>
            </>
          ) : null}
        </a>
      ))}
    </nav>
  );
}
