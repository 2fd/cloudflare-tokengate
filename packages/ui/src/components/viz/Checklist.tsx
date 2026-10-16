import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { LogoTile, type VizLogo } from './parts';

export interface ChecklistQuickLink {
  href: string;
  label: string;
  logo?: VizLogo;
}

export interface ChecklistStep {
  /** `done`, `next` (the one step with the primary button) or `todo`. */
  state: 'done' | 'next' | 'todo';
  /** The step, as an instruction ("Add a service token"). */
  title: Child;
  /** Why it matters, or what was done. */
  why: Child;
  /** The step's button. Primary on the `next` step, secondary otherwise; none when done. */
  action?: { href: string; label: Child };
  /** Shortcuts under the step (`.quick`), such as the token types to start from. */
  quick?: readonly ChecklistQuickLink[];
  /** Accessible name of the shortcuts. Default "Shortcuts". */
  quickLabel?: string;
}

export interface ChecklistProps {
  steps: readonly ChecklistStep[];
  class?: string;
}

export interface ChecklistProgressProps {
  done: number;
  total: number;
  class?: string;
}

/**
 * Progress for a checklist's tray header (`.progress` + "1 of 3 done"). The bar is decorative;
 * the sentence is read.
 */
export function ChecklistProgress({ done, total, class: className }: ChecklistProgressProps) {
  return (
    <>
      <span class={cx('progress', className)} aria-hidden="true">
        {Array.from({ length: Math.max(0, total) }, (_, index) => (
          <i class={index < done ? 'on' : undefined} />
        ))}
      </span>
      <span class="meta">
        {done} of {total} done
      </span>
    </>
  );
}

/**
 * Get started checklist (`ol.checklist`): the Overview content of an empty install. Numbered
 * steps with a Done / To do badge; only the next step has the primary button. Goes inside a
 * `.panel` in a tray whose header end shows `ChecklistProgress`.
 */
export function Checklist({ steps, class: className }: ChecklistProps) {
  return (
    <ol class={cx('checklist', className)}>
      {steps.map((step, index) => (
        <li class={cx(step.state === 'done' && 'is-done', step.state === 'next' && 'is-next')}>
          <span class="no" aria-hidden="true">
            {step.state === 'done' ? '✓' : index + 1}
          </span>
          <h3>
            {step.title}{' '}
            {step.state === 'done' ? (
              <span class="badge ok">
                <span aria-hidden="true">✓ </span>Done
              </span>
            ) : (
              <span class="badge">To do</span>
            )}
          </h3>
          <p class="why">{step.why}</p>
          {step.action && step.state !== 'done' ? (
            <div class="acts">
              <a
                class={cx('btn', step.state === 'next' ? 'primary' : 'secondary')}
                href={step.action.href}
              >
                {step.action.label}
              </a>
            </div>
          ) : null}
          {step.quick && step.quick.length > 0 ? (
            <div class="wide">
              <nav class="quick" aria-label={step.quickLabel ?? 'Shortcuts'}>
                {step.quick.map((q) => (
                  <a class="q" href={q.href}>
                    {q.logo ? <LogoTile logo={q.logo} size="xs" /> : null}
                    {q.label}
                  </a>
                ))}
              </nav>
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
