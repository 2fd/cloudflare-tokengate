import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface ResultProps {
  /** `ok` allowed, `bad` denied, `warn` upstream error. The word carries the meaning. */
  tone: 'ok' | 'bad' | 'warn';
  /** HTTP status code after the word, in mono (`.code`). */
  code?: number | string;
  class?: string;
  /** The outcome word: "Allowed", "Denied", "Error". */
  children: Child;
}

/** A request outcome in a log row (`.res`): dot, word and status code. */
export function Result({ tone, code, class: className, children }: ResultProps) {
  return (
    <span class={cx('res', tone, className)}>
      <span class={cx('dot', tone !== 'ok' && tone)} aria-hidden="true"></span>
      {children}
      {code !== undefined ? (
        <>
          {' '}
          <span class="code">{code}</span>
        </>
      ) : null}
    </span>
  );
}
