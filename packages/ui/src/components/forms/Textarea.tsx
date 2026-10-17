import { cx } from '../../lib/cx';
import { useControl } from './context';

export interface TextareaProps {
  /** Defaults to the id of the Field around it. */
  id?: string;
  name?: string;
  /** The current text (escaped). */
  value?: string;
  placeholder?: string;
  rows?: number;
  maxlength?: number;
  /** Mono type, no spellcheck: for JSON, headers, certificates. */
  mono?: boolean;
  readonly?: boolean;
  disabled?: boolean;
  /** Never inside a Reveal. */
  required?: boolean;
  invalid?: boolean;
  /** Ids added after the Field's hint, error and note ids (a shared hint). */
  describedBy?: string;
  class?: string;
}

/** Multi-line text (`textarea.input`): grows with its content, min 5rem, resizes vertically. */
export function Textarea(props: TextareaProps) {
  const control = useControl('Textarea', props);
  return (
    <textarea
      class={cx('input', props.mono && 'mono', props.class)}
      id={control.id}
      name={props.name}
      placeholder={props.placeholder}
      rows={props.rows}
      maxlength={props.maxlength}
      readonly={props.readonly}
      disabled={props.disabled}
      required={props.required}
      aria-invalid={control.invalid ? 'true' : undefined}
      aria-describedby={control.describedBy}
      spellcheck={props.mono ? false : undefined}
    >
      {props.value ?? ''}
    </textarea>
  );
}
