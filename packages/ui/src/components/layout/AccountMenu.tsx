import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { Avatar } from '../base/Avatar';
import { Menu } from './Menu';

export interface AccountMenuProps {
  /** Id of the popover menu. Unique on the page. */
  id: string;
  /** The signed-in person ("Maya Chen"); the avatar initials come from it. */
  name: string;
  /** Their role ("Owner", "Token manager"). */
  role: string;
  /** Initials to show instead of the ones taken from `name`. */
  initials?: string;
  class?: string;
  /** Menu items: Export configuration (admins and owners only), Docs, a separator, Sign out. */
  children: Child;
}

/**
 * Account block at the bottom of the sidebar (`.acct`): avatar, name and role on a button that
 * opens a popover `Menu`. Pass it to `AppShell`'s `account` slot. The menu never opens a dialog.
 */
export function AccountMenu(props: AccountMenuProps) {
  return (
    <div class={cx('acct', props.class)}>
      <button class="acct-btn" type="button" popovertarget={props.id}>
        <Avatar name={props.name} initials={props.initials} size="md" />
        <span class="acct-who">
          <b>{props.name}</b>
          <small>{props.role}</small>
        </span>
        <span class="chev" aria-hidden="true">
          ▾
        </span>
        <span class="vh">, account menu</span>
      </button>
      <Menu id={props.id}>{props.children}</Menu>
    </div>
  );
}
