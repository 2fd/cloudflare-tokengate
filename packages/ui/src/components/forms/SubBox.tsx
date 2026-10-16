import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface SubBoxProps {
  /** `aside` for a side note next to a form (“When you save”), labelled by its heading. */
  as?: 'div' | 'aside';
  /** Id of the heading inside, for an `aside`. */
  labelledBy?: string;
  class?: string;
  children: Child;
}

/** Gray box (`.subbox`) for fields that belong together under one choice, or a side note. */
export function SubBox(props: SubBoxProps) {
  const Tag = props.as ?? 'div';
  return (
    <Tag class={cx('subbox', props.class)} aria-labelledby={props.labelledBy}>
      {props.children}
    </Tag>
  );
}
