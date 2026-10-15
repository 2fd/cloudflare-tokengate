// Users › People (`/admin/users`) and the Person page (`/admin/users/:id`). Everyone can see who
// has access; only owners invite people, decide on pending sign-ins and refused attempts, change
// roles or statuses, reset sign-ins and cancel invitations (I-RBAC-1). Mutations go through
// ops/users.ts, which keeps an active owner (I-OWNER-1) and never links or re-invites a user who
// signed in (I-LINK-1); every admin request re-reads the user, so changes apply at once (I-SESS-1).
// Result notices are built from the viewer's own audit row (`done`), never from query text.
import type { App } from '../../app';
import { auditCountByActor, auditCountByActorAndCategory, listAuditEvents } from '../../db/audit';
import { getJoinDefaults } from '../../db/settings';
import type { AuditEvent, Role } from '../../db/types';
import {
  getUser,
  getUserEntry,
  listIdentities,
  listUsers,
  listUsersFiltered,
  refusedAttemptOpen,
  type UserFilter,
  type UserIdentity,
  type UserListEntry,
} from '../../db/users';
import { type NoticeContext, type NoticeTable, loadDone, resolveNotice } from '../notice';
import { type FieldError, fieldError, type OpFailure } from '../ops/shared';
import {
  decidePending,
  deleteUser,
  dismissRefusedAttempt,
  inviteUser,
  JOIN_POLICY_LABELS,
  joinPolicyOf,
  resendInvite,
  resetLogin,
  type SettableStatus,
  updateUser,
} from '../ops/users';
import { type AuditCategory, paths, returnPath } from '../paths';
import {
  type AdminContext,
  adminActor,
  type FormFields,
  formData,
  redirectWithNotice,
  renderPage,
  submittedVersion,
  type ViewContext,
} from '../render';
import {
  ActionButton,
  ApproveForm,
  DataTable,
  Field,
  NotFound,
  StatusBadge,
  Time,
} from '../views/components';
import { formatTime, relativeTime } from '../views/format';
import { ROLE_INFO, ROLE_ORDER, roleLabel } from '../views/roles';
import {
  accessUserId,
  type DecisionCard,
  DecisionCards,
  decisionKind,
  DismissError,
  InviteSection,
  PersonChange,
  signInMailto,
  StateButton,
  StatusCell,
  type UserReturn,
  userStatus,
} from '../views/users';

