import type { Child } from 'hono/jsx';
import { cx, idList } from '../../lib/cx';
import { H, useHeadingLevel, type HeadingLevel } from '../../lib/heading';
import { ChoiceContext, type LiveSlot } from './context';
import { FieldError } from './Field';

export interface StepperProps {
  class?: string;
  /** FormStep items, in order. */
  children: Child;
}

/** Numbered form sections on one page (`ol.stepper`), joined by a line. */
export function Stepper(props: StepperProps) {
  return <ol class={cx('stepper', props.class)}>{props.children}</ol>;
}

export interface FormStepProps {
  /** Step number, shown in the circle and read as “Step N:” before the title. */
  n: number;
  /** Step title. */
  title: Child;
  /** One line under the title (inherited facts, what the step decides). */
  description?: Child;
  /** `fieldset` step only: hint under the description (`${id}-hint`). Needs `id`. */
  hint?: Child;
  /**
   * `fieldset` step only: the server's error, above the choices (`${id}-error`), as on a FieldSet.
   * Needs `id`.
   */
  error?: Child;
  /**
   * `fieldset` (default): the step is one question; the title is its legend and the choices sit
   * directly inside. `group`: the step holds several fields; the title is a heading.
   */
  kind?: 'fieldset' | 'group';
  /** Level of a `group` step's title. Default 2: the steps sit under the page H1. */
  headingLevel?: HeadingLevel;
  /** `current` (solid accent number, `aria-current="step"`) or `done` (ok number). */
  state?: 'current' | 'done';
  /** Live-form field slot of a `fieldset` step (`.sfN`). */
  live?: LiveSlot;
  /** Counts the checked boxes inside, for a SelectedCount. */
  countScope?: boolean;
  /**
   * Id of the step. A `fieldset` step passes it to its choices (`${id}-1` …); a `group` step is
   * labelled by its heading `${id}-h`.
   */
  id?: string;
  class?: string;
  children: Child;
}

/**
 * One numbered step (`li.fstep`): the number circle (decorative), then the step body. The give
 * access page keeps every step equal; `state` exists for pages that track progress.
 */
export function FormStep(props: FormStepProps) {
  const prefix = (
    <span class="vh">
      Step {props.n}
      {props.state === 'done' ? ', done' : null}:{' '}
    </span>
  );
  const bodyClass = cx(
    'fstep-b',
    props.live !== undefined && `sf${props.live}`,
    props.countScope && 'count-scope',
  );
  let body: Child;
  if ((props.hint || props.error) && props.kind === 'group') {
    throw new Error('FormStep: hint and error are for a fieldset step (a group holds Fields)');
  }
  if ((props.hint || props.error) && !props.id) {
    throw new Error('FormStep: hint and error need an id');
  }
  if (props.kind === 'group') {
    const hLevel = useHeadingLevel(props.headingLevel ?? 2);
    const headingId = props.id ? `${props.id}-h` : undefined;
    body = (
      <div
        class={bodyClass}
        id={props.id}
        role={headingId ? 'group' : undefined}
        aria-labelledby={headingId}
      >
        <div class="fstep-t">
          <H level={hLevel} id={headingId}>
            {prefix}
            {props.title}
          </H>
          {props.description ? <p>{props.description}</p> : null}
        </div>
        {props.children}
      </div>
    );
  } else {
    const inner = props.id ? (
      <ChoiceContext.Provider value={{ id: props.id }}>{props.children}</ChoiceContext.Provider>
    ) : (
      props.children
    );
    const hintId = props.hint ? `${props.id}-hint` : undefined;
    const errorId = props.error ? `${props.id}-error` : undefined;
    body = (
      <fieldset class={bodyClass} id={props.id} aria-describedby={idList(hintId, errorId)}>
        <legend class="fstep-t">
          {prefix}
          {props.title}
        </legend>
        {props.description ? <p class="hint">{props.description}</p> : null}
        {hintId ? (
          <span class="hint" id={hintId}>
            {props.hint}
          </span>
        ) : null}
        {errorId ? <FieldError id={errorId}>{props.error}</FieldError> : null}
        {inner}
      </fieldset>
    );
  }
  return (
    <li
      class={cx(
        'fstep',
        props.state === 'current' && 'is-current',
        props.state === 'done' && 'is-done',
        props.class,
      )}
      aria-current={props.state === 'current' ? 'step' : undefined}
    >
      <span class="fstep-n" aria-hidden="true">
        {props.n}
      </span>
      {body}
    </li>
  );
}
