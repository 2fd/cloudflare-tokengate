import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface AskSomeoneProps {
  /** Names of the people who can do it; shown in bold ("Ask Priya Natarajan or Diego Ruiz."). */
  people: readonly string[];
  /**
   * How many more people can do it, not named (the component names at most the ones in `people`):
   * "Ask A, B or C and 2 more." Default 0. Ignored when `people` is empty.
   */
  more?: number;
  /** A way to reach them: usually a `mailto:` link with the page URL. */
  link?: { href: string; label: string };
  class?: string;
  /** Why the reader cannot do it: "Only token managers can add tokens." */
  children: Child;
}

/** "A, B or C": names joined for a sentence. */
function joinNames(people: readonly string[]): Child[] {
  const out: Child[] = [];
  people.forEach((person, index) => {
    if (index > 0) out.push(index === people.length - 1 ? ' or ' : ', ');
    out.push(<b>{person}</b>);
  });
  return out;
}

/**
 * Replaces an action the reader has no permission for (`p.ask`): why, who can do it, and how to
 * reach them. Never a disabled button without a reason.
 */
export function AskSomeone({
  people,
  more = 0,
  link,
  class: className,
  children,
}: AskSomeoneProps) {
  return (
    <p class={cx('ask', className)}>
      {children}
      {people.length > 0 ? (
        <>
          {' '}
          Ask {joinNames(people)}
          {more > 0 ? ` and ${more} more` : null}.
        </>
      ) : null}
      {link ? (
        <>
          {' '}
          <a href={link.href}>{link.label}</a>
        </>
      ) : null}
    </p>
  );
}
