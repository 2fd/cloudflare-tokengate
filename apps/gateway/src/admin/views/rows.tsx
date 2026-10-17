// Repeating form rows (rules, constraints): the existing rows plus blank ones, named
// `${group}.${i}.${field}` and parsed back by parseRows (render.tsx). A row is removed by ticking
// its Remove box (applied at save, no extra submit) and all-blank rows are ignored, so adding or
// removing rows never needs script. "Add 2 more rows" is a secondary submit placed after the
// form's primary submit (AddRowsButton), so Enter still saves.
import { Button } from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import { Checkbox } from './components';

/** Blank rows rendered after the existing ones (and added by "Add 2 more rows"). */
export const BLANK_ROWS = 2;

export function RepeatingRows<K extends string>(props: {
  group: string;
  legend: string;
  keys: readonly K[];
  rows: ReadonlyArray<Partial<Record<K, string>>>;
  /** One row's controls; `prefix` is `${group}.${i}.` (field names and, via fieldId, their ids). */
  render: (index: number, row: Partial<Record<K, string>>, prefix: string) => Child;
  /** Accepted for the shared component contract; rows hold no form of their own. */
  csrf?: string;
  /** Blank rows after the existing ones; defaults to BLANK_ROWS. */
  blank?: number;
  /** Index of the row that takes the page-level focus (the first row "Add rows" created). */
  focusIndex?: number;
}) {
  const blank = Object.fromEntries(props.keys.map((key) => [key, ''])) as Record<K, string>;
  const rows = [
    ...props.rows,
    ...Array.from({ length: props.blank ?? BLANK_ROWS }, () => ({ ...blank })),
  ];
  const existing = props.rows.length;
  return (
    <fieldset class="rows">
      <legend>{props.legend}</legend>
      {rows.map((row, index) => (
        <div
          class="row"
          id={`row-${props.group}-${index}`}
          tabindex={index === props.focusIndex ? -1 : undefined}
          autofocus={index === props.focusIndex ? true : undefined}
        >
          {props.render(index, row, `${props.group}.${index}.`)}
          {index < existing ? (
            <Checkbox
              name={`${props.group}.${index}.remove`}
              label={
                <>
                  Remove<span class="vh"> row {index + 1}</span>
                </>
              }
            />
          ) : null}
        </div>
      ))}
    </fieldset>
  );
}

/**
 * The secondary submit (a ui ghost button, for inline adds) that re-renders the form with
 * BLANK_ROWS more rows; writes nothing. No browser validation: the rows may still be incomplete.
 */
export function AddRowsButton(props: { group: string }) {
  return (
    <Button
      variant="ghost"
      plus
      type="submit"
      name="_action"
      value={`add:${props.group}`}
      formnovalidate
    >
      Add {BLANK_ROWS} more rows
    </Button>
  );
}