const DAY_MS = 86_400_000;
const CHANGES_WINDOW_MS = 30 * DAY_MS;
/** Above this many people the list gets a search field; below, the chips and Ctrl-F do. */
const SEARCH_THRESHOLD = 20;
const Q_MAX = 254;
const STATUS_FILTERS = ['active', 'invited', 'expired', 'suspended'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

interface UsersNoticeData {
  users: ReadonlyMap<string, UserListEntry>;
  host: string;
  /** The page the notice is on, for the Undo form. */
  back: UserReturn;
}

type Ctx = NoticeContext & UsersNoticeData;

/** The row the notice is about, now; null when it is gone. */
function subject(ctx: Ctx): UserListEntry | null {
  const id = ctx.done?.target_id;
  return id ? (ctx.users.get(id) ?? null) : null;
}

function emailOf(ctx: Ctx): string | null {
  const user = subject(ctx);
  if (user) return user.email;
  const before = ctx.done?.diff?.before as { email?: unknown } | undefined;
  return typeof before?.email === 'string' ? before.email : null;
}

function rolePair(event: AuditEvent | null): {
  before: { role?: Role; status?: string };
  after: { role?: Role; status?: string };
} {
  const diff = event?.diff ?? {};
  return {
    before: (diff.before ?? {}) as { role?: Role; status?: string },
    after: (diff.after ?? {}) as { role?: Role; status?: string },
  };
}

function doneOf(ctx: Ctx, ...actions: string[]): AuditEvent | null {
  return ctx.done && actions.includes(ctx.done.action) ? ctx.done : null;
}

const NOTICES: NoticeTable<Ctx> = {
  invited: (ctx) => {
    const event = doneOf(ctx, 'user.invite');
    const user = subject(ctx);
    if (!event || !user) return { text: 'Invitation saved. Nothing was sent.' };
    const again = event.diff?.before !== undefined ? ' again' : '';
    const until =
      user.invite_expires_at === null ? '' : ` until ${formatTime(user.invite_expires_at)}`;
    return {
      text: `Invited ${user.email}${again} as ${roleLabel(user.role)}${until}. Nothing was sent.`,
      next: {
        href: signInMailto(user, ctx.host, ctx.view.now),
        label: `Email ${user.email} the sign-in link`,
      },
    };
  },
  updated: (ctx) => {
    const event = doneOf(ctx, 'user.update');
    const user = subject(ctx);
    if (!event || !user) return { text: 'Saved. The change applies to their next request.' };
    const { before, after } = rolePair(event);
    let text: string;
    if (before.role !== after.role && after.role && before.role) {
      text = `Made ${user.email} ${roleLabel(after.role)} (was ${roleLabel(before.role)}).`;
    } else if (after.status === 'suspended') {
      text = `Suspended ${user.email}. Their Access session stays valid, but tokengate refuses every request they make.`;
    } else {
      text = `Reactivated ${user.email}. They can use the console from their next request.`;
    }
    // Undo only while the row is still what this change made, and never for owner transitions.
    const unchanged = user.role === after.role && user.status === after.status;
    const ownerInvolved = before.role === 'owner' || after.role === 'owner';
    const undoable = before.status === 'active' || before.status === 'suspended';
    if (!unchanged || ownerInvolved || !undoable || !before.role || !before.status) return { text };
    const field: Record<string, string> =
      before.role !== after.role ? { role: before.role } : { status: before.status };
    return {
      text,
      undo: {
        action: paths.user(user.id),
        label: 'Undo',
        fields: { ...field, expected_updated_at: String(user.updated_at), _return: ctx.back },
      },
    };
  },
  unchanged: () => ({ text: 'Nothing changed: they already have that role and status.' }),
  approved: (ctx) => {
    const user = doneOf(ctx, 'user.approve') ? subject(ctx) : null;
    return {
      text: user
        ? `Approved ${user.email} as ${roleLabel(user.role)}. They can use the console from their next request.`
        : 'Approved. They can use the console from their next request.',
    };
  },
  rejected: (ctx) => {
    const user = doneOf(ctx, 'user.reject') ? subject(ctx) : null;
    return {
      text: `Rejected ${user ? user.email : 'the sign-in'}. They are suspended; Reactivate lets them in later.`,
    };
  },
  reset: (ctx) => {
    const user = doneOf(ctx, 'user.reset_login') ? subject(ctx) : null;
    if (!user) return { text: 'Sign-in reset. Their next sign-in links their account again.' };
    return {
      text: `Reset the sign-in of ${user.email}. The next sign-in through Access with ${user.email} links the account again. Nothing was sent.`,
      next: {
        href: signInMailto(user, ctx.host, ctx.view.now),
        label: `Email ${user.email} the sign-in link`,
      },
    };
  },
  resent: (ctx) => {
    const user = doneOf(ctx, 'user.resend_invite') ? subject(ctx) : null;
    if (!user) return { text: 'Invitation renewed. Nothing was sent.' };
    return {
      text: `Renewed the invitation of ${user.email}. Nothing was sent.`,
      next: {
        href: signInMailto(user, ctx.host, ctx.view.now),
        label: `Email ${user.email} the sign-in link`,
      },
    };
  },
  deleted: (ctx) => {
    const email = doneOf(ctx, 'user.delete') ? emailOf(ctx) : null;
    return { text: `Deleted ${email ?? 'the invitation'}. Nobody signed in with it.` };
  },
  dismissed: (ctx) => {
    const email = doneOf(ctx, 'user.dismiss_attempt') ? emailOf(ctx) : null;
    return { text: `Dismissed the refused sign-in${email ? ` of ${email}` : ''}.` };
  },
};

interface InviteValues {
  email: string;
  error?: string | null;
  roleError?: string | null;
  existingId?: string;
}

/** A failed row action. `dismiss` errors show at the Dismiss button, others at "Change". */
interface RowError {
  userId: string;
  message: string;
  target?: 'dismiss';
}

interface PageOptions {
  errors?: FieldError[];
  /** The row a failed row action belongs to, and its message. */
  rowError?: RowError;
  invite?: InviteValues;
  status?: 400 | 404 | 409 | 422;
}

export function registerUsersRoutes(app: App): void {
  app.get('/admin/users', (c) => peoplePage(c, {}));

  app.post('/admin/users', async (c) => {
    const form = await formData(c);
    const email = text(form, 'email') ?? '';
    const result = await inviteUser(c.get('deps'), adminActor(c), {
      email,
      role: text(form, 'role'),
    });
    if (!result.ok) {
      const fields = result.fieldErrors ?? [];
      return peoplePage(c, {
        errors: fields.length > 0 ? fields : result.errors.map((m) => fieldError(null, m)),
        invite: {
          email,
          error: fields.find((e) => e.field === 'email')?.message ?? null,
          roleError: fields.find((e) => e.field === 'role')?.message ?? null,
          existingId: result.existingUserId,
        },
        status: statusOf(result),
      });
    }
    return redirectWithNotice(c, paths.users(), 'invited', {
      done: result.auditId,
      fragment: `user-${result.user.id}`,
    });
  });

  app.get('/admin/users/:id', (c) => personPage(c, c.req.param('id'), {}));

  app.post('/admin/users/:id', async (c) => {
    const id = c.req.param('id');
    const form = await formData(c);
    const back = returnOf(form);
    const role = text(form, 'role');
    const status = text(form, 'status');
    const deps = c.get('deps');
    // Suspending another owner is confirmed in a dialog (an owner acting on an owner).
    if (status === 'suspended' && id !== c.get('viewer').user.id && text(form, 'confirm') !== '1') {
      const target = await getUser(deps.env.DB, id);
      if (target?.role === 'owner' && target.status === 'active') {
        return rowFailure(c, back, id, {
          reason: 'confirmation_required',
          errors: [`Confirm suspending the owner ${target.email} in the dialog.`],
        });
      }
    }
    const result = await updateUser(deps, adminActor(c), id, {
      ...(role === undefined ? {} : { role: role as Role }),
      ...(status === undefined ? {} : { status: status as SettableStatus }),
      expectedUpdatedAt: submittedVersion(text(form, 'expected_updated_at')),
    });
    if (!result.ok) return rowFailure(c, back, id, result);
    if (!result.changed) return redirectWithNotice(c, backPath(back, id), 'unchanged');
    return redirectWithNotice(c, backPath(back, id), 'updated', {
      done: result.auditId ?? undefined,
      fragment: back === 'list' ? `user-${id}` : undefined,
    });
  });

  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/admin/users/:id/${decision}`, async (c) => {
      const id = c.req.param('id');
      const form = await formData(c);
      const result = await decidePending(
        c.get('deps'),
        adminActor(c),
        id,
        decision,
        decision === 'approve' ? text(form, 'role') : undefined,
      );
      if (!result.ok) return rowFailure(c, 'list', id, result);
      const back = returnPath(`POST /admin/users/:id/${decision}`, form._return);
      return redirectWithNotice(c, back, decision === 'approve' ? 'approved' : 'rejected', {
        done: result.auditId ?? undefined,
        fragment: back === paths.users() ? `user-${id}` : undefined,
      });
    });
  }

  app.post('/admin/users/:id/reset-login', async (c) => {
    const id = c.req.param('id');
    const form = await formData(c);
    const back = returnOf(form);
    const deps = c.get('deps');
    // Removing sign-in accounts cannot be undone, so it is confirmed. Without any, this is
    // "Invite again" and nothing is removed; inviting again as Owner is an escalation, so that
    // is confirmed too (the stored role is kept).
    const target = await getUserEntry(deps.env.DB, id);
    if (target && text(form, 'confirm') !== '1') {
      if (target.identity_count > 0) {
        return rowFailure(c, back, id, {
          reason: 'confirmation_required',
          errors: [
            `Confirm the reset of ${target.email} in the dialog: it removes their sign-in accounts.`,
          ],
        });
      }
      if (target.role === 'owner') {
        return rowFailure(c, back, id, {
          reason: 'confirmation_required',
          errors: [`Confirm inviting ${target.email} again as Owner in the dialog.`],
        });
      }
    }
    const result = await resetLogin(
      deps,
      adminActor(c),
      id,
      submittedVersion(text(form, 'expected_updated_at')),
    );
    if (!result.ok) return rowFailure(c, back, id, result);
    return redirectWithNotice(c, backPath(back, id), 'reset', {
      done: result.auditId ?? undefined,
      fragment: back === 'list' ? `user-${id}` : undefined,
    });
  });

  app.post('/admin/users/:id/resend-invite', async (c) => {
    const id = c.req.param('id');
    const form = await formData(c);
    const back = returnOf(form);
    const result = await resendInvite(c.get('deps'), adminActor(c), id);
    if (!result.ok) return rowFailure(c, back, id, result);
    return redirectWithNotice(c, backPath(back, id), 'resent', {
      done: result.auditId ?? undefined,
      fragment: back === 'list' ? `user-${id}` : undefined,
    });
  });

  app.post('/admin/users/:id/delete', async (c) => {
    const id = c.req.param('id');
    const form = await formData(c);
    const back = returnOf(form);
    if (text(form, 'confirm') !== '1') {
      return rowFailure(c, back, id, {
        reason: 'confirmation_required',
        errors: ['Confirm in the dialog: deleting a person cannot be undone.'],
      });
    }
    const result = await deleteUser(
      c.get('deps'),
      adminActor(c),
      id,
      submittedVersion(text(form, 'expected_updated_at')),
    );
    if (!result.ok) return rowFailure(c, back, id, result);
    return redirectWithNotice(c, paths.users(), 'deleted', { done: result.auditId ?? undefined });
  });

  app.post('/admin/users/:id/dismiss-attempt', async (c) => {
    const id = c.req.param('id');
    const form = await formData(c);
    const back = returnOf(form);
    const raw = text(form, 'expected_refused_at');
    const result = await dismissRefusedAttempt(
      c.get('deps'),
      adminActor(c),
      id,
      raw === undefined || raw.trim() === '' ? undefined : Number(raw),
    );
    if (!result.ok) return rowFailure(c, back, id, result, 'dismiss');
    return redirectWithNotice(c, backPath(back, id), 'dismissed', {
      done: result.auditId ?? undefined,
      fragment: back === 'list' ? 'decide' : undefined,
    });
  });
}

/** `_return` of a row action: a closed set, never a URL; anything else is the list. */
function returnOf(form: FormFields): UserReturn {
  return form._return === 'detail' ? 'detail' : 'list';
}

function backPath(back: UserReturn, id: string): string {
  return back === 'detail' ? paths.user(id) : paths.users();
}

function statusOf(failure: Pick<OpFailure, 'reason'>): 400 | 404 | 409 | 422 {
  switch (failure.reason) {
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'confirmation_required':
    case 'acknowledgement_required':
      return 422;
    default:
      return 400;
  }
}

/** A failed row action: the same page again, fresh, with the error at that row. */
function rowFailure(
  c: AdminContext,
  back: UserReturn,
  id: string,
  failure: Pick<OpFailure, 'reason' | 'errors'>,
  target?: RowError['target'],
) {
  const message = failure.errors.join(' ');
  const options: PageOptions = {
    rowError: { userId: id, message, ...(target ? { target } : {}) },
    status: statusOf(failure),
  };
  return back === 'detail' ? personPage(c, id, options) : peoplePage(c, options);
}

function parseFilter(c: AdminContext): { filter: UserFilter; qTooLong: boolean } {
  const role = c.req.query('role');
  const status = c.req.query('status');
  const q = (c.req.query('q') ?? '').trim();
  const filter: UserFilter = {};
  if (role !== undefined && (ROLE_ORDER as readonly string[]).includes(role)) {
    filter.role = role as Role;
  }
  if (status !== undefined && (STATUS_FILTERS as readonly string[]).includes(status)) {
    filter.status = status as StatusFilter;
  }
  const qTooLong = q.length > Q_MAX;
  if (q !== '' && !qTooLong) filter.q = q;
  return { filter, qTooLong };
}

/** `alex@<most frequent domain of active people>`, ties alphabetical; else alex@example.com. */
function emailExample(users: readonly UserListEntry[]): string {
  const counts = new Map<string, number>();
  for (const user of users) {
    if (user.status !== 'active') continue;
    const domain = user.email.slice(user.email.lastIndexOf('@') + 1);
    if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  const [best] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return `alex@${best?.[0] ?? 'example.com'}`;
}

function decisionCards(users: readonly UserListEntry[], now: number): DecisionCard[] {
  const pending = users
    .filter((user) => user.status === 'pending')
    .sort((a, b) => a.created_at - b.created_at);
  const refused = users.filter(
    (user) => user.status !== 'pending' && refusedAttemptOpen(user, now),
  );
  return [...pending, ...refused].map((user) => ({ kind: decisionKind(user), user }));
}

async function peoplePage(c: AdminContext, options: PageOptions) {
  const deps = c.get('deps');
  const db = deps.env.DB;
  const viewer = c.get('viewer');
  const now = deps.now();
  const { filter, qTooLong } = parseFilter(c);
  const [all, shown, defaults, changes, done] = await Promise.all([
    listUsers(db),
    listUsersFiltered(db, filter, now),
    getJoinDefaults(db),
    auditCountByActor(db, now - CHANGES_WINDOW_MS),
    options.status
      ? Promise.resolve(null)
      : loadDone(deps, { userId: viewer.user.id }, c.req.query('done')),
  ]);
  const byId = new Map(all.map((user) => [user.id, user]));
  const listed = all.filter((user) => user.status !== 'pending');
  const cards = decisionCards(all, now);
  const policy = JOIN_POLICY_LABELS[joinPolicyOf(defaults)];
  const notice = options.status
    ? null
    : resolveNotice(NOTICES, c.req.query('notice'), done, {
        users: byId,
        host: new URL(c.req.url).hostname,
        back: 'list',
      });
  // The summary links only to an error that is rendered: a failed Dismiss at its card, anything
  // else (or a Dismiss whose card is gone) at the row's "Change"; otherwise a plain item.
  const rowError = options.rowError;
  const ownerViewer = viewer.user.role === 'owner';
  const atCard =
    rowError?.target === 'dismiss' &&
    ownerViewer &&
    cards.some((card) => card.user.id === rowError.userId);
  const atRow =
    rowError !== undefined &&
    !atCard &&
    ownerViewer &&
    shown.some((user) => user.id === rowError.userId);
  const errors =
    options.errors ??
    (rowError
      ? [
          fieldError(
            atCard ? `dismiss-${rowError.userId}` : atRow ? `user-${rowError.userId}` : null,
            rowError.message,
          ),
        ]
      : undefined);
  const filtered =
    filter.role !== undefined || filter.status !== undefined || filter.q !== undefined;

  return renderPage(
    c,
    {
      title: 'People',
      section: 'users',
      subsection: 'people',
      errors,
      notice,
      status: options.status,
    },
    (ctx) => {
      const owner = ctx.can('users:write');
      const activeOwners = all.filter((u) => u.role === 'owner' && u.status === 'active').length;
      const existing = options.invite?.existingId
        ? (byId.get(options.invite.existingId) ?? null)
        : null;
      return (
        <>
          <p>
            People who can sign in to this console, and their{' '}
            <a href={paths.docs('concepts.md#user')}>roles</a>. Workloads that call through the
            gateway are <a href={paths.consumers()}>service consumers</a>, not people.
          </p>
          {owner && activeOwners === 1 ? (
            <div class="callout">
              <p>
                You are the only owner. If you lose access, recovery means editing the database
                (break-glass). <a href={paths.users({ hash: 'invite' })}>Invite a second owner</a>
              </p>
            </div>
          ) : null}
          <DecisionCards cards={cards} ctx={ctx} dismissError={atCard ? rowError : null} />
          {owner ? (
            <InviteSection
              ctx={ctx}
              email={options.invite?.email}
              error={options.invite?.error}
              roleError={options.invite?.roleError}
              existing={existing}
              emailExample={emailExample(all)}
              joinPolicy={policy}
            />
          ) : null}
          <h2 id="people-h">Everyone</h2>
          <FilterNav listed={listed} filter={filter} now={now} />
          {listed.length > SEARCH_THRESHOLD ? (
            <SearchForm filter={filter} listed={listed} qTooLong={qTooLong} />
          ) : null}
          <PeopleTable
            rows={shown}
            total={listed.length}
            ctx={ctx}
            owner={owner}
            changes={changes}
            policy={policy}
            filtered={filtered}
            rowError={atRow ? rowError : undefined}
          />
          <p>
            New people who sign in: <strong>{policy}</strong>.{' '}
            <a href={paths.signIn('policy')}>Change on Sign-in</a>
          </p>
        </>
      );
    },
  );
}

const ROLE_CHIPS: ReadonlyArray<{ role: Role; label: string }> = [
  { role: 'owner', label: 'Owners' },
  { role: 'admin', label: 'Admins' },
  { role: 'access_manager', label: 'Access managers' },
  { role: 'token_manager', label: 'Token managers' },
  { role: 'viewer', label: 'Viewers' },
];

const STATUS_CHIPS: ReadonlyArray<{ status: StatusFilter; label: string }> = [
  { status: 'invited', label: 'Invited' },
  { status: 'expired', label: 'Invitation expired' },
  { status: 'suspended', label: 'Suspended' },
];

function matchesStatus(user: UserListEntry, status: StatusFilter, now: number): boolean {
  if (status === 'expired') {
    return user.status === 'invited' && (user.invite_expires_at ?? 0) <= now;
  }
  if (status === 'invited') {
    return user.status === 'invited' && (user.invite_expires_at ?? 0) > now;
  }
  return user.status === status;
}

/** Who holds which role: link chips that are also the filters (1 load, no submit). */
function FilterNav(props: { listed: readonly UserListEntry[]; filter: UserFilter; now: number }) {
  const { listed, filter, now } = props;
  const q = filter.q;
  const chips: Array<{ href: string; label: string; count: number; current: boolean }> = [
    {
      href: paths.users({ q }),
      label: 'Everyone',
      count: listed.length,
      current: filter.role === undefined && filter.status === undefined,
    },
    ...ROLE_CHIPS.map((chip) => ({
      href: paths.users({ role: chip.role, status: filter.status, q }),
      label: chip.label,
      count: listed.filter((user) => user.role === chip.role).length,
      current: filter.role === chip.role,
    })),
    ...STATUS_CHIPS.map((chip) => ({
      href: paths.users({ role: filter.role, status: chip.status, q }),
      label: chip.label,
      count: listed.filter((user) => matchesStatus(user, chip.status, now)).length,
      current: filter.status === chip.status,
    })),
  ].filter((chip) => chip.count > 0 || chip.current || chip.label === 'Everyone');
  const active = filter.role !== undefined || filter.status !== undefined || q !== undefined;
  return (
    <nav aria-label="Filter people">
      <ul class="chips">
        {chips.map((chip) => (
          <li>
            <a class="chip" href={chip.href} aria-current={chip.current ? 'true' : undefined}>
              {chip.label} <span class="count">{chip.count}</span>
            </a>
          </li>
        ))}
        {active ? (
          <li>
            <a href={paths.users()}>Clear filters</a>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}

function SearchForm(props: {
  filter: UserFilter;
  listed: readonly UserListEntry[];
  qTooLong: boolean;
}) {
  const { filter } = props;
  return (
    <form
      method="get"
      action={paths.users()}
      role="search"
      class="filters"
      aria-label="Search people"
    >
      {filter.role ? <input type="hidden" name="role" value={filter.role} /> : null}
      {filter.status ? <input type="hidden" name="status" value={filter.status} /> : null}
      <Field
        name="q"
        label="Search"
        type="search"
        value={filter.q}
        maxlength={Q_MAX}
        autocomplete="off"
        spellcheck={false}
        example="alex@acme.com"
        hint={
          props.qTooLong
            ? 'Search text too long; showing everyone. Part of an email address or a name.'
            : 'Part of an email address or a name.'
        }
        suggestions={props.listed.map((user) => ({ value: user.email }))}
      />
      <button type="submit" class="secondary">
        Search
      </button>
    </form>
  );
}

function PeopleTable(props: {
  rows: readonly UserListEntry[];
  total: number;
  ctx: ViewContext;
  owner: boolean;
  changes: ReadonlyMap<string, number>;
  policy: string;
  filtered: boolean;
  rowError?: { userId: string; message: string };
}) {
  const { ctx } = props;
  const columns = [
    {
      key: 'person',
      header: 'Person',
      render: (user: UserListEntry) => (
        <>
          <a id={`user-${user.id}`} href={paths.user(user.id)}>
            {user.email}
          </a>
          {user.id === ctx.userId ? (
            <>
              {' '}
              <span class="badge">You</span>
            </>
          ) : null}
          {user.name ? <div class="muted">{user.name}</div> : null}
        </>
      ),
    },
    { key: 'role', header: 'Role', render: (user: UserListEntry) => roleLabel(user.role) },
    {
      key: 'status',
      header: 'Status',
      render: (user: UserListEntry) => <StatusCell user={user} now={ctx.now} />,
    },
    {
      key: 'last',
      header: 'Last sign-in',
      render: (user: UserListEntry) =>
        user.last_login_at === null ? (
          'Never'
        ) : (
          <Time ms={user.last_login_at} relative now={ctx.now} />
        ),
    },
    {
      key: 'changes',
      header: 'Changes',
      render: (user: UserListEntry) => {
        const n = props.changes.get(user.id) ?? 0;
        return n === 0 ? (
          '—'
        ) : (
          <a href={paths.audit({ actor: user.id })}>
            {n} in 30 days<span class="vh"> by {user.email}</span>
          </a>
        );
      },
    },
    ...(props.owner
      ? [
          {
            key: 'actions',
            header: 'Actions',
            render: (user: UserListEntry) =>
              user.id === ctx.userId ? (
                <span class="muted">This is you. Another owner can change your account.</span>
              ) : (
                <div class="row-actions">
                  <StateButton user={user} ctx={ctx} returnTo="list" />
                  <PersonChange
                    user={user}
                    ctx={ctx}
                    returnTo="list"
                    joinPolicy={props.policy}
                    error={props.rowError?.userId === user.id ? props.rowError.message : null}
                  />
                </div>
              ),
          },
        ]
      : []),
  ];
  return (
    <DataTable
      id="people"
      caption={`People (${props.rows.length} shown of ${props.total})`}
      rowHeader="person"
      rows={props.rows}
      columns={columns}
      empty={
        props.filtered ? (
          <p class="empty">
            No people match these filters. <a href={paths.users()}>Clear filters</a>
          </p>
        ) : undefined
      }
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Person page

const CATEGORY_CHIPS: ReadonlyArray<{
  category: Exclude<AuditCategory, 'signins'>;
  one: string;
  many: string;
}> = [
  { category: 'tokens', one: 'token', many: 'tokens' },
  { category: 'consumers', one: 'consumer', many: 'consumers' },
  { category: 'access', one: 'access', many: 'accesses' },
  { category: 'users', one: 'person', many: 'people' },
  { category: 'system', one: 'setting', many: 'settings' },
];

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  access: 'Cloudflare Access',
  dev: 'Local development login',
};

async function personPage(c: AdminContext, id: string, options: PageOptions) {
  const deps = c.get('deps');
  const db = deps.env.DB;
  const viewer = c.get('viewer');
  const now = deps.now();
  const user = await getUserEntry(db, id);
  if (!user) {
    return renderPage(
      c,
      {
        title: 'Person not found',
        section: 'users',
        subsection: 'people',
        breadcrumbs: [{ href: paths.users(), label: 'People' }],
        status: 404,
      },
      () => <NotFound what="user" />,
    );
  }
  const [identities, categories, history, defaults, done] = await Promise.all([
    listIdentities(db, id),
    auditCountByActorAndCategory(db, id, now - CHANGES_WINDOW_MS),
    listAuditEvents(db, { targetType: 'user', targetId: id, limit: 20 }),
    getJoinDefaults(db),
    options.status
      ? Promise.resolve(null)
      : loadDone(deps, { userId: viewer.user.id }, c.req.query('done')),
  ]);
  const policy = JOIN_POLICY_LABELS[joinPolicyOf(defaults)];
  const notice = options.status
    ? null
    : resolveNotice(NOTICES, c.req.query('notice'), done, {
        users: new Map([[user.id, user]]),
        host: new URL(c.req.url).hostname,
        back: 'detail',
      });
  // As on People: link the summary only to an error this page renders. A failed Dismiss shows at
  // the Dismiss button; anything else at "Change", which a pending person (ApproveForm) and the
  // viewer's own page do not have.
  const rowError = options.rowError;
  const ownerViewer = viewer.user.role === 'owner';
  const atDismiss = rowError?.target === 'dismiss' && ownerViewer && user.last_refused_at !== null;
  const atChange =
    rowError !== undefined &&
    !atDismiss &&
    ownerViewer &&
    viewer.user.id !== id &&
    user.status !== 'pending';
  const errors = rowError
    ? [fieldError(atDismiss ? `dismiss-${id}` : atChange ? `user-${id}` : null, rowError.message)]
    : options.errors;
  const status = userStatus(user, now);
  return renderPage(
    c,
    {
      title: user.email,
      section: 'users',
      subsection: 'people',
      breadcrumbs: [
        { href: paths.users(), label: 'People' },
        { href: paths.user(id), label: user.email },
      ],
      errors,
      notice,
      status: options.status,
    },
    (ctx) => {
      const owner = ctx.can('users:write');
      const self = ctx.userId === id;
      return (
        <>
          <p class="status-line">
            {user.name ? <span>{user.name} · </span> : null}
            <StatusBadge status={status.key} detail={status.detail} /> · {roleLabel(user.role)}
          </p>
          <section aria-labelledby="role-h">
            <h2 id="role-h">Role and status</h2>
            <p>
              {roleLabel(user.role)}: {ROLE_INFO[user.role].description}
            </p>
            {self ? (
              <p class="muted">This is you. Another owner can change your account.</p>
            ) : owner && user.status === 'pending' ? (
              <ApproveForm user={user} ctx={ctx} returnTo="list" />
            ) : user.status === 'pending' ? (
              <p>Only owners can decide.</p>
            ) : owner ? (
              <>
                <div class="actions">
                  <StateButton user={user} ctx={ctx} returnTo="detail" />
                </div>
                <PersonChange
                  user={user}
                  ctx={ctx}
                  returnTo="detail"
                  joinPolicy={policy}
                  error={atChange ? rowError.message : null}
                  bare
                />
              </>
            ) : null}
          </section>
          {user.last_refused_at !== null ? (
            <section aria-labelledby="refused-h">
              <h2 id="refused-h">Refused sign-in</h2>
              <p>
                Last refused sign-in {relativeTime(user.last_refused_at, now)} (
                <Time ms={user.last_refused_at} />) with Access user ID{' '}
                <code>{accessUserId(user.last_refused_subject)}</code>.
              </p>
              {atDismiss ? <DismissError userId={id} message={rowError.message} /> : null}
              {owner ? <DismissButton user={user} ctx={ctx} /> : null}
            </section>
          ) : null}
          <section aria-labelledby="accounts-h">
            <h2 id="accounts-h">Sign-in accounts</h2>
            <AccountsTable identities={identities} now={now} />
          </section>
          <section aria-labelledby="changes-h">
            <h2 id="changes-h">Changes by this person (30 days)</h2>
            <ChangeChips id={id} categories={categories} />
            <p>
              <a href={paths.audit({ actor: id })}>All changes by {user.email}</a>
            </p>
          </section>
          <section aria-labelledby="history-h">
            <h2 id="history-h">History of this account</h2>
            <HistoryTable events={history} now={now} />
            <p>
              <a href={paths.audit({ target: id })}>
                Full history<span class="vh"> of {user.email}</span>
              </a>
            </p>
          </section>
        </>
      );
    },
  );
}

function DismissButton(props: { user: UserListEntry; ctx: ViewContext }) {
  const { user, ctx } = props;
  return (
    <ActionButton
      action={`${paths.user(user.id)}/dismiss-attempt`}
      csrf={ctx.csrf}
      label="Dismiss"
      context={`the sign-in attempt of ${user.email}`}
      fields={{ expected_refused_at: String(user.last_refused_at) }}
      returnTo="detail"
    />
  );
}

function AccountsTable(props: { identities: UserIdentity[]; now: number }) {
  return (
    <DataTable
      id="accounts"
      caption="Sign-in accounts"
      captionHidden
      rowHeader="sub"
      rows={props.identities}
      empty={<p class="empty">Never signed in.</p>}
      columns={[
        {
          key: 'provider',
          header: 'Login provider',
          render: (row) => PROVIDER_LABELS[row.login_provider] ?? row.login_provider,
        },
        {
          key: 'sub',
          header: 'Access user ID',
          render: (row) => <code>{accessUserId(row.subject)}</code>,
        },
        { key: 'email', header: 'Email at link time', render: (row) => row.email ?? '—' },
        { key: 'linked', header: 'Linked', render: (row) => <Time ms={row.created_at} /> },
        {
          key: 'used',
          header: 'Last used',
          render: (row) =>
            row.last_used_at === null ? (
              'Never'
            ) : (
              <Time ms={row.last_used_at} relative now={props.now} />
            ),
        },
      ]}
    />
  );
}

function ChangeChips(props: {
  id: string;
  categories: Awaited<ReturnType<typeof auditCountByActorAndCategory>>;
}) {
  const chips = CATEGORY_CHIPS.filter((chip) => props.categories[chip.category] > 0);
  if (chips.length === 0) return <p class="muted">No changes in the last 30 days.</p>;
  return (
    <ul class="chips" aria-label="Changes by category">
      {chips.map((chip) => {
        const n = props.categories[chip.category];
        return (
          <li>
            <a class="chip" href={paths.audit({ actor: props.id, category: chip.category })}>
              {n} {n === 1 ? chip.one : chip.many}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function HistoryTable(props: { events: AuditEvent[]; now: number }) {
  return (
    <DataTable
      id="history"
      caption="History of this account, newest first"
      captionHidden
      rowHeader="when"
      rows={props.events}
      empty={<p class="empty">No events yet.</p>}
      columns={[
        {
          key: 'when',
          header: 'When',
          render: (event) => <Time ms={event.ts} relative now={props.now} />,
        },
        {
          key: 'who',
          header: 'Who',
          render: (event) =>
            event.actor_type === 'system' ? (
              'System'
            ) : event.actor_id ? (
              <a href={paths.audit({ actor: event.actor_id })}>
                {event.actor_email ?? event.actor_id}
              </a>
            ) : (
              (event.actor_email ?? '—')
            ),
        },
        {
          key: 'what',
          header: 'What',
          render: (event) => (
            <>
              {event.summary} <code>{event.action}</code>
            </>
          ),
        },
      ]}
    />
  );
}

/** Single-valued form field; repeated fields are treated as absent. */
function text(form: FormFields, name: string): string | undefined {
  const value = form[name];
  return typeof value === 'string' ? value : undefined;
}
