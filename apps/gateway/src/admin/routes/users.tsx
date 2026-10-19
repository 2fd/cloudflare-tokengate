// Users › People (`/admin/users`) and the Person page (`/admin/users/:id`). Everyone can see who
// has access; only owners invite people, decide on pending sign-ins and refused attempts, change
// roles or statuses, reset sign-ins and cancel invitations (I-RBAC-1). Mutations go through
// ops/users.ts, which keeps an active owner (I-OWNER-1) and never links or re-invites a user who
// signed in (I-LINK-1); every admin request re-reads the user, so changes apply at once (I-SESS-1).
// Result notices are built from the viewer's own audit row (`done`), never from query text.
import {
  Avatar,
  Button,
  Callout,
  Chip,
  Chips,
  DangerRow,
  DangerZone,
  DetailLayout,
  DialogTrigger,
  EmptyState,
  Feed,
  FeedItem,
  FieldError,
  Filters,
  FilterSearch,
  Disclosure,
  Icon,
  IdChip,
  Identity,
  PageHeader,
  Panel,
  QuickLinks,
  RailFoot,
  RailKeyValue,
  type RailKeyValueItem,
  RelationLine,
  Row,
  RowHeader,
  Cell,
  Stack,
  Table,
  Time,
  Tray,
  Badge,
  ActionForm,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
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
import { type FieldError as OpFieldError, fieldError, type OpFailure } from '../ops/shared';
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
import { AskSomeone, NotFound, notFoundText } from '../views/components';
import { relativeTime } from '../views/format';
import { AUDIT_ACTION_TEXT } from '../views/monitoring';
import { ROLE_INFO, ROLE_ORDER, roleLabel } from '../views/roles';
import {
  accessUserId,
  ApproveCards,
  CanList,
  type DecisionCard,
  DecisionTray,
  decisionKind,
  firstName,
  InviteTray,
  PersonDialogs,
  PersonRow,
  RoleCards,
  RoleMap,
  signInMailto,
  StateButton,
  type UserReturn,
  UserBadge,
  userStatus,
  utcTime,
} from '../views/users';

const DAY_MS = 86_400_000;
const CHANGES_WINDOW_MS = 30 * DAY_MS;
/** Above this many people the list gets a search field; below, the chips and Ctrl-F do. */
const SEARCH_THRESHOLD = 20;
const Q_MAX = 254;
const STATUS_FILTERS = ['active', 'invited', 'expired', 'suspended'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
/** A person's own sign-ins are audited, but they are not changes they made. */
const SIGN_IN_ACTIONS: ReadonlySet<string> = new Set(['user.bootstrap', 'user.join', 'user.link']);

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
      user.invite_expires_at === null ? '' : ` until ${utcTime(user.invite_expires_at)}`;
    return {
      text: `Invited ${user.email}${again} as ${roleLabel(user.role)}${until}. Nothing was sent.`,
      more: `Send them https://${ctx.host}/admin. They sign in with Cloudflare Access as ${user.email}.`,
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
    let more: string | undefined;
    const roleChanged = before.role !== after.role && after.role && before.role;
    if (roleChanged && after.role && before.role) {
      text = `Made ${user.email} ${roleLabel(after.role)} (was ${roleLabel(before.role)}).`;
      more = `${roleLabel(after.role)}: ${ROLE_INFO[after.role].description}`;
    } else if (after.status === 'suspended') {
      text = `Suspended ${user.email}. Their Access session stays valid, but tokengate refuses every request they make.`;
    } else {
      text = `Reactivated ${user.email}. They can use the console from their next request.`;
    }
    // Undo only while the row is still what this change made, and never for owner transitions.
    const unchanged = user.role === after.role && user.status === after.status;
    const ownerInvolved = before.role === 'owner' || after.role === 'owner';
    const undoable = before.status === 'active' || before.status === 'suspended';
    if (!unchanged || ownerInvolved || !undoable || !before.role || !before.status) {
      return { text, more };
    }
    const byRole = before.role !== after.role;
    const field: Record<string, string> = byRole
      ? { role: before.role }
      : { status: before.status };
    return {
      text,
      more,
      undo: {
        action: paths.user(user.id),
        label: 'Undo',
        srSuffix: byRole
          ? `: make ${user.email} ${roleLabel(before.role)} again`
          : before.status === 'active'
            ? `: reactivate ${user.email}`
            : `: suspend ${user.email} again`,
        fields: { _return: ctx.back, ...field, expected_updated_at: String(user.updated_at) },
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
  errors?: OpFieldError[];
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

/** The order of roles in People (as in the role map): owners first, then the two duties. */
const ROW_ROLES: readonly Role[] = ['owner', 'admin', 'token_manager', 'access_manager', 'viewer'];

/** Rows of People: active people first, by role, then invitations, then the rest. */
function rowOrder(a: UserListEntry, b: UserListEntry): number {
  const state = (user: UserListEntry) =>
    user.status === 'active' ? 0 : user.status === 'invited' ? 1 : 2;
  return (
    state(a) - state(b) ||
    ROW_ROLES.indexOf(a.role) - ROW_ROLES.indexOf(b.role) ||
    a.email.localeCompare(b.email)
  );
}

/** At most this many invitation rows look up who sent them (one audit query each). */
const INVITERS_MAX = 25;

/** Who sent each open invitation, and when: the newest invite or renewal in the audit log. */
async function invitersOf(
  db: D1Database,
  rows: readonly UserListEntry[],
  byId: ReadonlyMap<string, UserListEntry>,
): Promise<Map<string, { name: string; at: number }>> {
  const invited = rows.filter((user) => user.status === 'invited').slice(0, INVITERS_MAX);
  const found = await Promise.all(
    invited.map(async (user) => {
      const [event] = await listAuditEvents(db, {
        targetType: 'user',
        targetId: user.id,
        actions: { prefixes: [], exact: ['user.invite', 'user.resend_invite'] },
        limit: 1,
      });
      if (!event || event.actor_type !== 'user') return null;
      const actor = event.actor_id ? byId.get(event.actor_id) : undefined;
      const name = actor?.name ?? actor?.email ?? event.actor_email;
      return name ? ([user.id, { name, at: event.ts }] as const) : null;
    }),
  );
  return new Map(found.filter((entry) => entry !== null));
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
  const rows = [...shown].sort(rowOrder);
  const inviters = await invitersOf(db, rows, byId);
  const pendingPeople = all.filter((user) => user.status === 'pending');
  const cards = decisionCards(all, now);
  const policyKey = joinPolicyOf(defaults);
  const policy = JOIN_POLICY_LABELS[policyKey];
  const notice = options.status
    ? null
    : resolveNotice(NOTICES, c.req.query('notice'), done, {
        users: byId,
        host: new URL(c.req.url).hostname,
        back: 'list',
      });
  // The summary links only to an error that is rendered: a failed Dismiss at its card (pending
  // cards have no Dismiss), anything else (or a Dismiss whose card is gone) at the row's
  // "Change"; otherwise a plain item.
  const rowError = options.rowError;
  const ownerViewer = viewer.user.role === 'owner';
  const atCard =
    rowError?.target === 'dismiss' &&
    ownerViewer &&
    cards.some((card) => card.kind !== 'pending' && card.user.id === rowError.userId);
  const atRow =
    rowError !== undefined &&
    !atCard &&
    ownerViewer &&
    rowError.userId !== viewer.user.id &&
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
  const highlight = notice && done?.target_id ? done.target_id : null;

  return renderPage(
    c,
    {
      title: 'People',
      section: 'users',
      subsection: 'people',
      errors,
      notice,
      status: options.status,
      header: (ctx) => (
        <PageHeader
          title="People"
          count={all.length}
          description={
            <>
              Who signs in to this console, and what each person may change.{' '}
              <a href={paths.docs('concepts.md#user')}>How roles work</a>
            </>
          }
          actions={
            ctx.can('users:write') ? (
              <Button variant="primary" plus href={paths.users({ hash: 'invite' })}>
                Invite someone
              </Button>
            ) : undefined
          }
        />
      ),
    },
    (ctx) => {
      const owner = ctx.can('users:write');
      const activeOwners = all.filter((u) => u.role === 'owner' && u.status === 'active').length;
      const existing = options.invite?.existingId
        ? (byId.get(options.invite.existingId) ?? null)
        : null;
      const singleOwner = owner && activeOwners === 1;
      const hasStack = cards.length > 0 || singleOwner;
      return (
        <>
          {owner ? (
            <InviteTray
              ctx={ctx}
              open={options.invite !== undefined}
              email={options.invite?.email}
              error={options.invite?.error}
              roleError={options.invite?.roleError}
              existing={existing}
              emailExample={emailExample(all)}
            />
          ) : null}
          {hasStack ? (
            <Stack>
              <DecisionTray cards={cards} ctx={ctx} dismissError={atCard ? rowError : null} />
              {singleOwner ? (
                <Callout
                  title="You are the only owner."
                  actions={
                    <Button size="sm" href={paths.users({ hash: 'invite' })}>
                      Invite a second owner
                    </Button>
                  }
                >
                  If you lose access, only a break-glass database edit gets you back.
                </Callout>
              ) : null}
            </Stack>
          ) : null}
          <AccountsTray
            all={all}
            listed={listed}
            shown={rows}
            inviters={inviters}
            pendingPeople={pendingPeople}
            filter={filter}
            qTooLong={qTooLong}
            filtered={filtered}
            ctx={ctx}
            owner={owner}
            changes={changes}
            policy={policy}
            policyPending={policyKey === 'pending'}
            highlight={highlight}
            rowError={atRow ? rowError : undefined}
          />
          <Disclosure
            summary="Who can change what"
            hint="Roles and permissions"
            class="u-role-guide"
          >
            <RoleMap listed={listed} selfId={ctx.userId} />
          </Disclosure>
        </>
      );
    },
  );
}

const ROLE_CHIPS: ReadonlyArray<{ role: Role; label: string }> = [
  { role: 'owner', label: 'Owners' },
  { role: 'admin', label: 'Admins' },
  { role: 'access_manager', label: 'Access managers' },
  { role: 'token_manager', label: 'Credential managers' },
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

/** Who holds which role: quick links that are also the filters (1 load, no submit). */
function filterLinks(props: {
  all: readonly UserListEntry[];
  listed: readonly UserListEntry[];
  pending: number;
  filter: UserFilter;
  now: number;
}) {
  const { listed, filter, now } = props;
  const q = filter.q;
  const links: Array<{
    href: string;
    label: string;
    count: number;
    current: boolean;
    tone?: 'warn';
    glyph?: string;
  }> = [
    {
      href: paths.users({ q }),
      label: 'Everyone',
      count: props.all.length,
      current: filter.role === undefined && filter.status === undefined,
    },
    ...ROLE_CHIPS.map((chip) => ({
      href: paths.users({ role: chip.role, status: filter.status, q }),
      label: chip.label,
      count: listed.filter((user) => user.role === chip.role).length,
      current: filter.role === chip.role,
    })),
    // A jump to the decisions, not a filter: pending people have no row.
    ...(props.pending > 0
      ? [
          {
            href: '#decide',
            label: 'Pending',
            count: props.pending,
            current: false,
            tone: 'warn' as const,
            glyph: '◐',
          },
        ]
      : []),
    ...STATUS_CHIPS.map((chip) => ({
      href: paths.users({ role: filter.role, status: chip.status, q }),
      label: chip.label,
      count: listed.filter((user) => matchesStatus(user, chip.status, now)).length,
      current: filter.status === chip.status,
    })),
  ];
  return links.filter((link) => link.count > 0 || link.current || link.label === 'Everyone');
}

/** "Accounts": everyone but the pending people, filterable, with the row controls for owners. */
function AccountsTray(props: {
  all: readonly UserListEntry[];
  listed: readonly UserListEntry[];
  shown: readonly UserListEntry[];
  pendingPeople: readonly UserListEntry[];
  filter: UserFilter;
  qTooLong: boolean;
  filtered: boolean;
  ctx: ViewContext;
  owner: boolean;
  changes: ReadonlyMap<string, number>;
  policy: string;
  policyPending: boolean;
  highlight: string | null;
  rowError?: { userId: string; message: string };
  inviters: ReadonlyMap<string, { name: string; at: number }>;
}) {
  const { ctx, filter, listed, pendingPeople } = props;
  const [firstPending] = pendingPeople;
  const waiting =
    pendingPeople.length === 1 && firstPending
      ? `${firstPending.name ?? firstPending.email} waits`
      : `${pendingPeople.length} people wait`;
  const waitingCaption =
    pendingPeople.length === 1 && firstPending
      ? `${firstPending.name ?? firstPending.email} is waiting`
      : `${pendingPeople.length} people are waiting`;
  const caption = `People (${props.shown.length} shown of ${listed.length}${
    pendingPeople.length > 0 ? `; ${waitingCaption} for a decision above` : ''
  })`;
  const columns = [
    { label: 'Person' },
    { label: 'Role' },
    { label: 'Status' },
    { label: 'Last sign-in · changes' },
    ...(props.owner ? [{ label: 'Actions', act: true }] : []),
  ];
  return (
    <Tray
      id="people"
      title="Accounts"
      count={listed.length}
      description={
        pendingPeople.length > 0 ? `${waiting} above, under “Needs your decision”.` : undefined
      }
      bar={
        <QuickLinks
          label="Filter people"
          links={filterLinks({
            all: props.all,
            listed,
            pending: pendingPeople.length,
            filter,
            now: ctx.now,
          })}
        />
      }
      actions={props.filtered ? <a href={paths.users()}>Clear filters</a> : undefined}
      footer={
        <>
          <span>
            New people who sign in: <b>{props.policy}</b>.
            {props.policyPending ? ' They wait in “Needs your decision”.' : null}
          </span>
          <a href={paths.signIn('policy')}>Change on Sign-in</a>
        </>
      }
    >
      {listed.length > SEARCH_THRESHOLD ? (
        <Panel variant="pad">
          <Filters
            label="Search people"
            action={paths.users()}
            hidden={{
              ...(filter.role ? { role: filter.role } : {}),
              ...(filter.status ? { status: filter.status } : {}),
            }}
            submitLabel="Search"
          >
            <FilterSearch
              id="f-q"
              label="Search"
              name="q"
              value={filter.q}
              placeholder="alex@acme.com"
              maxlength={Q_MAX}
              describedBy="f-q-hint"
              suggestions={listed.map((user) => user.email)}
            />
          </Filters>
          <p class="hint" id="f-q-hint">
            {props.qTooLong
              ? 'Search text too long; showing everyone. Part of an email address or a name.'
              : 'Part of an email address or a name.'}
          </p>
        </Panel>
      ) : null}
      <Panel variant="flush">
        <Table scroll={false} caption={caption} stackable columns={columns}>
          {props.shown.map((user) => (
            <PersonRow
              user={user}
              ctx={ctx}
              owner={props.owner}
              changes={props.changes.get(user.id) ?? 0}
              joinPolicy={props.policy}
              highlight={props.highlight === user.id}
              error={props.rowError?.userId === user.id ? props.rowError.message : null}
              invitedBy={props.inviters.get(user.id) ?? null}
            />
          ))}
        </Table>
        {props.shown.length === 0 && props.filtered ? (
          <EmptyState
            title="No people match these filters."
            actions={
              <Button size="sm" href={paths.users()}>
                Clear filters
              </Button>
            }
          />
        ) : null}
      </Panel>
    </Tray>
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
  { category: 'access_rules', one: 'access rule', many: 'access rules' },
  { category: 'global_rules', one: 'global access rule', many: 'global access rules' },
  { category: 'users', one: 'person', many: 'people' },
  { category: 'system', one: 'setting', many: 'settings' },
];

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  access: 'Cloudflare Access',
  dev: 'Local development login',
};

type Categories = Awaited<ReturnType<typeof auditCountByActorAndCategory>>;

/** "7 tokens · 1 access rule": the category counts in words. */
function categoryWords(categories: Categories): string {
  return CATEGORY_CHIPS.filter((chip) => categories[chip.category] > 0)
    .map((chip) => {
      const n = categories[chip.category];
      return `${n} ${n === 1 ? chip.one : chip.many}`;
    })
    .join(' · ');
}

/** The one sentence under the identity: what this person can do (no counts). */
function relationSentence(user: UserListEntry, now: number): string {
  const first = firstName(user);
  if (user.status === 'pending') {
    return `tokengate refuses everything ${first} does until an owner approves them.`;
  }
  if (user.status === 'invited') {
    return user.invite_expires_at !== null && user.invite_expires_at > now
      ? `Invited as ${roleLabel(user.role)} until ${utcTime(user.invite_expires_at)}. Nothing happens until they sign in.`
      : `The invitation as ${roleLabel(user.role)} expired. Renew it to let ${first} sign in.`;
  }
  const can: Record<Role, string> = {
    viewer: `${first} sees every page and changes nothing.`,
    token_manager: `${first} can add, rotate, test, disable and delete every credential, and cannot decide who may use them.`,
    access_manager: `${first} can add and change the credential access rules of every credential, and never sees a secret. They cannot add or replace credentials.`,
    admin: `${first} can change credentials, credential and global access rules, and download the configuration export.`,
    owner: `${first} can change everything, including people, sign-in and settings.`,
  };
  return user.status === 'suspended'
    ? `Suspended: tokengate refuses every request they make. As ${roleLabel(user.role)}, ${can[user.role].charAt(0).toLowerCase()}${can[user.role].slice(1)}`
    : can[user.role];
}

/** The icon of an audit action's category, for a feed avatar. */
function actionIcon(action: string): 'token' | 'consumer' | 'users' | 'system' {
  if (/^(service|credential|keyring)\./.test(action)) return 'token';
  if (/^(credential_access_rule|global_access_rule)\./.test(action)) return 'consumer';
  if (action.startsWith('user.')) return 'users';
  return 'system';
}

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
        status: 404,
        header: (
          <PageHeader
            crumbs={[{ href: paths.users(), label: 'People' }, { label: 'Not found' }]}
            title="Person not found"
            description={notFoundText('user')}
          />
        ),
      },
      () => <NotFound />,
    );
  }
  const since = now - CHANGES_WINDOW_MS;
  const [identities, categories, history, recent, defaults, done] = await Promise.all([
    listIdentities(db, id),
    auditCountByActorAndCategory(db, id, since),
    listAuditEvents(db, { targetType: 'user', targetId: id, limit: 20 }),
    listAuditEvents(db, { actorId: id, since, limit: 10 }),
    getJoinDefaults(db),
    options.status
      ? Promise.resolve(null)
      : loadDone(deps, { userId: viewer.user.id }, c.req.query('done')),
  ]);
  const changesFeed = recent
    .filter((event) => event.actor_type === 'user' && !SIGN_IN_ACTIONS.has(event.action))
    .slice(0, 5);
  const policy = JOIN_POLICY_LABELS[joinPolicyOf(defaults)];
  const notice = options.status
    ? null
    : resolveNotice(NOTICES, c.req.query('notice'), done, {
        users: new Map([[user.id, user]]),
        host: new URL(c.req.url).hostname,
        back: 'detail',
      });
  // As on People: link the summary only to an error this page renders. A failed Dismiss shows at
  // the Dismiss button; anything else at the role cards, which a pending person (approve cards)
  // and the viewer's own page do not have.
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
  const changesTotal = Object.values(categories).reduce((sum, n) => sum + n, 0);
  const first = firstName(user);
  const status = userStatus(user, now);
  const invited = status.key === 'invited' || status.key === 'invite_expired';
  const firstLinked = identities.reduce<number | null>(
    (min, row) => (min === null || row.created_at < min ? row.created_at : min),
    null,
  );
  return renderPage(
    c,
    {
      title: user.email,
      section: 'users',
      subsection: 'people',
      errors,
      notice,
      status: options.status,
      header: (ctx) => (
        <PageHeader
          class="u-person"
          crumbs={[{ href: paths.users(), label: 'People' }, { label: user.email }]}
          identity={
            <Identity
              logoSlot={
                <Avatar
                  size="lg"
                  name={user.name ?? user.email}
                  variant={user.status === 'pending' || invited ? 'pending' : undefined}
                />
              }
              title={user.email}
              status={<UserBadge user={user} now={now} />}
              type={
                user.name ? (
                  <>
                    {user.name} · <b>{roleLabel(user.role)}</b>
                  </>
                ) : (
                  <b>{roleLabel(user.role)}</b>
                )
              }
              entityId={{ value: user.id, kind: 'User' }}
              facts={[
                user.last_login_at === null ? (
                  'Never signed in'
                ) : (
                  <>
                    Last sign-in{' '}
                    <Time datetime={new Date(user.last_login_at)}>
                      {relativeTime(user.last_login_at, now)}
                    </Time>
                  </>
                ),
              ]}
            />
          }
          actions={
            <>
              <Button
                href={
                  status.key === 'invited'
                    ? signInMailto(user, ctx.host, now)
                    : `mailto:${encodeURIComponent(user.email).replace('%40', '@')}`
                }
              >
                {status.key === 'invited' ? 'Email sign-in link' : `Email ${first}`}
              </Button>
              <Button href={paths.audit({ actor: id })}>Open in audit log</Button>
            </>
          }
        >
          <RelationLine>{relationSentence(user, now)}</RelationLine>
        </PageHeader>
      ),
    },
    (ctx) => {
      const owner = ctx.can('users:write');
      const self = ctx.userId === id;
      const manage = owner && !self && user.status !== 'pending';
      const rail = (
        <>
          <Tray id="can" title={`What ${first} can do`} description={`As ${roleLabel(user.role)}.`}>
            <Panel>
              <CanList role={user.role} />
              <RailFoot>
                {owner ? (
                  <a href={`${paths.users()}#compare-roles`}>Compare all roles</a>
                ) : (
                  <a href={paths.docs('concepts.md#user')}>How roles work</a>
                )}
              </RailFoot>
            </Panel>
          </Tray>
          <Tray id="details" title="Details">
            <Panel>
              <RailKeyValue
                items={[
                  { label: 'User ID', value: user.id, mono: true, copyable: true },
                  {
                    label: 'Signs in with',
                    value:
                      [
                        ...new Set(
                          identities.map(
                            (row) => PROVIDER_LABELS[row.login_provider] ?? row.login_provider,
                          ),
                        ),
                      ].join(', ') || 'Not signed in yet',
                  },
                  {
                    label: 'First sign-in',
                    value:
                      firstLinked === null ? (
                        '—'
                      ) : (
                        <Time datetime={new Date(firstLinked)} format="date" />
                      ),
                  },
                  {
                    label: 'Last sign-in',
                    value:
                      user.last_login_at === null ? (
                        'Never'
                      ) : (
                        <Time datetime={new Date(user.last_login_at)}>
                          {relativeTime(user.last_login_at, now)}
                        </Time>
                      ),
                  },
                  ...(user.status === 'invited' && user.invite_expires_at !== null
                    ? [
                        {
                          label: 'Invitation',
                          value: `until ${utcTime(user.invite_expires_at)}`,
                        } satisfies RailKeyValueItem,
                      ]
                    : []),
                  {
                    label: 'Changes · 30 days',
                    value: (
                      <a href={paths.audit({ actor: id })}>
                        {changesTotal}
                        <span class="vh"> changes by {user.email}</span>
                      </a>
                    ),
                    note: changesTotal > 0 ? categoryWords(categories) : undefined,
                  },
                ]}
              />
            </Panel>
          </Tray>
        </>
      );
      return (
        <DetailLayout railLabel={`${user.email}: what they can do and details`} rail={rail}>
          <Tray
            id="role"
            title="Role"
            description={
              manage ? 'One click changes it. The notice that follows has Undo.' : undefined
            }
            actions={
              <>
                {manage ? (
                  <StateButton user={user} ctx={ctx} returnTo="detail" scope="detail" />
                ) : null}
                <Badge tone="accent">Current: {roleLabel(user.role)}</Badge>
              </>
            }
          >
            <Panel variant="pad">
              {self ? (
                <>
                  <p>
                    {roleLabel(user.role)}: {ROLE_INFO[user.role].description}
                  </p>
                  <p class="meta">This is you. Another owner can change your account.</p>
                </>
              ) : user.status === 'pending' ? (
                owner ? (
                  <ApproveCards user={user} ctx={ctx} />
                ) : (
                  <>
                    <p>Only owners can decide.</p>
                    <AskSomeoneLine ctx={ctx} />
                  </>
                )
              ) : owner ? (
                <>
                  <RoleCards user={user} ctx={ctx} error={atChange ? rowError.message : null} />
                  <PersonDialogsRoles user={user} ctx={ctx} policy={policy} />
                </>
              ) : (
                <>
                  <p>
                    {roleLabel(user.role)}: {ROLE_INFO[user.role].description}
                  </p>
                  <AskSomeoneLine ctx={ctx} />
                </>
              )}
            </Panel>
          </Tray>
          {user.last_refused_at !== null ? (
            <Tray id="refused" tone="warn" title="Refused sign-in">
              <Panel variant="pad">
                <p>
                  Last refused sign-in {relativeTime(user.last_refused_at, now)} (
                  <Time datetime={new Date(user.last_refused_at)} />) with Access user ID{' '}
                  <code>{accessUserId(user.last_refused_subject)}</code>.
                </p>
                {atDismiss ? (
                  <FieldError id={`f-dismiss-${id}`}>{rowError.message}</FieldError>
                ) : null}
                {owner ? (
                  <div>
                    <ActionForm
                      size="sm"
                      action={`${paths.user(id)}/dismiss-attempt`}
                      hidden={ctx.hidden({
                        _return: 'detail',
                        expected_refused_at: String(user.last_refused_at),
                      })}
                      srSuffix={`the sign-in attempt of ${user.email}`}
                    >
                      Dismiss
                    </ActionForm>
                  </div>
                ) : null}
              </Panel>
            </Tray>
          ) : null}
          <ChangesTray id={id} user={user} categories={categories} events={changesFeed} />
          <Tray
            id="accounts"
            title="Sign-in accounts"
            description="The Cloudflare Access identity linked to this person. tokengate never shows your Access team domain."
          >
            <Panel variant="flush">
              <AccountsTable user={user} identities={identities} now={now} />
            </Panel>
          </Tray>
          <Tray
            id="history"
            title="History of this account"
            actions={
              <Button size="sm" href={paths.audit({ target: id })} srSuffix={`of ${user.email}`}>
                Full history
              </Button>
            }
          >
            <Panel>
              {history.length === 0 ? (
                <p class="meta u-pad">No events yet.</p>
              ) : (
                <Feed>
                  {history.map((event) => (
                    <FeedItem
                      avatar={
                        event.actor_type === 'system' ? (
                          <Avatar variant="sys">
                            <Icon name="system" />
                          </Avatar>
                        ) : (
                          <Avatar name={event.actor_email ?? '?'} />
                        )
                      }
                      time={<Time datetime={new Date(event.ts)} format="day" />}
                    >
                      <b>
                        {event.actor_type === 'system' ? (
                          'System'
                        ) : event.actor_id ? (
                          <a href={paths.audit({ actor: event.actor_id })}>
                            {event.actor_email ?? event.actor_id}
                          </a>
                        ) : (
                          (event.actor_email ?? '—')
                        )}
                      </b>{' '}
                      {/* User summaries start with a verb: "maya@acme.dev made tom@acme.dev …" */}
                      {event.summary.charAt(0).toLowerCase() + event.summary.slice(1)}
                    </FeedItem>
                  ))}
                </Feed>
              )}
            </Panel>
          </Tray>
          {manage ? (
            <AccessDangerZone
              user={user}
              ctx={ctx}
              policy={policy}
              changes={changesTotal}
              subject={identities[0]?.subject ?? null}
            />
          ) : null}
        </DetailLayout>
      );
    },
  );
}

/** "Only owners can change people. Ask …": the same AskSomeone sentence as every page. */
function AskSomeoneLine(props: { ctx: ViewContext }) {
  return <AskSomeone permission="users:write" ctx={props.ctx} verb="change people" />;
}

/** The role confirm dialogs (owner promotion and demotions), after the role form. */
function PersonDialogsRoles(props: { user: UserListEntry; ctx: ViewContext; policy: string }) {
  return (
    <PersonDialogs
      user={props.user}
      ctx={props.ctx}
      returnTo="detail"
      joinPolicy={props.policy}
      only="roles"
    />
  );
}

function ChangesTray(props: {
  id: string;
  user: UserListEntry;
  categories: Categories;
  events: AuditEvent[];
}) {
  const { id, user } = props;
  const first = firstName(user);
  const chips = CATEGORY_CHIPS.filter((chip) => props.categories[chip.category] > 0);
  return (
    <Tray
      id="changes"
      title={`Changes by ${first}`}
      count="30 days"
      description={`What ${first} changed, newest first. The counts open the audit log filtered to them.`}
      actions={
        chips.length > 0 ? (
          <Chips label="Changes by category">
            {chips.map((chip) => {
              const n = props.categories[chip.category];
              return (
                <Chip href={paths.audit({ actor: id, category: chip.category })}>
                  {`${n} ${n === 1 ? chip.one : chip.many}`}
                </Chip>
              );
            })}
          </Chips>
        ) : undefined
      }
    >
      <Panel>
        {props.events.length === 0 ? (
          <p class="meta u-pad">No changes in the last 30 days.</p>
        ) : (
          <Feed>
            {props.events.map((event) => (
              <FeedItem
                avatar={
                  <Avatar variant="sys">
                    <Icon name={actionIcon(event.action)} />
                  </Avatar>
                }
                time={<Time datetime={new Date(event.ts)} format="day" />}
                meta={AUDIT_ACTION_TEXT[event.action] ?? <code>{event.action}</code>}
              >
                {event.summary}
              </FeedItem>
            ))}
          </Feed>
        )}
        <RailFoot>
          <a href={paths.audit({ actor: id })}>All changes by {user.email} in the audit log</a>
        </RailFoot>
      </Panel>
    </Tray>
  );
}

function AccountsTable(props: { user: UserListEntry; identities: UserIdentity[]; now: number }) {
  const columns = [
    { label: 'Login provider' },
    { label: 'Access user ID' },
    { label: 'Email at link time' },
    { label: 'Linked' },
    { label: 'Last used' },
  ];
  if (props.identities.length === 0) {
    return (
      <>
        <Table
          scroll={false}
          caption={`Sign-in accounts of ${props.user.email}`}
          stackable
          columns={columns}
        />
        <EmptyState
          title="Never signed in."
          description="Their first sign-in through Cloudflare Access links an account."
        />
      </>
    );
  }
  return (
    <Table
      labelledBy="accounts-h"
      caption={`Sign-in accounts of ${props.user.email}`}
      stackable
      columns={columns}
    >
      {props.identities.map((row) => (
        <Row>
          <RowHeader>
            <span class="ent-n">{PROVIDER_LABELS[row.login_provider] ?? row.login_provider}</span>
          </RowHeader>
          <Cell label="Access user ID">
            <IdChip kind="Access user">{accessUserId(row.subject)}</IdChip>
          </Cell>
          <Cell label="Email at link time">{row.email ?? '—'}</Cell>
          <Cell label="Linked">
            <Time datetime={new Date(row.created_at)} format="date" />
          </Cell>
          <Cell label="Last used">
            {row.last_used_at === null ? (
              'Never'
            ) : (
              <Time datetime={new Date(row.last_used_at)}>
                {relativeTime(row.last_used_at, props.now)}
              </Time>
            )}
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

/** "Account access": suspend, reset sign-in, delete or cancel the invitation, by state. */
function AccessDangerZone(props: {
  user: UserListEntry;
  ctx: ViewContext;
  policy: string;
  changes: number;
  subject: string | null;
}) {
  const { user, ctx } = props;
  const first = firstName(user);
  const sub = accessUserId(props.subject);
  const reset = (
    <DangerRow
      title="Reset sign-in"
      description={`Unlinks Access user ${sub}. Use it only after ${first} changed their Cloudflare Access account. Cannot be undone.`}
      action={
        <DialogTrigger variant="danger" dialog={`dlg-reset-${user.id}`}>
          Reset sign-in…
        </DialogTrigger>
      }
    />
  );
  const suspendText = `tokengate refuses every request ${first} makes. Their Access session stays valid.`;
  let rows: Child;
  if (user.status === 'active') {
    rows = (
      <>
        <DangerRow
          title={`Suspend ${user.email}`}
          description={
            user.role === 'owner'
              ? `${suspendText} You confirm in a dialog.`
              : `${suspendText} Undo appears right after.`
          }
          action={
            user.role === 'owner' ? (
              <DialogTrigger variant="danger" dialog={`dlg-suspend-${user.id}`}>
                Suspend…
              </DialogTrigger>
            ) : (
              <ActionForm
                variant="danger"
                action={paths.user(user.id)}
                hidden={ctx.hidden({
                  _return: 'detail',
                  expected_updated_at: String(user.updated_at),
                  status: 'suspended',
                })}
                srSuffix={user.email}
              >
                Suspend {first}
              </ActionForm>
            )
          }
        />
        {reset}
      </>
    );
  } else if (user.status === 'suspended' && user.identity_count > 0) {
    rows = reset;
  } else {
    const invitation = user.status === 'invited';
    rows = (
      <DangerRow
        title={invitation ? 'Cancel the invitation' : `Delete ${user.email}`}
        description={
          invitation
            ? 'Deletes the invitation. You can invite again later.'
            : 'Deletes this person, who never signed in.'
        }
        action={
          <DialogTrigger variant="danger" dialog={`dlg-delete-${user.id}`}>
            {invitation ? 'Cancel invitation…' : 'Delete…'}
          </DialogTrigger>
        }
      />
    );
  }
  return (
    <>
      <DangerZone
        id="access"
        title="Account access"
        description={`Stop ${first} from using the console.`}
      >
        {rows}
      </DangerZone>
      <PersonDialogs
        user={user}
        ctx={ctx}
        returnTo="detail"
        joinPolicy={props.policy}
        only="state"
        detail={{ changes: props.changes, accessUserId: sub }}
      />
    </>
  );
}

/** Single-valued form field; repeated fields are treated as absent. */
function text(form: FormFields, name: string): string | undefined {
  const value = form[name];
  return typeof value === 'string' ? value : undefined;
}
