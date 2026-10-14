// Admin pages: users. Everyone can see who has access; only owners invite people, approve or reject
// pending sign-ins, change roles or statuses, reset logins and set the join defaults (I-RBAC-1). Mutations go through ops/users.ts, which keeps an active
// owner (I-OWNER-1); every admin request re-reads the user, so changes apply at once (I-SESS-1).
import type { App } from '../../app';
import { type Config, parseConfig } from '../../config';
import { getJoinDefaults, JOIN_ROLES, JOIN_STATUSES, type JoinDefaults } from '../../db/settings';
import type { Role, User } from '../../db/types';
import { INVITE_TTL_MS, listUsers, type UserListEntry } from '../../db/users';
import { can } from '../auth/rbac';
import type { OpFailure } from '../ops/shared';
import {
  decidePending,
  inviteUser,
  resendInvite,
  resetLogin,
  type SettableStatus,
  updateJoinDefaults,
  updateUser,
} from '../ops/users';
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
    `Invitation created. Ask the person to open the admin console and sign in with ${providers} using the invited email address within ${INVITE_DAYS} days.`,
  updated: () => 'User updated. The change applies to their next request.',
  unchanged: () => 'Nothing changed: the user already has that role and status.',
  reset: (providers: string) =>
    `Login reset. Their sign-in accounts were unlinked. They can sign in again with ${providers} using their email address within ${INVITE_DAYS} days.`,
  resent: () => `Invitation renewed for another ${INVITE_DAYS} days.`,
  approved: () => 'User approved. They can use the admin console from their next request.',
  rejected: () => 'User rejected and suspended. Reactivate them in the list if needed.',
  defaults_saved: () =>
    'Saved. People who sign in for the first time from now on get these values.',
  defaults_unchanged: () => 'Nothing changed: those are the current values for new users.',
} as const;
type NoticeKey = keyof typeof NOTICES;

const ROLE_OPTIONS: Array<{ value: Role; label: string }> = [
  { value: 'viewer', label: 'Viewer: can look at everything, change nothing' },
  { value: 'admin', label: 'Admin: manages services, caller providers and grants' },
  { value: 'owner', label: 'Owner: everything, plus users, settings and keys' },
];

const ROLE_NAMES: Record<Role, string> = { viewer: 'Viewer', admin: 'Admin', owner: 'Owner' };

