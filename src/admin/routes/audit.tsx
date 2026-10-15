// Monitoring › Audit log: every admin mutation, sign-in and system event, newest first. Filters are
// link tabs (range, category) and two selects of existing objects and people (target, actor), so
// nothing is typed; keyset pagination both ways. Diffs were redacted when written (db/audit.ts,
// I-CRED-1); this page only displays them, escaped. Query text is never echoed as a label.
import type { Child } from 'hono/jsx';
import type { App } from '../../app';
import { type AuditActionSet, listAuditEvents } from '../../db/audit';
import type { AuditEvent, UserStatus } from '../../db/types';
import { DAY_MS, parseRange, RANGE_LABEL } from '../../telemetry/ranges';
import type { Connections } from '../connections';
import type { FieldError } from '../ops/shared';
import { type AuditCategory, paths } from '../paths';
import { renderPage, type ViewContext } from '../render';
import {
  DataTable,
  EmptyState,
  FilterChips,
  type OptionList,
  Pager,
  Select,
  Tabs,
  Time,
} from '../views/components';
import { formatTime } from '../views/format';
import {
  actionText,
  AUDIT_TARGETS,
  AuditTarget,
  auditActorText,
  auditTargetValue,
  FindRequestForm,
} from '../views/monitoring';

const PAGE_SIZE = 50;
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const AUDIT_ID = new RegExp(`^aud_${ULID}$`);
const USER_ID = new RegExp(`^usr_${ULID}$`);
const TARGET_ID = new RegExp(`^(svc|cpr|grt|usr)_${ULID}$`);
/** Upper bound of the people the actor select lists. */
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
      label: 'Tokens',
      prefixes: ['service.', 'credential.', 'keyring.'],
      exact: ['settings.upstream_hosts'],
    },
    consumers: { label: 'Consumers', prefixes: ['caller_provider.'], exact: [] },
    access: { label: 'Access', prefixes: ['grant.'], exact: [] },
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
        'settings.admin_hosts',
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
  connections: Pick<Connections, 'tokens' | 'consumers' | 'accesses'>,
  people: readonly AuditPerson[],
): Map<string, string> {
  return new Map<string, string>([
    ...connections.tokens.map((t) => [t.id, t.name] as [string, string]),
    ...connections.consumers.map((c) => [c.id, c.name] as [string, string]),
    ...connections.accesses.map((a) => [a.grant.id, a.grant.name] as [string, string]),
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
    const [people, tokens, consumers, grants] = await Promise.all([
      loadAuditPeople(db),
      db
        .prepare('SELECT id, name FROM services ORDER BY name, id')
        .all<{ id: string; name: string }>(),
      db
        .prepare('SELECT id, name FROM caller_providers ORDER BY name, id')
        .all<{ id: string; name: string }>(),
      db
        .prepare(
          `SELECT grants.id, grants.name, services.name AS token FROM grants
           LEFT JOIN services ON services.id = grants.service_id ORDER BY grants.name, grants.id`,
        )
        .all<{ id: string; name: string; token: string | null }>(),
    ]);
    const errors: FieldError[] = [];
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
      ...consumers.results.map((r) => [r.id, r.name] as [string, string]),
      ...grants.results.map((g) => [g.id, g.name] as [string, string]),
      ...people.map((p) => [p.id, p.email] as [string, string]),
    ]);
    const suspended = new Set(people.filter((p) => p.status === 'suspended').map((p) => p.id));
    const targetOptions: OptionList = [
      { group: 'Tokens', options: tokens.results.map((t) => ({ value: t.id, label: t.name })) },
      {
        group: 'Consumers',
        options: consumers.results.map((r) => ({ value: r.id, label: r.name })),
      },
      {
        group: 'Access',
        options: grants.results.map((g) => ({
          value: g.id,
          label: g.token ? `${g.name} — ${g.token}` : g.name,
        })),
      },
      { group: 'Users', options: people.map((p) => ({ value: p.id, label: p.email })) },
      {
        group: 'Other',
        options: [
          { value: 'settings', label: 'Settings' },
          { value: 'keyring', label: 'Encryption keys' },
        ],
      },
    ].filter((group) => group.options.length > 0);
    // A well-formed id of an object that no longer exists keeps its own option (never free text).
    if (params.target && TARGET_ID.test(params.target) && !names.has(params.target)) {
      const noun = AUDIT_TARGETS[targetTypeOf(params.target) ?? '']?.noun ?? 'object';
      targetOptions.push({
        group: 'Deleted',
        options: [{ value: params.target, label: `Deleted ${noun} ${params.target}` }],
      });
    }
    const actorOptions = [
      { value: 'system', label: 'System (hourly job)' },
      ...people.map((p) => ({
        value: p.id,
        label: p.status === 'suspended' ? `${p.email} (suspended)` : p.email,
      })),
    ];
    if (actorId && !people.some((p) => p.id === actorId)) {
      actorOptions.push({ value: actorId, label: `Deleted user ${actorId}` });
    }
    const chips: Array<{ label: string; removeHref: string }> = [];
    if (params.target) {
      chips.push({
        label: `Object: ${flatLabel(targetOptions, params.target) ?? params.target}`,
        removeHref: link({ ...params, target: undefined }, {}),
      });
    }
    if (params.actor) {
      chips.push({
        label: `Who: ${actorOptions.find((o) => o.value === params.actor)?.label ?? params.actor}`,
        removeHref: link({ ...params, actor: undefined }, {}),
      });
    }
    const filtered = Boolean(params.target || params.actor || params.category || params.range);
    return renderPage(
      c,
      {
        title: 'Audit log',
        section: 'monitoring',
        subsection: 'audit',
        errors,
        subnavExtra: <FindRequestForm />,
        ...(errors.length > 0 ? { status: 400 as const } : {}),
      },
      (ctx) => (
        <>
          <p class="muted">
            Every change made in this admin UI, every sign-in, and events from the hourly
            maintenance job, newest first. Secrets are never recorded.
          </p>
          <Tabs
            label="Time range"
            current={params.range ?? 'all'}
            items={[
              ...AUDIT_RANGES.map((key) => ({
                key,
                href: link({ ...params, range: key }, {}),
                label: RANGE_LABEL[key],
              })),
              { key: 'all', href: link({ ...params, range: undefined }, {}), label: 'All' },
            ]}
          />
          <Tabs
            label="Category"
            current={params.category ?? 'all'}
            items={[
              { key: 'all', href: link({ ...params, category: undefined }, {}), label: 'All' },
              ...CATEGORY_KEYS.map((key) => ({
                key,
                href: link({ ...params, category: key }, {}),
                label: AUDIT_CATEGORIES[key].label,
              })),
            ]}
          />
          <form method="get" action={paths.audit()} class="filters" aria-label="Filter audit log">
            {params.range ? <input type="hidden" name="range" value={params.range} /> : null}
            {params.category ? (
              <input type="hidden" name="category" value={params.category} />
            ) : null}
            <Select
              name="target"
              label="Object"
              value={params.target ?? (errors.some((e) => e.field === 'target') ? '' : null)}
              placeholder="Any object"
              options={targetOptions}
              hint="Show the history of one object. Each object page also has a History link."
              error={errors.find((e) => e.field === 'target')?.message}
            />
            <Select
              name="actor"
              label="Who"
              value={params.actor ?? null}
              placeholder="Anyone"
              options={actorOptions}
              hint="Who made the change."
              error={errors.find((e) => e.field === 'actor')?.message}
            />
            <button type="submit" class="secondary">
              Apply filters
            </button>
          </form>
          <FilterChips items={chips} clearHref={paths.audit()} />
          {page.length === 0 ? (
            filtered || params.before || params.after ? (
              <EmptyState>
                No audit events match these filters. <a href={paths.audit()}>Clear filters</a>
              </EmptyState>
            ) : (
              <EmptyState>
                No audit events yet. They appear when someone signs in or changes the configuration.
              </EmptyState>
            )
          ) : (
            <AuditTable
              events={page}
              names={names}
              suspended={suspended}
              params={params}
              ctx={ctx}
            />
          )}
          <Pager
            newest={params.before || params.after ? link(params, {}) : null}
            newer={newer}
            older={older}
          />
        </>
      ),
    );
  });
}

