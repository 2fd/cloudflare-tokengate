import { cx } from '../../lib/cx';
import { Callout, type CalloutProps } from './Callout';

export type NoticeProps = Omit<CalloutProps, 'role'>;

/**
 * The result of an action (`.callout.notice`, `role="status"`), right under the page header after a
 * redirect: "Access given." It replaces toasts: it stays until the next page. Default tone `ok`.
 */
export function Notice(props: NoticeProps) {
  return (
    <Callout {...props} tone={props.tone ?? 'ok'} role="status" class={cx('notice', props.class)} />
  );
}
