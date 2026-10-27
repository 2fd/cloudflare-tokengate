import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { Chip } from '../base/Chip';
import type { LogoSpec } from '../base/Logo';

export interface PrefillValue {
  /** The value as it will appear in the form. */
  label: Child;
  logo?: LogoSpec;
  /** Mono type, for repositories, branches and IDs. */
  mono?: boolean;
}

export interface NextStepProps {
  /** The next step in one short sentence, bold ("Give access from this request."). */
  title: Child;
  /** What happens when you take it. */
  children?: Child;
  /** The values the next form opens with, as chips. */
  prefill?: readonly PrefillValue[];
  /** The step's buttons: one `.btn.primary`, then secondary ones. */
  actions?: Child;
  class?: string;
}

/**
 * Next step box (`.todo`): after a denied request, offers the fix with the values it will
 * prefill. Neutral background; its one primary button carries the accent.
 */
export function NextStep(props: NextStepProps) {
  return (
    <div class={cx('todo', props.class)}>
      <p>
        <b>{props.title}</b>
        {props.children !== undefined ? <> {props.children}</> : null}
      </p>
      {props.prefill && props.prefill.length > 0 ? (
        <p class="prefill">
          <span class="vh">Filled in: </span>
          {props.prefill.map((value) => (
            <Chip logo={value.logo} class={value.mono ? 'mono' : undefined}>
              {value.label}
            </Chip>
          ))}
        </p>
      ) : null}
      {props.actions !== undefined ? <div class="btn-row">{props.actions}</div> : null}
    </div>
  );
}
