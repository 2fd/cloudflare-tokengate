import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { HeadingScope, H, useHeadingLevel, type HeadingLevel } from '../../lib/heading';
import { Hidden, type HiddenFields } from '../../lib/hidden';
import { Button, type ButtonProps } from '../base/Button';

interface DialogBase {
  /** Id of the `dialog`; triggers point at it. The heading gets `${id}-h`, the description `${id}-d`. */
  id: string;
  /** The question or task ("Delete Slack and its 3 issuer access ruleses?"). */
  title: Child;
  /** One or two sentences under the title; the dialog's description for screen readers. */
  description?: Child;
  /**
   * Level of the title. Default 2: a modal dialog is its own context. An `open` dialog drawn in
   * the page flow under an h2 takes 3.
   */
  headingLevel?: HeadingLevel;
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

/** The dialog renders its own `<form>` around header, body and footer. */
interface DialogOwnForm extends DialogBase {
  /** Where the dialog's form posts. Default: the current URL. */
  action?: string;
  /** Form method. Default `post`. */
  method?: 'post' | 'get';
  /** Hidden fields at the top of the form (`_csrf`, ids), one `input type="hidden"` each. */
  hidden?: HiddenFields;
  form?: never;
}

/** The footer submits a form outside the dialog: no own `<form>`, so nothing nests. */
interface DialogOuterForm extends DialogBase {
  /**
   * Id of the outer form that the footer buttons submit (each sets `form=` to it). The dialog then
   * renders no `<form>` (the content goes in `div.dlg-in`) and takes no `action`, `method` or
   * `hidden`. It can sit inside or after that form; inside, it must come after the form's default
   * button in tree order.
   */
  form: string;
  action?: never;
  method?: never;
  hidden?: never;
}

export type DialogProps = DialogOwnForm | DialogOuterForm;

/** True when a children value renders something (Hono passes `[undefined]` for `{undefined}`). */
function rendersSomething(node: Child): boolean {
  if (Array.isArray(node)) return node.some(rendersSomething);
  return node !== undefined && node !== null && node !== false && node !== '';
}

/**
 * Dialog (`dialog.dlg`): header, scrolling body and footer around one form, its own or (with
 * `form`) one outside it. Opened with no JavaScript by a `DialogTrigger` (`command="show-modal"`):
 * modal, Esc closes it and focus returns to the trigger. Where invoker commands are missing, the
 * same trigger opens it as a popover (it carries `popover="auto"`), with the same backdrop and Esc
 * to close.
 */
export function Dialog(props: DialogProps) {
  const headingId = `${props.id}-h`;
  const descriptionId = `${props.id}-d`;
  const nominal = props.headingLevel ?? 2;
  const hLevel = useHeadingLevel(nominal);
  const content = (
    <>
      <div class="dlg-h">
        <H level={hLevel} id={headingId}>
          {props.title}
        </H>
        {props.description !== undefined ? <p id={descriptionId}>{props.description}</p> : null}
      </div>
      {rendersSomething(props.children) ? (
        <div class="dlg-b">
          <HeadingScope by={nominal - 2}>{props.children}</HeadingScope>
        </div>
      ) : null}
      <div class="dlg-f">{props.footer}</div>
    </>
  );
  return (
    <dialog
      class={cx('dlg', props.wide && 'wide', props.class)}
      id={props.id}
      aria-labelledby={headingId}
      aria-describedby={props.description !== undefined ? descriptionId : undefined}
      popover={props.open ? undefined : 'auto'}
      open={props.open ? true : undefined}
    >
      {props.form !== undefined ? (
        <div class="dlg-in">{content}</div>
      ) : (
        <form method={props.method ?? 'post'} action={props.action}>
          <Hidden fields={props.hidden} />
          {content}
        </form>
      )}
    </dialog>
  );
}

/**
 * Every `Button` prop except the ones the trigger sets itself (`type`, `href`, `command`,
 * `commandfor`, `popovertarget`) and the submit-only ones.
 */
export type DialogTriggerProps = Omit<
  ButtonProps,
  | 'type'
  | 'href'
  | 'command'
  | 'commandfor'
  | 'popovertarget'
  | 'form'
  | 'formaction'
  | 'formmethod'
  | 'formnovalidate'
  | 'name'
  | 'value'
> & {
  /** Id of the `Dialog` it opens. */
  dialog: string;
};

/**
 * A `Button` that opens a `Dialog`: `commandfor` + `command="show-modal"` (modal), plus
 * `popovertarget` as the fallback where invoker commands are missing. `type="button"`, so it
 * never submits a surrounding form. A label that opens a confirm dialog ends with "…"
 * ("Delete Slack…"); a row trigger names its object with `srSuffix`.
 */
export function DialogTrigger({ dialog, ...button }: DialogTriggerProps) {
  return (
    <Button
      {...button}
      type="button"
      command="show-modal"
      commandfor={dialog}
      popovertarget={dialog}
    />
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
