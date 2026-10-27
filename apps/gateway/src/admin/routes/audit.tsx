// Monitoring › Audit log: every admin mutation, sign-in and system event, newest first, as a
// sentence feed grouped by UTC day. Filters are links: category tabs, the time range control, and
// "+ Who" / "+ Target" menus of existing people and objects, so nothing is typed; keyset
// pagination both ways. Diffs were redacted when written (db/audit.ts, I-CRED-1); this page only
// displays them, escaped. Query text is never echoed as a label.
import {
  ActiveFilters,
  AddFilter,
  Avatar,
  DiffTable,
  Disclosure,
  EmptyState,
  Feed,
  FeedDay,
  FeedItem,
  FieldError,
  type FilterOption,
  type FilterOptionGroup,
  Filters,
  LinkAction,
  PageHeader,
  Panel,
  Segmented,
  TabRow,
  Tabs,
  Time,
  Tray,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import type { App } from '../../app';
import { type AuditActionSet, listAuditEvents } from '../../db/audit';
import type { AuditEvent, UserStatus } from '../../db/types';
import { DAY_MS, parseRange, RANGE_LABEL } from '../../telemetry/ranges';
import type { Connections } from '../connections';
import type { FieldError as FieldErrorData } from '../ops/shared';
import { type AuditCategory, paths } from '../paths';
import { renderPage } from '../render';
import { formatTime } from '../views/format';
import { LearnMore } from '../views/header';
import {
  actionText,
  AUDIT_TARGETS,
  AuditTarget,
  auditActorText,
  auditTargetValue,
  ActorAvatar,
  byUtcDay,
  dayLabel,
  FindRequest,
  LogPager,
} from '../views/monitoring';

const PAGE_SIZE = 50;
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const AUDIT_ID = new RegExp(`^aud_${ULID}$`);
const USER_ID = new RegExp(`^usr_${ULID}$`);
const TARGET_ID = new RegExp(`^(svc|acr|gar|usr)_${ULID}$`);
/** Upper bound of the people the actor menu lists. */
const PEOPLE_LIMIT = 1000;

type AuditRange = '24h' | '7d' | '30d' | '90d';
const AUDIT_RANGES: readonly AuditRange[] = ['24h', '7d', '30d', '90d'];
const RANGE_MS: Readonly<Record<AuditRange, number>> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
};

/**
 * Audit actions by category. Prefix entries are `[prefix, successor)` ranges on audit_log_action;
 * every action the ops and the cron emit belongs to exactly one category (a test checks this).
 */
export const AUDIT_CATEGORIES: Readonly<Record<AuditCategory, { label: string } & AuditActionSet>> =
  {
    tokens: {
      label: 'Credentials',
      prefixes: ['service.', 'credential.', 'keyring.'],
      exact: ['settings.upstream_hosts'],
    },
    access_rules: {
      label: 'Access rules',
      prefixes: ['credential_access_rule.'],
      exact: [],
    },
    global_rules: {
      label: 'Global access rules',
      prefixes: ['global_access_rule.'],
      exact: [],
    },
    users: {
      label: 'Users',
      prefixes: [],
      exact: [
        'user.invite',
        'user.update',
        'user.approve',
        'user.reject',
        'user.delete',
        'user.dismiss_attempt',
        'user.join_defaults',
        'user.reset_login',
        'user.resend_invite',
      ],
    },
    signins: {
      label: 'Sign-ins',
      prefixes: [],
      exact: ['user.bootstrap', 'user.join', 'user.link'],
    },
    system: { label: 'System', prefixes: [], exact: ['settings.update', 'config.export'] },
  };

const CATEGORY_KEYS = Object.keys(AUDIT_CATEGORIES) as AuditCategory[];

/** The categories `action` belongs to (exactly one for every emitted action). */
export function auditCategoriesOf(action: string): AuditCategory[] {
  return CATEGORY_KEYS.filter((key) => {
    const set = AUDIT_CATEGORIES[key];
    return set.exact.includes(action) || set.prefixes.some((prefix) => action.startsWith(prefix));
  });
}

export interface AuditPerson {
  id: string;
  email: string;
  status: UserStatus;
}

