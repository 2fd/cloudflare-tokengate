// Views shared by the Monitoring pages (Overview, Requests, Audit log, Data retention): the
// "Find a request" form of the subnav, the KPI list, the Top denials table and the audit event
// texts and target links. Section-owned primitives live here, not in components.tsx.
import type { Child } from 'hono/jsx';
import type { DenialGroup } from '../../db/rollups';
import type { AuditEvent, CallerProvider, Service } from '../../db/types';
import { PROFILES } from '../../identity/profiles';
import type { ProfileId } from '../../identity/types';
import type { Percentile, TrafficStats } from '../../telemetry/dashboard';
import { type OverviewRange, RANGE_LABEL } from '../../telemetry/ranges';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { DataTable, Field, Time } from './components';
import { formatCount, formatDuration, formatPercent, formatShortTime } from './format';
import { accessFixable, reasonText } from './reasons';

// ---------------------------------------------------------------------------------------------
// Find a request (subnav of every Monitoring page)

/** A request id anywhere in pasted text (a whole CI log line works), any case. */
export const REQUEST_ID_IN_TEXT = /req_[0-9A-Za-z]{26}/i;
export const FIND_REQUEST_PATTERN = '.*[Rr][Ee][Qq]_[0-9A-Za-z]{26}.*';
export const FIND_REQUEST_MAX = 512;

/** The id `text` contains, normalised to `req_` plus 26 upper-case characters, or null. */
export function extractRequestId(text: string): string | null {
  const match = REQUEST_ID_IN_TEXT.exec(text.slice(0, FIND_REQUEST_MAX));
  return match ? `req_${match[0].slice(4).toUpperCase()}` : null;
}

