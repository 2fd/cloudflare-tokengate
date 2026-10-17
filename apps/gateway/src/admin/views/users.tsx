// Users section views (design D, @tokengate/ui): a person's status words, the state button and the
// "Change" row menu of the People table, the role cards and dialogs of the Person page, the
// "Needs your decision" tray, the invite tray, Compare roles and the role map. No client script:
// row menus are `<details name>` disclosures (one open at a time), and dialogs open with invoker
// commands, never from inside a popover. A dialog that submits another form follows that form in
// tree order, so Enter keeps the form's first submit.
import {
  type ActionCard,
  ActionCards,
  ActionForm,
  type AttentionItem,
  Avatar,
  Badge,
  Button,
  ButtonRow,
  Cell,
  ConfirmDialog,
  DialogTrigger,
  Disclosure,
  Entity,
  Field,
  FieldError,
  FieldSet,
  Icon,
  Input,
  Kbd,
  MenuHeader,
  MenuItem,
  MenuSeparator,
  NeedsAttention,
  Panel,
  Row,
  RowHeader,
  RowMenu,
  Status,
  Table,
  Time,
  formatTime as uiFormatTime,
  Tray,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import type { Role, User } from '../../db/types';
import type { UserListEntry } from '../../db/users';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { AskSomeone } from './components';
import { formatTime, relativeTime } from './format';
import { CAPABILITIES, ROLE_INFO, ROLE_ORDER, ROLE_POWERS, roleDiff, roleLabel } from './roles';
import type { StatusKey } from './status';

/** Where a row action returns to: the People list or the Person page (never a URL). */
export type UserReturn = 'list' | 'detail';

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Words and status

/** The status of a person: invitations show their days left, or that they expired. */
export function userStatus(
  user: Pick<User, 'status' | 'invite_expires_at'>,
  now: number,
): { key: StatusKey; detail?: string } {
  if (user.status === 'invited') {
    const expires = user.invite_expires_at;
    if (expires === null || expires <= now) return { key: 'invite_expired' };
    return { key: 'invited', detail: String(Math.max(1, Math.ceil((expires - now) / DAY_MS))) };
  }
  return { key: user.status === 'pending' ? 'pending' : user.status };
}

/** The part of a stored login subject after `<team domain>|`: the team domain is never shown. */
export function accessUserId(subject: string | null): string {
  if (subject === null) return '';
  const bar = subject.indexOf('|');
  return bar === -1 ? subject : subject.slice(bar + 1);
}

/** How a sentence names a person: the first word of the name, else the email. */
export function firstName(user: Pick<User, 'name' | 'email'>): string {
  const first = user.name?.trim().split(/\s+/)[0];
  return first ? first : user.email;
}

/** "21 Oct 2026, 14:00 UTC": a moment in a sentence (notices, relation lines). */
export function utcTime(ms: number): string {
  return `${uiFormatTime(new Date(ms), 'datetime')} UTC`;
}

/**
 * `mailto:` with the console address: tokengate sends no email itself. The validity sentence is
 * left out once the invitation expired.
 */
export function signInMailto(
  user: Pick<User, 'email' | 'invite_expires_at'>,
  host: string,
  now: number,
): string {
  const expires =
    user.invite_expires_at === null || user.invite_expires_at <= now
      ? ''
      : ` The invitation is valid until ${formatTime(user.invite_expires_at)}.`;
  const body = `Sign in to tokengate at https://${host}/admin with your Cloudflare Access account (${user.email}).${expires}`;
  const to = encodeURIComponent(user.email).replace('%40', '@');
  return `mailto:${to}?subject=${encodeURIComponent('Your tokengate sign-in')}&body=${encodeURIComponent(body)}`;
}

type StatusTone = 'ok' | 'info' | 'warn' | 'off';

/** Tone, glyph and word of each person status (README "Status words"). */
const LOOK: Readonly<
  Record<'active' | 'pending' | 'invited' | 'invite_expired' | 'suspended', Look>
> = {
  active: { tone: 'ok', glyph: '✓', word: 'Active' },
  pending: { tone: 'info', glyph: '◐', word: 'Pending approval' },
  invited: { tone: 'info', glyph: '◐', word: 'Invited' },
  invite_expired: { tone: 'warn', glyph: '✕', word: 'Invitation expired' },
  suspended: { tone: 'off', glyph: '⏸', word: 'Suspended' },
};

interface Look {
  tone: StatusTone;
  glyph: string;
  word: string;
}

function lookOf(key: StatusKey): Look {
  return key in LOOK ? LOOK[key as keyof typeof LOOK] : LOOK.active;
}

/** The status badge of a person (detail header, decision cards). */
export function UserBadge(props: {
  user: Pick<User, 'status' | 'invite_expires_at'>;
  now: number;
}) {
  const look = lookOf(userStatus(props.user, props.now).key);
  return (
    <Badge tone={look.tone} glyph={look.glyph}>
      {look.word}
    </Badge>
  );
}

/** A recent refused sign-in (last 7 days) of someone who is not waiting for a decision. */
function triedAt(user: UserListEntry, now: number): number | null {
  return user.status !== 'pending' &&
    user.last_refused_at !== null &&
    user.last_refused_at > now - 7 * DAY_MS
    ? user.last_refused_at
    : null;
}

/** Status cell of a row: dot + word, then a muted line (expiry, a recent refused sign-in). */
export function StatusCell(props: { user: UserListEntry; now: number }) {
  const { user, now } = props;
  const status = userStatus(user, now);
  const look = lookOf(status.key);
  const parts: Child[] = [];
  if (status.key === 'invited' && status.detail) {
    parts.push(`expires in ${status.detail === '1' ? '1 day' : `${status.detail} days`}`);
  } else if (status.key === 'invite_expired' && user.invite_expires_at !== null) {
    parts.push(
      <>
        expired <Time datetime={new Date(user.invite_expires_at)} format="date" />
      </>,
    );
  }
  const tried = triedAt(user, now);
  if (tried !== null) parts.push(`tried ${relativeTime(tried, now)}`);
  return (
    <span class="ent-t">
      <Status tone={look.tone}>{look.word}</Status>
      {parts.length > 0 ? (
        <span class="meta">
          {parts.map((part, index) => (
            <>
              {index > 0 ? ' · ' : null}
              {part}
            </>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** "+ service tokens · − consumer access": what a role change adds and removes. */
export function RoleDiff(props: { from: Role; to: Role }) {
  const { gain, lose } = roleDiff(props.from, props.to);
  return (
    <>
      {gain.length > 0 ? <span class="gain">+ {gain.join(', ')}</span> : null}
      {gain.length > 0 && lose.length > 0 ? ' · ' : null}
      {lose.length > 0 ? <span class="lose">− {lose.join(', ')}</span> : null}
      {gain.length === 0 && lose.length === 0 ? 'Same powers' : null}
    </>
  );
}

/** The role of a row as two lines: the label, then the duty. */
const CELL_TAG: Readonly<Record<Role, string>> = {
  ...Object.fromEntries(ROLE_ORDER.map((role) => [role, ROLE_INFO[role].tag])),
  admin: 'Loads keys and grants access',
} as Record<Role, string>;

const ROLE_ICON: Partial<Record<Role, 'token' | 'consumer'>> = {
  token_manager: 'token',
  access_manager: 'consumer',
};

// ---------------------------------------------------------------------------------------------
// Row state, the state button and the dialogs of one person

type RowState =
  | 'active'
  | 'active_owner'
  | 'suspended_linked'
  | 'suspended_unlinked'
  | 'invited'
  | 'invite_expired'
  | 'pending';

function rowState(user: UserListEntry, now: number): RowState {
  if (user.status === 'active') return user.role === 'owner' ? 'active_owner' : 'active';
  if (user.status === 'suspended') {
    return user.identity_count > 0 ? 'suspended_linked' : 'suspended_unlinked';
  }
  if (user.status === 'invited') {
    return user.invite_expires_at !== null && user.invite_expires_at > now
      ? 'invited'
      : 'invite_expired';
  }
  return 'pending';
}

function base(user: { id: string }): string {
  return paths.user(user.id);
}

function version(user: { updated_at: number }): Record<string, string> {
  return { expected_updated_at: String(user.updated_at) };
}

/**
 * "Invite again as <role>" for a person who never signed in (reset-login keeps the stored role).
 * An Owner invitation is an escalation: it goes through a dialog, and the server requires
 * `confirm=1`.
 */
function InviteAgain(props: {
  user: UserListEntry;
  ctx: ViewContext;
  returnTo: UserReturn;
  /** Unique on the page: `dlg-<scope>-again-<id>`. */
  scope: string;
}) {
  const { user, ctx } = props;
  const label = `Invite again as ${ROLE_INFO[user.role].label}`;
  if (user.role !== 'owner') {
    return (
      <ActionForm
        size="sm"
        action={`${base(user)}/reset-login`}
        hidden={ctx.hidden({ _return: props.returnTo, ...version(user) })}
        srSuffix={user.email}
      >
        {label}
      </ActionForm>
    );
  }
  const id = `dlg-${props.scope}-again-${user.id}`;
  return (
    <>
      <DialogTrigger size="sm" dialog={id} srSuffix={user.email}>
        {label}…
      </DialogTrigger>
      <ConfirmDialog
        id={id}
        confirmVariant="primary"
        action={`${base(user)}/reset-login`}
        hidden={ctx.hidden({ _return: props.returnTo, ...version(user), confirm: '1' })}
        title={`Invite ${user.email} again as Owner?`}
        description={`Owner: ${ROLE_INFO.owner.description}`}
        confirmLabel={`Invite ${user.email} again as Owner`}
      />
    </>
  );
}

/** The one action a person shows outside "Change", when their state has one (1 click). */
export function StateButton(props: {
  user: UserListEntry;
  ctx: ViewContext;
  returnTo: UserReturn;
  /** Prefix of dialog ids, so two renders of one person on a page stay unique. */
  scope?: string;
}) {
  const { user, ctx } = props;
  switch (rowState(user, ctx.now)) {
    case 'suspended_linked':
      return (
        <ActionForm
          size="sm"
          action={base(user)}
          hidden={ctx.hidden({ _return: props.returnTo, ...version(user), status: 'active' })}
          srSuffix={user.email}
        >
          Reactivate
        </ActionForm>
      );
    case 'suspended_unlinked':
      return (
        <InviteAgain user={user} ctx={ctx} returnTo={props.returnTo} scope={props.scope ?? 'row'} />
      );
    case 'invited':
    case 'invite_expired':
      return (
        <ActionForm
          size="sm"
          action={`${base(user)}/resend-invite`}
          hidden={ctx.hidden({ _return: props.returnTo })}
          srSuffix={`for ${user.email}`}
        >
          Renew invitation
        </ActionForm>
      );
    default:
      return null;
  }
}

/** Whether moving `user` to `role` needs a confirm dialog (an owner on either side). */
function needsDialog(user: { role: Role }, role: Role): boolean {
  return role === 'owner' || user.role === 'owner';
}

function roleDialogId(user: { id: string }, role: Role): string {
  return role === 'owner' ? `dlg-owner-${user.id}` : `dlg-demote-${user.id}-${role}`;
}

export function resetBody(user: UserListEntry): string {
  return `Reset only after ${user.email} confirms that they changed their sign-in account. After the reset, the next person to sign in through Access with ${user.email} gets this account and its role (${ROLE_INFO[user.role].label}).`;
}

/**
 * The confirm dialogs of one person's changes (owner promotion and demotions, suspending an
 * owner, reset sign-in, delete or cancel the invitation): each posts on its own, so none needs
 * the role form. `detail` adds the Person page's consequence list to the reset dialog.
 */
export function PersonDialogs(props: {
  user: UserListEntry;
  ctx: ViewContext;
  returnTo: UserReturn;
  /** The join policy label, for the delete dialog. */
  joinPolicy: string;
  detail?: { changes: number; accessUserId: string };
  /** Only the role dialogs (after the role form) or only the state ones (the danger zone). */
  only?: 'roles' | 'state';
}) {
  const { user, ctx, returnTo } = props;
  const state = rowState(user, ctx.now);
  const hidden = (extra: Record<string, string>) =>
    ctx.hidden({ _return: returnTo, ...version(user), ...extra });
  const first = firstName(user);
  const roles = ROLE_ORDER.filter((role) => role !== user.role && needsDialog(user, role));
  const roleDialogs = roles.map((role) => {
    const label = ROLE_INFO[role].label;
    return (
      <ConfirmDialog
        id={roleDialogId(user, role)}
        confirmVariant="primary"
        action={base(user)}
        hidden={hidden({ role })}
        title={`Make ${user.email} ${label}?`}
        description={
          role === 'owner'
            ? `Owner: ${ROLE_INFO.owner.description}`
            : `${user.email} stops being an owner and can no longer change people, sign-in, allowed hosts, data retention or encryption keys. ${label}: ${ROLE_INFO[role].description}`
        }
        confirmLabel={`Make ${user.email} ${label}`}
      />
    );
  });
  const reset =
    state === 'active' || state === 'active_owner' || state === 'suspended_linked' ? (
      <ConfirmDialog
        id={`dlg-reset-${user.id}`}
        action={`${base(user)}/reset-login`}
        hidden={hidden({ confirm: '1' })}
        title={`Reset sign-in for ${user.email}?`}
        description={
          props.detail
            ? `Reset only after ${first} confirms that they changed their sign-in account.`
            : resetBody(user)
        }
        consequences={
          props.detail
            ? [
                <>
                  Access user <code>{props.detail.accessUserId || '—'}</code> is unlinked.
                </>,
                <>
                  The next person to sign in through Access with <b>{user.email}</b> gets this
                  account and its role (<b>{ROLE_INFO[user.role].label}</b>).
                </>,
                `Their ${props.detail.changes} ${props.detail.changes === 1 ? 'change stays' : 'changes stay'} in the audit log. This cannot be undone.`,
              ]
            : undefined
        }
        confirmLabel={props.detail ? 'Reset sign-in' : `Reset sign-in for ${user.email}`}
      />
    ) : null;
  const suspend =
    state === 'active_owner' ? (
      <ConfirmDialog
        id={`dlg-suspend-${user.id}`}
        action={base(user)}
        hidden={hidden({ status: 'suspended', confirm: '1' })}
        title={`Suspend ${user.email}?`}
        description={`${user.email} is an owner. Their Access session stays valid, but tokengate refuses every request they make. Reactivate restores access.`}
        confirmLabel={`Suspend ${user.email}`}
      />
    ) : null;
  const invitation = state === 'invited' || state === 'invite_expired';
  const remove =
    state === 'suspended_unlinked' || invitation ? (
      <ConfirmDialog
        id={`dlg-delete-${user.id}`}
        action={`${base(user)}/delete`}
        hidden={hidden({ confirm: '1' })}
        title={invitation ? `Cancel the invitation of ${user.email}?` : `Delete ${user.email}?`}
        description={`This deletes ${user.email}, who never signed in. If they sign in later, they are treated like anyone new: ${props.joinPolicy}.`}
        confirmLabel={invitation ? 'Cancel invitation' : `Delete ${user.email}`}
        cancelLabel={invitation ? 'Keep it' : undefined}
      />
    ) : null;
  return (
    <>
      {props.only === 'state' ? null : roleDialogs}
      {props.only === 'roles' ? null : (
        <>
          {suspend}
          {reset}
          {remove}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// People: one row of the Accounts table

/** The "Change ▾" row menu: role items, then state actions, then View details. */
function PersonMenu(props: { user: UserListEntry; ctx: ViewContext; error?: string | null }) {
  const { user, ctx } = props;
  const state = rowState(user, ctx.now);
  const first = firstName(user);
  const invitation = state === 'invited' || state === 'invite_expired';
  const hidden = (extra: Record<string, string> = {}) =>
    ctx.hidden({ _return: 'list', ...version(user), ...extra });
  const roleItems = ROLE_ORDER.filter((role) => role !== user.role).map((role) => {
    const label = ROLE_INFO[role].label;
    if (needsDialog(user, role)) {
      return (
        <MenuItem
          dialog={roleDialogId(user, role)}
          srPrefix={`Make ${user.email}`}
          keyFact={ROLE_INFO[role].tag}
          detail={
            role === 'owner' ? (
              'People, sign-in and settings too. You confirm in a dialog.'
            ) : (
              <RoleDiff from={user.role} to={role} />
            )
          }
        >
          {label}…
        </MenuItem>
      );
    }
    return (
      <MenuItem
        action={base(user)}
        name="role"
        value={role}
        hidden={hidden()}
        srPrefix={`Make ${user.email}`}
        keyFact={ROLE_INFO[role].tag}
        detail={<RoleDiff from={user.role} to={role} />}
      >
        {label}
      </MenuItem>
    );
  });
  const reset = (
    <MenuItem
      dialog={`dlg-reset-${user.id}`}
      tone="bad"
      srSuffix={user.email}
      detail={`Unlinks ${first}'s Cloudflare Access account. Cannot be undone.`}
    >
      Reset sign-in…
    </MenuItem>
  );
  const remove = (
    <MenuItem
      dialog={`dlg-delete-${user.id}`}
      tone="bad"
      srSuffix={user.email}
      detail={
        invitation
          ? 'Deletes the invitation. You can invite again later.'
          : 'Deletes this person, who never signed in.'
      }
    >
      {invitation ? 'Cancel invitation…' : 'Delete…'}
    </MenuItem>
  );
  const stateItems: Record<RowState, Child> = {
    active: (
      <>
        <MenuItem
          action={base(user)}
          name="status"
          value="suspended"
          hidden={hidden()}
          tone="bad"
          srSuffix={user.email}
          detail={`tokengate refuses every request ${first} makes. Undo appears right after.`}
        >
          Suspend
        </MenuItem>
        {reset}
      </>
    ),
    active_owner: (
      <>
        <MenuItem
          dialog={`dlg-suspend-${user.id}`}
          tone="bad"
          srSuffix={user.email}
          detail={`${first} is an owner. tokengate refuses every request they make. You confirm in a dialog.`}
        >
          Suspend…
        </MenuItem>
        {reset}
      </>
    ),
    suspended_linked: reset,
    suspended_unlinked: remove,
    invited: null,
    invite_expired: null,
    pending: null,
  };
  return (
    <RowMenu name="person-actions" srSuffix={user.email} open={props.error ? true : undefined}>
      {props.error ? <FieldError id={`f-user-${user.id}`}>{props.error}</FieldError> : null}
      {invitation ? (
        <MenuHeader
          end={
            state === 'invite_expired'
              ? 'expired'
              : `expires ${uiFormatTime(new Date(user.invite_expires_at ?? 0), 'day')}`
          }
        >
          Invitation for <b>{user.email}</b>
        </MenuHeader>
      ) : (
        <MenuHeader end={`now ${roleLabel(user.role)}`}>
          Change the role of <b>{user.email}</b>
        </MenuHeader>
      )}
      {invitation ? (
        <>
          <MenuItem
            href={signInMailto(user, ctx.host, ctx.now)}
            srSuffix={`to ${user.email}`}
            keyFact="mailto"
            detail={`Opens your mail app with https://${ctx.host}/admin.`}
          >
            Email sign-in link
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      {roleItems}
      <MenuSeparator />
      {stateItems[state]}
      {invitation ? remove : null}
      <MenuItem
        href={paths.user(user.id)}
        srSuffix={`of ${user.email}`}
        keyFact={<span aria-hidden="true">→</span>}
      >
        View details
      </MenuItem>
    </RowMenu>
  );
}

/** One row of the Accounts table (`tr#user-<id>`, the target of every redirect back to it). */
export function PersonRow(props: {
  user: UserListEntry;
  ctx: ViewContext;
  owner: boolean;
  /** Changes this person made in the last 30 days. */
  changes: number;
  joinPolicy: string;
  /** The row the notice is about (just changed or invited). */
  highlight: boolean;
  /** A failed row action, shown in the open row menu. */
  error?: string | null;
  /** Who sent an open invitation, and when ("you" for the viewer). */
  invitedBy?: { name: string; at: number } | null;
}) {
  const { user, ctx } = props;
  const self = user.id === ctx.userId;
  const invitedBy = user.status === 'invited' ? (props.invitedBy ?? null) : null;
  const n = props.changes;
  const icon = ROLE_ICON[user.role];
  return (
    <Row id={`user-${user.id}`} highlight={props.highlight}>
      <RowHeader>
        <Entity
          logoSlot={
            <Avatar
              size="md"
              name={user.name ?? user.email}
              variant={user.status === 'invited' ? 'pending' : undefined}
            />
          }
          href={paths.user(user.id)}
          name={user.email}
          after={self ? <Badge tone="outline">You</Badge> : undefined}
          meta={user.name ?? (user.identity_count === 0 ? 'Not signed in yet' : undefined)}
        />
      </RowHeader>
      <Cell label="Role">
        <span class="ent-t">
          <span>{roleLabel(user.role)}</span>
          <span class="meta">
            {icon ? <Icon name={icon} /> : null}
            {CELL_TAG[user.role]}
          </span>
        </span>
      </Cell>
      <Cell label="Status">
        <StatusCell user={user} now={ctx.now} />
      </Cell>
      <Cell label="Last sign-in">
        <span class="ent-t">
          <span>
            {user.last_login_at === null ? (
              'Never'
            ) : (
              <Time datetime={new Date(user.last_login_at)}>
                {relativeTime(user.last_login_at, ctx.now)}
              </Time>
            )}
          </span>
          <span class="meta">
            {invitedBy && n === 0 ? (
              <>
                Invited by {invitedBy.name}{' '}
                <span class="nowrap">
                  <Time datetime={new Date(invitedBy.at)}>
                    {relativeTime(invitedBy.at, ctx.now)}
                  </Time>
                </span>
              </>
            ) : n > 0 ? (
              <>
                <a href={paths.audit({ actor: user.id })}>
                  {n} {n === 1 ? 'change' : 'changes'}
                  <span class="vh"> by {user.email}</span>
                </a>{' '}
                in 30 days
              </>
            ) : (
              'No changes in 30 days'
            )}
          </span>
        </span>
      </Cell>
      {props.owner ? (
        <Cell act>
          {self ? (
            // Short, so the Actions column does not squeeze Role and Status; the Person page says
            // who can change it.
            <span class="meta">
              This is you<span class="vh">. Another owner can change your account.</span>
            </span>
          ) : (
            <>
              <StateButton user={user} ctx={ctx} returnTo="list" />
              <PersonMenu user={user} ctx={ctx} error={props.error} />
              <PersonDialogs user={user} ctx={ctx} returnTo="list" joinPolicy={props.joinPolicy} />
            </>
          )}
        </Cell>
      ) : null}
    </Row>
  );
}

// ---------------------------------------------------------------------------------------------
// Person page: the role cards

/** The four roles a pending person can be approved as with one click; Owner confirms first. */
const APPROVE_ROLES: readonly Role[] = ['viewer', 'token_manager', 'access_manager', 'admin'];

/** One-click role cards of a pending person, with Reject and the Owner dialog after the form. */
export function ApproveCards(props: { user: UserListEntry; ctx: ViewContext }) {
  const { user, ctx } = props;
  const first = firstName(user);
  const action = `${base(user)}/approve`;
  const ownerDialog = `dlg-approve-owner-${user.id}`;
  const cards: ActionCard[] = [
    ...APPROVE_ROLES.map((role) => ({
      value: role,
      srPrefix: `Approve ${user.email} as`,
      title: ROLE_INFO[role].label,
      description: ROLE_INFO[role].short,
      footnote: <RoleTag role={role} />,
    })),
    {
      value: 'owner',
      srPrefix: `Approve ${user.email} as`,
      title: 'Owner…',
      description: ROLE_INFO.owner.short,
      footnote: <RoleTag role="owner" />,
      dialog: ownerDialog,
      go: 'Confirm next →',
    },
  ];
  return (
    <>
      <form method="post" action={action}>
        <HiddenInputs fields={ctx.hidden({ _return: 'list' })} />
        <FieldSet id={`approve-${user.id}`} legend={`Approve ${first} as`}>
          <ActionCards name="role" go="Approve →" cards={cards} />
        </FieldSet>
      </form>
      <ButtonRow>
        <ActionForm
          variant="danger"
          action={`${base(user)}/reject`}
          hidden={ctx.hidden({ _return: 'list' })}
          srSuffix={`${user.email} (you can reactivate them later)`}
        >
          Reject
        </ActionForm>
      </ButtonRow>
      <ApproveOwnerDialog user={user} ctx={ctx} />
    </>
  );
}

/** "Approve … as Owner?": posts the approve with `role=owner` on its own. */
function ApproveOwnerDialog(props: { user: UserListEntry; ctx: ViewContext }) {
  const { user, ctx } = props;
  return (
    <ConfirmDialog
      id={`dlg-approve-owner-${user.id}`}
      confirmVariant="primary"
      action={`${base(user)}/approve`}
      hidden={ctx.hidden({ _return: 'list', role: 'owner' })}
      title={`Approve ${user.email} as Owner?`}
      description={`Owner: ${ROLE_INFO.owner.description}`}
      confirmLabel={`Approve ${user.email} as Owner`}
    />
  );
}

function HiddenInputs(props: { fields: Record<string, string> }) {
  return (
    <>
      {Object.entries(props.fields).map(([name, value]) => (
        <input type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

/** The duty of a role as a badge: the two separate duties stand out (accent). */
function RoleTag(props: { role: Role }) {
  const accent = props.role === 'token_manager' || props.role === 'access_manager';
  return <Badge tone={accent ? 'accent' : 'neutral'}>{ROLE_INFO[props.role].tag}</Badge>;
}

/**
 * The role cards of the Person page (`form#role-<id>`): one click per role, with what it adds and
 * removes. A change that involves Owner opens its confirm dialog, rendered after the form.
 */
export function RoleCards(props: { user: UserListEntry; ctx: ViewContext; error?: string | null }) {
  const { user, ctx } = props;
  const first = firstName(user);
  const cards: ActionCard[] = ROLE_ORDER.filter((role) => role !== user.role).map((role) => {
    const dialog = needsDialog(user, role) ? roleDialogId(user, role) : undefined;
    const label = ROLE_INFO[role].label;
    return {
      value: role,
      srPrefix: `Make ${user.email}`,
      title: dialog ? `${label}…` : label,
      description: ROLE_INFO[role].short,
      footnote: <RoleDiff from={user.role} to={role} />,
      dialog,
      go: dialog ? 'Confirm next →' : undefined,
    };
  });
  return (
    <>
      {props.error ? <FieldError id={`f-user-${user.id}`}>{props.error}</FieldError> : null}
      <form method="post" action={base(user)} id={`role-${user.id}`}>
        <HiddenInputs fields={ctx.hidden({ _return: 'detail', ...version(user) })} />
        <FieldSet id={`f-role-${user.id}`} legend={`Make ${first}`}>
          <ActionCards name="role" go="→" cards={cards} />
        </FieldSet>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// People: Needs your decision

/** Whether a person's row needs an owner's decision, and which card it gets. */
export type DecisionCard =
  | { kind: 'pending'; user: UserListEntry }
  | { kind: 'expired' | 'cancelled' | 'other_account'; user: UserListEntry };

export function decisionKind(user: UserListEntry): DecisionCard['kind'] {
  if (user.status === 'pending') return 'pending';
  if (user.status === 'invited') return 'expired';
  if (user.status === 'suspended' && user.identity_count === 0) return 'cancelled';
  return 'other_account';
}

function decisionItem(
  card: DecisionCard,
  ctx: ViewContext,
  owner: boolean,
  dismissError: string | null,
): AttentionItem {
  const { user } = card;
  const now = ctx.now;
  const tried = user.last_refused_at;
  const when = tried === null ? '' : relativeTime(tried, now);
  const who = {
    id: `decide-${user.id}-h`,
    avatar: (
      <Avatar
        size="lg"
        name={user.name ?? user.email}
        variant={card.kind === 'pending' ? 'pending' : undefined}
      />
    ),
    name: user.email,
    status: <UserBadge user={user} now={now} />,
  };
  if (card.kind === 'pending') {
    return {
      who: {
        ...who,
        meta: (
          <>
            {user.name ? `${user.name} · ` : null}signed in first{' '}
            <Time datetime={new Date(user.created_at)}>{relativeTime(user.created_at, now)}</Time>
            {tried !== null ? (
              <>
                {' '}
                · last tried <Time datetime={new Date(tried)}>{relativeTime(tried, now)}</Time>
              </>
            ) : null}
          </>
        ),
      },
      approve: owner
        ? {
            action: `${base(user)}/approve`,
            subject: user.email,
            legend: 'Approve as',
            hidden: ctx.hidden({ _return: 'list' }),
            roles: [
              ...APPROVE_ROLES.map((role) => ({ value: role, label: ROLE_INFO[role].label })),
              { value: 'owner', label: 'Owner…', dialog: `dlg-approve-owner-${user.id}` },
            ],
            reject: {
              action: `${base(user)}/reject`,
              hidden: ctx.hidden({ _return: 'list' }),
              srSuffix: `${user.email} (you can reactivate them later)`,
            },
          }
        : undefined,
    };
  }
  const dismiss =
    tried !== null ? (
      <ActionForm
        size="sm"
        action={`${base(user)}/dismiss-attempt`}
        hidden={ctx.hidden({ _return: 'list', expected_refused_at: String(tried) })}
        srSuffix={`the sign-in attempt of ${user.email}`}
      >
        Dismiss
      </ActionForm>
    ) : null;
  const error = dismissError ? (
    <FieldError id={`f-dismiss-${user.id}`}>{dismissError}</FieldError>
  ) : null;
  let body: Child;
  let actions: Child;
  if (card.kind === 'expired') {
    const expires = user.invite_expires_at;
    body = `${user.email} tried to sign in ${when}, but the invitation expired${expires !== null ? ` ${relativeTime(expires, now)}` : ''}.`;
    actions = (
      <>
        {error}
        <ActionForm
          size="sm"
          action={`${base(user)}/resend-invite`}
          hidden={ctx.hidden({ _return: 'list' })}
          srSuffix={`for ${user.email}`}
        >
          Renew invitation
        </ActionForm>
        <Button size="sm" href={signInMailto(user, ctx.host, now)} srSuffix={`to ${user.email}`}>
          Email sign-in link
        </Button>
        {dismiss}
      </>
    );
  } else if (card.kind === 'cancelled') {
    body = `${user.email} tried to sign in ${when}, but their invitation as ${ROLE_INFO[user.role].label} was cancelled.`;
    actions = (
      <>
        {error}
        <InviteAgain user={user} ctx={ctx} returnTo="list" scope="card" />
        {dismiss}
      </>
    );
  } else {
    const sub = accessUserId(user.last_refused_subject);
    body = (
      <>
        {user.email} tried {when} with a different sign-in account (Access user ID{' '}
        <code>…{sub.slice(-4)}</code>).
      </>
    );
    actions = (
      <>
        {error}
        <DialogTrigger
          size="sm"
          variant="danger"
          dialog={`dlg-card-reset-${user.id}`}
          srSuffix={user.email}
        >
          Reset sign-in…
        </DialogTrigger>
        <ConfirmDialog
          id={`dlg-card-reset-${user.id}`}
          action={`${base(user)}/reset-login`}
          hidden={ctx.hidden({ _return: 'list', ...version(user), confirm: '1' })}
          title={`Reset sign-in for ${user.email}?`}
          description={resetBody(user)}
          confirmLabel={`Reset sign-in for ${user.email}`}
        />
        {dismiss}
      </>
    );
  }
  return {
    who: { ...who, meta: user.name ?? undefined },
    body,
    actions: owner ? actions : undefined,
  };
}

/** "Needs your decision": pending people, then refused sign-ins only an owner can fix. */
export function DecisionTray(props: {
  cards: DecisionCard[];
  ctx: ViewContext;
  /** A failed Dismiss, shown at its card. */
  dismissError?: { userId: string; message: string } | null;
}) {
  const { cards, ctx } = props;
  if (cards.length === 0) return null;
  const owner = ctx.can('users:write');
  const pending = cards.filter((card) => card.kind === 'pending');
  const [onlyPending] = pending;
  const description = owner ? (
    <>
      {pending.length === 1 && onlyPending
        ? `tokengate refuses everything ${firstName(onlyPending.user)} does until you pick a role.`
        : 'tokengate refuses everything these people do until an owner decides.'}{' '}
      <a href="#compare-roles">Compare roles</a>
    </>
  ) : (
    'Only owners can decide.'
  );
  return (
    <Tray
      id="decide"
      tone="warn"
      title="Needs your decision"
      count={cards.length}
      description={description}
      footer={
        // The description already says "Only owners can decide."; this names them.
        owner ? undefined : <AskSomeone permission="users:write" ctx={ctx} lead={false} />
      }
    >
      <Panel>
        <NeedsAttention
          layout="list"
          items={cards.map((card) =>
            decisionItem(
              card,
              ctx,
              owner,
              card.kind !== 'pending' && props.dismissError?.userId === card.user.id
                ? props.dismissError.message
                : null,
            ),
          )}
        />
        {owner ? pending.map((card) => <ApproveOwnerDialog user={card.user} ctx={ctx} />) : null}
      </Panel>
    </Tray>
  );
}

// ---------------------------------------------------------------------------------------------
// People: Invite someone

/** The email pattern of the invite field (A12.8): the server's normalizeEmail decides. */
export const EMAIL_PATTERN = '[^\\s@,;<>"]+@[A-Za-z0-9\\-]+(\\.[A-Za-z0-9\\-]+)+';

/** Roles invited with a role card; Owner goes through a dialog. */
const INVITE_ROLES: readonly Role[] = APPROVE_ROLES;

/**
 * "Invite someone": the email and one submit per role (the card is the choice). The first submit
 * in tree order is Viewer, so Enter invites with the least privilege; the Owner dialog comes after
 * `</form>` and submits it with `form=`. Shown when targeted (`#invite`) or after a failed invite.
 */
export function InviteTray(props: {
  ctx: ViewContext;
  open: boolean;
  email?: string;
  error?: string | null;
  roleError?: string | null;
  /** The row of an email that is already a person who signed in: its own action is offered. */
  existing?: UserListEntry | null;
  emailExample: string;
}) {
  const { ctx } = props;
  const existing = props.existing ?? null;
  const cards: ActionCard[] = INVITE_ROLES.map((role) => ({
    value: role,
    srPrefix: 'Invite as',
    title:
      role === 'viewer' ? (
        <>
          Viewer <Kbd>Enter</Kbd>
        </>
      ) : (
        ROLE_INFO[role].label
      ),
    description: ROLE_INFO[role].description,
    footnote: <RoleTag role={role} />,
  }));
  return (
    <Tray
      id="invite"
      class={props.open ? 'span-12 is-open' : 'span-12'}
      title="Invite someone"
      description="Type their email, then pick the role. The role button sends the invitation. It lasts 7 days."
      actions={
        <Button size="sm" href={paths.users()} srSuffix="invite someone">
          Close
        </Button>
      }
    >
      <Panel variant="pad">
        <form method="post" action={paths.users()} id="invite-form" class="fields w-form">
          <HiddenInputs fields={ctx.hidden()} />
          <Field
            id="f-email"
            label="Email"
            hint={
              <>
                The email of their Cloudflare Access account. Press <Kbd>Enter</Kbd> to invite as
                Viewer. Nothing is sent: you get a link to email them.
              </>
            }
            error={props.error || undefined}
          >
            <Input
              name="email"
              type="email"
              value={props.email}
              required
              maxlength={254}
              pattern={EMAIL_PATTERN}
              placeholder={props.emailExample}
              autocomplete="off"
              spellcheck={false}
              autocapitalize="none"
              enterkeyhint="send"
              describedBy={existing ? 'invite-existing' : undefined}
            />
          </Field>
          <FieldSet
            id="f-role"
            legend="Invite as"
            hint="Token manager and Access manager are separate duties: one person loads keys, another decides who may use them."
            error={props.roleError || undefined}
          >
            <ActionCards name="role" go="Invite →" cards={cards} />
          </FieldSet>
          <ButtonRow>
            <DialogTrigger dialog="dlg-invite-owner">Invite as Owner…</DialogTrigger>
            <span class="hint">{ROLE_INFO.owner.description} You confirm first.</span>
          </ButtonRow>
        </form>
        {existing ? (
          // After `</form>`: the state button is a form of its own and must not nest in this one.
          <ButtonRow id="invite-existing">
            {/* A pending person has no table row: their card under "Needs your decision". */}
            <a
              href={
                existing.status === 'pending'
                  ? `#decide-${existing.id}-h`
                  : paths.users({ hash: `user-${existing.id}` })
              }
            >
              Go to {existing.email}
            </a>
            <StateButton user={existing} ctx={ctx} returnTo="list" scope="invite" />
          </ButtonRow>
        ) : null}
        <ConfirmDialog
          id="dlg-invite-owner"
          confirmVariant="primary"
          form="invite-form"
          name="role"
          value="owner"
          formnovalidate
          title="Invite as Owner?"
          description="The email you typed gets every power in this console."
          consequences={[
            <>
              Owners add, suspend and change the role of <b>every person</b>, including you.
            </>,
            'Owners change sign-in, admin hosts, allowed hosts, data retention and encryption keys.',
            'A second owner is your recovery path. Pick someone who can sign in when you cannot.',
          ]}
          confirmLabel="Invite as Owner"
        />
        <Disclosure id="compare-roles" summary="Compare roles">
          <CompareRoles />
        </Disclosure>
      </Panel>
    </Tray>
  );
}

/** Capability × role table (Compare roles). */
export function CompareRoles() {
  return (
    <div class="u-compare">
      <Table
        label="What each role can do"
        caption="What each role can do"
        columns={[
          { label: 'Capability' },
          ...ROLE_ORDER.map((role) => ({ label: ROLE_INFO[role].label })),
        ]}
      >
        {CAPABILITIES.map((row) => (
          <Row>
            <RowHeader>{row.text}</RowHeader>
            {ROLE_ORDER.map((role) =>
              row.roles.includes(role) ? (
                <Cell class="y">
                  <span aria-hidden="true">✓ </span>Yes
                </Cell>
              ) : (
                <Cell class="n">No</Cell>
              ),
            )}
          </Row>
        ))}
      </Table>
    </div>
  );
}

/** "What Tom can do": the capability list of one role, yes and no. */
export function CanList(props: { role: Role }) {
  return (
    <ul class="u-can">
      {CAPABILITIES.map((row) => {
        const yes = row.roles.includes(props.role);
        return (
          <li class={yes ? undefined : 'no'}>
            <span class={yes ? 'y' : 'n'} aria-hidden="true">
              {yes ? '✓' : '✕'}
            </span>
            <span>
              <span class="vh">{yes ? 'Yes: ' : 'No: '}</span>
              {row.text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// People: Who can change what (role map)

const MAP_ROLES: readonly Role[] = ['owner', 'admin', 'token_manager', 'access_manager', 'viewer'];
const MAP_CAPS = ['Service tokens', 'Consumer access', 'People and settings'] as const;
/** Which capability rows each role reaches (indexes into MAP_CAPS). */
const MAP_WIRES: Readonly<Record<Role, readonly number[]>> = {
  owner: [0, 1, 2],
  admin: [0, 1],
  token_manager: [0],
  access_manager: [1],
  viewer: [],
};
/** Node pitch of the compact map (node 40px + gap 8px): row i is centered at i * 48 + 20. */
const PITCH = 48;
/**
 * Vertical center of each capability node: the first two span two role rows (`.rs2`), centered
 * between rows 0–1 and 2–3; the last sits on row 4.
 */
const CAP_CENTER: readonly number[] = [PITCH - 4, 3 * PITCH - 4, 4 * PITCH + 20];

function mapName(user: UserListEntry): string {
  const name = user.name ? user.name : user.email.slice(0, user.email.indexOf('@'));
  return user.status === 'invited' ? `${name} (invited)` : name;
}

/** "Priya", "Priya and Lena", "Priya, Lena and Tom". */
function andList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The first names of the active holders of `roles` ("you" last), or null past `max`. */
function holders(
  people: readonly UserListEntry[],
  roles: readonly Role[],
  selfId: string | undefined,
  max: number,
): string[] | null {
  const active = people.filter((user) => user.status === 'active' && roles.includes(user.role));
  if (active.length === 0 || active.length > max) return null;
  const sorted = [...active].sort((a, b) => Number(a.id === selfId) - Number(b.id === selfId));
  return sorted.map((user) => (user.id === selfId ? 'you' : firstName(user)));
}

/** "loads" for one person, "load" for several or for "you". */
function verbFor(who: readonly string[] | null, one: string, many: string): string {
  return who !== null && who.length === 1 && who[0] !== 'you' ? one : many;
}

/**
 * The role map: roles with their people on the left, what each role can change on the right,
 * wires between them. Decorative wires; the text after the map says the same in words.
 */
export function RoleMap(props: { listed: readonly UserListEntry[]; selfId?: string }) {
  // Active people first: a role's line names who holds it now before an open invitation.
  const people = props.listed
    .filter((user) => user.status !== 'suspended')
    .sort((a, b) => Number(a.status === 'invited') - Number(b.status === 'invited'));
  const byRole = new Map<Role, UserListEntry[]>(
    MAP_ROLES.map((role) => [role, people.filter((user) => user.role === role)]),
  );
  const height = MAP_ROLES.length * PITCH - 8;
  const wires = MAP_ROLES.flatMap((role, row) =>
    MAP_WIRES[role].map((cap) => {
      const from = row * PITCH + 20;
      const to = CAP_CENTER[cap] ?? 0;
      return {
        d: `M0 ${from} C50 ${from} 50 ${to} 100 ${to}`,
        on: role === 'token_manager' || role === 'access_manager',
      };
    }),
  );
  const names = (role: Role) => (byRole.get(role) ?? []).map(mapName);
  const loaders = holders(people, ['token_manager'], props.selfId, 2);
  const granters = holders(people, ['access_manager'], props.selfId, 2);
  const both = holders(people, ['owner', 'admin'], props.selfId, 3);
  const bothText = both ? andList(both) : null;
  return (
    <Tray
      id="roles-map"
      class="span-5"
      title="Who can change what"
      description="Everyone reads every page. Select a role to filter the list."
      footer={
        <p class="legend">
          <span>
            <svg width="20" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="20" y2="4" class="wire on" />
            </svg>
            <span class="lt">
              Separate duties: {loaders ? <b>{andList(loaders)}</b> : 'token managers'}{' '}
              {verbFor(loaders, 'loads', 'load')} keys,{' '}
              {granters ? <b>{andList(granters)}</b> : 'access managers'}{' '}
              {verbFor(granters, 'grants', 'grant')} access
            </span>
          </span>
          <span>
            <svg width="20" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="20" y2="4" class="wire" />
            </svg>
            <span class="lt">
              {bothText
                ? `${bothText.charAt(0).toUpperCase()}${bothText.slice(1)} do both`
                : 'Admins and owners do both'}
            </span>
          </span>
        </p>
      }
    >
      <Panel>
        <div class="cmap u-rmap">
          <div class="cmap-col">
            <div class="cmap-h">
              Role <span class="n">· people</span>
            </div>
            <ul class="nodes" aria-label="Roles">
              {MAP_ROLES.map((role) => {
                const count = byRole.get(role)?.length ?? 0;
                const list = names(role);
                return (
                  <li>
                    <a
                      class={role === 'viewer' ? 'node cnode idle' : 'node cnode'}
                      href={paths.users({ role })}
                    >
                      <span class="id">
                        <span class="nm">{ROLE_INFO[role].label}</span>
                        <span class="nl">
                          {list.length > 0 ? list.slice(0, 2).join(' · ') : 'Nobody'}
                          {list.length > 2 ? ` +${list.length - 2}` : ''}
                        </span>
                      </span>
                      <span class="cnt">
                        {count}
                        <span class="vh">{count === 1 ? ' person' : ' people'}</span>
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
          <div class="cmap-mid" aria-hidden="true">
            <div class="cmap-h" />
            <svg
              class="wires"
              viewBox={`0 0 100 ${height}`}
              preserveAspectRatio="none"
              height={height}
              focusable="false"
            >
              {wires.map((wire) => (
                <path class={wire.on ? 'wire on' : 'wire'} d={wire.d} />
              ))}
            </svg>
          </div>
          <div class="cmap-col">
            <div class="cmap-h">Can change</div>
            <ul class="nodes" aria-label="What they can change">
              {MAP_CAPS.map((cap, index) => (
                <li class={index < 2 ? 'node tcap rs2' : 'node tcap'}>
                  <span class="logo sm lg-custom" aria-hidden="true">
                    <Icon name={index === 0 ? 'token' : index === 1 ? 'consumer' : 'users'} />
                  </span>
                  <span class="id">
                    <span class="nm">{cap}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p class="cmap-note u-rmap-txt">
          {MAP_ROLES.map((role) => (
            <>
              <b>{ROLE_INFO[role].label}:</b>{' '}
              {ROLE_POWERS[role].length > 0
                ? `${ROLE_POWERS[role].join(', ')}.`
                : 'reads only.'}{' '}
            </>
          ))}
        </p>
      </Panel>
    </Tray>
  );
}
