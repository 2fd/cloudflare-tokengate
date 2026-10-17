// Views shared by the Monitoring pages (Overview, Requests, Audit log, Data retention): "Find a
// request", the log pager and times, the logo tiles, the request pipeline, the Top denied callers
// table, the Needs attention items, and the audit event texts, avatars and target links.
// Section-owned compositions of ui components live here, not in components.tsx.
import {
  ArrowRow,
  type AttentionItem,
  Avatar,
  Button,
  Cell,
  ConfirmDialog,
  CountLink,
  FieldInline,
  formatTime,
  Icon,
  type LogoBrand,
  type LogoSpec,
  NeedsAttention,
  type PipelineStage,
  Row,
  RowHeader,
  Table,
  Pager as UiPager,
  Time as UiTime,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import type { DenialGroup } from '../../db/rollups';
import type { AuditEvent, CallerProvider, Role, Service } from '../../db/types';
import { PROFILES } from '../../identity/profiles';
import type { ProfileId } from '../../identity/types';
import type { Percentile, TokenTraffic, TrafficStats } from '../../telemetry/dashboard';
import { DAY_MS, type OverviewRange, RANGE_LABEL } from '../../telemetry/ranges';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import type { Alert } from './alerts';
import { ActionButton, AskSomeone } from './components';
import { formatCount, formatDuration, formatPercent, relativeTime } from './format';
import { accessFixable, reasonText } from './reasons';
import { ROLE_INFO } from './roles';

// ---------------------------------------------------------------------------------------------
// Find a request (header actions of the Monitoring pages)

/** A request id anywhere in pasted text (a whole CI log line works), any case. */
export const REQUEST_ID_IN_TEXT = /req_[0-9A-Za-z]{26}/i;
export const FIND_REQUEST_PATTERN = '.*[Rr][Ee][Qq]_[0-9A-Za-z]{26}.*';
export const FIND_REQUEST_MAX = 512;

/** The id `text` contains, normalised to `req_` plus 26 upper-case characters, or null. */
export function extractRequestId(text: string): string | null {
  const match = REQUEST_ID_IN_TEXT.exec(text.slice(0, FIND_REQUEST_MAX));
  return match ? `req_${match[0].slice(4).toUpperCase()}` : null;
}

/**
 * "Find a request" (ui FieldInline, GET to the Requests list) with its hint under the box. On
 * every Monitoring page: in the page header actions, or in a tray (the Overview "Where calls
 * went" bar), or in a narrow panel (the fresh Overview's Traffic tray), where the box says
 * "Request ID". The input id stays `f-id`, so the ErrorSummary of a failed lookup links to it.
 */
export function FindRequest(props: {
  value?: string;
  error?: string | null;
  placement: 'header' | 'tray' | 'panel';
}) {
  return (
    <div class="find">
      <FieldInline
        id="f-id"
        name="id"
        type="search"
        label={props.placement === 'panel' ? 'Request ID' : 'Find a request'}
        submit="Find"
        method="get"
        action={paths.requests()}
        formLabel="Find a request"
        placeholder="req_01JB8Z5K2Q7W3N4M6P8R9T0V1X"
        value={props.value}
        pattern={FIND_REQUEST_PATTERN}
        maxlength={FIND_REQUEST_MAX}
        enterkeyhint="go"
        error={props.error ?? undefined}
        describedBy="f-id-hint"
        class="find-request"
      />
      <span class="hint" id="f-id-hint">
        Paste the ID (x-tokengate-request-id) or the whole log line from CI.
      </span>
    </div>
  );
}

/**
 * The pager under a log (Requests, Audit log): what is shown, then "Newest entries" on an older
 * page, Newer and Older as small buttons; a missing end is faint text, never a dead link.
 */
export function LogPager(props: {
  summary: Child;
  newest?: string | null;
  newer?: string | null;
  older?: string | null;
}) {
  return (
    <UiPager
      summary={props.summary}
      newest={props.newest ?? undefined}
      newestLabel="Newest entries"
      newer={props.newer ?? undefined}
      older={props.older ?? undefined}
      buttons
      label="Pages"
    />
  );
}

/** A relative time ("3 min ago") that keeps the exact moment in its `datetime`. */
export function Ago(props: { ms: number; now: number }) {
  return <UiTime datetime={new Date(props.ms)}>{relativeTime(props.ms, props.now)}</UiTime>;
}

/** A log cell time: 14:03:22 for today (UTC), "16 Oct 23:59:10" earlier this year, "15 Oct 2025, 14:03" before. Mono. */
export function LogTime(props: { ms: number; now: number }) {
  const date = new Date(props.ms);
  if (sameUtcDay(props.ms, props.now)) return <UiTime mono datetime={date} format="time" />;
  // earlier this year: "16 Oct 23:59:10", short enough to keep the log on one line per row
  return new Date(props.now).getUTCFullYear() === date.getUTCFullYear() ? (
    <UiTime mono datetime={date}>
      {`${formatTime(date, 'day')} ${formatTime(date, 'time')}`}
    </UiTime>
  ) : (
    <UiTime mono datetime={date} format="datetime" />
  );
}

function sameUtcDay(a: number, b: number): boolean {
  return Math.floor(a / 86_400_000) === Math.floor(b / 86_400_000);
}

// ---------------------------------------------------------------------------------------------
// Logo tiles (decorative: the name is always next to them)

/** The brand tile of a token, from the template it was made from; `custom` otherwise. */
export function tokenLogo(
  token: Pick<Service, 'template_id' | 'enabled'> | null | undefined,
): LogoSpec {
  const template = token?.template_id ?? '';
  const brand: LogoBrand = template.startsWith('slack')
    ? 'slack'
    : template.startsWith('discord')
      ? 'discord'
      : template.startsWith('openai')
        ? 'openai'
        : template.startsWith('anthropic')
          ? 'anthropic'
          : template.startsWith('github')
            ? 'github'
            : 'custom';
  return token && !token.enabled ? { brand, disabled: true } : brand;
}

/** The brand tile of a consumer, from its profile; the OIDC key otherwise. */
export function consumerLogo(
  consumer: Pick<CallerProvider, 'profile' | 'enabled'> | null | undefined,
): LogoSpec {
  const brand: LogoBrand =
    consumer?.profile === 'github-actions'
      ? 'github'
      : consumer?.profile === 'gitlab-ci'
        ? 'gitlab'
        : 'oidc';
  return consumer && !consumer.enabled ? { brand, disabled: true } : brand;
}

// ---------------------------------------------------------------------------------------------
// Traffic

/** Percentiles in the open-ended bucket only have a lower bound. */
export function percentileText(p: Percentile | null): string {
  if (p === null) return '—';
  if (p.overflow) return `≥ ${Math.round(p.ms / 1000)} s`;
  return formatDuration(p.ms);
}

/** The four pipeline counts and the calls lost between them. */
export interface PipelineCounts {
  /** Every request in the range. */
  received: number;
  /** Stopped before a token was chosen (the `''` token bucket). */
  refused: number;
  /** Caller verified and token found. */
  resolved: number;
  /** Denied after the token was found: no access, path, rate limit, credential problems. */
  deniedAfter: number;
  matched: number;
  /** Gateway errors and upstream 5xx after the token was found. */
  errorsAfter: number;
  /** Allowed and not answered with 5xx. */
  ok: number;
}

/**
 * Where calls went, from the per-token traffic: the `''` bucket holds every request stopped before
 * a token was chosen (no, bad or unknown caller token, tenant mismatch, unknown or disabled slug,
 * and gateway errors raised there), so only its denials and errors are lost at stage 1. The
 * errors after it are subtracted once: `ok = matched − (errors − errors before)`.
 */
export function pipelineCounts(
  totals: Pick<TrafficStats, 'requests' | 'denied' | 'errors'>,
  tokens: readonly Pick<TokenTraffic, 'serviceId' | 'requests' | 'denied' | 'errors'>[],
): PipelineCounts {
  const unresolved = tokens.find((t) => t.serviceId === '');
  const received = totals.requests;
  const refused = unresolved?.requests ?? 0;
  const resolved = received - refused;
  const deniedAfter = totals.denied - (unresolved?.denied ?? 0);
  const matched = resolved - deniedAfter;
  const errorsAfter = totals.errors - (unresolved?.errors ?? 0);
  return {
    received,
    refused,
    resolved,
    deniedAfter,
    matched,
    errorsAfter,
    ok: matched - errorsAfter,
  };
}

function seeRequests(n: number): string {
  return `See ${formatCount(n)} ${n === 1 ? 'request' : 'requests'}`;
}

/** The pipeline stages of the Overview: every count links to the request list it counts. */
export function pipelineStages(
  totals: TrafficStats,
  tokens: readonly TokenTraffic[],
  range: OverviewRange,
  tokenNames: ReadonlyMap<string, string>,
): PipelineStage[] {
  const c = pipelineCounts(totals, tokens);
  const pct = (n: number) => (c.received > 0 ? formatPercent(n / c.received) : '0.0%');
  const erroring = tokens
    .filter((t) => t.serviceId !== '' && t.errors > 0)
    .map((t) => `${tokenNames.get(t.serviceId) ?? 'a deleted token'} ${formatCount(t.errors)}`);
  return [
    {
      label: 'Received',
      value: c.received,
      meta: `last ${RANGE_LABEL[range]}`,
      href: paths.requests({ range }),
      totals: [
        {
          label: 'Denied',
          count: totals.denied,
          share: pct(totals.denied),
          href: paths.requests({ range, outcome: 'denied' }),
        },
        {
          label: 'Errors',
          count: totals.errors,
          share: pct(totals.errors),
          href: paths.requests({ range, outcome: 'error' }),
          kind: 'error',
        },
      ],
    },
    {
      label: 'Caller verified',
      value: c.resolved,
      meta: `${pct(c.resolved)} of received`,
      drop: {
        count: c.refused,
        unit: 'not recognized',
        why: 'Refused before a token was chosen: no or bad caller token, unknown issuer, or unknown token slug.',
        ...(c.refused > 0 ? { href: paths.requests({ range, token: 'none' }) } : {}),
        go: seeRequests(c.refused),
      },
    },
    {
      label: 'Access matched',
      value: c.matched,
      meta: `${pct(c.matched)} of received`,
      drop: {
        count: c.deniedAfter,
        unit: 'no access',
        why: 'Verified callers that no consumer access allows, or a token problem.',
        go: seeRequests(c.deniedAfter),
        ...(c.deniedAfter > 0 ? { href: paths.requests({ range, outcome: 'denied' }) } : {}),
      },
    },
    {
      label: 'Upstream OK · allowed',
      value: c.ok,
      meta: `${pct(c.ok)} · p50 ${percentileText(totals.p50)} · p95 ${percentileText(totals.p95)}`,
      href: paths.requests({ range, outcome: 'allowed' }),
      drop: {
        count: c.errorsAfter,
        unit: 'errors',
        kind: 'error',
        go: seeRequests(c.errorsAfter),
        why: `${erroring.length > 0 ? `${erroring.join(' · ')}. ` : ''}Gateway errors and upstream 5xx answers.`,
        ...(c.errorsAfter > 0 ? { href: paths.requests({ range, outcome: 'error' }) } : {}),
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Top denied callers

/**
 * Built-in issuer constant → consumer type, for "Add consumer" on `issuer_unknown`. The link
 * carries a value of this closed set, never text from the unverified token (I-LOG-2).
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

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The exact request list of one denial group. */
function groupHref(g: DenialGroup, range: OverviewRange): string {
  return paths.requests({
    range,
    outcome: 'denied',
    token: g.service_id || 'none',
    consumer: g.caller_provider_id || 'none',
    ...(g.reason ? { reason: g.reason } : {}),
    ...(g.claims_verified === 1 && g.caller_kind === 'repository' && g.caller
      ? { repo: g.caller }
      : {}),
  });
}

/**
 * Top denied callers (ui Table): caller → token with the reason under it, the count as a link to
 * exactly that group, when it was last seen and the one fix the viewer may take.
 */
export function TopDenied(props: {
  groups: readonly DenialGroup[];
  range: OverviewRange;
  caption: string;
  now: number;
  consumers: ReadonlyMap<string, Pick<CallerProvider, 'name' | 'profile' | 'enabled'>>;
  tokens: ReadonlyMap<string, Pick<Service, 'name' | 'slug' | 'template_id' | 'enabled'>>;
  ctx: ViewContext;
}) {
  const { consumers, tokens, ctx, range } = props;
  const tokenName = (g: DenialGroup) => tokens.get(g.service_id)?.name ?? g.service_slug ?? null;
  return (
    <Table
      labelledBy="denials-h"
      caption={props.caption}
      stackable
      columns={[
        { label: 'Caller → token' },
        { label: 'Requests', num: true },
        { label: 'Last seen' },
        { label: 'Action', act: true },
      ]}
    >
      {props.groups.map((g) => {
        const verified = g.claims_verified === 1;
        const consumer = consumers.get(g.caller_provider_id);
        const token = tokenName(g);
        const caller = verified ? (g.caller ?? consumer?.name ?? 'unknown caller') : null;
        return (
          <Row>
            <RowHeader>
              <span class="ent-t">
                <ArrowRow
                  verb="to"
                  consumer={{
                    name: <span class="ent-n">{caller ?? 'Unverified token'}</span>,
                    logo: verified ? consumerLogo(consumer) : 'oidc',
                    // read from a token that was not trusted: text only, never in a link
                    context:
                      !verified && g.caller ? (
                        <>
                          from <code>{g.caller}</code>
                        </>
                      ) : undefined,
                  }}
                  token={
                    g.service_id && token
                      ? { name: token, logo: tokenLogo(tokens.get(g.service_id)) }
                      : undefined
                  }
                />
                <span class="meta">
                  <span class="t-bad">
                    <span aria-hidden="true">✕ </span>
                    {g.reason ? capitalise(reasonText(g.reason) ?? g.reason) : 'Denied'}
                  </span>{' '}
                  ·{' '}
                  {consumer?.name ??
                    (g.service_id
                      ? 'no service consumer'
                      : `refused before a token was chosen${g.service_slug ? ` for /proxy/${g.service_slug}` : ''}`)}
                </span>
              </span>
            </RowHeader>
            <Cell label="Requests" num>
              <CountLink
                tone="bad"
                href={groupHref(g, range)}
                srSuffix={`denied requests from ${caller ?? 'unverified callers'}${token ? ` to ${token}` : ''}`}
              >
                {formatCount(g.requests)}
              </CountLink>
            </Cell>
            <Cell label="Last seen">
              <a href={paths.request(g.latest_id)}>
                <Ago ms={g.latest_ts} now={props.now} />
              </a>
            </Cell>
            <Cell act>
              <DenialAction group={g} range={range} ctx={ctx} token={token} caller={caller} />
            </Cell>
          </Row>
        );
      })}
    </Table>
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
      <Button
        size="sm"
        href={paths.accessNew({ from_request: g.latest_verified_id })}
        srSuffix={`for ${props.caller ?? 'this caller'}${props.token ? ` on ${props.token}` : ''}`}
      >
        Give access
      </Button>
    );
  }
  if (g.reason === 'issuer_unknown' && ctx.can('access:write')) {
    const type =
      g.claims_verified === 0 && g.caller_kind === 'issuer'
        ? profileForIssuer(g.caller)
        : undefined;
    return (
      <Button
        size="sm"
        href={paths.consumerNew(type ? { type } : undefined)}
        srSuffix="for this issuer"
      >
        Add consumer
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      href={groupHref(g, props.range)}
      srSuffix={`from ${props.caller ?? 'unverified callers'}${props.token ? ` to ${props.token}` : ''}`}
    >
      See requests
    </Button>
  );
}

// ---------------------------------------------------------------------------------------------
// Needs attention

const ATTENTION_LEVEL = { error: 'bad', warning: 'warn', info: 'info' } as const;

/** The roles Approve offers as one click each; Owner opens a confirm dialog. */
const APPROVE_ROLES: readonly Exclude<Role, 'owner'>[] = [
  'viewer',
  'token_manager',
  'access_manager',
  'admin',
];

/**
 * The alerts as Needs attention items, worst first: the objects are always shown, the fix only
 * with its permission (AskSomeone otherwise). A pending-people alert becomes one item per person
 * with the approve buttons for `users:write`, and never names them to anyone else.
 */
export function toAttentionItems(alerts: readonly Alert[], ctx: ViewContext): AttentionItem[] {
  return alerts.flatMap((alert): AttentionItem[] => {
    const level = ATTENTION_LEVEL[alert.level];
    const objects =
      alert.objects.length > 0 ? (
        <>
          {alert.objects.map((object, index) => (
            <>
              {index > 0 ? ' · ' : null}
              <a href={object.href}>{object.label}</a>
            </>
          ))}
        </>
      ) : null;
    const body =
      alert.detail || objects ? (
        <>
          {alert.detail}
          {alert.detail && objects ? ' ' : null}
          {objects}
        </>
      ) : undefined;
    const form = alert.form ?? null;
    if (form?.kind === 'approve-pending' && ctx.can('users:write') && form.users.length > 0) {
      return form.users.map((user, index) => ({
        level,
        title: index === 0 ? alert.title : 'Another person needs a decision.',
        // The role buttons follow the sentence ("Approve as:"), wrapping at their own width.
        body: (
          <>
            {user.name ? (
              <>
                <b>{user.name}</b> · {user.email}
              </>
            ) : (
              <b>{user.email}</b>
            )}{' '}
            · signed in first <Ago ms={user.updated_at} now={ctx.now} />. Approve as:
          </>
        ),
        approve: {
          id: `approve-${user.id}`,
          action: `/admin/users/${encodeURIComponent(user.id)}/approve`,
          subject: user.email,
          hidden: ctx.hidden({ _return: 'overview' }),
          roles: [
            ...APPROVE_ROLES.map((role) => ({ value: role, label: ROLE_INFO[role].label })),
            { value: 'owner', label: 'Owner…', dialog: `approve-owner-${user.id}` },
          ],
          reject: {
            action: `/admin/users/${encodeURIComponent(user.id)}/reject`,
            hidden: ctx.hidden({ _return: 'overview' }),
            srSuffix: user.email,
          },
        },
      }));
    }
    const fix = alert.fix ?? null;
    const actions: Child[] = [];
    if (fix && ctx.can(fix.permission)) {
      actions.push(
        fix.short ? (
          <Button size="sm" href={fix.href} srSuffix={fix.short.srSuffix}>
            {fix.short.label}
          </Button>
        ) : (
          <Button size="sm" href={fix.href}>
            {fix.label}
          </Button>
        ),
      );
    }
    if (form?.kind === 'rewrap' && ctx.can('keyring:rewrap')) {
      actions.push(
        <ActionButton
          action="/admin/tokens/keys/rewrap"
          csrf={ctx.csrf}
          returnTo="overview"
          size="sm"
          label={`Re-encrypt ${form.count} ${form.count === 1 ? 'secret' : 'secrets'} with the active key`}
        />,
      );
    }
    if (fix && !ctx.can(fix.permission)) {
      actions.push(<AskSomeone permission={fix.permission} ctx={ctx} />);
    }
    if (form?.kind === 'approve-pending' && !ctx.can('users:write')) {
      actions.push(<AskSomeone permission="users:write" ctx={ctx} />);
    }
    return [
      {
        level,
        title: alert.title,
        ...(body !== undefined ? { body } : {}),
        ...(actions.length > 0 ? { actions: <>{actions}</> } : {}),
      },
    ];
  });
}

/** The Owner… confirm dialogs of the approve items: each submits its approve form as Owner. */
export function ApproveOwnerDialogs(props: { alerts: readonly Alert[]; ctx: ViewContext }) {
  if (!props.ctx.can('users:write')) return null;
  const users = props.alerts.flatMap((alert) =>
    alert.form?.kind === 'approve-pending' ? alert.form.users : [],
  );
  return (
    <>
      {users.map((user) => (
        <ConfirmDialog
          id={`approve-owner-${user.id}`}
          title={`Approve ${user.email} as Owner?`}
          description={`Owner: ${ROLE_INFO.owner.description}`}
          confirmLabel={`Approve ${user.email} as Owner`}
          confirmVariant="primary"
          form={`approve-${user.id}`}
          name="role"
          value="owner"
          formnovalidate
        />
      ))}
    </>
  );
}

/** Needs attention as cards (or a list), the rest past `max` in a disclosure: never dropped. */
export function AttentionCards(props: {
  items: readonly AttentionItem[];
  layout: 'cols' | 'list';
  max?: number;
}) {
  const max = props.max ?? 8;
  const shown = props.items.slice(0, max);
  const rest = props.items.slice(max);
  return (
    <>
      <NeedsAttention items={shown} layout={props.layout} />
      {rest.length > 0 ? (
        <details class="disc">
          <summary>
            {rest.length} more {rest.length === 1 ? 'problem' : 'problems'}
          </summary>
          <div class="disc-b">
            <NeedsAttention items={rest} layout="list" />
          </div>
        </details>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Feeds

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The UTC day of a feed group: "Today", "Yesterday", "3 Oct" (and the year when it is not this
 * year); with `withDate`, "Today, 15 Oct" and "Yesterday, 14 Oct".
 */
export function dayLabel(ms: number, now: number, withDate = false): string {
  const day = Math.floor(ms / DAY_MS);
  const today = Math.floor(now / DAY_MS);
  const date = new Date(ms);
  const short = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  if (day === today) return withDate ? `Today, ${short}` : 'Today';
  if (day === today - 1) return withDate ? `Yesterday, ${short}` : 'Yesterday';
  return date.getUTCFullYear() === new Date(now).getUTCFullYear()
    ? short
    : `${short} ${date.getUTCFullYear()}`;
}

/** Events in UTC day groups, in the order given (newest first). */
export function byUtcDay<T extends { ts: number }>(events: readonly T[]): T[][] {
  const days: T[][] = [];
  let current = Number.NaN;
  for (const event of events) {
    const day = Math.floor(event.ts / DAY_MS);
    if (day !== current) {
      days.push([]);
      current = day;
    }
    days.at(-1)?.push(event);
  }
  return days;
}

/** The decorative avatar of an event's actor: initials, or the system tile. */
export function ActorAvatar(props: { event: Pick<AuditEvent, 'actor_type' | 'actor_email'> }) {
  return props.event.actor_type === 'system' ? (
    <Avatar variant="sys">
      <Icon name="system" />
    </Avatar>
  ) : (
    <Avatar name={props.event.actor_email ?? ''} />
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
  const text = Object.hasOwn(AUDIT_ACTION_TEXT, action)
    ? (AUDIT_ACTION_TEXT[action] ?? null)
    : null;
  // it follows the actor in a sentence: "priya@acme.dev disabled a service token: Slack (legacy)."
  return text === null ? null : text.charAt(0).toLowerCase() + text.slice(1);
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