export function FindRequestForm(props: { value?: string; error?: string | null }) {
  return (
    <form role="search" method="get" action={paths.requests()} class="find-request">
      <Field
        name="id"
        type="search"
        label="Find a request"
        value={props.value}
        example="req_01JB8Z5K2Q7W3N4M6P8R9T0V1X"
        hint="The request ID from the x-tokengate-request-id header or the error body. You can paste the whole log line."
        error={props.error}
        pattern={FIND_REQUEST_PATTERN}
        maxlength={FIND_REQUEST_MAX}
        autocomplete="off"
        spellcheck={false}
        autocapitalize="none"
        enterkeyhint="go"
      />
      <button type="submit" class="secondary">
        Go<span class="vh"> to the request</span>
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Traffic

/** Percentiles in the open-ended bucket only have a lower bound. */
export function percentileText(p: Percentile | null): string {
  if (p === null) return '—';
  if (p.overflow) return `≥ ${Math.round(p.ms / 1000)} s`;
  return formatDuration(p.ms);
}

const KPI_NOUN = {
  allowed: 'allowed requests',
  denied: 'denied requests',
  error: 'requests with errors',
} as const;

/** Requests · Allowed · Denied · Errors (count and %) · p50 · p95; every count links to its list. */
export function KpiList(props: { totals: TrafficStats; range: OverviewRange }) {
  const { totals: t, range } = props;
  // The number alone is not a link name (2.4.4): the hidden text names the list it opens.
  const link = (n: number, outcome?: 'allowed' | 'denied' | 'error') => (
    <a href={paths.requests({ range, outcome })}>
      {formatCount(n)}
      <span class="vh">
        {' '}
        {outcome ? KPI_NOUN[outcome] : 'requests'}, last {RANGE_LABEL[range]}
      </span>
    </a>
  );
  return (
    <dl class="kpis">
      <div>
        <dt>Requests</dt>
        <dd>{link(t.requests)}</dd>
      </div>
      <div>
        <dt>Allowed</dt>
        <dd>{link(t.allowed, 'allowed')}</dd>
      </div>
      <div>
        <dt>Denied</dt>
        <dd>{link(t.denied, 'denied')}</dd>
      </div>
      <div>
        <dt>Errors</dt>
        <dd>
          {link(t.errors, 'error')} <span class="muted">({formatPercent(t.errorRate)})</span>
        </dd>
      </div>
      <div>
        <dt>Median latency (p50)</dt>
        <dd>{percentileText(t.p50)}</dd>
      </div>
      <div>
        <dt>p95 latency</dt>
        <dd>{percentileText(t.p95)}</dd>
      </div>
    </dl>
  );
}

// ---------------------------------------------------------------------------------------------
// Top denials

/**
 * Built-in issuer constant → consumer type, for "Add a service consumer" on `issuer_unknown`. The
 * link carries a value of this closed set, never text from the unverified token (I-LOG-2).
 */
export const PROFILE_BY_ISSUER: ReadonlyMap<string, ProfileId> = new Map(
  Object.values(PROFILES).flatMap((profile) =>
    profile.sharedIssuers.map((issuer) => [issuer, profile.id] as const),
  ),
);

/** The consumer type of an unverified issuer, only when it is exactly a built-in constant. */
export function profileForIssuer(issuer: string | null): ProfileId | undefined {
  return issuer === null ? undefined : PROFILE_BY_ISSUER.get(issuer);
}

export function DenialTable(props: {
  groups: readonly DenialGroup[];
  range: OverviewRange;
  since: number;
  consumers: ReadonlyMap<string, Pick<CallerProvider, 'name'>>;
  tokens: ReadonlyMap<string, Pick<Service, 'name' | 'slug'>>;
  ctx: ViewContext;
}) {
  const { consumers, tokens, ctx, range } = props;
  const tokenName = (g: DenialGroup) => tokens.get(g.service_id)?.name ?? g.service_slug ?? null;
  const callerText = (g: DenialGroup) => {
    const consumer = consumers.get(g.caller_provider_id)?.name;
    return [consumer, g.caller].filter(Boolean).join(' · ') || 'unknown caller';
  };
  return (
    <DataTable
      id="top-denials"
      caption={`Top denied callers since ${formatShortTime(props.since)}`}
      rowHeader="caller"
      rows={props.groups}
      columns={[
        {
          key: 'caller',
          header: 'Caller',
          render: (g) =>
            g.claims_verified === 1 ? (
              callerText(g)
            ) : (
              <>
                unverified token
                {g.caller ? (
                  <>
                    {' '}
                    from <code>{g.caller}</code>
                  </>
                ) : null}
              </>
            ),
        },
        {
          key: 'token',
          header: 'Token',
          render: (g) =>
            g.service_id && tokens.has(g.service_id) ? (
              <a href={paths.token(g.service_id)}>{tokenName(g)}</a>
            ) : g.service_slug ? (
              <code>{g.service_slug}</code>
            ) : (
              '—'
            ),
        },
        {
          key: 'reason',
          header: 'Reason',
          render: (g) => (g.reason ? (reasonText(g.reason) ?? g.reason) : '—'),
        },
        {
          key: 'requests',
          header: 'Requests',
          numeric: true,
          render: (g) => formatCount(g.requests),
        },
        {
          key: 'last',
          header: 'Last seen',
          render: (g) => (
            <a href={paths.request(g.latest_id)}>
              <Time ms={g.latest_ts} />
            </a>
          ),
        },
        {
          key: 'action',
          header: 'Action',
          render: (g) => (
            <DenialAction
              group={g}
              range={range}
              ctx={ctx}
              token={tokenName(g)}
              caller={g.claims_verified === 1 ? (g.caller ?? callerText(g)) : null}
            />
          ),
        },
      ]}
    />
  );
}

function DenialAction(props: {
  group: DenialGroup;
  range: OverviewRange;
  ctx: ViewContext;
  token: string | null;
  caller: string | null;
}) {
  const { group: g, ctx } = props;
  if (
    accessFixable(g.reason) &&
    g.latest_verified_id !== null &&
    g.claims_verified === 1 &&
    ctx.can('access:write')
  ) {
    return (
      <a href={paths.accessNew({ from_request: g.latest_verified_id })}>
        Create access
        <span class="vh">
          {' '}
          for {props.caller ?? 'this caller'}
          {props.token ? ` on ${props.token}` : ''}
        </span>
      </a>
    );
  }
  if (g.reason === 'issuer_unknown' && ctx.can('access:write')) {
    const type =
      g.claims_verified === 0 && g.caller_kind === 'issuer'
        ? profileForIssuer(g.caller)
        : undefined;
    return (
      <a href={paths.consumerNew(type ? { type } : undefined)}>
        Add a service consumer
        <span class="vh"> for this issuer</span>
      </a>
    );
  }
  return (
    <a
      href={paths.requests({
        range: props.range,
        outcome: 'denied',
        token: g.service_id || 'none',
        consumer: g.caller_provider_id || 'none',
        ...(g.reason ? { reason: g.reason } : {}),
        ...(g.claims_verified === 1 && g.caller_kind === 'repository' && g.caller
          ? { repo: g.caller }
          : {}),
      })}
    >
      See requests
      <span class="vh">
        {' '}
        from {props.caller ?? 'unverified callers'}
        {props.token ? ` to ${props.token}` : ''}
      </span>
    </a>
  );
}

// ---------------------------------------------------------------------------------------------
// Audit events

/** Plain-language text of each audit action (the code is shown next to it). */
export const AUDIT_ACTION_TEXT: Readonly<Record<string, string>> = {
  'service.create': 'Added a service token',
  'service.update': 'Changed a service token',
  'service.delete': 'Deleted a service token',
  'service.enable': 'Enabled a service token',
  'service.disable': 'Disabled a service token',
  'service.credential.set': 'Replaced secret',
  'service.credential.test': 'Tested a secret',
  'service.credential.test_result': 'Tested a secret',
  'credential.expiring': 'Secret expires soon',
  'keyring.rewrap': 'Re-encrypted secrets',
  'settings.upstream_hosts': 'Changed the allowed hosts',
  'caller_provider.create': 'Added a service consumer',
  'caller_provider.update': 'Changed a service consumer',
  'caller_provider.delete': 'Deleted a service consumer',
  'caller_provider.enable': 'Enabled a service consumer',
  'caller_provider.disable': 'Disabled a service consumer',
  'grant.create': 'Gave access',
  'grant.update': 'Changed access',
  'grant.delete': 'Deleted access',
  'grant.enable': 'Enabled access',
  'grant.disable': 'Disabled access',
  'grant.duplicate': 'Copied access to another token',
  'user.invite': 'Invited a person',
  'user.update': 'Changed a person',
  'user.approve': 'Approved a person',
  'user.reject': 'Rejected a person',
  'user.delete': 'Cancelled an invitation',
  'user.dismiss_attempt': 'Dismissed a refused sign-in',
  'user.join_defaults': 'Changed the join policy',
  'user.reset_login': 'Reset a sign-in',
  'user.resend_invite': 'Renewed an invitation',
  'settings.admin_hosts': 'Changed the admin hosts',
  'user.bootstrap': 'First owner signed in',
  'user.join': 'Joined by signing in',
  'user.link': 'Accepted an invitation',
  'settings.update': 'Changed data retention',
  'config.export': 'Downloaded the configuration export',
};

export function actionText(action: string): string | null {
  return Object.hasOwn(AUDIT_ACTION_TEXT, action) ? (AUDIT_ACTION_TEXT[action] ?? null) : null;
}

/** Pages that hold each settings change, by audit action (settings rows have no target id). */
const SETTINGS_PAGES: Readonly<Record<string, string>> = {
  'settings.update': paths.retention(),
  'settings.upstream_hosts': paths.tokenHosts(),
  'settings.admin_hosts': paths.signIn('hosts'),
  'user.join_defaults': paths.signIn('policy'),
};

/** Target types written by the ops: the noun, the id prefix and the entity page. */
export const AUDIT_TARGETS: Readonly<
  Record<
    string,
    {
      label: string;
      noun: string;
      prefix: string | null;
      page: (id: string, action: string) => string | null;
    }
  >
> = {
  service: { label: 'Service token', noun: 'token', prefix: 'svc', page: (id) => paths.token(id) },
  caller_provider: {
    label: 'Service consumer',
    noun: 'consumer',
    prefix: 'cpr',
    page: (id) => paths.consumer(id),
  },
  grant: {
    label: 'Consumer access',
    noun: 'access',
    prefix: 'grt',
    page: (id) => paths.accessItem(id),
  },
  user: { label: 'User', noun: 'user', prefix: 'usr', page: (id) => paths.user(id) },
  settings: {
    label: 'Settings',
    noun: 'settings',
    prefix: null,
    page: (_id, action) =>
      Object.hasOwn(SETTINGS_PAGES, action) ? (SETTINGS_PAGES[action] ?? null) : null,
  },
  keyring: {
    label: 'Encryption keys',
    noun: 'encryption keys',
    prefix: null,
    page: () => paths.tokenKeys(),
  },
};

/** The `target` filter value of an event's target: its id, or `settings` / `keyring`. */
export function auditTargetValue(
  event: Pick<AuditEvent, 'target_type' | 'target_id'>,
): string | null {
  if (event.target_type === 'settings' || event.target_type === 'keyring') return event.target_type;
  return event.target_id;
}

/**
 * The entity an event concerns, as a link with its current name; "deleted token svc_…" when it
 * no longer exists. `names` maps ids of existing entities to their names.
 */
export function AuditTarget(props: {
  event: AuditEvent;
  names: ReadonlyMap<string, string>;
  history?: boolean;
}) {
  const { target_type: type, target_id: id, action } = props.event;
  if (!type) return <>—</>;
  const target = Object.hasOwn(AUDIT_TARGETS, type) ? AUDIT_TARGETS[type] : undefined;
  const label = target?.label ?? type;
  const page = target?.page(id ?? '', action) ?? null;
  const value = auditTargetValue(props.event);
  const history: Child =
    props.history && value ? (
      <>
        {' '}
        <a class="secondary-text" href={paths.audit({ target: value })}>
          History<span class="vh"> of this {target?.noun ?? 'object'}</span>
        </a>
      </>
    ) : null;
  if (!id)
    return (
      <>
        {page ? <a href={page}>{label}</a> : label}
        {history}
      </>
    );
  const name = props.names.get(id);
  if (target?.prefix && name === undefined) {
    return (
      <>
        deleted {target.noun} <code>{id}</code>
        {history}
      </>
    );
  }
  return (
    <>
      {page ? <a href={page}>{name ?? id}</a> : (name ?? <code>{id}</code>)}
      {name ? <span class="vh"> ({label})</span> : null}
      {history}
    </>
  );
}

/** Who made a change: "System (hourly job)", or the email, "(suspended)" for a suspended user. */
export function auditActorText(
  event: Pick<AuditEvent, 'actor_type' | 'actor_email' | 'actor_id'>,
  suspended: ReadonlySet<string>,
): string {
  if (event.actor_type === 'system') return 'System (hourly job)';
  const who = event.actor_email ?? event.actor_id ?? 'unknown';
  return event.actor_id && suspended.has(event.actor_id) ? `${who} (suspended)` : who;
}
