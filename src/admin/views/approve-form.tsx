// Approving a pending person with a role in one click (Users people list and the Overview alert):
// one submit per role in privilege order, Owner behind a confirmation dialog, and a separate
// Reject. The dialog's confirm submits the approve form, and the dialog follows that form in tree
// order so Enter still approves as Viewer.
import type { Role } from '../../db/types';
import type { ViewContext } from '../render';
import {
  ActionButton,
  ConfirmBox,
  ConfirmTrigger,
  type ConfirmDialogProps,
  PostForm,
} from './components';
import { ROLE_INFO } from './roles';

/** The roles offered as plain buttons; Owner needs the dialog. */
const APPROVE_ROLES: readonly Exclude<Role, 'owner'>[] = [
  'viewer',
  'token_manager',
  'access_manager',
  'admin',
];

export function ApproveForm(props: {
  user: { id: string; email: string; updated_at: number };
  ctx: ViewContext;
  returnTo: 'list' | 'overview';
  compact?: boolean;
}) {
  const { user, ctx } = props;
  const formId = `approve-${user.id}`;
  const action = `/admin/users/${encodeURIComponent(user.id)}/approve`;
  const owner: ConfirmDialogProps = {
    id: `approve-owner-${user.id}`,
    trigger: 'Owner…',
    triggerContext: user.email,
    title: `Approve ${user.email} as Owner?`,
    body: `Owner: ${ROLE_INFO.owner.description}`,
    confirmLabel: `Approve ${user.email} as Owner`,
    variant: 'submits',
    formId,
    name: 'role',
    value: 'owner',
    formnovalidate: true,
  };
  return (
    <div class={props.compact ? 'approve compact' : 'approve'}>
      <PostForm action={action} csrf={ctx.csrf} id={formId} returnTo={props.returnTo}>
        <fieldset class="submits">
          <legend>
            Approve as<span class="vh"> (for {user.email})</span>
          </legend>
          <div class="actions">
            {APPROVE_ROLES.map((role) => (
              <button type="submit" name="role" value={role} class="secondary">
                {ROLE_INFO[role].label}
                <span class="vh"> for {user.email}</span>
              </button>
            ))}
            <ConfirmTrigger {...owner} />
          </div>
        </fieldset>
      </PostForm>
      <ConfirmBox {...owner} />
      <ActionButton
        action={`/admin/users/${encodeURIComponent(user.id)}/reject`}
        csrf={ctx.csrf}
        label="Reject"
        context={user.email}
        tone="danger"
        returnTo={props.returnTo}
      />
    </div>
  );
}