/** Every person by email (bounded): the actor select, target names and "(suspended)". */
export async function loadAuditPeople(db: D1Database): Promise<AuditPerson[]> {
  const { results } = await db
    .prepare('SELECT id, email, status FROM users ORDER BY email, id LIMIT ?')
    .bind(PEOPLE_LIMIT)
    .all<AuditPerson>();
  return results;
}

/** Current names of the objects audit events point at, by id. */
export function auditTargetNames(
  connections: Pick<Connections, 'credentials' | 'rules' | 'globals'>,
  people: readonly AuditPerson[],
): Map<string, string> {
  return new Map<string, string>([
    ...connections.credentials.map((t) => [t.id, t.name] as [string, string]),
    ...connections.rules.map((edge) => [edge.rule.id, edge.rule.name] as [string, string]),
    ...connections.globals.map((g) => [g.id, g.name] as [string, string]),
    ...people.map((p) => [p.id, p.email] as [string, string]),
  ]);
}

interface AuditParams {
  range?: AuditRange;
  category?: AuditCategory;
  target?: string;
  actor?: string;
  before?: string;
  after?: string;
}

export function registerAuditRoutes(app: App): void {
  app.get('/admin/audit', async (c) => {
    const deps = c.get('deps');
    const db = deps.env.DB;
    const q = (name: string) => c.req.query(name);
    const [people, tokens, rules, globals] = await Promise.all([
      loadAuditPeople(db),
      db
        .prepare('SELECT id, name FROM credentials ORDER BY name, id')
        .all<{ id: string; name: string }>(),
      db
        .prepare(
          `SELECT r.id, r.name, credentials.name AS token FROM access_rules r
           LEFT JOIN credentials ON credentials.id = r.credential_id
           WHERE r.credential_id IS NOT NULL ORDER BY r.name, r.id`,
        )
        .all<{ id: string; name: string; token: string | null }>(),
      db
        .prepare(
          'SELECT id, name, issuer_key FROM access_rules WHERE credential_id IS NULL ORDER BY name, id',
        )
        .all<{ id: string; name: string; issuer_key: string }>(),
    ]);
    const errors: FieldErrorData[] = [];
    const params: AuditParams = {};
    const range = parseRange(q('range'), AUDIT_RANGES);
    if (range) params.range = range;
    else if (q('range'))
      errors.push({
        field: null,
        message: 'That time range is not available; showing all events.',
      });
    const category = parseRange(q('category'), CATEGORY_KEYS);
    if (category) params.category = category;
    else if (q('category'))
      errors.push({
        field: null,
        message: 'That category is not available; showing every category.',
      });
    const target = q('target')?.trim() ?? '';
    if (target !== '') {
      if (target === 'settings' || target === 'keyring' || TARGET_ID.test(target))
        params.target = target;
      else errors.push({ field: 'target', message: 'Choose an object from the list.' });
    }
    const actorRaw = q('actor')?.trim() ?? '';
    let actorId: string | undefined;
    let systemActor = false;
    if (actorRaw !== '') {
      const byEmail = people.find((p) => p.email.toLowerCase() === actorRaw.toLowerCase());
      if (actorRaw === 'system') systemActor = true;
      else if (USER_ID.test(actorRaw)) actorId = actorRaw;
      else if (byEmail) actorId = byEmail.id;
      if (systemActor || actorId) params.actor = systemActor ? 'system' : actorId;
      else errors.push({ field: 'actor', message: 'Choose a person from the list.' });
    }
    for (const cursor of ['before', 'after'] as const) {
      const value = q(cursor);
      if (!value) continue;
      if (AUDIT_ID.test(value)) params[cursor] = value;
      else
        errors.push({
          field: null,
          message: 'The page position is not valid; showing the newest events.',
        });
    }
    if (params.after) delete params.before;

    const targetType = params.target ? targetTypeOf(params.target) : undefined;
    const rows = await listAuditEvents(db, {
      ...(targetType ? { targetType } : {}),
      ...(params.target && targetType !== 'settings' && targetType !== 'keyring'
        ? { targetId: params.target }
        : {}),
      ...(actorId ? { actorId } : {}),
      systemActor,
      ...(params.category ? { actions: AUDIT_CATEGORIES[params.category] } : {}),
      ...(params.range ? { since: deps.now() - RANGE_MS[params.range] } : {}),
      ...(params.before ? { before: params.before } : {}),
      ...(params.after ? { after: params.after } : {}),
      limit: PAGE_SIZE + 1,
    });
    let page: AuditEvent[];
    let older: string | null = null;
    let newer: string | null = null;
    if (params.after) {
      page = rows.length > PAGE_SIZE ? rows.slice(1) : rows;
      if (rows.length > PAGE_SIZE && page[0]) newer = link(params, { after: page[0].id });
      const last = page.at(-1);
      older = last ? link(params, { before: last.id }) : null;
    } else {
      page = rows.slice(0, PAGE_SIZE);
      const last = page.at(-1);
      if (rows.length > PAGE_SIZE && last) older = link(params, { before: last.id });
      if (params.before && page[0]) newer = link(params, { after: page[0].id });
    }
    const names = new Map<string, string>([
      ...tokens.results.map((t) => [t.id, t.name] as [string, string]),
      ...rules.results.map((r) => [r.id, r.name] as [string, string]),
      ...globals.results.map((g) => [g.id, g.name] as [string, string]),
      ...people.map((p) => [p.id, p.email] as [string, string]),
    ]);
    const suspended = new Set(people.filter((p) => p.status === 'suspended').map((p) => p.id));
    // "+ Target": today's object groups, in the same order (credentials, access rules, people),
    // then the settings pages and the keyring.
    const targetGroups: FilterOptionGroup[] = [
      {
        group: 'Credentials',
        options: tokens.results.map((t) => ({
          href: link({ ...params, target: t.id }, {}),
          label: t.name,
          slug: 'token',
        })),
      },
      {
        group: 'Credential access rules',
        options: rules.results.map((r) => ({
          href: link({ ...params, target: r.id }, {}),
          label: r.token ? `${r.name} — ${r.token}` : r.name,
          slug: 'access rule',
        })),
      },
      {
        group: 'Global access rules',
        options: globals.results.map((g) => ({
          href: link({ ...params, target: g.id }, {}),
          label: `${g.name} — ${g.issuer_key}`,
          slug: 'global rule',
        })),
      },
      {
        group: 'Users',
        options: people.map((p) => ({
          href: link({ ...params, target: p.id }, {}),
          label: p.email,
          slug: 'person',
        })),
      },
    ].filter((group) => group.options.length > 0);
    const targetExtra: FilterOption[] = [
      { href: link({ ...params, target: 'settings' }, {}), label: 'Settings' },
      { href: link({ ...params, target: 'keyring' }, {}), label: 'Encryption keys' },
    ];
    const peopleOptions: FilterOption[] = people.map((p) => ({
      href: link({ ...params, actor: p.id }, {}),
      label: p.status === 'suspended' ? `${p.email} (suspended)` : p.email,
      logoSlot: <Avatar name={p.email} />,
    }));
    const chips: Array<{ label: string; href: string }> = [];
    if (params.target) {
      chips.push({
        label: `Target: ${targetLabel(params.target, names, people)}`,
        href: link({ ...params, target: undefined }, {}),
      });
    }
    if (params.actor) {
      chips.push({
        label: `Who: ${actorLabel(params.actor, people)}`,
        href: link({ ...params, actor: undefined }, {}),
      });
    }
    const filtered = Boolean(params.target || params.actor || params.category || params.range);
    const error = (field: string) => errors.find((e) => e.field === field)?.message;
    // A7.1: the filter menus only when they can narrow something: an active filter or cursor, an
    // invalid value to correct, or more than 10 rows.
    const showFilters =
      filtered || Boolean(params.before || params.after) || errors.length > 0 || page.length > 10;
    return renderPage(
      c,
      {
        title: 'Audit log',
        section: 'monitoring',
        subsection: 'audit',
        errors,
        ...(errors.length > 0 ? { status: 400 as const } : {}),
        header: (
          <PageHeader
            title="Audit log"
            description={
              <>
                Every change to credentials, access rules, people and settings, every sign-in, and
                the hourly job, newest first. Secrets are never recorded.
                <LearnMore path="concepts.md#audit-event" about="audit events" />
              </>
            }
            actions={<FindRequest placement="header" />}
          >
            <TabRow>
              <Tabs
                label="Category"
                items={[
                  {
                    label: 'All',
                    href: link({ ...params, category: undefined }, {}),
                    current: !params.category,
                  },
                  ...CATEGORY_KEYS.map((key) => ({
                    label: AUDIT_CATEGORIES[key].label,
                    href: link({ ...params, category: key }, {}),
                    current: params.category === key,
                  })),
                ]}
              />
              <Segmented
                label="Time range"
                size="sm"
                items={[
                  ...AUDIT_RANGES.map((key) => ({
                    label: RANGE_LABEL[key],
                    href: link({ ...params, range: key }, {}),
                    current: params.range === key,
                  })),
                  {
                    label: 'All',
                    href: link({ ...params, range: undefined }, {}),
                    current: !params.range,
                  },
                ]}
              />
            </TabRow>
          </PageHeader>
        ),
      },
      () => (
        <Tray
          id="audit-events"
          title="Audit events, newest first"
          description={
            params.range ? `Last ${RANGE_LABEL[params.range]} · times in UTC` : 'Times in UTC'
          }
          bar={
            showFilters ? (
              <>
                <Filters as="group" label="Filter audit log">
                  <AddFilter
                    id="f-actor"
                    label="Who"
                    open={error('actor') !== undefined}
                    options={peopleOptions}
                    extra={[
                      {
                        href: link({ ...params, actor: 'system' }, {}),
                        label: 'System (hourly job)',
                      },
                    ]}
                  />
                  <AddFilter
                    id="f-target"
                    label="Target"
                    open={error('target') !== undefined}
                    options={targetGroups}
                    extra={targetExtra}
                  />
                  {error('actor') ? (
                    <FieldError id="f-actor-error">{error('actor')}</FieldError>
                  ) : null}
                  {error('target') ? (
                    <FieldError id="f-target-error">{error('target')}</FieldError>
                  ) : null}
                </Filters>
                <ActiveFilters
                  lead="Active filters"
                  filters={chips}
                  clearHref={paths.audit()}
                  clearLabel="Clear filters"
                />
              </>
            ) : undefined
          }
        >
          <Panel variant="flush">
            {page.length === 0 ? (
              filtered || params.before || params.after ? (
                <EmptyState
                  title="No audit events match these filters."
                  actions={<LinkAction href={paths.audit()}>Clear filters</LinkAction>}
                />
              ) : (
                <EmptyState
                  title="No audit events yet."
                  description="They appear when someone signs in or changes the configuration."
                />
              )
            ) : (
              <AuditFeed
                events={page}
                names={names}
                suspended={suspended}
                params={params}
                now={deps.now()}
              />
            )}
            <LogPager
              summary={`Showing ${page.length} ${page.length === 1 ? 'event' : 'events'} · times in UTC`}
              newest={params.before || params.after ? link(params, {}) : null}
              newer={newer}
              older={older}
            />
          </Panel>
        </Tray>
      ),
    );
  });
}

