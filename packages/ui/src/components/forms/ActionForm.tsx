import { cx } from '../../lib/cx';
import { Hidden, type HiddenFields } from '../../lib/hidden';
import { Button, type ButtonProps } from '../base/Button';

/**
 * The button props an action form passes on: every `Button` prop except the ones the form sets
 * (`type`, `href`, the invoker commands and the per-button form overrides).
 */
export type ActionFormProps = Omit<
  ButtonProps,
  | 'type'
  | 'href'
  | 'command'
  | 'commandfor'
  | 'popovertarget'
  | 'form'
  | 'formaction'
  | 'formmethod'
  | 'class'
> & {
  /** Where the button posts. */
  action: string;
  /** Hidden fields (`_csrf`, ids, `expected_updated_at`), one `input type="hidden"` each. */
  hidden?: HiddenFields;
  /** Classes on the `form`. In a table cell, a button row or a danger row it lays out inline. */
  class?: string;
  /** Classes on the button. */
  buttonClass?: string;
};

/**
 * A one-button POST form (`form` > hidden fields + `Button type="submit"`): the row actions of the
 * admin (Disable, Reject, Revoke, Undo). Secondary and small by default in a row; name the row's
 * object with `srSuffix` ("Disable" + "acme/api → Slack"). Irreversible actions open a confirm
 * dialog instead (`DialogTrigger`).
 */
export function ActionForm({
  action,
  hidden,
  class: className,
  buttonClass,
  ...button
}: ActionFormProps) {
  return (
    <form class={cx('action-form', className)} method="post" action={action}>
      <Hidden fields={hidden} />
      <Button {...button} class={buttonClass} type="submit" />
    </form>
  );
}
