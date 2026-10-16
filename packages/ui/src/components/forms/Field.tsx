import type { Child } from 'hono/jsx';
import { cx, idList } from '../../lib/cx';
import { FieldContext } from './context';

export interface FieldProps {
  /** Id of the control. The hint, error and note get `${id}-hint`, `${id}-error`, `${id}-note`. */
  id: string;
  /** Visible label (`label[for=id]`). Required: every control has a name. */
  label: Child;
  /** Adds “(optional)” after the label. Fields are required unless they say so. */
  optional?: boolean;
  /** Adds “(needed for …)” after the label: a field that only one choice needs ("Environment"). */
  neededFor?: string;
  /** Hint in words, between label and control. Describes the control. */
  hint?: Child;
  /** Inline error from the server, above the control. Sets aria-invalid on the control. */
  error?: Child;
  /** Line after the control that also describes it (a kept draft, a derived value). */
  note?: Child;
  class?: string;
  /** The control: an Input, Select or Textarea. It reads its id and ARIA from this Field. */
  children: Child;
}

/** The label of a field with its “(optional)” or “(needed for …)” marker. */
export function FieldLabelMarker(props: { optional?: boolean; neededFor?: string }) {
  if (props.neededFor) return <span class="opt">(needed for {props.neededFor})</span>;
  return props.optional ? <span class="opt">(optional)</span> : null;
}

/**
 * One labelled control (`.field`): label, hint, inline error, the control, then a note. The control
 * inside gets the id, `aria-describedby` (only the parts that are rendered) and `aria-invalid`.
 */
export function Field(props: FieldProps) {
  const hintId = props.hint ? `${props.id}-hint` : undefined;
  const errorId = props.error ? `${props.id}-error` : undefined;
  const noteId = props.note ? `${props.id}-note` : undefined;
  const control = {
    id: props.id,
    describedBy: idList(hintId, errorId, noteId),
    invalid: Boolean(props.error),
  };
  return (
    <div class={cx('field', props.class)}>
      <label for={props.id}>
        {props.label}
        {props.optional || props.neededFor ? ' ' : null}
        <FieldLabelMarker optional={props.optional} neededFor={props.neededFor} />
      </label>
      {props.hint ? (
        <span class="hint" id={hintId}>
          {props.hint}
        </span>
      ) : null}
      {props.error ? <FieldError id={errorId as string}>{props.error}</FieldError> : null}
      <FieldContext.Provider value={control}>{props.children}</FieldContext.Provider>
      {props.note ? (
        <p class="hint" id={noteId}>
          {props.note}
        </p>
      ) : null}
    </div>
  );
}

/** The inline error line (`p.field-error`): a hidden “Error:” prefix and a decorative ✕. */
export function FieldError(props: { id: string; children: Child }) {
  return (
    <p class="field-error" id={props.id}>
      <span aria-hidden="true">✕</span>
      <span class="vh">Error:</span> {props.children}
    </p>
  );
}