/** The chip label of a target filter: its current name, or "Deleted credential svc_…" (never free text). */
function targetLabel(
  target: string,
  names: ReadonlyMap<string, string>,
  people: readonly AuditPerson[],
): string {
  if (target === 'settings') return 'Settings';
  if (target === 'keyring') return 'Encryption keys';
  const name = names.get(target) ?? people.find((p) => p.id === target)?.email;
  if (name !== undefined) return name;
  const noun = AUDIT_TARGETS[targetTypeOf(target) ?? '']?.noun ?? 'object';
  return `Deleted ${noun} ${target}`;
}

/** The chip label of an actor filter (ids only reach here validated). */
function actorLabel(actor: string, people: readonly AuditPerson[]): string {
  if (actor === 'system') return 'System (hourly job)';
  const person = people.find((p) => p.id === actor);
  if (!person) return `Deleted user ${actor}`;
  return person.status === 'suspended' ? `${person.email} (suspended)` : person.email;
}

function targetTypeOf(target: string): string | undefined {
  if (target === 'settings' || target === 'keyring') return target;
  const prefix = target.slice(0, 3);
  return Object.entries(AUDIT_TARGETS).find(([, info]) => info.prefix === prefix)?.[0];
}

/** The audit list URL for `params`, with the cursor replaced (filters never keep a cursor). */
function link(params: AuditParams, cursor: { before?: string; after?: string }): string {
  const url = new URL(
    paths.audit({
      range: params.range,
      category: params.category,
      target: params.target,
      actor: params.actor,
    }),
    'https://audit.invalid',
  );
  if (cursor.before) url.searchParams.set('before', cursor.before);
  else if (cursor.after) url.searchParams.set('after', cursor.after);
  return `${url.pathname}${url.search}`;
}

