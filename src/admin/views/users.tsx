// Users section views: a person's status, the visible state button and the "Change" controls of
// a row (shared by People and the Person page), the decision cards, the invite form and the role
// comparison. No client script: row controls are `<details name>` disclosures (one open at a
// time), and dialogs open with invoker commands, never from inside a popover. Every dialog that
// submits another form follows that form in tree order, so Enter keeps its default button.
import type { Child } from 'hono/jsx';
import type { Role, User } from '../../db/types';
import type { UserListEntry } from '../../db/users';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import {
  ActionButton,
  ApproveForm,
  ConfirmBox,
  ConfirmDialog,
  type ConfirmDialogProps,
  DataTable,
  Field,
  PostForm,
  StatusBadge,
  Time,
  VersionField,
} from './components';
import { formatTime, relativeTime } from './format';
import { ROLE_INFO, ROLE_ORDER } from './roles';
import type { StatusKey } from './status';

/** Where a row action returns to: the People list or the Person page (never a URL). */
export type UserReturn = 'list' | 'detail';

const DAY_MS = 86_400_000;

/** The status badge of a person: invitations show their days left, or that they expired. */
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

/** `mailto:` with the console address: tokengate sends no email itself. */
export function signInMailto(
  user: Pick<User, 'email' | 'invite_expires_at'>,
  host: string,
): string {
  const expires =
    user.invite_expires_at === null
      ? ''
      : ` The invitation is valid until ${formatTime(user.invite_expires_at)}.`;
  const body = `Sign in to tokengate at https://${host}/admin with your Cloudflare Access account (${user.email}).${expires}`;
  const to = encodeURIComponent(user.email).replace('%40', '@');
  return `mailto:${to}?subject=${encodeURIComponent('Your tokengate sign-in')}&body=${encodeURIComponent(body)}`;
}

export function StatusCell(props: { user: UserListEntry; now: number }) {
  const { user, now } = props;
  const status = userStatus(user, now);
  const tried =
    user.last_refused_at !== null && user.last_refused_at > now - 7 * DAY_MS
      ? user.last_refused_at
      : null;
  return (
    <>
      <StatusBadge status={status.key} detail={status.detail} />
      {user.status === 'invited' && user.invite_expires_at !== null ? (
        <span class="muted">
          {' '}
          {status.key === 'invite_expired' ? 'expired' : 'until'}{' '}
          <Time ms={user.invite_expires_at} />
        </span>
      ) : null}
      {tried !== null ? <span class="muted"> · tried {relativeTime(tried, now)}</span> : null}
    </>
  );
}

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

/** A link styled as a secondary button. */
function MailLink(props: { user: UserListEntry; host: string; primary?: boolean }) {
  return (
    <a
      class={props.primary ? 'button' : 'button secondary'}
      href={signInMailto(props.user, props.host)}
    >
      Email sign-in link<span class="vh"> to {props.user.email}</span>
    </a>
  );
}

/** Opens dialog `dlg-<id>`; type="button", so it never submits an enclosing form. */
function Opener(props: { dialog: string; danger?: boolean; children: Child }) {
  const target = `dlg-${props.dialog}`;
  return (
    <button
      type="button"
      class={props.danger ? 'confirm-trigger danger' : 'confirm-trigger secondary'}
      commandfor={target}
      command="show-modal"
      popovertarget={target}
    >
      {props.children}
    </button>
  );
}

