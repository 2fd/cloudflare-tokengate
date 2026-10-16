import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

/** The four admin sections of the sidebar, in sidebar order. */
export type NavIconName = 'monitoring' | 'tokens' | 'consumers' | 'users';

export interface NavIconProps {
  name: NavIconName;
  class?: string;
}

/** Path data of each icon, 24px grid, drawn with `stroke: currentColor` by `svg.ic`. */
const ICONS: Record<NavIconName, () => Child> = {
  monitoring: () => <path d="M3 12h4l3-7 4 14 3-7h4" />,
  tokens: () => (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M16 7l3 3" />
    </>
  ),
  consumers: () => (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <path d="M10 6.5h4a3 3 0 0 1 3 3V14" />
    </>
  ),
  users: () => (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.6c1.8.7 3 2.6 3.5 5.4" />
    </>
  ),
};

/**
 * Decorative 16px section icon (`svg.ic`, `aria-hidden`), inline SVG so every page renders the
 * sidebar the same way with no sprite or external file. The section label carries the meaning.
 */
export function NavIcon({ name, class: className }: NavIconProps) {
  return (
    <svg class={cx('ic', className)} viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name]()}
    </svg>
  );
}
