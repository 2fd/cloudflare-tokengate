// Admin pages: users. Everyone can see who has access; only owners invite people, change roles or
// statuses, reset logins and end sessions (I-RBAC-1). Mutations go through ops/users.ts, which
// ends sessions on access changes (I-SESS-1) and keeps an active owner (I-OWNER-1).
import type { App } from '../../app';
import { type Config, canonicalOrigin, parseConfig } from '../../config';
import type { Role, User } from '../../db/types';
import { INVITE_TTL_MS, listUsers, type UserListEntry } from '../../db/users';
import { can } from '../auth/rbac';
import type { OpFailure } from '../ops/shared';
import { inviteUser, resendInvite, resetLogin, revokeSessions, updateUser } from '../ops/users';
import {
  type AdminContext,
  adminActor,
  type FormFields,
  formData,
  redirectWithNotice,
  renderPage,
} from '../render';
import { Badge, Csrf, Field, Messages, Select } from '../views/components';
import { formatTime, loginProviderNames } from '../views/format';
import type { Banner } from '../views/layout';

const SECTION = '/admin/users';
const INVITE_DAYS = Math.round(INVITE_TTL_MS / 86_400_000);

const NOTICES = {
  invited: (providers: string) =>
    `Invitation created. Ask the person to open the sign-in page and sign in with ${providers} using the invited email address within ${INVITE_DAYS} days.`,
  updated: () =>
    'User updated. Their sessions were ended, so the change applies the next time they sign in.',
  unchanged: () => 'Nothing changed: the user already has that role and status.',
  reset: (providers: string) =>
    `Login reset. Their sign-in accounts were unlinked and their sessions ended. They can sign in again with ${providers} using their email address within ${INVITE_DAYS} days.`,
  revoked: () => 'Sessions ended. The user must sign in again.',
  resent: () => `Invitation renewed for another ${INVITE_DAYS} days.`,
} as const;
type NoticeKey = keyof typeof NOTICES;

const ROLE_OPTIONS: Array<{ value: Role; label: string }> = [
  { value: 'viewer', label: 'Viewer: can look at everything, change nothing' },
  { value: 'admin', label: 'Admin: manages services, caller providers and grants' },
  { value: 'owner', label: 'Owner: everything, plus users, settings and keys' },
];

const ROLE_NAMES: Record<Role, string> = { viewer: 'Viewer', admin: 'Admin', owner: 'Owner' };

interface InviteValues {
  email: string;
  role: string;
}

export function registerUsersRoutes(app: App): void {
  app.get('/admin/users', (c) => usersPage(c, { notice: noticeKey(c.req.query('notice')) }));

  app.post('/admin/users', async (c) => {
    const form = await formData(c);
    const values: InviteValues = {
      email: text(form, 'email') ?? '',
      role: text(form, 'role') ?? '',
    };
    const result = await inviteUser(c.get('deps'), adminActor(c), {
      email: values.email,
      role: values.role as Role,
    });
    if (!result.ok) return failurePage(c, result, values);
    return redirectWithNotice(c, SECTION, 'invited');
  });

  app.post('/admin/users/:id', async (c) => {
    const form = await formData(c);
    const role = text(form, 'role');
    const status = text(form, 'status');
    const result = await updateUser(c.get('deps'), adminActor(c), c.req.param('id'), {
      ...(role === undefined ? {} : { role: role as Role }),
      ...(status === undefined ? {} : { status: status as 'active' | 'disabled' }),
    });
    if (!result.ok) return failurePage(c, result);
    return redirectWithNotice(c, SECTION, result.changed ? 'updated' : 'unchanged');
  });

  app.post('/admin/users/:id/reset-login', async (c) => {
    const result = await resetLogin(c.get('deps'), adminActor(c), c.req.param('id'));
    if (!result.ok) return failurePage(c, result);
    return redirectWithNotice(c, SECTION, 'reset');
  });

  app.post('/admin/users/:id/resend-invite', async (c) => {
    const result = await resendInvite(c.get('deps'), adminActor(c), c.req.param('id'));
    if (!result.ok) return failurePage(c, result);
    return redirectWithNotice(c, SECTION, 'resent');
  });

  app.post('/admin/users/:id/revoke-sessions', async (c) => {
    const result = await revokeSessions(c.get('deps'), adminActor(c), c.req.param('id'));
    if (!result.ok) return failurePage(c, result);
    return redirectWithNotice(c, SECTION, 'revoked');
  });
}

function failurePage(c: AdminContext, failure: OpFailure, invite?: InviteValues) {
  const status = failure.reason === 'not_found' ? 404 : failure.reason === 'conflict' ? 409 : 400;
  return usersPage(c, { errors: failure.errors, invite, status });
}