function AuditFeed(props: {
  events: AuditEvent[];
  names: ReadonlyMap<string, string>;
  suspended: ReadonlySet<string>;
  params: AuditParams;
  now: number;
}) {
  const { names, params } = props;
  return (
    <>
      {byUtcDay(props.events).map((events) => (
        <>
          <FeedDay>{dayLabel(events[0]?.ts ?? 0, props.now, true)}</FeedDay>
          <Feed>
            {events.map((e) => {
              const text = auditActorText(e, props.suspended);
              const actor = e.actor_type === 'system' ? 'system' : e.actor_id;
              const value = auditTargetValue(e);
              const noun = AUDIT_TARGETS[e.target_type ?? '']?.noun ?? 'object';
              return (
                <FeedItem
                  avatar={<ActorAvatar event={e} />}
                  time={<Time datetime={new Date(e.ts)} format="clock" />}
                  meta={
                    <>
                      <code>{e.action}</code>
                      {e.summary ? <span class="muted"> {e.summary}</span> : null}
                      {value ? (
                        <>
                          {' '}
                          <a href={paths.audit({ target: value })}>
                            History<span class="vh"> of this {noun}</span>
                          </a>
                        </>
                      ) : null}
                    </>
                  }
                  details={
                    <AuditChanges
                      event={e}
                      name={value ? (names.get(e.target_id ?? '') ?? null) : null}
                    />
                  }
                >
                  {actor ? (
                    <a href={link({ ...params, actor }, {})}>
                      {text}
                      <span class="vh"> (show only their changes)</span>
                    </a>
                  ) : (
                    <b>{text}</b>
                  )}{' '}
                  {actionText(e.action) ?? e.action}
                  {e.target_type ? (
                    <>
                      : <AuditTarget event={e} names={names} />
                    </>
                  ) : null}
                  .
                </FeedItem>
              );
            })}
          </Feed>
        </>
      ))}
    </>
  );
}

