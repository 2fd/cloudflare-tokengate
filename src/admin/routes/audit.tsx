// Audit log page: every admin mutation and system event, newest first, with filters and keyset
// pagination. Diffs were redacted when written (db/audit.ts, I-CRED-1); this page only displays.
import type { App } from '../../app';
import { listAuditEvents } from '../../db/audit';
import type { AuditEvent } from '../../db/types';
import { paths } from '../paths';
import { renderPage } from '../render';
import { Code, EmptyState, Field, Messages, NextPage, Select } from '../views/components';
import { formatTime, withQuery } from '../views/format';

const SECTION = paths.audit();
const PAGE_SIZE = 50;
const AUDIT_ID = /^aud_[0-9A-HJKMNP-TV-Z]{26}$/;
const TARGET_TYPE = /^[a-z_]{1,64}$/;
const MAX_TEXT_FILTER = 256;

/** Pages that hold each settings change, by audit action (settings rows have no target id). */
const SETTINGS_PAGES: Readonly<Record<string, string>> = {
  'settings.update': paths.retention(),
  'settings.upstream_hosts': paths.tokenHosts(),
  'settings.admin_hosts': paths.signIn('hosts'),
  'user.join_defaults': paths.signIn('policy'),
};

/** Target types written by the ops, with their labels and pages. */
const TARGETS: Readonly<
  Record<string, { label: string; page: (id: string, action: string) => string | null }>
> = {
  service: { label: 'Service token', page: (id) => paths.token(id) },
  caller_provider: { label: 'Service consumer', page: (id) => paths.consumer(id) },
  grant: { label: 'Consumer access', page: (id) => paths.accessItem(id) },
  user: { label: 'User', page: () => paths.users() },
  settings: {
    label: 'Settings',
    page: (_id, action) =>
      Object.hasOwn(SETTINGS_PAGES, action) ? (SETTINGS_PAGES[action] ?? null) : null,
  },
  keyring: { label: 'Encryption keys', page: () => paths.tokenKeys() },
};

type AuditQueryText = Record<'target_type' | 'target_id' | 'actor' | 'before', string>;