function targetTypeOf(target: string): string | undefined {
  if (target === 'settings' || target === 'keyring') return target;
  const prefix = target.slice(0, 3);
  return Object.entries(AUDIT_TARGETS).find(([, info]) => info.prefix === prefix)?.[0];
}

function flatLabel(options: OptionList, value: string): string | undefined {
  for (const entry of options) {
    const list = 'group' in entry ? entry.options : [entry];
    const found = list.find((option) => option.value === value);
    if (found) return found.label;
  }
  return undefined;
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

function AuditTable(props: {
  events: AuditEvent[];
  names: ReadonlyMap<string, string>;
  suspended: ReadonlySet<string>;
  params: AuditParams;
  ctx: ViewContext;
}) {
  const { names, params } = props;
  return (
    <DataTable
      id="audit-events"
      caption="Audit events, newest first"
      rowHeader="what"
      rows={props.events}
      columns={[
        { key: 'when', header: 'When', render: (e) => <Time ms={e.ts} /> },
        {
          key: 'who',
          header: 'Who',
          render: (e) => {
            const text = auditActorText(e, props.suspended);
            const value = e.actor_type === 'system' ? 'system' : e.actor_id;
            return value ? (
              <a href={link({ ...params, actor: value }, {})}>
                {text}
                <span class="vh"> (show only their changes)</span>
              </a>
            ) : (
              text
            );
          },
        },
        {
          key: 'what',
          header: 'What',
          render: (e) => (
            <>
              {actionText(e.action) ?? e.action} <code>{e.action}</code>
              <br />
              <span class="muted">{e.summary}</span>
            </>
          ),
        },
        {
          key: 'target',
          header: 'Target',
          render: (e) => <AuditTarget event={e} names={names} history />,
        },
        {
          key: 'changes',
          header: 'Changes',
          render: (e) => (
            <AuditChanges
              event={e}
              name={auditTargetValue(e) ? (names.get(e.target_id ?? '') ?? null) : null}
            />
          ),
        },
      ]}
    />
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

function DiffValue(props: { value: unknown }) {
  const { value } = props;
  if (value === undefined) return <span class="muted">—</span>;
  if (value === null || typeof value !== 'object') {
    return <code>{typeof value === 'string' ? value : JSON.stringify(value)}</code>;
  }
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

/** Diff table (changed keys only, `[redacted]` kept as written), then the event metadata. */
function AuditChanges(props: { event: AuditEvent; name: string | null }) {
  const { diff, ip, user_agent: userAgent, id, ts } = props.event;
  const { before, after, ...other } = diff ?? {};
  const keys = changedKeys(before, after);
  const hasOther = Object.keys(other).length > 0;
  const summary: Child =
    keys.length > 0
      ? `Changes: ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}`
      : 'Details';
  return (
    <details class="audit-diff">
      <summary>
        {summary}
        <span class="vh">
          {' '}
          for {props.name ?? props.event.target_type ?? 'this event'} at {formatTime(ts)}
        </span>
      </summary>
      {keys.length > 0 ? (
        <div class="table-region" role="region" aria-labelledby={`diff-${id}`} tabindex={0}>
          <table>
            <caption id={`diff-${id}`} class="vh">
              Changed fields
            </caption>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Before</th>
                <th scope="col">After</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr>
                  <th scope="row">
                    <code>{key}</code>
                  </th>
                  <td>
                    <DiffValue value={asRecord(before)[key]} />
                  </td>
                  <td>
                    <DiffValue value={asRecord(after)[key]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {hasOther ? (
        <>
          <p>Other details</p>
          <pre>{JSON.stringify(other, null, 2)}</pre>
        </>
      ) : null}
      <p class="muted">
        Event <code>{id}</code>
        {ip ? ` · IP ${ip}` : ''}
        {userAgent ? ` · ${userAgent}` : ''}
      </p>
    </details>
  );
}
