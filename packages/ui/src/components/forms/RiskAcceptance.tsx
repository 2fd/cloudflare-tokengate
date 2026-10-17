import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { H, useHeadingLevel, type HeadingLevel } from '../../lib/heading';
import { FieldError } from './Field';

export interface AcceptedRisk {
  /** The risky choice, bold (“Pull request into”). */
  label: Child;
  /** What can go wrong, in one sentence. */
  text: Child;
}

export interface RiskAcceptanceProps {
  /** Id base: heading `${id}-h`, checkbox `${id}-ack`, error `${id}-error`. */
  id: string;
  /** “Accept 1 risk to save this access”. A ⚠ glyph is added before it. */
  title: Child;
  /** One item per risk the person accepts. */
  risks: readonly AcceptedRisk[];
  /** Checkbox label, naming what is accepted: “I accept this risk for acme/api → Slack”. */
  confirm: Child;
  /** Checkbox name; the server refuses a risky save without it. */
  name?: string;
  value?: string;
  checked?: boolean;
  /** Line under the checkbox. */
  hint?: Child;
  /** The server's error when the risk was not accepted. */
  error?: Child;
  /** Level of the heading. Default 2: it sits in the form, under the page H1. */
  headingLevel?: HeadingLevel;
  class?: string;
}

/**
 * Risk acceptance (`.riskacc`), directly before the submit row: the risks, then one checkbox that
 * accepts them. In a LiveForm it shows only while a risky option is checked; elsewhere render it
 * only when there is a risk. Never `required`: the server checks it, so a hidden box never blocks.
 */
export function RiskAcceptance(props: RiskAcceptanceProps) {
  const headingId = `${props.id}-h`;
  const errorId = props.error ? `${props.id}-error` : undefined;
  const hLevel = useHeadingLevel(props.headingLevel ?? 2);
  return (
    <div class={cx('riskacc', props.class)} id={props.id} role="group" aria-labelledby={headingId}>
      <H level={hLevel} id={headingId}>
        <span aria-hidden="true">⚠</span> {props.title}
      </H>
      <ul>
        {props.risks.map((risk) => (
          <li>
            <b>{risk.label}:</b> {risk.text}
          </li>
        ))}
      </ul>
      {props.error ? <FieldError id={errorId as string}>{props.error}</FieldError> : null}
      <label class="check">
        <input
          type="checkbox"
          id={`${props.id}-ack`}
          name={props.name ?? 'acknowledge_warnings'}
          value={props.value ?? '1'}
          checked={props.checked}
          aria-invalid={props.error ? 'true' : undefined}
          aria-describedby={errorId}
        />
        <span>{props.confirm}</span>
      </label>
      {props.hint !== null ? (
        <p class="hint">{props.hint ?? 'Or pick a safer option above; this box then goes away.'}</p>
      ) : null}
    </div>
  );
}