const STATUS_LABELS: Record<JoinDefaults['status'], string> = {
  active: 'Active: they can use the console right away',
  pending: 'Pending: an owner must approve them first',
  suspended: 'Suspended: no access until an owner activates them',
};

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

  // Registered before /admin/users/:id, which would otherwise match "defaults" as an id.
  app.post('/admin/users/defaults', async (c) => {
    const form = await formData(c);
    const result = await updateJoinDefaults(c.get('deps'), adminActor(c), {
      role: text(form, 'role'),
      status: text(form, 'status'),
    });
    if (!result.ok) return failurePage(c, result);
    return redirectWithNotice(c, SECTION, result.changed ? 'defaults_saved' : 'defaults_unchanged');
  });

  app.post('/admin/users/:id', async (c) => {
    const form = await formData(c);
    const role = text(form, 'role');
    const status = text(form, 'status');
    const result = await updateUser(c.get('deps'), adminActor(c), c.req.param('id'), {
      ...(role === undefined ? {} : { role: role as Role }),
      ...(status === undefined ? {} : { status: status as SettableStatus }),
    });
    if (!result.ok) return failurePage(c, result);
    return redirectWithNotice(c, SECTION, result.changed ? 'updated' : 'unchanged');
  });

  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/admin/users/:id/${decision}`, async (c) => {
      const result = await decidePending(c.get('deps'), adminActor(c), c.req.param('id'), decision);
      if (!result.ok) return failurePage(c, result);
      return redirectWithNotice(c, SECTION, decision === 'approve' ? 'approved' : 'rejected');
    });
  }

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
  const [users, joinDefaults] = await Promise.all([
    listUsers(deps.env.DB),
    getJoinDefaults(deps.env.DB),
  ]);
  const pending = users.filter((u) => u.status === 'pending');
  const listed = users.filter((u) => u.status !== 'pending');
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
      <p class="muted">
        Anyone your Cloudflare Access policy lets in joins on their first sign-in as{' '}
        <strong>
          {joinDefaults.status} {joinDefaults.role}
        </strong>
        . Invite people to give them another role from the start.
      </p>
      <Messages errors={options.errors} />
      <h2>Waiting for approval</h2>
      {pending.length === 0 ? (
        <p class="empty">Nobody is waiting for approval.</p>
      ) : (
        <PendingTable users={pending} csrf={viewer.csrfToken} isOwner={isOwner} />
      )}
      <h2>All users</h2>
      <UsersTable
        users={listed}
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

      <h2>New users</h2>
      {isOwner ? (
        <JoinDefaultsForm csrf={viewer.csrfToken} defaults={joinDefaults} />
      ) : (
        <p class="muted">
          People join as {joinDefaults.status} {joinDefaults.role}. Only owners can change this.
        </p>
      )}

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
          loginUrl={`${new URL(c.req.url).origin}/admin`}
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

function PendingTable(props: { users: UserListEntry[]; csrf: string; isOwner: boolean }) {
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">User</th>
          <th scope="col">Role after approval</th>
          <th scope="col">Signed in first</th>
          {props.isOwner ? <th scope="col">Decision</th> : null}
        </tr>
      </thead>
      <tbody>
        {props.users.map((user) => {
          const base = `/admin/users/${encodeURIComponent(user.id)}`;
          return (
            <tr>
              <td>
                {user.email}
                {user.name ? <div class="muted">{user.name}</div> : null}
              </td>
              <td>{ROLE_NAMES[user.role] ?? user.role}</td>
              <td>{formatTime(user.created_at)}</td>
              {props.isOwner ? (
                <td>
                  <div class="user-actions">
                    <RowAction
                      action={`${base}/approve`}
                      csrf={props.csrf}
                      label="Approve"
                      email={user.email}
                    />
                    <RowAction
                      action={`${base}/reject`}
                      csrf={props.csrf}
                      label="Reject"
                      email={user.email}
                      danger
                    />
                  </div>
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StatusCell(props: { user: User; now: number }) {
  const { user } = props;
  if (user.status === 'active') return <Badge tone="ok">active</Badge>;
  if (user.status === 'suspended') return <Badge tone="muted">suspended</Badge>;
  if (user.status === 'pending') return <Badge tone="warn">pending</Badge>;
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
  // Only a user with a linked sign-in can be active (ops/users.ts updateUser).
  const statusEditable = user.status !== 'invited' && user.identity_count > 0;
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
        {statusEditable ? (
          <>
            <select name="status" aria-label={`Status for ${user.email}`}>
              <option value="active" selected={user.status === 'active'}>
                Active
              </option>
              <option value="suspended" selected={user.status === 'suspended'}>
                Suspended
              </option>
            </select>{' '}
          </>
        ) : null}
        <button type="submit" class="secondary" aria-label={`Save ${user.email}`}>
          Save
        </button>
      </form>
      {user.status === 'invited' ? (
        <>
          <RowAction
            action={`${base}/resend-invite`}
            csrf={csrf}
            label="Resend invitation"
            email={user.email}
          />
          <RowAction
            action={base}
            csrf={csrf}
            label="Cancel invitation"
            email={user.email}
            fields={{ status: 'suspended' }}
            danger
          />
        </>
      ) : (
        <RowAction
          action={`${base}/reset-login`}
          csrf={csrf}
          label={user.identity_count === 0 ? 'Invite again' : 'Reset login'}
          email={user.email}
          danger={user.identity_count > 0}
        />
      )}
    </div>
  );
}

function JoinDefaultsForm(props: { csrf: string; defaults: JoinDefaults }) {
  return (
    <form method="post" action={`${SECTION}/defaults`} class="stack">
      <Csrf token={props.csrf} />
      <p>
        What people get on their first sign-in, when they were not invited. The first owner is
        always created as an active owner.
      </p>
      <Select
        label="Role"
        name="role"
        value={props.defaults.role}
        options={JOIN_ROLES.map((role) => ({
          value: role,
          label: ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role,
        }))}
      />
      <Select
        label="Status"
        name="status"
        value={props.defaults.status}
        options={JOIN_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] }))}
      />
      <div class="actions">
        <button type="submit">Save</button>
      </div>
    </form>
  );
}

/** Plain-language effect of each row action; there is no confirmation step (no client JS). */
function ActionsHelp() {
  return (
    <>
      <h2>What the actions do</h2>
      <dl class="details">
        <dt>Approve or Reject</dt>
        <dd>
          Approve makes a pending user active. Reject suspends them, so they do not come back as
          pending on their next sign-in.
        </dd>
        <dt>Save (role and status)</dt>
        <dd>
          Applies the selected role and status from their next request on. Suspended users keep
          their linked sign-in accounts, so making them active again restores access. To also end
          their Cloudflare Access session, revoke it in Zero Trust.
        </dd>
        <dt>Cancel invitation</dt>
        <dd>Suspends an invitation that nobody used yet. "Invite again" reopens it.</dd>
        <dt>Reset login</dt>
        <dd>
          Unlinks their sign-in accounts (for example after their identity provider account was
          replaced) and invites them again for {INVITE_DAYS} days with the same role. They regain
          access by signing in with their email address.
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
  const noLogin = !props.config.login.access && !props.config.login.dev;
  return (
    <form method="post" action={SECTION} class="stack">
      <Csrf token={props.csrf} />
      {noLogin ? (
        <p class="banner warning">
          No login provider is configured, so invited people cannot sign in yet. See{' '}
          <code>docs/configuration.md</code> to set up Cloudflare Access.
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
        The invitation is valid for {INVITE_DAYS} days. Nothing is emailed; send them the admin
        console address yourself: <code>{props.loginUrl}</code>
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
