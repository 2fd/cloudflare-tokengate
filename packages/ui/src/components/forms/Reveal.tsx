import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { type LiveSlot, RevealContext } from './context';

export interface RevealProps {
  /** The live field slot whose choice shows this branch (the FieldSet's `live`). */
  field: LiveSlot;
  /** Option number (`data-o`, 1–12) that shows it: its position in the options list. */
  option: number;
  /**
   * Gray box around the branch (`.subbox`, default). Set false for a branch that is one field
   * directly in an existing box.
   */
  box?: boolean;
  class?: string;
  /** Conditional fields. Never `required`: rendering one throws. The server validates them. */
  children: Child;
}

/**
 * A hidden branch of a LiveForm (`.rvN[data-o]`): shown with `display:grid` while option `option`
 * of field `field` is checked, by the generic `:has()` rules of `.lform`. No JS.
 */
export function Reveal(props: RevealProps) {
  return (
    <div
      class={cx(`rv${props.field}`, props.box !== false && 'subbox', props.class)}
      data-o={String(props.option)}
    >
      <RevealContext.Provider value={true}>{props.children}</RevealContext.Provider>
    </div>
  );
}
