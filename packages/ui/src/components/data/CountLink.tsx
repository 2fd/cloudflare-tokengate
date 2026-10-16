import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface CountLinkProps {
  /** The filtered list the number counts ("/admin/requests?outcome=denied&token=slack"). */
  href: string;
  /** `bad` for denials, `warn` for errors; plain otherwise. The number and the column name carry the meaning. */
  tone?: 'bad' | 'warn';
  /** Screen reader suffix that says what is counted (" denied requests from acme/web"). */
  srLabel?: string;
  class?: string;
  /** The number, formatted ("2,140"), or a short count phrase ("2 consumers · 3 accesses"). */
  children: Child;
}

/** A count that links to the list it counts (`a.nlink`): tabular figures, medium weight. */
export function CountLink({ href, tone, srLabel, class: className, children }: CountLinkProps) {
  return (
    <a class={cx('nlink', tone, className)} href={href}>
      {children}
      {srLabel ? <span class="vh">{srLabel}</span> : null}
    </a>
  );
}
