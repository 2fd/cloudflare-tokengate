// Internal wiring of the forms group (not exported from the barrel). A Field or FieldSet provides
// the ids its control needs; a Reveal marks a hidden branch, where `required` is a bug.
import { createContext, useContext } from 'hono/jsx';

/** What a Field gives the one control inside it: its id and the ids that describe it. */
export interface FieldControl {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

/** What a FieldSet gives the choices inside it: the prefix of their input ids. */
export interface ChoiceGroup {
  id: string;
}

export const FieldContext = createContext<FieldControl | null>(null);
export const ChoiceContext = createContext<ChoiceGroup | null>(null);
export const RevealContext = createContext<boolean>(false);

/** The live-form field slots of `.lform` (`.sf1` … `.sf8`, `.sv1` … `.sv8`, `.rv1` … `.rv8`). */
export type LiveSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Props of the one control inside a Field, resolved against the Field around it. */
export function useControl(
  component: string,
  props: { id?: string; describedBy?: string; invalid?: boolean; required?: boolean },
): FieldControl {
  const field = useContext(FieldContext);
  assertNotRequiredInReveal(component, props.required);
  const id = props.id ?? field?.id;
  if (!id) throw new Error(`${component} needs an id, or a Field around it`);
  return {
    id,
    describedBy: props.describedBy ?? field?.describedBy,
    invalid: props.invalid ?? field?.invalid ?? false,
  };
}

/** The id prefix of a choice group: its own `id`, else the FieldSet around it. */
export function useChoiceIds(component: string, props: { id?: string; required?: boolean }) {
  assertNotRequiredInReveal(component, props.required);
  return props.id ?? useContext(ChoiceContext)?.id;
}

/**
 * A hidden branch (`.rvN`) is display:none until its option is picked, and the browser refuses to
 * submit a form with a required control it cannot show. The server validates those fields instead.
 */
export function assertNotRequiredInReveal(component: string, required: boolean | undefined) {
  if (required && useContext(RevealContext)) {
    throw new Error(
      `${component}: no required inside a Reveal (the server validates hidden fields)`,
    );
  }
}
