import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface HealthLineProps {
  /** Where the line leads: Overview, Needs attention (`/admin#ov-attention`) or Health (`#ov-health`). */
  href: string;
  /** Dot color; `ok` (default) is green. The words carry the meaning. */
  tone?: 'ok' | 'warn' | 'bad' | 'info';
  /** Visible summary: "3 warnings to review", "Healthy · 1 note". */
  children: Child;
  /** Rest of the link name for screen readers: ". Open Overview, Needs attention". */
  srLabel?: string;
  class?: string;
}

/**
 * Health line under the instance block (`a.health`): one dot and a short summary that links to
 * the Overview. Pass it to `AppShell`'s `health` slot. Hidden below 40rem (the top bar).
 */
export function HealthLine({
  href,
  tone = 'ok',
  children,
  srLabel,
  class: className,
}: HealthLineProps) {
  return (
    <a class={cx('health', className)} href={href}>
      <span class={cx('dot', tone !== 'ok' && tone)} aria-hidden="true"></span>
      {children}
      {srLabel ? <span class="vh">{srLabel}</span> : null}
    </a>
  );
}
