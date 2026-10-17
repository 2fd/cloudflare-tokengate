import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { H, useHeadingLevel, type HeadingLevel } from '../../lib/heading';
import { assertNotRequiredInReveal } from './context';
import { FieldError } from './Field';

export interface AcceptedRisk {
  /** The risky choice, bold (“Pull request into”). */
  label: Child;
  /** What can go wrong, in one sentence. */
  text: Child;
}

interface RiskAcceptanceBase {
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
  /**
   * Line under the checkbox; `null` for none. Default: “Or pick a safer option above; this box then
   * goes away.”, and none with `always` (the box does not go away).
   */
  hint?: Child;
  /** The server's error when the risk was not accepted. */
  error?: Child;
  /** Level of the heading. Default 2: it sits in the form, under the page H1. */
  headingLevel?: HeadingLevel;
  class?: string;
}

export type RiskAcceptanceProps = RiskAcceptanceBase &
  (
    | {
        /** Default: in a LiveForm, shown only while a risky (`[data-risk]`) option is checked. */
        always?: false;
        required?: never;
      }
    | {
        /**
         * Shown without a checked risky option (`.riskacc.always`): for risks the server computed
         * (a copy, the row editor, validator warnings).
         */
        always: true;
        /** `required` on the checkbox. Only with `always`: a hidden box would block every submit. */
        required?: boolean;
      }
  );

/**
 * Risk acceptance (`.riskacc`), directly before the submit row: the risks, then one checkbox that
 * accepts them. In a LiveForm it shows only while a risky option is checked, unless `always`;
 * elsewhere render it only when there is a risk. Never `required` unless `always`: the server
 * checks it, so a hidden box never blocks.
 */
export function RiskAcceptance(props: RiskAcceptanceProps) {
  const required = props.always === true && props.required === true;
  assertNotRequiredInReveal('RiskAcceptance', required);
  const headingId = `${props.id}-h`;
  const errorId = props.error ? `${props.id}-error` : undefined;
  const hLevel = useHeadingLevel(props.headingLevel ?? 2);
  const hint =
    props.hint !== undefined
      ? props.hint
      : props.always
        ? null
        : 'Or pick a safer option above; this box then goes away.';
  return (
    <div
      class={cx('riskacc', props.always && 'always', props.class)}
      id={props.id}
      role="group"
      aria-labelledby={headingId}
    >
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
          required={required}
          aria-invalid={props.error ? 'true' : undefined}
          aria-describedby={errorId}
        />
        <span>{props.confirm}</span>
      </label>
      {hint !== null ? <p class="hint">{hint}</p> : null}
    </div>
  );
}