/** The one action a row shows outside "Change", when its state has one (1 click). */
export function StateButton(props: {
  user: UserListEntry;
  ctx: ViewContext;
  returnTo: UserReturn;
}) {
  const { user, ctx } = props;
  switch (rowState(user, ctx.now)) {
    case 'suspended_linked':
      return (
        <ActionButton
          action={base(user)}
          csrf={ctx.csrf}
          label="Reactivate"
          context={user.email}
          tone="primary"
          fields={{ status: 'active', ...version(user) }}
          returnTo={props.returnTo}
        />
      );
    case 'suspended_unlinked':
      return (
        <ActionButton
          action={`${base(user)}/reset-login`}
          csrf={ctx.csrf}
          label="Invite again"
          context={user.email}
          tone="primary"
          fields={version(user)}
          returnTo={props.returnTo}
        />
      );
    case 'invited':
      return <MailLink user={user} host={ctx.host} primary />;
    case 'invite_expired':
      return (
        <ActionButton
          action={`${base(user)}/resend-invite`}
          csrf={ctx.csrf}
          label="Renew invitation"
          context={`for ${user.email}`}
          tone="primary"
          returnTo={props.returnTo}
        />
      );
    default:
      return null;
  }
}

/** The non-owner roles, in privilege order. */
const PLAIN_ROLES = ROLE_ORDER.filter((role) => role !== 'owner');

/**
 * The role buttons and row actions of one person (not the viewer). On People they sit in
 * `<details name="person-actions">`; the Person page shows them open (`bare`).
 */
export function PersonChange(props: {
  user: UserListEntry;
  ctx: ViewContext;
  returnTo: UserReturn;
  /** The join policy label, for the cancel-invitation dialog. */
  joinPolicy: string;
  error?: string | null;
  bare?: boolean;
}) {
  const { user, ctx, returnTo } = props;
  const state = rowState(user, ctx.now);
  const formId = `role-${user.id}`;
  const dialogs: ConfirmDialogProps[] = [];
  const roleButtons = ROLE_ORDER.filter((role) => role !== user.role).map((role) => {
    const label = ROLE_INFO[role].label;
    const name = (
      <>
        <span class="vh">Make {user.email} </span>
        {label}
      </>
    );
    if (role !== 'owner' && user.role !== 'owner') {
      return (
        <button type="submit" name="role" value={role} class="secondary">
          {name}
        </button>
      );
    }
    const id = role === 'owner' ? `owner-${user.id}` : `demote-${user.id}-${role}`;
    dialogs.push({
      id,
      trigger: `${label}…`,
      title: `Make ${user.email} ${label}?`,
      body:
        role === 'owner'
          ? `Owner: ${ROLE_INFO.owner.description}`
          : `${user.email} stops being an owner and can no longer change people, sign-in, allowed hosts, data retention or encryption keys. ${label}: ${ROLE_INFO[role].description}`,
      confirmLabel: `Make ${user.email} ${label}`,
      variant: 'submits',
      formId,
      name: 'role',
      value: role,
      formnovalidate: true,
    });
    return (
      <Opener dialog={id}>
        {name}
        <span aria-hidden="true">…</span>
      </Opener>
    );
  });

  const reset: ConfirmDialogProps = {
    id: `reset-${user.id}`,
    trigger: 'Reset sign-in…',
    triggerContext: user.email,
    title: `Reset sign-in for ${user.email}?`,
    body: resetBody(user),
    confirmLabel: `Reset sign-in for ${user.email}`,
    danger: true,
    variant: 'standalone',
    action: `${base(user)}/reset-login`,
    csrf: ctx.csrf,
    fields: version(user),
    returnTo,
  };
  const cancel: ConfirmDialogProps = {
    id: `delete-${user.id}`,
    trigger: state === 'suspended_unlinked' ? 'Delete…' : 'Cancel invitation…',
    triggerContext: user.email,
    title:
      state === 'suspended_unlinked'
        ? `Delete ${user.email}?`
        : `Cancel the invitation of ${user.email}?`,
    body: `This deletes ${user.email}, who never signed in. If they sign in later, they are treated like anyone new: ${props.joinPolicy}.`,
    confirmLabel:
      state === 'suspended_unlinked'
        ? `Delete ${user.email}`
        : `Cancel the invitation of ${user.email}`,
    danger: true,
    variant: 'standalone',
    action: `${base(user)}/delete`,
    csrf: ctx.csrf,
    fields: version(user),
    returnTo,
  };
  const suspend = (
    <ActionButton
      action={base(user)}
      csrf={ctx.csrf}
      label="Suspend"
      context={user.email}
      tone="danger"
      fields={{ status: 'suspended', ...version(user) }}
      returnTo={returnTo}
    />
  );
  const suspendOwner: ConfirmDialogProps = {
    id: `suspend-${user.id}`,
    trigger: 'Suspend…',
    triggerContext: user.email,
    title: `Suspend ${user.email}?`,
    body: `${user.email} is an owner. Their Access session stays valid, but tokengate refuses every request they make. Reactivate restores access.`,
    confirmLabel: `Suspend ${user.email}`,
    danger: true,
    variant: 'standalone',
    action: base(user),
    csrf: ctx.csrf,
    fields: { status: 'suspended', ...version(user) },
    returnTo,
  };
  const renew = (
    <ActionButton
      action={`${base(user)}/resend-invite`}
      csrf={ctx.csrf}
      label="Renew invitation"
      context={`for ${user.email}`}
      returnTo={returnTo}
    />
  );
  const details = props.bare ? null : (
    <a href={paths.user(user.id)}>
      View details<span class="vh"> of {user.email}</span>
    </a>
  );
  const actions: Record<RowState, Child> = {
    active: (
      <>
        {suspend}
        <ConfirmDialog {...reset} />
      </>
    ),
    active_owner: (
      <>
        <ConfirmDialog {...suspendOwner} />
        <ConfirmDialog {...reset} />
      </>
    ),
    suspended_linked: <ConfirmDialog {...reset} />,
    suspended_unlinked: <ConfirmDialog {...cancel} />,
    invited: (
      <>
        {renew}
        <ConfirmDialog {...cancel} />
      </>
    ),
    invite_expired: (
      <>
        <MailLink user={user} host={ctx.host} />
        <ConfirmDialog {...cancel} />
      </>
    ),
    pending: null,
  };

  const body = (
    <>
      {props.error ? (
        <p class="field-error" id={`f-user-${user.id}`}>
          <span class="vh">Error:</span> {props.error}
        </p>
      ) : null}
      <PostForm action={base(user)} csrf={ctx.csrf} id={formId} returnTo={returnTo}>
        <VersionField value={String(user.updated_at)} />
        <fieldset class="submits">
          <legend>
            Role<span class="vh"> of {user.email}</span>
          </legend>
          <div class="actions">{roleButtons}</div>
        </fieldset>
      </PostForm>
      {dialogs.map((dialog) => (
        <ConfirmBox {...dialog} />
      ))}
      <div class="actions">
        {actions[state]}
        {details}
      </div>
    </>
  );
  if (props.bare) return <div class="person-change">{body}</div>;
  return (
    <details name="person-actions" class="person-actions" open={props.error ? true : undefined}>
      <summary>
        Change<span class="vh"> {user.email}</span>
      </summary>
      {body}
    </details>
  );
}

