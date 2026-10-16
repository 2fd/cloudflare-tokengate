import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface DisclosureProps {
  /** The summary text: what opens ("Advanced trust settings"). */
  summary: Child;
  /** Regular-weight hint after the summary: what is inside ("issuer, audience, algorithms"). */
  hint?: Child;
  /**
   * `disc` (default): plain disclosure with a chevron, content under it. `more`: the "More
   * constraints" disclosure of a form, content as a 16px-gap grid of fields.
   */
  variant?: 'disc' | 'more';
  /** Rendered open (the server opens it when a field inside has an error). */
  open?: boolean;
  /** Exclusive group: only one disclosure with the same name is open. */
  name?: string;
  /** Id of the `details`, to link to it (`?open=trust#trust`). */
  id?: string;
  class?: string;
  children: Child;
}

/**
 * Disclosure (`details.disc` / `details.more`): native `details`, so it opens with the keyboard
 * and without JavaScript. Never put `required` fields in a closed disclosure.
 */
export function Disclosure(props: DisclosureProps) {
  const variant = props.variant ?? 'disc';
  return (
    <details
      class={cx(variant, props.class)}
      id={props.id}
      name={props.name}
      open={props.open ? true : undefined}
    >
      <summary>
        {props.summary}
        {props.hint !== undefined ? (
          <>
            {' '}
            <span class={variant === 'more' ? 'meta' : 'hint'}>{props.hint}</span>
          </>
        ) : null}
      </summary>
      <div class={variant === 'more' ? 'more-b' : 'disc-b'}>{props.children}</div>
    </details>
  );
}
