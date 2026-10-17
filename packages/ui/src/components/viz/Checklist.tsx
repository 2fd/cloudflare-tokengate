import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { H, useHeadingLevel, type HeadingLevel } from '../../lib/heading';
import { Badge } from '../base/Badge';
import { LogoTile, type LogoSpec } from '../base/Logo';

export interface ChecklistQuickLink {
  href: string;
  label: string;
  logo?: LogoSpec;
}

export interface ChecklistStep {
  /** `done`, `next` (the one step with the primary button) or `todo`. */
  state: 'done' | 'next' | 'todo';
  /** The step, as an instruction ("Add a credential"). */
  title: Child;
  /** Why it matters, or what was done. */
  why: Child;
  /** The step's button. Primary on the `next` step, secondary otherwise; none when done. */
  action?: { href: string; label: Child };
  /**
   * Replaces `action` when the reader may not do the step, usually an `AskSomeone`. Renders in a
   * `.wide` block after `why`; `action` is not rendered. None when done, like the action.
   */
  ask?: Child;
  /** Shortcuts under the step (`.quick`), such as the token types to start from. */
  quick?: readonly ChecklistQuickLink[];
  /** Accessible name of the shortcuts. Default "Shortcuts". */
  quickLabel?: string;
  /** Block content under the step, after `quick`: a second link, a `CodeBlock` preview. */
  detail?: Child;
}

export interface ChecklistProps {
  steps: readonly ChecklistStep[];
  /** Level of the step titles. Default 3, one under the tray title (a Tray sets it). */
  headingLevel?: HeadingLevel;
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
export function Checklist({ steps, headingLevel, class: className }: ChecklistProps) {
  const hLevel = useHeadingLevel(headingLevel ?? 3);
  return (
    <ol class={cx('checklist', className)}>
      {steps.map((step, index) => (
        <li class={cx(step.state === 'done' && 'is-done', step.state === 'next' && 'is-next')}>
          <span class="no" aria-hidden="true">
            {step.state === 'done' ? '✓' : index + 1}
          </span>
          <H level={hLevel}>
            {step.title}{' '}
            {step.state === 'done' ? (
              <Badge tone="ok" glyph="✓">
                Done
              </Badge>
            ) : (
              <Badge>To do</Badge>
            )}
          </H>
          <p class="why">{step.why}</p>
          {step.state === 'done' ? null : step.ask !== undefined ? (
            <div class="wide">{step.ask}</div>
          ) : step.action ? (
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
          {step.detail !== undefined ? <div class="wide">{step.detail}</div> : null}
        </li>
      ))}
    </ol>
  );
}
