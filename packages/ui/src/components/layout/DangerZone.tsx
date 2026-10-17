import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { H, useHeadingLevel, type HeadingLevel } from '../../lib/heading';
import { Panel } from './Panel';
import { Tray } from './Tray';

export interface DangerZoneProps {
  /** Id of the tray; the heading gets `${id}-h`. */
  id: string;
  /** Tray title, in the bad color. Default "Danger zone". */
  title?: Child;
  /** One line under the title, the tray's `description` ("Stop Tom from using the console."). */
  description?: Child;
  /** Level of the tray title: 2 (default), 3 under another h2. The rows follow one level deeper. */
  headingLevel?: HeadingLevel;
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
  description,
  headingLevel,
  class: className,
  children,
}: DangerZoneProps) {
  return (
    <Tray
      id={id}
      title={title}
      description={description}
      headingLevel={headingLevel}
      class={cx('danger-zone', className)}
    >
      <Panel variant="flush">{children}</Panel>
    </Tray>
  );
}

export interface DangerRowProps {
  /** What the action does, named after the object ("Delete Slack and its 3 issuer access ruleses"). */
  title: Child;
  /** The consequence in one sentence ("This cannot be undone."). */
  description?: Child;
  /**
   * The button: an `ActionForm` (secondary submit in its own form) for reversible actions, a
   * `DialogTrigger` with `variant="danger"` (label ends with "…") for irreversible ones.
   */
  action: Child;
  /** Level of the row title. Default 3, one under its DangerZone (which sets it). */
  headingLevel?: HeadingLevel;
  class?: string;
}

/** One row of a `DangerZone` (`.dz-row`): heading + consequence on the left, the button on the right. */
export function DangerRow({
  title,
  description,
  action,
  headingLevel,
  class: className,
}: DangerRowProps) {
  const hLevel = useHeadingLevel(headingLevel ?? 3);
  return (
    <div class={cx('dz-row', className)}>
      <div>
        <H level={hLevel}>{title}</H>
        {description !== undefined ? <p>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