function resetBody(user: UserListEntry): string {
  return `Reset only after ${user.email} confirms that they changed their sign-in account. After the reset, the next person to sign in through Access with ${user.email} gets this account and its role (${ROLE_INFO[user.role].label}).`;
}

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

/** "Needs your decision (N)": pending people and refused sign-ins only an owner can fix. */
export function DecisionCards(props: { cards: DecisionCard[]; ctx: ViewContext }) {
  const { cards, ctx } = props;
  if (cards.length === 0) return null;
  const owner = ctx.can('users:write');
  return (
    <section id="decide" aria-labelledby="decide-h">
      <h2 id="decide-h">Needs your decision ({cards.length})</h2>
      {owner ? null : <p>Only owners can decide.</p>}
      <ul class="decisions">
        {cards.map((card) => (
          <li>
            <article aria-labelledby={`decide-${card.user.id}-h`} class="decision">
              <h3 id={`decide-${card.user.id}-h`}>{card.user.email}</h3>
              {card.user.name ? <p class="muted">{card.user.name}</p> : null}
              <CardBody card={card} ctx={ctx} owner={owner} />
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CardBody(props: { card: DecisionCard; ctx: ViewContext; owner: boolean }) {
  const { card, ctx, owner } = props;
  const { user } = card;
  const now = ctx.now;
  const tried = user.last_refused_at;
  const dismiss =
    owner && tried !== null ? (
      <ActionButton
        action={`${base(user)}/dismiss-attempt`}
        csrf={ctx.csrf}
        label="Dismiss"
        context={`the sign-in attempt of ${user.email}`}
        fields={{ expected_refused_at: String(tried) }}
        returnTo="list"
      />
    ) : null;
  if (card.kind === 'pending') {
    return (
      <>
        <p>
          Signed in first <Time ms={user.created_at} relative now={now} />
          {tried !== null ? <>. Last tried {relativeTime(tried, now)}</> : null}.
        </p>
        {owner ? <ApproveForm user={user} ctx={ctx} returnTo="list" /> : null}
      </>
    );
  }
  const when = tried === null ? '' : relativeTime(tried, now);
  if (card.kind === 'expired') {
    const expires = user.invite_expires_at;
    return (
      <>
        <p>
          {user.email} tried to sign in {when}, but the invitation expired
          {expires !== null ? ` ${relativeTime(expires, now)}` : ''}.
        </p>
        {owner ? (
          <div class="actions">
            <ActionButton
              action={`${base(user)}/resend-invite`}
              csrf={ctx.csrf}
              label="Renew invitation"
              context={`for ${user.email}`}
              tone="primary"
              returnTo="list"
            />
            <MailLink user={user} host={ctx.host} />
            {dismiss}
          </div>
        ) : null}
      </>
    );
  }
  if (card.kind === 'cancelled') {
    return (
      <>
        <p>
          {user.email} tried to sign in {when}, but their invitation was cancelled.
        </p>
        {owner ? (
          <div class="actions">
            <ActionButton
              action={`${base(user)}/reset-login`}
              csrf={ctx.csrf}
              label="Invite again"
              context={user.email}
              tone="primary"
              fields={version(user)}
              returnTo="list"
            />
            {dismiss}
          </div>
        ) : null}
      </>
    );
  }
  const sub = accessUserId(user.last_refused_subject);
  return (
    <>
      <p>
        {user.email} tried {when} with a different sign-in account (Access user ID{' '}
        <code>…{sub.slice(-4)}</code>).
      </p>
      {owner ? (
        <div class="actions">
          <ConfirmDialog
            id={`card-reset-${user.id}`}
            trigger="Reset sign-in…"
            triggerContext={user.email}
            title={`Reset sign-in for ${user.email}?`}
            body={resetBody(user)}
            confirmLabel={`Reset sign-in for ${user.email}`}
            danger
            variant="standalone"
            action={`${base(user)}/reset-login`}
            csrf={ctx.csrf}
            fields={version(user)}
            returnTo="list"
          />
          {dismiss}
        </div>
      ) : null}
    </>
  );
}

/** Roles invited with a plain submit; Owner goes through a dialog. */
const INVITE_ROLES: readonly Exclude<Role, 'owner'>[] = PLAIN_ROLES as Exclude<Role, 'owner'>[];

/** The email pattern of the invite field (A12.8): the server's normalizeEmail decides. */
export const EMAIL_PATTERN = '[^\\s@,;<>"]+@[A-Za-z0-9\\-]+(\\.[A-Za-z0-9\\-]+)+';

/**
 * "Invite someone": the email and one submit per role (the button is the choice). The first
 * submit in tree order is Viewer, so Enter invites with the least privilege; the Owner dialog comes
 * after `</form>` and submits it with `form=`.
 */
export function InviteSection(props: {
  ctx: ViewContext;
  email?: string;
  error?: string | null;
  roleError?: string | null;
  /** The row of an email that is already a user who signed in: its own action is offered. */
  existing?: UserListEntry | null;
  emailExample: string;
  joinPolicy: string;
}) {
  const { ctx } = props;
  const owner: ConfirmDialogProps = {
    id: 'invite-owner',
    trigger: 'Owner…',
    title: 'Invite as Owner?',
    body: `Owner: ${ROLE_INFO.owner.description}`,
    confirmLabel: 'Invite as Owner',
    variant: 'submits',
    formId: 'invite-form',
    name: 'role',
    value: 'owner',
    formnovalidate: true,
  };
  return (
    <section id="invite" aria-labelledby="invite-h">
      <h2 id="invite-h">Invite someone</h2>
      <PostForm action={paths.users()} csrf={ctx.csrf} id="invite-form" class="stack">
        <Field
          name="email"
          label="Email address"
          type="email"
          value={props.email}
          required
          maxlength={254}
          autocomplete="off"
          spellcheck={false}
          autocapitalize="none"
          enterkeyhint="send"
          pattern={EMAIL_PATTERN}
          example={props.emailExample}
          hint="The email of their Cloudflare Access account. Press Enter to invite as Viewer. Nothing is sent: you get a link to email them."
          error={props.error}
        />
        {props.existing ? (
          <div class="actions">
            <a href={paths.users({ hash: `user-${props.existing.id}` })}>
              Go to {props.existing.email}
            </a>
            <StateButton user={props.existing} ctx={ctx} returnTo="list" />
          </div>
        ) : null}
        <fieldset class="submits" id="f-role" data-invalid={props.roleError ? 'true' : undefined}>
          <legend>Invite as</legend>
          {props.roleError ? (
            <p class="field-error">
              <span class="vh">Error:</span> {props.roleError}
            </p>
          ) : null}
          <div class="actions role-cards">
            {INVITE_ROLES.map((role) => (
              <span class="submit-option">
                <button
                  type="submit"
                  name="role"
                  value={role}
                  class="secondary"
                  aria-describedby={`invite-${role}-desc`}
                >
                  {ROLE_INFO[role].label}
                </button>
                <span class="hint" id={`invite-${role}-desc`}>
                  {ROLE_INFO[role].description}
                </span>
              </span>
            ))}
            <span class="submit-option">
              <Opener dialog="invite-owner">
                Owner<span aria-hidden="true">…</span>
              </Opener>
              <span class="hint">{ROLE_INFO.owner.description}</span>
            </span>
          </div>
        </fieldset>
      </PostForm>
      <ConfirmBox {...owner} />
      <details id="compare-roles">
        <summary>Compare roles</summary>
        <CompareRoles />
      </details>
    </section>
  );
}

const CAPABILITIES: ReadonlyArray<{ text: string; roles: readonly Role[] }> = [
  {
    text: 'See every page (no secrets)',
    roles: ['viewer', 'token_manager', 'access_manager', 'admin', 'owner'],
  },
  {
    text: 'Add, rotate, test, disable and delete service tokens',
    roles: ['token_manager', 'admin', 'owner'],
  },
  { text: 'Add and change service consumers', roles: ['access_manager', 'admin', 'owner'] },
  { text: 'Create and change consumer access', roles: ['access_manager', 'admin', 'owner'] },
  { text: 'Download the configuration export', roles: ['admin', 'owner'] },
  { text: 'People, roles, sign-in policy, admin hosts', roles: ['owner'] },
  { text: 'Allowed hosts, data retention, re-encrypt secrets', roles: ['owner'] },
];

export function CompareRoles() {
  return (
    <DataTable
      id="roles"
      caption="What each role can do"
      rowHeader="capability"
      rows={CAPABILITIES}
      columns={[
        { key: 'capability', header: 'Capability', render: (row) => row.text },
        ...ROLE_ORDER.map((role) => ({
          key: role,
          header: ROLE_INFO[role].label,
          render: (row: (typeof CAPABILITIES)[number]) => (row.roles.includes(role) ? 'Yes' : 'No'),
        })),
      ]}
    />
  );
}