async function usersPage(
  c: AdminContext,
  options: {
    notice?: NoticeKey | null;
    errors?: string[];
    invite?: InviteValues;
    status?: 400 | 404 | 409;
  },
) {
  const deps = c.get('deps');
  const viewer = c.get('viewer');
  const config = parseConfig(deps.env);
  const users = await listUsers(deps.env.DB);
  const now = deps.now();
  const providers = loginProviderNames(config);
  const providerText = providers.length > 0 ? joinOr(providers) : 'a configured login provider';
  const isOwner = can(viewer.user.role, 'users:write');
  const activeOwners = users.filter((u) => u.role === 'owner' && u.status === 'active');

  const banners: Banner[] = [];
  if (activeOwners.length === 1) {
    banners.push({
      level: 'warning',
      text: `Only one active owner (${activeOwners[0]?.email}). If that person loses access, recovering the deployment requires editing the database by hand (docs/operations/break-glass.md). Invite a second owner.`,
    });
  }

  return renderPage(
    c,
    {
      title: 'Users',
      section: SECTION,
      banners,
      notice: options.notice ? NOTICES[options.notice](providerText) : null,
      status: options.status,
    },
    <>
      <p>
        People who can sign in to this admin console. Callers (CI jobs) are not users: they are
        authorized by <a href="/admin/grants">grants</a>.
      </p>
      <Messages errors={options.errors} />
      <UsersTable
        users={users}
        viewer={viewer.user}
        csrf={viewer.csrfToken}
        isOwner={isOwner}
        now={now}
      />
      {users.length === 1 && isOwner ? (
        <p class="empty">
          You are the only user. Invite a second owner below, so the deployment stays manageable if
          you lose access to your account.
        </p>
      ) : null}
      {isOwner ? <ActionsHelp /> : null}

      <h2>Roles</h2>
      <dl class="details">
        <dt>Viewer</dt>
        <dd>Can see every page (no page ever shows a secret). Cannot change anything.</dd>
        <dt>Admin</dt>
        <dd>
          Viewer, plus: create and change services, credentials, caller providers and grants, and
          download the configuration export.
        </dd>
        <dt>Owner</dt>
        <dd>Admin, plus: manage users, change settings and re-encrypt credentials.</dd>
      </dl>

      <h2>Invite a user</h2>
      {isOwner ? (
        <InviteForm
          csrf={viewer.csrfToken}
          values={options.invite}
          config={config}
          providerText={providerText}
          loginUrl={`${canonicalOrigin(config, new URL(c.req.url))}/auth/login`}
        />
      ) : (
        <p class="muted">Only owners can invite users or change their access.</p>
      )}
    </>,
  );
}

