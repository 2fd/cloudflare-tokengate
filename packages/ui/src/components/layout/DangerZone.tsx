import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { Panel } from './Panel';
import { Tray } from './Tray';

export interface DangerZoneProps {
  /** Id of the tray; the heading gets `${id}-h`. */
  id: string;
  /** Tray title, in the bad color. Default "Danger zone". */
  title?: Child;
  class?: string;
  /** `DangerRow`s, least destructive first (Disable, then Delete). */
  children: Child;
}

/**
 * Danger zone (`section.tray.danger-zone`): the last tray of a detail page, holding the
 * destructive actions as rows. Delete opens a confirm dialog; Disable posts directly.
 */
export function DangerZone({
  id,
  title = 'Danger zone',
  class: className,
  children,
}: DangerZoneProps) {
  return (
    <Tray id={id} title={title} class={cx('danger-zone', className)}>
      <Panel variant="flush">{children}</Panel>
    </Tray>
  );
}

export interface DangerRowProps {
  /** What the action does, named after the object ("Delete Slack and its 3 consumer accesses"). */
  title: Child;
  /** The consequence in one sentence ("This cannot be undone."). */
  description?: Child;
  /**
   * The button: a secondary submit in its own form for reversible actions, a `DialogTrigger`
   * with `variant="danger"` (label ends with "…") for irreversible ones.
   */
  action: Child;
  class?: string;
}

/** One row of a `DangerZone` (`.dz-row`): h3 + consequence on the left, the button on the right. */
export function DangerRow({ title, description, action, class: className }: DangerRowProps) {
  return (
    <div class={cx('dz-row', className)}>
      <div>
        <h3>{title}</h3>
        {description !== undefined ? <p>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
