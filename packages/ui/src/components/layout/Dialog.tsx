import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface DialogProps {
  /** Id of the `dialog`; triggers point at it. The heading gets `${id}-h`, the description `${id}-d`. */
  id: string;
  /** The question or task, as an h2 ("Delete Slack and its 3 consumer accesses?"). */
  title: Child;
  /** One or two sentences under the title; the dialog's description for screen readers. */
  description?: Child;
  /** Where the dialog's form posts. Default: the current URL. */
  action?: string;
  /** Form method. Default `post`. */
  method?: 'post' | 'get';
  /** Hidden inputs at the top of the form (CSRF token, ids). */
  fields?: Child;
  /** Body (`.dlg-b`): consequence list, fields. It scrolls; header and footer stay. */
  children?: Child;
  /** Footer buttons (`.dlg-f`), right-aligned: `DialogClose` first, then the confirm button. */
  footer: Child;
  /** 40rem instead of 32rem, for edit dialogs. */
  wide?: boolean;
  /**
   * Render it already open, in the page flow (non-modal): the server re-renders a page this way
   * after a failed submit (type-to-confirm mismatch), or on a GET confirm page.
   */
  open?: boolean;
  class?: string;
}

/**
 * Dialog (`dialog.dlg`): header, scrolling body and footer around one form. Opened with no
 * JavaScript by a `DialogTrigger` (`command="show-modal"`): modal, Esc closes it and focus
 * returns to the trigger. Where invoker commands are missing, the same trigger opens it as a
 * popover (it carries `popover="auto"`), with the same backdrop and Esc to close.
 */
/** True when a children value renders something (Hono passes `[undefined]` for `{undefined}`). */
function rendersSomething(node: Child): boolean {
  if (Array.isArray(node)) return node.some(rendersSomething);
  return node !== undefined && node !== null && node !== false && node !== '';
}

export function Dialog(props: DialogProps) {
  const headingId = `${props.id}-h`;
  const descriptionId = `${props.id}-d`;
  return (
    <dialog
      class={cx('dlg', props.wide && 'wide', props.class)}
      id={props.id}
      aria-labelledby={headingId}
      aria-describedby={props.description !== undefined ? descriptionId : undefined}
      popover={props.open ? undefined : 'auto'}
      open={props.open ? true : undefined}
    >
      <form method={props.method ?? 'post'} action={props.action}>
        {props.fields}
        <div class="dlg-h">
          <h2 id={headingId}>{props.title}</h2>
          {props.description !== undefined ? <p id={descriptionId}>{props.description}</p> : null}
        </div>
        {rendersSomething(props.children) ? <div class="dlg-b">{props.children}</div> : null}
        <div class="dlg-f">{props.footer}</div>
      </form>
    </dialog>
  );
}

export interface DialogTriggerProps {
  /** Id of the `Dialog` it opens. */
  dialog: string;
  /** Button style. `danger` on a page always opens a confirm dialog. Default `secondary`. */
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm';
  class?: string;
  /** The label; a label that opens a confirm dialog ends with "…" ("Delete Slack…"). */
  children: Child;
}

/**
 * Button that opens a `Dialog`: `commandfor` + `command="show-modal"` (modal), plus
 * `popovertarget` as the fallback where invoker commands are missing. `type="button"`, so it
 * never submits a surrounding form.
 */
export function DialogTrigger({
  dialog,
  variant = 'secondary',
  size,
  class: className,
  children,
}: DialogTriggerProps) {
  return (
    <button
      class={cx('btn', variant, size, className)}
      type="button"
      commandfor={dialog}
      command="show-modal"
      popovertarget={dialog}
    >
      {children}
    </button>
  );
}

export interface DialogCloseProps {
  /** Id of the `Dialog` it closes. */
  dialog: string;
  /**
   * Focus this button when the dialog opens (`autofocus`): the safe choice for a destructive
   * confirm without a text field.
   */
  autofocus?: boolean;
  class?: string;
  /** Label. Default "Cancel". */
  children?: Child;
}

/** Secondary button that closes its `Dialog` without submitting (`command="close"`, popover hide). */
export function DialogClose({ dialog, autofocus, class: className, children }: DialogCloseProps) {
  return (
    <button
      class={cx('btn secondary', className)}
      type="button"
      commandfor={dialog}
      command="close"
      popovertarget={dialog}
      popovertargetaction="hide"
      autofocus={autofocus ? true : undefined}
    >
      {children ?? 'Cancel'}
    </button>
  );
}
