import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { SrSuffix } from '../../lib/sr';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid';

export interface ButtonProps {
  /**
   * `primary`: one per page header and the first submit of a form. `secondary` (default): every
   * other labelled action. `ghost`: inline adds inside a form. `danger`: on a page, opens a confirm
   * dialog (label ends with "…"). `danger-solid`: only the confirm button inside the dialog.
   */
  variant?: ButtonVariant;
  /** `sm` (32px): row actions, tray actions, inline fixes. Default 40px. */
  size?: 'md' | 'sm';
  /** Full width (`.block`). */
  block?: boolean;
  /** Renders a link (`<a class="btn">`) instead of a button: for navigation (GET). */
  href?: string;
  /** Button type; default `button`. A form's submit is `type="submit"`. Ignored with `href`. */
  type?: 'button' | 'submit' | 'reset';
  /** Submitted name/value pair (one click per role: `name="role" value="viewer"`). */
  name?: string;
  value?: string;
  /** Id of the form the button submits, when it sits outside it. */
  form?: string;
  /** Overrides the form action / method for this submit. */
  formaction?: string;
  formmethod?: 'get' | 'post' | 'dialog';
  /** Invoker commands, no JS: `command="show-modal"` + `commandfor="dlg-del"` opens a dialog. */
  command?:
    | 'show-modal'
    | 'close'
    | 'request-close'
    | 'show-popover'
    | 'hide-popover'
    | 'toggle-popover';
  commandfor?: string;
  /** Popover invoker (account menu). */
  popovertarget?: string;
  /**
   * Disabled. A button gets `disabled`; a link loses its `href` and gets `aria-disabled="true"`,
   * so it is not focusable and not followed.
   */
  disabled?: boolean;
  /** Leading "+" (`.plus`), for create actions: "+ Add token", "+ Give access". */
  plus?: boolean;
  /** Leading icon of the set. Decorative: the label is always there (no icon-only buttons). */
  icon?: IconName;
  /**
   * Screen-reader-only suffix (`.vh`) that names the object of a row action: "Disable" +
   * "acme/api → Slack" is read "Disable acme/api → Slack". The space before it is added.
   */
  srSuffix?: string;
  id?: string;
  /** Ids of elements that describe the button (a hint next to a submit). */
  describedBy?: string;
  class?: string;
  /** The visible label: names the outcome ("Give access", "Delete Slack…"). */
  children: Child;
}

/**
 * A button (`.btn`) or a link that looks like one. One primary per page header; labels name the
 * outcome. Default type is `button`, so a button in a form never submits by accident.
 */
export function Button(props: ButtonProps) {
  const variant = props.variant ?? 'secondary';
  const className = cx(
    'btn',
    props.size === 'sm' && 'sm',
    variant,
    props.block && 'block',
    props.class,
  );
  const content = (
    <>
      {props.plus ? (
        <span class="plus" aria-hidden="true">
          +
        </span>
      ) : null}
      {props.icon ? <Icon name={props.icon} /> : null}
      {props.children}
      <SrSuffix text={props.srSuffix} />
    </>
  );
  if (props.href !== undefined) {
    return (
      <a
        class={className}
        id={props.id}
        href={props.disabled ? undefined : props.href}
        aria-disabled={props.disabled ? 'true' : undefined}
        aria-describedby={props.describedBy}
      >
        {content}
      </a>
    );
  }
  return (
    <button
      class={className}
      id={props.id}
      type={props.type ?? 'button'}
      name={props.name}
      value={props.value}
      form={props.form}
      formaction={props.formaction}
      formmethod={props.formmethod}
      command={props.command}
      commandfor={props.commandfor}
      popovertarget={props.popovertarget}
      disabled={props.disabled}
      aria-describedby={props.describedBy}
    >
      {content}
    </button>
  );
}
