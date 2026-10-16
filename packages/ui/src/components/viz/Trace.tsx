import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

/**
 * `pass`, `fail` (the call stopped here), `notrun` (not reached), `warn` (passed on a risky
 * condition, such as an accepted risk) and `on` (the current choice in a step explainer).
 */
export type TraceState = 'pass' | 'fail' | 'notrun' | 'warn' | 'on';

export interface TraceStep {
  state: TraceState;
  /** Status word; defaults to Passed, Failed, Not reached, Risk accepted or Current choice. */
  status?: string;
  /** Glyph before the status; defaults by state (✓ ✕ – ⚠, none for `on`). `''` for none. */
  glyph?: string;
  /** The check ("Caller verified", "Access matched"). */
  title: Child;
  /** The evidence ("GitHub Actions (acme)"); wrap the failing claim in `<mark>`. */
  detail?: Child;
}

export interface TraceProps {
  steps: readonly TraceStep[];
  /** Accessible name of the list ("Where the call stopped"). */
  label?: string;
  class?: string;
}

const DEFAULTS: Record<TraceState, { glyph: string; status: string; cls: string }> = {
  pass: { glyph: '✓', status: 'Passed', cls: 'pass' },
  fail: { glyph: '✕', status: 'Failed', cls: 'fail' },
  notrun: { glyph: '–', status: 'Not reached', cls: 'notrun' },
  warn: { glyph: '⚠', status: 'Risk accepted', cls: 'warn' },
  on: { glyph: '', status: 'Current choice', cls: 'is-on' },
};

/**
 * Request trace (`ol.trace > li.tstep`): the checks a request went through, in order, with the
 * outcome of each. 4 per row, 2 below 64rem, 1 below 40rem; connectors are CSS.
 */
export function Trace({ steps, label, class: className }: TraceProps) {
  return (
    <ol class={cx('trace', className)} aria-label={label}>
      {steps.map((step) => {
        const preset = DEFAULTS[step.state];
        const glyph = step.glyph ?? preset.glyph;
        return (
          <li class={`tstep ${preset.cls}`}>
            <span class="s">
              {glyph ? <span aria-hidden="true">{`${glyph} `}</span> : null}
              {step.status ?? preset.status}
            </span>
            <span class="v">{step.title}</span>
            {step.detail !== undefined ? <span class="d">{step.detail}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