function UsersTable(props: {
  users: UserListEntry[];
  viewer: User;
  csrf: string;
  isOwner: boolean;
  now: number;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">User</th>
          <th scope="col">Role</th>
          <th scope="col">Status</th>
          <th scope="col">Last sign-in</th>
          <th scope="col">Linked sign-in accounts</th>
          {props.isOwner ? <th scope="col">Actions</th> : null}
        </tr>
      </thead>
      <tbody>
        {props.users.map((user) => (
          <tr>
            <td>
              {user.email}
              {user.name ? <div class="muted">{user.name}</div> : null}
              <div>
                <code>{user.id}</code>
              </div>
            </td>
            <td>{ROLE_NAMES[user.role] ?? user.role}</td>
            <td>
              <StatusCell user={user} now={props.now} />
            </td>
            <td>{user.last_login_at === null ? 'never' : formatTime(user.last_login_at)}</td>
            <td>{user.identity_count}</td>
            {props.isOwner ? (
              <td>
                {user.id === props.viewer.id ? (
                  <span class="muted">This is you. Another owner can change your account.</span>
                ) : (
                  <UserActions user={user} csrf={props.csrf} />
                )}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusCell(props: { user: User; now: number }) {
  const { user } = props;
  if (user.status === 'active') return <Badge tone="ok">active</Badge>;
  if (user.status === 'disabled') return <Badge tone="muted">disabled</Badge>;
  const expires = user.invite_expires_at;
  const expired = expires === null || expires <= props.now;
  return (
    <>
      <Badge tone={expired ? 'bad' : 'warn'}>{expired ? 'invitation expired' : 'invited'}</Badge>
      <div class="muted">
        {expired ? 'Expired' : 'Expires'} {formatTime(expires)}
      </div>
    </>
  );
}

function UserActions(props: { user: UserListEntry; csrf: string }) {
  const { user, csrf } = props;
  const base = `/admin/users/${encodeURIComponent(user.id)}`;
  return (
    <div class="user-actions">
      <form method="post" action={base} class="inline">
        <Csrf token={csrf} />
        <select name="role" aria-label={`Role for ${user.email}`}>
          {ROLE_OPTIONS.map((option) => (
            <option value={option.value} selected={option.value === user.role}>
              {ROLE_NAMES[option.value]}
            </option>
          ))}
        </select>{' '}
        <button type="submit" class="secondary" aria-label={`Change role of ${user.email}`}>
          Change role
        </button>
      </form>
      {user.status === 'invited' ? (
        <RowAction
          action={`${base}/resend-invite`}
          csrf={csrf}
          label="Resend invitation"
          email={user.email}
        />
      ) : null}
      {user.status === 'active' ? (
        <RowAction
          action={`${base}/revoke-sessions`}
          csrf={csrf}
          label="End sessions"
          email={user.email}
        />
      ) : null}
      {user.status === 'disabled' && user.identity_count > 0 ? (
        <RowAction
          action={base}
          csrf={csrf}
          label="Enable"
          email={user.email}
          fields={{ status: 'active' }}
        />
      ) : null}
      {user.status !== 'invited' ? (
        <RowAction
          action={`${base}/reset-login`}
          csrf={csrf}
          label={user.identity_count === 0 ? 'Invite again' : 'Reset login'}
          email={user.email}
          danger={user.identity_count > 0}
        />
      ) : null}
      {user.status !== 'disabled' ? (
        <RowAction
          action={base}
          csrf={csrf}
          label={user.status === 'invited' ? 'Cancel invitation' : 'Disable'}
          email={user.email}
          fields={{ status: 'disabled' }}
          danger
        />
      ) : null}
    </div>
  );
}

/** Plain-language effect of each row action; there is no confirmation step (no client JS). */
function ActionsHelp() {
  return (
    <>
      <h2>What the actions do</h2>
      <dl class="details">
        <dt>Change role</dt>
        <dd>
          Gives the user the selected role. Their sessions end, so the new role applies when they
          sign in again.
        </dd>
        <dt>End sessions</dt>
        <dd>
          Signs the user out on every device, for example after a lost laptop. They can sign in
          again right away.
        </dd>
        <dt>Disable or Cancel invitation</dt>
        <dd>
          Blocks all sign-ins and ends their sessions. Linked sign-in accounts are kept, so "Enable"
          restores access later.
        </dd>
        <dt>Reset login</dt>
        <dd>
          Unlinks their sign-in accounts (for example after they lost access to their GitHub
          account), ends their sessions and invites them again for {INVITE_DAYS} days with the same
          role. They regain access by signing in with their email address.
        </dd>
        <dt>Resend invitation or Invite again</dt>
        <dd>
          Makes the invitation valid for another {INVITE_DAYS} days. Nothing is emailed: tell the
          person yourself.
        </dd>
      </dl>
    </>
  );
}

/** One-button POST form whose accessible name includes the user it acts on. */
function RowAction(props: {
  action: string;
  csrf: string;
  label: string;
  email: string;
  danger?: boolean;
  fields?: Record<string, string>;
}) {
  return (
    <form method="post" action={props.action} class="inline">
      <Csrf token={props.csrf} />
      {Object.entries(props.fields ?? {}).map(([name, value]) => (
        <input type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        class={props.danger ? 'danger' : 'secondary'}
        aria-label={`${props.label}: ${props.email}`}
      >
        {props.label}
      </button>
    </form>
  );
}

function InviteForm(props: {
  csrf: string;
  values?: InviteValues;
  config: Config;
  providerText: string;
  loginUrl: string;
}) {
  const noLogin =
    !props.config.login.github && !props.config.login.oidc && !props.config.login.access;
  return (
    <form method="post" action={SECTION} class="stack">
      <Csrf token={props.csrf} />
      {noLogin ? (
        <p class="banner warning">
          No login provider is configured, so invited people cannot sign in yet. See{' '}
          <code>docs/configuration.md</code> to set up GitHub, Google, single sign-on or Cloudflare
          Access.
        </p>
      ) : null}
      <Field
        label="Email address"
        name="email"
        type="email"
        value={props.values?.email}
        required
        autocomplete="off"
        placeholder="alex@example.com"
        hint={`The address the person signs in with. It must be a verified email address of their ${props.providerText} account.`}
      />
      <Select
        label="Role"
        name="role"
        value={props.values?.role || 'viewer'}
        options={ROLE_OPTIONS}
        hint="Start with the smallest role that lets them do their work; you can change it later."
      />
      <p class="muted">
        The invitation is valid for {INVITE_DAYS} days. Nothing is emailed; send them the sign-in
        page address yourself: <code>{props.loginUrl}</code>
      </p>
      <div class="actions">
        <button type="submit">Invite</button>
      </div>
    </form>
  );
}

function joinOr(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

function noticeKey(raw: string | undefined): NoticeKey | null {
  return raw !== undefined && Object.hasOwn(NOTICES, raw) ? (raw as NoticeKey) : null;
}

/** Single-valued form field; repeated fields are treated as absent. */
function text(form: FormFields, name: string): string | undefined {
  const value = form[name];
  return typeof value === 'string' ? value : undefined;
}
