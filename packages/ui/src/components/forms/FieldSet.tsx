import type { Child } from 'hono/jsx';
import { cx, idList } from '../../lib/cx';
import { ChoiceContext, FieldContext, type LiveSlot } from './context';
import { FieldError, FieldLabelMarker } from './Field';

export interface FieldSetProps {
  /**
   * Id of the fieldset. Hint and error get `${id}-hint` / `${id}-error`; the choices inside get
   * input ids `${id}-1`, `${id}-2` … (link an ErrorSummary entry to the first enabled one,
   * `firstChoiceId(id, options)`: a fieldset cannot take focus).
   */
  id: string;
  /** The question (`legend`). Required: it names the group of choices. */
  legend: Child;
  optional?: boolean;
  neededFor?: string;
  /** Hint in words under the legend. */
  hint?: Child;
  /** Inline error from the server, above the choices. */
  error?: Child;
  /** Live-form field slot: adds `.sfN`, so `.svN` / `.rvN` elements follow its choices. */
  live?: LiveSlot;
  /** Counts the checked boxes inside for a SelectedCount (`.count-scope`). */
  countScope?: boolean;
  class?: string;
  /** RadioCards, RowPicker, Picks, CheckPresets, or Checkbox rows. */
  children: Child;
}

/**
 * A question answered by a group of choices (`fieldset.field` + `legend`). The fieldset is
 * described by its hint and error; the choice inputs take their ids from it.
 */
export function FieldSet(props: FieldSetProps) {
  const hintId = props.hint ? `${props.id}-hint` : undefined;
  const errorId = props.error ? `${props.id}-error` : undefined;
  return (
    <fieldset
      class={cx(
        'field',
        props.live !== undefined && `sf${props.live}`,
        props.countScope && 'count-scope',
        props.class,
      )}
      id={props.id}
      aria-describedby={idList(hintId, errorId)}
    >
      <legend>
        {props.legend}
        {props.optional || props.neededFor ? ' ' : null}
        <FieldLabelMarker optional={props.optional} neededFor={props.neededFor} />
      </legend>
      {props.hint ? (
        <span class="hint" id={hintId}>
          {props.hint}
        </span>
      ) : null}
      {props.error ? <FieldError id={errorId as string}>{props.error}</FieldError> : null}
      <FieldContext.Provider value={null}>
        <ChoiceContext.Provider value={{ id: props.id }}>{props.children}</ChoiceContext.Provider>
      </FieldContext.Provider>
    </fieldset>
  );
}