export function registerAuditRoutes(app: App): void {
  app.get(SECTION, async (c) => {
    const query: AuditQueryText = {
      target_type: (c.req.query('target_type') ?? '').trim(),
      target_id: (c.req.query('target_id') ?? '').trim(),
      actor: (c.req.query('actor') ?? '').trim(),
      before: c.req.query('before') ?? '',
    };
    const errors = queryErrors(query);
    if (errors.length > 0) {
      return renderPage(
        c,
        { title: 'Audit log', section: SECTION, status: 400 },
        <>
          <Messages errors={errors} />
          <AuditFilters query={query} />
        </>,
      );
    }
    const rows = await listAuditEvents(c.get('deps').env.DB, {
      targetType: query.target_type || undefined,
      targetId: query.target_id || undefined,
      // User emails are stored lowercased; user ids (`usr_…`) are case-sensitive.
      actor: (query.actor.includes('@') ? query.actor.toLowerCase() : query.actor) || undefined,
      before: query.before || undefined,
      limit: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    const next =
      rows.length > PAGE_SIZE && last ? withQuery(SECTION, { ...query, before: last.id }) : null;
    const filtered = Boolean(query.target_type || query.target_id || query.actor);
    return renderPage(
      c,
      { title: 'Audit log', section: SECTION },
      <>
        <p class="muted">
          Every change made in this admin UI, every sign-in, and events from the hourly maintenance
          job, newest first. Secrets are never recorded.
        </p>
        <AuditFilters query={query} />
        {query.before ? (
          <p>
            <a href={withQuery(SECTION, { ...query, before: '' })}>← Newest events</a>
          </p>
        ) : null}
        {page.length === 0 ? (
          filtered || query.before ? (
            <EmptyState>
              No audit events match these filters. <a href={SECTION}>Clear filters</a>
            </EmptyState>
          ) : (
            <EmptyState>
              No audit events yet. They appear when someone signs in or changes the configuration.
            </EmptyState>
          )
        ) : (
          <AuditTable events={page} />
        )}
        <NextPage href={next} />
      </>,
    );
  });
}

function queryErrors(query: AuditQueryText): string[] {
  const errors: string[] = [];
  if (query.target_type && !TARGET_TYPE.test(query.target_type)) {
    errors.push('The target type filter is not valid.');
  }
  if (query.target_id.length > MAX_TEXT_FILTER) errors.push('The target id filter is too long.');
  if (query.actor.length > MAX_TEXT_FILTER) errors.push('The actor filter is too long.');
  if (query.before && !AUDIT_ID.test(query.before)) {
    errors.push('The page position (before) is not a valid audit event id.');
  }
  return errors;
}

function AuditFilters(props: { query: AuditQueryText }) {
  const { query } = props;
  const options = [
    { value: '', label: 'Any target' },
    ...Object.entries(TARGETS).map(([value, target]) => ({ value, label: target.label })),
  ];
  // Only a well-formed type gets its own option: arbitrary query text is never shown as a label.
  if (TARGET_TYPE.test(query.target_type) && !Object.hasOwn(TARGETS, query.target_type)) {
    options.push({ value: query.target_type, label: query.target_type });
  }
  return (
    <form method="get" action={SECTION} class="filters" aria-label="Filter audit log">
      <Select label="Target type" name="target_type" value={query.target_type} options={options} />
      <Field
        label="Target ID"
        name="target_id"
        value={query.target_id}
        placeholder="svc_…"
        hint="ID of the service, grant, caller provider or user."
      />
      <Field
        label="Actor"
        name="actor"
        value={query.actor}
        placeholder="alice@example.com"
        hint="Email or user ID of who made the change."
      />
      <button type="submit">Apply filters</button>
      <a href={SECTION}>Clear</a>
    </form>
  );
}

function TargetCell(props: { event: AuditEvent }) {
  const { target_type: type, target_id: id, action } = props.event;
  if (!type) return <>—</>;
  const target = Object.hasOwn(TARGETS, type) ? TARGETS[type] : undefined;
  const label = target?.label ?? type;
  const page = target?.page(id ?? '', action) ?? null;
  if (!id) return page ? <a href={page}>{label}</a> : <>{label}</>;
  return (
    <>
      {label}{' '}
      {page ? (
        <a href={page}>
          <Code>{id}</Code>
        </a>
      ) : (
        <Code>{id}</Code>
      )}
      <br />
      <small>
        <a href={withQuery(SECTION, { target_type: type, target_id: id })}>History</a>
      </small>
    </>
  );
}

function AuditTable(props: { events: AuditEvent[] }) {
  return (
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Actor</th>
            <th scope="col">Action</th>
            <th scope="col">Target</th>
            <th scope="col">Summary and changes</th>
          </tr>
        </thead>
        <tbody>
          {props.events.map((event) => (
            <tr>
              <td>{formatTime(event.ts)}</td>
              <td class="wrap">
                {event.actor_type === 'system' ? (
                  <span class="muted">system</span>
                ) : event.actor_email ? (
                  <a href={withQuery(SECTION, { actor: event.actor_email })}>{event.actor_email}</a>
                ) : (
                  (event.actor_id ?? '—')
                )}
              </td>
              <td>
                <Code>{event.action}</Code>
              </td>
              <td class="wrap">
                <TargetCell event={event} />
              </td>
              <td class="wrap">
                {event.summary}
                <AuditDetails event={event} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Before/after JSON and request metadata, collapsed by default (<details> needs no script). */
function AuditDetails(props: { event: AuditEvent }) {
  const { diff, ip, user_agent: userAgent, id } = props.event;
  const { before, after, ...other } = diff ?? {};
  const hasOther = Object.keys(other).length > 0;
  return (
    <details class="audit-diff">
      <summary>Details</summary>
      <div class="diff">
        {before !== undefined ? (
          <div>
            <b>Before</b>
            <pre>{prettyJson(before)}</pre>
          </div>
        ) : null}
        {after !== undefined ? (
          <div>
            <b>After</b>
            <pre>{prettyJson(after)}</pre>
          </div>
        ) : null}
      </div>
      {hasOther ? (
        <div>
          <b>Other details</b>
          <pre>{prettyJson(other)}</pre>
        </div>
      ) : null}
      <p class="muted">
        Event <Code>{id}</Code>
        {ip ? ` · IP ${ip}` : ''}
        {userAgent ? ` · ${userAgent}` : ''}
      </p>
    </details>
  );
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}