/** Keys whose before and after differ, in order of first appearance. */
function changedKeys(before: unknown, after: unknown): string[] {
  const keys = new Set([...Object.keys(asRecord(before)), ...Object.keys(asRecord(after))]);
  return [...keys].filter(
    (key) => JSON.stringify(asRecord(before)[key]) !== JSON.stringify(asRecord(after)[key]),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A diff value: `undefined` stays empty (the table says "Not set"), objects as JSON. */
function diffValue(value: unknown): Child | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    return <code>{typeof value === 'string' ? value : JSON.stringify(value)}</code>;
  }
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

/** The changes of one event: changed keys only, `[redacted]` kept as written, then the metadata. */
function AuditChanges(props: { event: AuditEvent; name: string | null }) {
  const { diff, ip, user_agent: userAgent, id, ts } = props.event;
  const { before, after, ...other } = diff ?? {};
  const keys = changedKeys(before, after);
  const hasOther = Object.keys(other).length > 0;
  const subject = props.name ?? props.event.target_type ?? 'this event';
  return (
    <Disclosure
      summary={
        <>
          {keys.length > 0
            ? `Changes: ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}`
            : 'Details'}
          <span class="vh">
            {' '}
            for {subject} at {formatTime(ts)}
          </span>
        </>
      }
    >
      {keys.length > 0 ? (
        <DiffTable
          caption={`Changed fields of ${subject} at ${formatTime(ts)}`}
          rows={keys.map((key) => ({
            field: <code>{key}</code>,
            before: diffValue(asRecord(before)[key]),
            after: diffValue(asRecord(after)[key]),
          }))}
        />
      ) : null}
      {hasOther ? (
        <>
          <p>Other details</p>
          <pre>{JSON.stringify(other, null, 2)}</pre>
        </>
      ) : null}
      <p class="hint">
        Event <code>{id}</code>
        {ip ? ` · IP ${ip}` : ''}
        {userAgent ? ` · ${userAgent}` : ''}
      </p>
    </Disclosure>
  );
}
