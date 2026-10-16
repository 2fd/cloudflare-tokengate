import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface FixedBarProps {
  /** What is fixed (“Token”). */
  label: Child;
  /** Logo tile (`logo sm`), decorative. */
  logo?: Child;
  /** The preselected value, bold (“Slack”). */
  name: Child;
  /** Mono fact after the name: path or ID (“/proxy/slack”). */
  meta?: Child;
  /** A status badge after the name (“✓ Secret set”); it wraps instead of overlapping. */
  status?: Child;
  /** Link that goes back to choose another value. `context` completes the hidden link text. */
  change?: { href: string; context: string; label?: string };
  class?: string;
}

/**
 * Fixed context (`.fixedbar`): a value preselected from the entry point (“Token: Slack”), shown as
 * a fact with a Change link instead of a field.
 */
export function FixedBar(props: FixedBarProps) {
  return (
    <div class={cx('fixedbar', props.class)}>
      <span class="lbl">{props.label}</span>
      {props.logo ?? null}
      <span class="grow">
        <b>{props.name}</b>
        {props.meta ? (
          <>
            {' '}
            <span class="meta mono">{props.meta}</span>
          </>
        ) : null}
      </span>
      {props.status ?? null}
      {props.change ? (
        <a class="sm" href={props.change.href}>
          {props.change.label ?? 'Change'}
          <span class="vh"> {props.change.context}</span>
        </a>
      ) : null}
    </div>
  );
}
