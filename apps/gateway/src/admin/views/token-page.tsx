// The token page (A13.3): the header (identity, relation line, Test and the page's one primary),
// problems as callouts, who can use the token (a WhoCanUse map with the scale rule, or the
// hand-off), then the secret (with the inline rotate form), how consumers call it, the
// destination (changed only with the secret, I-CRED-2) with the details form, the danger zone,
// and a rail with the record and its history. Viewers and access managers get the same page
// without token forms, except the access manager's "Give a consumer access".
import {
  Avatar,
  Badge,
  Button,
  Callout,
  CodeBlock,
  ConfirmDialog,
  DangerRow,
  DangerZone,
  DetailLayout,
  DialogTrigger,
  Disclosure,
  Entity,
  Feed,
  FeedItem,
  Field,
  Icon,
  Identity,
  Input,
  KeyValue,
  Kpis,
  LinkAction,
  Mono,
  PageHeader,
  Panel,
  RailFoot,
  RailKeyValue,
  RelationLine,
  Secret,
  SubmitRow,
  Time,
  Tray,
  type WhoAccess,
  WhoCanUse,
  type WhoGroup,
  ZeroState,
  formatTime as uiFormatTime,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import { sealedKid } from '../../crypto/envelope';
import type { KeyringError } from '../../crypto/keyring';
import type { GrantUsage } from '../../db/rollups';
import type { AuditEvent, Service } from '../../db/types';
import type { Injection, VerifyCheck } from '../../policy/types';
import { CALLER_TOKEN_HEADER } from '../../proxy/caller-token';
import { EXPIRY_WARNING_MS, type TrafficStats } from '../../telemetry/dashboard';
import { CSRF_FIELD } from '../auth/csrf';
import type { Permission } from '../auth/rbac';
import type { AccessEdge } from '../connections';
import { KEYRING_ERROR_TEXT } from '../ops/keyring';
import type { StoredBinding } from '../ops/services';
import { storedUpstreamHost } from '../ops/upstream-hosts';
import type { VerifyOutcome } from '../ops/verify';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { REPO_PLACEHOLDER, SERVICE_TEMPLATES, type ServiceTemplate } from '../service-templates';
import { consumerLogo } from './access-visuals';
import {
  ActionButton,
  AskSomeone,
  Checkbox,
  PostForm,
  StatusBadge,
  VersionField,
} from './components';
import { formatCount, formatPercent, relativeTime } from './format';
import { percentileText } from './monitoring';
import type { StatusKey } from './status';
import { CUSTOM_SECRET } from './token-cards';
import {
  AdvancedFields,
  allowlistPattern,
  baseUrlSuggestions,
  CheckResult,
  dateInput,
  DetailFields,
  EMPTY_VALUES,
  ExpiryField,
  FormIds,
  type FormState,
  InjectionFields,
  inSentence,
  PATH_WARNING,
  QUERY_WARNING,
  SecretField,
  SecretSubmits,
  type TokenFormValues,
  valuesFromService,
} from './token-forms';
import {
  plural,
  secretParts,
  templateLogo,
  typeLabel,
  upstreamHost,
  upstreamShort,
} from './token-ui';

export { typeLabel, upstreamHost } from './token-ui';

const DAY_MS = 86_400_000;
/** The scale rule of the "Who can use" map: consumers drawn, and accesses per consumer. */
const MAP_GROUPS = 3;
const MAP_ROWS = 3;

export type BindingState = StoredBinding | { status: 'unknown' };

/** The `also` query of a token page notice: a second outcome of the same submit. */
export type TokenAlso =
  | 'host_added'
  | 'uploads_host_added'
  | 'hosts_added'
  | 'pair_failed'
  | 'pair_failed_hosts'
  | 'pair_failed_conflict'
  | 'pair_failed_check'
  | 'sibling_failed';

/** Why the uploads token of a GitHub create failed, per `also` code (a closed set, no free text). */
const PAIR_FAILURE_REASONS: Partial<Record<TokenAlso, string>> = {
  pair_failed: 'its settings were refused',
  pair_failed_hosts: 'uploads.github.com is not an allowed host',
  pair_failed_conflict: 'another change to the tokens happened at the same time',
  pair_failed_check: 'its secret check failed',
};

/** Days until `at`, rounded up (the "Expires in N days" count). */
export function daysUntil(at: number, now: number): number {
  return Math.ceil((at - now) / DAY_MS);
}

/** One token's status in the A9 vocabulary, most severe first. */
export function tokenStatus(
  service: Pick<Service, 'enabled' | 'credential_sealed' | 'credential_expires_at'>,
  o: { unreadable: boolean; outside: boolean; now: number },
): { status: StatusKey; detail?: string } {
  if (!service.enabled) return { status: 'disabled' };
  if (service.credential_sealed === null) return { status: 'no_credential' };
  if (o.unreadable) return { status: 'credential_unreadable' };
  if (o.outside) return { status: 'outside_hosts' };
  const expires = service.credential_expires_at;
  if (expires !== null && expires <= o.now) return { status: 'expired' };
  if (expires !== null && expires - o.now <= EXPIRY_WARNING_MS) {
    return { status: 'expiring', detail: String(daysUntil(expires, o.now)) };
  }
  return { status: 'active' };
}

export function injectionText(injection: Injection): string {
  switch (injection.kind) {
    case 'bearer':
      return 'Authorization: Bearer <secret>';
    case 'header':
      return `${injection.name}: ${injection.prefix ?? ''}<secret>`;
    case 'basic':
      return injection.username
        ? `HTTP Basic authentication as user "${injection.username}"`
        : 'HTTP Basic authentication (the secret is "username:password")';
    case 'query':
      return `query parameter ?${injection.param}=<secret>`;
    case 'path':
      // Same layout as credentialPathSegment (proxy/path.ts).
      return `URL path: <base URL>/${(injection.prefix ?? '').replace(/^\//, '')}<secret>/…`;
    default:
      return 'invalid stored injection; set the secret again under Change destination';
  }
}

export function verifyText(verify: VerifyCheck | null): string {
  if (!verify) return 'none';
  const okField = verify.expect_ok_field ? ' and "ok": true' : '';
  return `${verify.method} ${verify.path}, expecting HTTP ${verify.expect_status}${okField}`;
}

/** "3 h ago", or why there is no time. */
export function LastUsed(props: {
  hour: number | null;
  now: number;
  usageAvailable: boolean;
  sampleRate: number;
}) {
  if (props.sampleRate === 0) return <span class="muted">not recorded (sample rate 0)</span>;
  if (!props.usageAvailable) return <span class="muted">not available</span>;
  if (props.hour === null) return <span class="muted">not in the last 30 days</span>;
  return (
    <time datetime={new Date(props.hour).toISOString()}>{relativeTime(props.hour, props.now)}</time>
  );
}

/** Accesses that let a consumer call: enabled, unexpired, of an enabled consumer. */
export function usableAccesses(accesses: readonly AccessEdge[], now: number): AccessEdge[] {
  return accesses.filter(
    (edge) =>
      edge.grant.enabled &&
      (edge.grant.expires_at === null || edge.grant.expires_at > now) &&
      edge.consumer?.enabled === true,
  );
}

// ---------------------------------------------------------------------------------------------
// Page

export interface TokenPageData {
  service: Service;
  template: ServiceTemplate | null;
  binding: BindingState;
  keyringError: KeyringError | null;
  allowlist: string[] | null;
  /** The base URL's host is not on the allowlist (requests are refused). */
  outside: boolean;
  accesses: AccessEdge[];
  /** Allowed requests per access in the last 30 days (map order, relation line). */
  usage: ReadonlyMap<string, GrantUsage>;
  usageAvailable: boolean;
  sampleRate: number;
  /** Requests through the token in the last 24 hours (rail); null when telemetry is unreadable. */
  traffic: TrafficStats | null;
  lastSet: { ts: number; actor_email: string | null } | null;
  /** Who created the token (the `service.create` audit row), when recorded. */
  creator: string | null;
  /** The newest audit events of the token (the rail history). */
  recent: AuditEvent[];
  /** Tokens of the same family holding the same secret (rotate pre-ticks them). */
  siblings: Service[];
  /** destinationFingerprint of the stored destination: the rotate form posts it back (I-CRED-2). */
  destinationFingerprint: string;
  /** Every token, for the destination form's suggestions. */
  tokens: readonly Service[];
  proxyOrigin: string;
  today: string;
  also: TokenAlso | null;
}

export interface TokenPageState {
  secret?: FormState;
  destination?: FormState;
  details?: FormState;
  /** A check just run with the stored secret (POST /test). */
  test?: VerifyOutcome;
  open?: 'destination' | 'details' | null;
}

function unreadable(data: TokenPageData): boolean {
  return data.binding.status === 'unattested' || data.keyringError !== null;
}

/** Allowed requests through the token's accesses in the last 30 days. */
function usage30d(data: TokenPageData): number {
  return data.accesses.reduce(
    (sum, edge) => sum + (data.usage.get(edge.grant.id)?.requests ?? 0),
    0,
  );
}

/** The people to ask for an access, and one mail to all of them with the link in the body. */
function handoffMail(ctx: ViewContext, service: Service, url: string): string | null {
  const people = ctx.askers('access:write');
  if (people.length === 0) return null;
  const query = new URLSearchParams({
    subject: `Access to service token ${service.name}`,
    body: `Please give a consumer access to the service token ${service.name}: ${url}`,
  })
    .toString()
    .replace(/\+/g, '%20');
  return `mailto:${people.map((person) => person.email).join(',')}?${query}`;
}

/**
 * The header of a token page: breadcrumb, identity (logo, name, status, type, slug, ID, host),
 * Test, and the one primary: "Give a consumer access" for access managers, else "Ask an access
 * manager" (a mail with the link) for token managers. Then the relation line.
 */
export function TokenHeader(props: { ctx: ViewContext; data: TokenPageData }) {
  const { ctx, data } = props;
  const { service } = data;
  const status = tokenStatus(service, {
    unreadable: unreadable(data),
    outside: data.outside,
    now: ctx.now,
  });
  const attested = data.binding.status === 'attested';
  const giveHref = paths.accessNew({ token: service.id });
  const mail = ctx.can('tokens:write')
    ? handoffMail(ctx, service, `${data.proxyOrigin}${giveHref}`)
    : null;
  const test = ctx.can('tokens:write') && service.verify !== null && attested;
  const primary = ctx.can('access:write') ? (
    <Button variant="primary" plus href={giveHref}>
      Give a consumer access
    </Button>
  ) : mail ? (
    <Button variant="primary" href={mail}>
      Ask an access manager
    </Button>
  ) : null;
  return (
    <PageHeader
      crumbs={[{ href: paths.tokens(), label: 'Service tokens' }, { label: service.name }]}
      identity={
        <Identity
          logo={templateLogo(data.template, { disabled: !service.enabled })}
          title={service.name}
          status={<StatusBadge status={status.status} detail={status.detail} />}
          type={typeLabel(data.template)}
          slug={service.slug}
          entityId={{ value: service.id, kind: 'Token' }}
          facts={[<Mono>{upstreamShort(service.base_url)}</Mono>]}
        />
      }
      actions={
        test || primary ? (
          <>
            {test ? (
              <ActionButton
                action={`${paths.token(service.id)}/test`}
                csrf={ctx.csrf}
                label="Test"
                context={`${service.name} secret`}
              />
            ) : null}
            {primary}
          </>
        ) : undefined
      }
    >
      <RelationLine>
        <Relation ctx={ctx} data={data} />
      </RelationLine>
    </PageHeader>
  );
}

function Relation(props: { ctx: ViewContext; data: TokenPageData }) {
  const { ctx, data } = props;
  const { service } = data;
  const usable = usableAccesses(data.accesses, ctx.now);
  const consumers = new Set(usable.map((edge) => edge.grant.caller_provider_id)).size;
  const reason = unusableReason(data);
  const reasonText = reason !== null ? ` The token is not usable now: ${reason}.` : '';
  const requests = data.usageAvailable && data.sampleRate > 0 ? usage30d(data) : 0;
  const listHref = paths.access({ token: service.id });
  if (usable.length === 0) {
    return (
      <>
        No consumer can use {service.name} yet.{reasonText}
      </>
    );
  }
  return (
    <>
      <a href={listHref}>{plural(consumers, 'consumer')}</a> can use {service.name} through{' '}
      <a href={listHref}>{plural(usable.length, 'access', 'accesses')}</a>.{reasonText}
      {requests > 0
        ? ` ${formatCount(requests)} allowed ${requests === 1 ? 'request' : 'requests'} in the last 30 days.`
        : ''}
    </>
  );
}

export function TokenPage(props: { ctx: ViewContext; data: TokenPageData; state: TokenPageState }) {
  const { ctx, data, state } = props;
  const { service } = data;
  const canDelete =
    ctx.can('tokens:write') && (data.accesses.length === 0 || ctx.can('access:write'));
  return (
    <>
      <Problems ctx={ctx} data={data} />
      <ConsumersTray ctx={ctx} data={data} />
      <DetailLayout railLabel={`${service.name} details`} rail={<Rail ctx={ctx} data={data} />}>
        <SecretTray ctx={ctx} data={data} state={state} />
        <UseTray data={data} />
        <DestinationTray ctx={ctx} data={data} state={state} />
        <Danger ctx={ctx} data={data} />
      </DetailLayout>
      {canDelete ? <DeleteDialog ctx={ctx} data={data} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Problems

interface Problem {
  tone: 'bad' | 'warn';
  title: Child;
  more?: Child;
  fix?: { href: string; label: string; srSuffix?: string; permission?: Permission };
}

/** One problem as a callout; its fix as a small button, or who can fix it. */
function ProblemCallout(props: { ctx: ViewContext; problem: Problem }) {
  const { ctx, problem } = props;
  const fix = problem.fix;
  const allowed = fix && (fix.permission === undefined || ctx.can(fix.permission));
  return (
    <Callout
      tone={problem.tone}
      title={problem.title}
      more={problem.more}
      actions={
        fix && allowed ? (
          <Button size="sm" href={fix.href} srSuffix={fix.srSuffix}>
            {fix.label}
          </Button>
        ) : fix?.permission ? (
          <AskSomeone
            permission={fix.permission}
            ctx={ctx}
            verb={`${fix.label.charAt(0).toLowerCase()}${fix.label.slice(1)}`}
          />
        ) : undefined
      }
    />
  );
}

function Problems(props: { ctx: ViewContext; data: TokenPageData }) {
  const { ctx, data } = props;
  const { service } = data;
  const problems: Problem[] = [];
  const destinationFix = {
    href: paths.token(service.id, { open: 'destination', hash: 'destination' }),
    label: 'Change destination',
    permission: 'tokens:write' as const,
  };
  if (data.binding.status === 'unattested') {
    problems.push({
      tone: 'bad',
      title: 'The stored destination is not confirmed.',
      more: bindingText(data.binding),
      fix: destinationFix,
    });
  }
  if (service.credential_sealed === null) {
    problems.push({
      tone: 'bad',
      title: 'No secret is stored, so requests through this token fail.',
      more: 'Set it under Destination; you will be asked to confirm the host.',
      fix: destinationFix,
    });
  }
  if (data.keyringError !== null) {
    problems.push({
      tone: 'bad',
      title: 'Encryption keys are not loaded: the secret cannot be used or changed.',
      more: KEYRING_ERROR_TEXT[data.keyringError],
      fix: { href: paths.tokenKeys(), label: 'Open encryption keys' },
    });
  }
  if (storedUpstreamHost(service.base_url) === null) {
    problems.push({
      tone: 'bad',
      title: 'The stored base URL cannot be read, so requests through this token are refused.',
      more: 'Set the destination again under Change destination.',
      fix: destinationFix,
    });
  } else if (data.outside) {
    problems.push({
      tone: 'bad',
      title: `${upstreamHost(service.base_url)} is not an allowed host, so requests through this token are refused.`,
      fix: { href: paths.tokenHosts(), label: 'Open allowed hosts', permission: 'settings:write' },
    });
  }
  const expires = service.credential_expires_at;
  if (service.credential_sealed !== null && expires !== null) {
    const date = uiFormatTime(new Date(expires), 'date');
    const replace = {
      href: paths.token(service.id, { hash: 'secret' }),
      label: 'Replace the secret',
      permission: 'tokens:write' as const,
    };
    if (expires <= ctx.now) {
      problems.push({
        tone: 'bad',
        title: `The secret of ${service.name} expired on ${date}.`,
        more: 'Upstream calls fail until it is replaced.',
        fix: replace,
      });
    } else if (expires - ctx.now <= EXPIRY_WARNING_MS) {
      const days = daysUntil(expires, ctx.now);
      // The consequence, when calls are recorded: who would be refused after that date.
      const calls = data.usageAvailable && data.sampleRate > 0 ? usage30d(data) : 0;
      const subjects = [
        ...new Set(
          data.accesses
            .filter((edge) => (data.usage.get(edge.grant.id)?.requests ?? 0) > 0)
            .map((edge) => edge.subject),
        ),
      ];
      const who =
        subjects.length <= 2
          ? subjects.join(' and ')
          : plural(subjects.length, 'repository', 'repositories');
      problems.push({
        tone: 'warn',
        title: `The secret of ${service.name} expires on ${date} (in ${plural(days, 'day')}).`,
        more:
          calls > 0
            ? `${who} made ${formatCount(calls)} ${calls === 1 ? 'call' : 'calls'} through it in the last 30 days. After ${uiFormatTime(new Date(expires), 'day')}, they are refused.`
            : 'Replace it before then.',
        fix: replace,
      });
    }
  }
  const pairReason = data.also === null ? undefined : PAIR_FAILURE_REASONS[data.also];
  if (pairReason !== undefined) {
    problems.push({
      tone: 'warn',
      title: `The GitHub release asset uploads token was not created: ${pairReason}.`,
      more: 'This token was saved; add the uploads token on its own.',
      fix: {
        href: paths.tokenNew({ template: 'github-uploads' }),
        label: 'Add GitHub release asset uploads',
        permission: 'tokens:write',
      },
    });
  }
  if (service.enabled && problems.length === 0) return null;
  return (
    <>
      {service.enabled ? null : (
        <Callout
          tone="warn"
          glyph="⏸"
          title={`${service.name} is disabled: requests through it are refused.`}
          actions={
            ctx.can('tokens:write') ? (
              <ActionButton
                action={`${paths.token(service.id)}/toggle`}
                csrf={ctx.csrf}
                label="Enable"
                context={service.name}
                size="sm"
                fields={{ enabled: '1' }}
                returnTo="detail"
              />
            ) : undefined
          }
        />
      )}
      {problems.map((problem) => (
        <ProblemCallout ctx={ctx} problem={problem} />
      ))}
    </>
  );
}

function bindingText(binding: Extract<StoredBinding, { status: 'unattested' }>): string {
  const cause =
    binding.error === 'credential_binding_mismatch'
      ? binding.keyChanged === false
        ? 'The base URL or the way the secret is sent was changed outside the admin UI: the stored secret no longer matches them, and the encryption key is unchanged.'
        : 'The stored secret does not match this token: either its base URL or the way the secret is sent was changed outside the admin UI, or the key behind its key id was replaced (see Encryption keys).'
      : binding.error === 'keyring_missing_key'
        ? 'The stored secret was encrypted with a key that is no longer in the keyring, so the stored base URL and injection cannot be confirmed.'
        : 'The stored secret is damaged, so the stored base URL and injection cannot be confirmed.';
  return `${cause} Treat this as possible tampering: a secret entered now goes to the base URL you submit. Check the base URL and injection against an out-of-band source (the provider's documentation, your configuration as code) before you enter the secret again. The audit log is not a reliable reference: anyone who can edit the database can edit it too.`;
}

/** Why a token with a secret and accesses still cannot serve them, or null. */
function unusableReason(data: TokenPageData): string | null {
  const { service } = data;
  if (!service.enabled) return 'the token is disabled';
  if (service.credential_sealed === null) return 'no secret is stored';
  if (unreadable(data)) return 'the stored secret does not open';
  if (storedUpstreamHost(service.base_url) === null) return 'its base URL cannot be read';
  if (data.outside) return `${upstreamHost(service.base_url)} is not an allowed host`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Who can use it

function lastUsedText(edge: AccessEdge, data: TokenPageData, now: number): string | null {
  if (data.sampleRate === 0 || !data.usageAvailable) return null;
  return edge.lastUsedHour === null
    ? 'not used in 30 days'
    : `last used ${relativeTime(edge.lastUsedHour, now)}`;
}

function accessRow(
  edge: AccessEdge,
  data: TokenPageData,
  ctx: ViewContext,
  tokenName: string,
): WhoAccess {
  const [first, ...more] = edge.operations;
  const used = lastUsedText(edge, data, ctx.now);
  const expires = edge.grant.expires_at;
  const risky = edge.flags.some((flag) => flag.status === 'risk_accepted');
  return {
    name: edge.subject,
    href: paths.accessItem(edge.grant.id),
    context: edge.context,
    meta: (
      <>
        {first ? <code>{first}</code> : 'no operations'}
        {more.length > 0 ? ` +${more.length}` : ''} ·{' '}
        {expires === null ? 'never expires' : `ends ${uiFormatTime(new Date(expires), 'day')}`}
        {used ? ` · ${used}` : ''}
      </>
    ),
    // One grid cell for both words: the row is a two-column grid (text, status).
    status: risky ? (
      <span class="wst">
        <StatusBadge status={edge.status} detail={edge.statusDetail} />
        <StatusBadge status="risk_accepted" />
      </span>
    ) : (
      <StatusBadge status={edge.status} detail={edge.statusDetail} />
    ),
    statusAction:
      edge.status === 'expiring' && ctx.can('access:write') ? (
        <a class="sm" href={paths.accessItem(edge.grant.id, { open: 'edit', hash: 'edit' })}>
          Extend
          <span class="vh">
            {' '}
            {edge.subject} → {tokenName}
          </span>
        </a>
      ) : undefined,
    warn: edge.status === 'expiring' || edge.status === 'inactive' || edge.status === 'expired',
  };
}

function ConsumersTray(props: { ctx: ViewContext; data: TokenPageData }) {
  const { ctx, data } = props;
  const { service } = data;
  const byConsumer = new Map<string, AccessEdge[]>();
  for (const edge of data.accesses) {
    const list = byConsumer.get(edge.grant.caller_provider_id) ?? [];
    list.push(edge);
    byConsumer.set(edge.grant.caller_provider_id, list);
  }
  const requests = (edge: AccessEdge) => data.usage.get(edge.grant.id)?.requests ?? 0;
  const ordered = [...byConsumer.entries()]
    .map(([id, edges]) => ({
      id,
      edges: [...edges].sort((a, b) => requests(b) - requests(a)),
      total: edges.reduce((sum, edge) => sum + requests(edge), 0),
      name: edges[0]?.consumer?.name ?? 'Deleted consumer',
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const shown = ordered.slice(0, MAP_GROUPS);
  const hidden = ordered.slice(MAP_GROUPS);
  const groups: WhoGroup[] = shown.map((group) => {
    const consumer = group.edges[0]?.consumer ?? null;
    const rows = group.edges.slice(0, MAP_ROWS);
    const rest = group.edges.slice(MAP_ROWS);
    const restExpiring = rest.filter((edge) => edge.status === 'expiring').length;
    return {
      consumer: {
        name: group.name,
        href: consumer ? paths.consumer(consumer.id) : paths.access({ token: service.id }),
        line: plural(group.edges.length, 'access', 'accesses'),
        logo: consumerLogo(consumer),
        count: group.edges.length,
      },
      accesses: rows.map((edge) => accessRow(edge, data, ctx, service.name)),
      more:
        rest.length > 0
          ? {
              href: paths.access({ token: service.id, consumer: group.id }),
              label: `+ ${plural(rest.length, 'more access', 'more accesses')}`,
              srSuffix: `of ${group.name} to ${service.name}`,
              meta: restExpiring > 0 ? `${restExpiring} expiring` : undefined,
            }
          : undefined,
    };
  });
  const hiddenAccesses = hidden.reduce((sum, group) => sum + group.edges.length, 0);
  const cut = hidden.length > 0 || shown.some((group) => group.edges.length > MAP_ROWS);
  const expiring = data.accesses.filter((edge) => edge.status === 'expiring').length;
  const inactive = data.accesses.filter((edge) => edge.status === 'inactive').length;
  const giveHref = paths.accessNew({ token: service.id });
  const canGive = ctx.can('access:write');
  return (
    <Tray
      id="consumers"
      title={`Who can use ${service.name}`}
      count={data.accesses.length}
      description={
        <>
          Each line is one consumer access. Consumers call <code>{`/proxy/${service.slug}`}</code>;
          they never see the secret.
        </>
      }
      actions={
        <>
          <LinkAction href={paths.requests({ token: service.id })} arrow>
            Requests through {service.name}
          </LinkAction>
          <LinkAction href={paths.access({ token: service.id })} arrow>
            Connections map
          </LinkAction>
        </>
      }
    >
      <WhoCanUse
        label={`Accesses to ${service.name}, grouped by consumer`}
        token={{
          name: service.name,
          logo: templateLogo(data.template, { disabled: !service.enabled }),
          path: `/proxy/${service.slug}`,
        }}
        groups={groups}
        rest={
          hidden.length > 0
            ? {
                href: paths.access({ token: service.id, view: 'matrix' }),
                label: `+ ${plural(hidden.length, 'more consumer')} · ${plural(hiddenAccesses, 'access', 'accesses')}`,
                line: `Open them in the matrix, filtered to ${service.name}`,
              }
            : undefined
        }
        empty={{
          title: 'No consumer access yet',
          children: canGive ? (
            <>
              <p>
                Give a consumer access so its jobs can call <code>{`/proxy/${service.slug}`}</code>.
              </p>
              <div>
                <Button size="sm" plus href={giveHref}>
                  Give a consumer access
                </Button>
              </div>
            </>
          ) : (
            <HandOff ctx={ctx} data={data} />
          ),
        }}
        note={
          cut ? (
            <>
              <b>
                {plural(byConsumer.size, 'consumer')},{' '}
                {plural(data.accesses.length, 'access', 'accesses')}.
              </b>{' '}
              The map shows the {plural(shown.length, 'consumer')} with the most requests and up to{' '}
              {MAP_ROWS} accesses each. The{' '}
              <a href={paths.access({ token: service.id, view: 'matrix' })}>matrix</a> shows all of
              them
              {expiring > 0 ? (
                <>
                  ;{' '}
                  <a href={paths.access({ token: service.id, status: 'expiring' })}>
                    {expiring} expiring
                  </a>
                </>
              ) : null}
              {inactive > 0 ? (
                <>
                  {expiring > 0 ? ' and ' : '; '}
                  <a href={paths.access({ token: service.id, status: 'inactive' })}>
                    {inactive} inactive
                  </a>
                </>
              ) : null}
              .
            </>
          ) : undefined
        }
        footerAction={
          canGive && groups.length > 0 ? (
            <Button variant="ghost" size="sm" plus href={giveHref}>
              Give another consumer access
            </Button>
          ) : undefined
        }
      />
      {!canGive && groups.length > 0 ? (
        <Panel variant="pad">
          <HandOff ctx={ctx} data={data} />
        </Panel>
      ) : null}
    </Tray>
  );
}

/** For people who cannot give access: the link that opens the form, and whom to send it to. */
function HandOff(props: { ctx: ViewContext; data: TokenPageData }) {
  const { ctx, data } = props;
  const { service } = data;
  const absolute = `${data.proxyOrigin}${paths.accessNew({ token: service.id })}`;
  return (
    <div class="stack-sm">
      <p>Consumer access is granted by access managers. Send them this link:</p>
      <Field
        id="handoff"
        label={`Link that opens “Give a consumer access” for ${service.name}`}
        hint="Select to copy."
      >
        <Input name="handoff" mono readonly value={absolute} />
      </Field>
      <AskSomeone
        permission="access:write"
        ctx={ctx}
        verb="give a consumer access"
        subject={`Access to service token ${service.name}`}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Secret

/** Rotate prefill: the stored expiry only when it is more than 14 days away (A13.8.2). */
function rotateExpiry(service: Service, now: number): { value: string; past: string | null } {
  const expires = service.credential_expires_at;
  if (expires === null) return { value: '', past: null };
  if (expires - now > EXPIRY_WARNING_MS) return { value: dateInput(expires), past: null };
  return { value: '', past: dateInput(expires) };
}

function secretPlaceholder(template: ServiceTemplate | null) {
  return template?.secret ?? CUSTOM_SECRET;
}

function SecretTray(props: { ctx: ViewContext; data: TokenPageData; state: TokenPageState }) {
  const { ctx, data, state } = props;
  const { service } = data;
  const attested = data.binding.status === 'attested';
  const canWrite = ctx.can('tokens:write');
  return (
    <Tray
      id="secret"
      title="Secret"
      description="Only the last 4 characters are kept for display. The secret is never shown again."
    >
      <Panel variant="pad">
        <StoredSecret ctx={ctx} data={data} />
        {state.test ? <CheckResult verify={state.test} announce /> : null}
        {canWrite && service.verify && attested ? (
          <p class="hint">Test sends {verifyText(service.verify)} to the upstream now.</p>
        ) : null}
      </Panel>
      {canWrite ? (
        <Panel variant="pad">
          {attested ? (
            <RotateForm ctx={ctx} data={data} state={state.secret} />
          ) : data.keyringError !== null ? (
            <p>
              Secrets cannot be changed while the encryption keys are not loaded.{' '}
              <a href={paths.tokenKeys()}>Open encryption keys</a>
            </p>
          ) : (
            <p>
              <a href={paths.token(service.id, { open: 'destination', hash: 'destination' })}>
                Set the secret through Change destination below
              </a>
              : the host is confirmed there first.
            </p>
          )}
        </Panel>
      ) : null}
    </Tray>
  );
}

function StoredSecret(props: { ctx: ViewContext; data: TokenPageData }) {
  const { ctx, data } = props;
  const { service, template } = data;
  if (service.credential_sealed === null) {
    return (
      <p>
        <StatusBadge status="no_credential" /> No secret is stored.
      </p>
    );
  }
  const parts = secretParts(service.credential_hint);
  const kid = sealedKid(service.credential_sealed);
  const expires = service.credential_expires_at;
  const set = service.credential_updated_at;
  return (
    <Secret
      last4={parts.last4 ?? undefined}
      facts={
        <>
          {template?.secret.label ?? 'Secret'}
          {parts.length !== null ? ` · ${parts.length} characters` : ''}
          {unreadable(data) ? (
            <>
              {' '}
              <StatusBadge status="credential_unreadable" />
            </>
          ) : null}
        </>
      }
      meta={
        <>
          {set === null ? (
            'Set at an unknown time'
          ) : (
            <>
              Set{' '}
              <Time datetime={new Date(set)} format="datetime">
                {relativeTime(set, ctx.now)}
              </Time>
            </>
          )}{' '}
          by {data.lastSet?.actor_email ?? 'someone (not recorded)'} ·{' '}
          {expires === null ? (
            'does not expire, or not known'
          ) : (
            <>
              {expires <= ctx.now ? 'expired ' : 'expires '}
              <Time datetime={new Date(expires)} format="date" />
            </>
          )}
          {template?.expiry_from_check ? ' (read from GitHub)' : ''}
          {kid ? (
            <>
              {' '}
              · sealed with key <code>{kid}</code>
            </>
          ) : null}
        </>
      }
    />
  );
}

function RotateForm(props: { ctx: ViewContext; data: TokenPageData; state?: FormState }) {
  const { ctx, data, state } = props;
  const { service, template } = data;
  const ids = new FormIds('secret', state?.errors ?? []);
  const expiry = rotateExpiry(service, ctx.now);
  const values: TokenFormValues = state?.values ?? {
    ...EMPTY_VALUES,
    credential_expires_at: expiry.value,
  };
  const secret = secretPlaceholder(template);
  const submitted = state ? new Set(state.values.also_replace.split(',')) : null;
  const failedCheck = !!state?.verify;
  const context = `of ${service.name}`;
  return (
    <PostForm action={`${paths.token(service.id)}/secret`} csrf={ctx.csrf} class="stack-sm">
      <h3 class="lbl" id="rotate-h">
        Replace secret
      </h3>
      {/* The destination shown here, so a token repointed since is refused (I-CRED-2). */}
      <input type="hidden" name="expected_destination" value={data.destinationFingerprint} />
      <div class="rot-row">
        <SecretField
          ids={ids}
          label={`New ${inSentence(secret.label)}`}
          placeholder={secret.placeholder}
          hint={`Sent to ${upstreamHost(service.base_url)}. Replaces ${service.credential_hint ?? 'the stored secret'}. Consumers keep working, with the new secret from the next request.`}
          pattern={template?.secret.pattern}
          draft={state?.draft ?? null}
        />
        {template?.expiry_from_check ? null : (
          <ExpiryField
            ids={ids}
            values={values}
            label="New secret expires on"
            optional
            min={data.today}
            hint={
              expiry.past
                ? `The old secret ${(service.credential_expires_at ?? 0) <= ctx.now ? 'expired' : 'expires'} on ${uiFormatTime(new Date(service.credential_expires_at ?? 0), 'date')}. Empty = does not expire.`
                : 'Empty = does not expire.'
            }
          />
        )}
        {failedCheck ? null : (
          <Button type="submit" srSuffix={context}>
            {service.verify ? 'Check and replace' : 'Replace secret'}
          </Button>
        )}
      </div>
      {state?.verify ? <CheckResult verify={state.verify} /> : null}
      {data.siblings.map((sibling) => (
        <Checkbox
          name="also_replace"
          id={ids.id(`also_replace.${sibling.id}`)}
          value={sibling.id}
          checked={submitted ? submitted.has(sibling.id) : true}
          label={`Also replace in ${sibling.slug} (same secret, ${sibling.credential_hint ?? 'stored'})`}
        />
      ))}
      {failedCheck ? <SecretSubmits label="Replace secret" context={context} failedCheck /> : null}
    </PostForm>
  );
}

// ---------------------------------------------------------------------------------------------
// How consumers call it

/** A curl of the type's first default operation, when its path is a plain one. */
function exampleCall(data: TokenPageData, base: string): string | null {
  const rule = data.template?.operation_presets.find((preset) => preset.default)?.rules[0];
  if (!rule || rule.path.includes(REPO_PLACEHOLDER) || /[*{]/.test(rule.path)) return null;
  const method = rule.methods.find((m) => m !== '*') ?? 'GET';
  return `curl -sS -X ${method} ${base}${rule.path} \\\n  -H "${CALLER_TOKEN_HEADER}: $TOKENGATE_TOKEN"`;
}

function UseTray(props: { data: TokenPageData }) {
  const { data } = props;
  const { service, template } = data;
  const base = `${data.proxyOrigin}/proxy/${service.slug}`;
  const example = exampleCall(data, base);
  return (
    <Tray
      id="use"
      title="How consumers call it"
      description="Consumers send their tokengate token; tokengate adds the secret on the way out."
    >
      <Panel variant="pad">
        <div>
          <CodeBlock label="Proxy base URL" caption="Proxy base URL (select to copy)">
            {base}
          </CodeBlock>
        </div>
        {example ? (
          <div>
            <CodeBlock
              label="Example call"
              caption="Example call from a job that has access (select to copy)"
            >
              {example}
            </CodeBlock>
          </div>
        ) : null}
        {template ? <p class="hint">{template.notes}</p> : null}
      </Panel>
    </Tray>
  );
}

// ---------------------------------------------------------------------------------------------
// Destination and details

function DestinationTray(props: { ctx: ViewContext; data: TokenPageData; state: TokenPageState }) {
  const { ctx, data, state } = props;
  const { service, template } = data;
  const unattested = data.binding.status === 'unattested';
  const none = service.credential_sealed === null;
  const canWrite = ctx.can('tokens:write');
  const editDestination = unattested || none || !!state.destination || state.open === 'destination';
  const editDetails = !!state.details || state.open === 'details';
  const notConfirmed = unattested ? (
    <>
      {' '}
      <Badge tone="bad">not confirmed</Badge>
    </>
  ) : null;
  return (
    <Tray
      id="destination"
      title="Destination"
      description={
        template ? `Set by the ${template.label} type.` : 'Set when the token was added.'
      }
      actions={
        canWrite && !(editDestination && editDetails) ? (
          <>
            {editDestination ? null : (
              <Button
                size="sm"
                href={paths.token(service.id, { open: 'destination', hash: 'destination' })}
              >
                Change destination…
              </Button>
            )}
            {editDetails ? null : (
              <Button
                size="sm"
                href={paths.token(service.id, { open: 'details', hash: 'details' })}
              >
                Edit name and options…
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      <Panel variant="pad">
        <KeyValue
          items={[
            {
              label: 'Base URL',
              value: (
                <>
                  <code>{service.base_url}</code>
                  {notConfirmed}
                </>
              ),
            },
            {
              label: 'Secret sent as',
              value: (
                <>
                  {injectionText(service.injection)}
                  {notConfirmed}
                </>
              ),
            },
            {
              label: 'Extra forwarded headers',
              value:
                service.forward_headers.length > 0 ? (
                  service.forward_headers.join(', ')
                ) : (
                  <span class="muted">none</span>
                ),
            },
            { label: 'Timeout', value: `${service.timeout_ms / 1000} s` },
            { label: 'Secret check', value: verifyText(service.verify) },
            {
              label: 'Description',
              value: service.description || (
                <span class="muted">
                  None. Add one so access managers know which account this is.
                </span>
              ),
            },
          ]}
        />
        {unattested ? (
          <p class="hint">
            May have been changed outside the admin UI. Do not copy it into the destination form.
          </p>
        ) : null}
        {service.injection.kind === 'query' ? <Callout title={QUERY_WARNING} /> : null}
        {service.injection.kind === 'path' ? <Callout title={PATH_WARNING} /> : null}
      </Panel>
      {/* The header buttons open one form at a time (`?open=`, no script); a closed form is not
          drawn, so the tray never repeats its two buttons as two disclosures. */}
      {canWrite && editDestination ? (
        <Panel variant="pad">
          <Disclosure
            id="destination-edit"
            class="lform"
            summary="Change destination"
            hint="base URL and how the secret is sent"
            open
          >
            <DestinationForm ctx={ctx} data={data} state={state.destination} />
          </Disclosure>
        </Panel>
      ) : null}
      {canWrite && editDetails ? (
        <Panel variant="pad">
          <Disclosure id="details" summary="Edit name, description and options" open>
            <DetailsForm ctx={ctx} data={data} state={state.details} />
          </Disclosure>
        </Panel>
      ) : null}
    </Tray>
  );
}

/** A host with an optional port, as `confirm_destination` expects it (no scheme, no path). */
const HOST_PATTERN = String.raw`[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)+(?::[0-9]{1,5})?`;

function DestinationForm(props: { ctx: ViewContext; data: TokenPageData; state?: FormState }) {
  const { ctx, data, state } = props;
  const { service, template } = data;
  const attested = data.binding.status === 'attested';
  const confirm = data.binding.status === 'unattested' || service.credential_sealed === null;
  const ids = new FormIds('destination', state?.errors ?? []);
  const stored = valuesFromService(service);
  const expiry = rotateExpiry(service, ctx.now);
  // An unattested or absent binding is not prefilled: the admin types the destination from an
  // out-of-band source instead of resubmitting a possibly tampered value (I-CRED-2).
  const defaults: TokenFormValues = attested
    ? { ...stored, credential_expires_at: expiry.value }
    : { ...EMPTY_VALUES };
  const values = state ? { ...state.values, confirm_destination: '' } : defaults;
  const listed = data.allowlist !== null && data.allowlist.length > 0;
  const canAllow = ctx.can('settings:write');
  // Shown from the start, as on the custom card, so a new host needs one submit: the server
  // applies it only when the submitted host is not covered (A13.8.3).
  const showAllow = canAllow && listed;
  // Unattested or none: only code-sourced suggestions; D1 values could be the attacker's.
  const suggestions = attested
    ? baseUrlSuggestions(data.allowlist, data.tokens)
    : SERVICE_TEMPLATES.map((t) => ({ value: t.base_url, label: t.label }));
  const secret = secretPlaceholder(template);
  return (
    <PostForm action={`${paths.token(service.id)}/destination`} csrf={ctx.csrf} class="stack-sm">
      <Field
        id={ids.id('base_url')}
        label="Base URL"
        hint={
          <>
            https only, no query string. Changing it requires the secret again: the secret is bound
            to its destination.
            {listed ? <> Allowed hosts: {data.allowlist?.join(', ')}.</> : null}
          </>
        }
        error={ids.error('base_url') ?? undefined}
      >
        <Input
          name="base_url"
          type="url"
          mono
          required
          value={values.base_url}
          placeholder="https://api.example.com/v1"
          suggestions={suggestions}
          // As on the custom card: no generated pattern when the owner may tick allow_host.
          pattern={listed && !canAllow ? allowlistPattern(data.allowlist ?? []) : undefined}
        />
      </Field>
      <InjectionFields ids={ids} values={values} tokens={data.tokens} />
      {confirm ? (
        <Field
          id={ids.id('confirm_destination')}
          label="Confirm destination host"
          hint="Check the base URL against the provider's docs, then type its host only, without https:// or a path. Nothing is sent upstream until this matches."
          error={ids.error('confirm_destination') ?? undefined}
        >
          <Input
            name="confirm_destination"
            mono
            required
            value=""
            placeholder="api.example.com"
            pattern={HOST_PATTERN}
          />
        </Field>
      ) : null}
      <SecretField
        ids={ids}
        label={secret.label}
        placeholder={secret.placeholder}
        hint="Required: a new destination needs the secret again."
        draft={state?.draft ?? null}
      />
      {state?.verify ? <CheckResult verify={state.verify} /> : null}
      {showAllow ? (
        <Checkbox
          name="allow_host"
          id={ids.id('allow_host')}
          value="1"
          checked={state ? state.values.allow_host !== '' : false}
          label="Also add this host to Allowed hosts"
          hint="Only when the base URL's host is not allowed yet. Applies to every token."
          error={ids.error('allow_host')}
        />
      ) : null}
      {template?.expiry_from_check ? null : (
        <ExpiryField
          ids={ids}
          values={values}
          optional
          min={data.today}
          hint="Leave empty if it does not expire. GitHub tokens report their expiry when checked."
        />
      )}
      <SecretSubmits
        label={service.verify ? 'Check and change destination' : 'Change destination'}
        context={`of ${service.name}`}
        failedCheck={!!state?.verify}
      />
    </PostForm>
  );
}

function DetailsForm(props: { ctx: ViewContext; data: TokenPageData; state?: FormState }) {
  const { ctx, data, state } = props;
  const { service } = data;
  const ids = new FormIds('details', state?.errors ?? []);
  const values = state?.values ?? valuesFromService(service);
  return (
    <PostForm action={paths.token(service.id)} csrf={ctx.csrf} class="stack-sm">
      <VersionField value={String(service.updated_at)} />
      <DetailFields ids={ids} values={values} example={data.template?.name ?? 'Slack'} />
      <AdvancedFields
        ids={ids}
        values={values}
        tokens={data.tokens}
        verifyHeaders={service.verify?.headers}
      />
      <SubmitRow>
        <Button variant="primary" type="submit" srSuffix={`to ${service.name}`}>
          Save changes
        </Button>
      </SubmitRow>
    </PostForm>
  );
}

// ---------------------------------------------------------------------------------------------
// Danger zone and the delete dialog

function Danger(props: { ctx: ViewContext; data: TokenPageData }) {
  const { ctx, data } = props;
  if (!ctx.can('tokens:write')) return null;
  const { service } = data;
  const usable = usableAccesses(data.accesses, ctx.now);
  const consumers = new Set(usable.map((edge) => edge.grant.caller_provider_id)).size;
  const accesses = data.accesses;
  const toggle = `${paths.token(service.id)}/toggle`;
  const countText = plural(accesses.length, 'consumer access', 'consumer accesses');
  return (
    <DangerZone id="danger">
      {service.enabled ? (
        <DangerRow
          title="Disable token"
          description={`${plural(consumers, 'consumer loses', 'consumers lose')} access until you enable it again. Nothing is deleted.`}
          action={
            <ActionButton
              action={toggle}
              csrf={ctx.csrf}
              label={`Disable ${service.name}`}
              fields={{ enabled: '0' }}
              returnTo="detail"
            />
          }
        />
      ) : (
        <DangerRow
          title="Enable token"
          description="Consumers with access can use it again."
          action={
            <ActionButton
              action={toggle}
              csrf={ctx.csrf}
              label={`Enable ${service.name}`}
              fields={{ enabled: '1' }}
              returnTo="detail"
            />
          }
        />
      )}
      {accesses.length === 0 ? (
        <DangerRow
          title={`Delete ${service.name}`}
          description="The token and its stored secret are deleted. The audit log keeps its configuration, never the secret."
          action={
            <DialogTrigger dialog="dlg-delete" variant="danger">
              Delete {service.name}…
            </DialogTrigger>
          }
        />
      ) : ctx.can('access:write') ? (
        <DangerRow
          title={`Delete ${service.name} and its ${countText}`}
          description="The secret and the accesses are removed. This cannot be undone."
          action={
            <DialogTrigger dialog="dlg-delete" variant="danger">
              Delete {service.name}…
            </DialogTrigger>
          }
        />
      ) : (
        <DangerRow
          title={`Delete ${service.name}`}
          description={
            <>
              {service.name} cannot be deleted while consumer access uses it. Disable the token now;
              an access manager can delete the accesses, or an admin can delete both. Accesses:{' '}
              {accesses.map((edge, index) => (
                <>
                  {index > 0 ? ' · ' : null}
                  <a href={paths.accessItem(edge.grant.id)}>
                    {edge.grant.name} ({edge.consumer?.name ?? 'deleted consumer'})
                  </a>
                </>
              ))}
            </>
          }
          action={<AskSomeone permission="access:write" ctx={ctx} verb="delete these accesses" />}
        />
      )}
    </DangerZone>
  );
}

function DeleteDialog(props: { ctx: ViewContext; data: TokenPageData }) {
  const { ctx, data } = props;
  const { service } = data;
  const accesses = data.accesses;
  const countText = plural(accesses.length, 'consumer access', 'consumer accesses');
  const cascade = accesses.length > 0;
  const disableInstead = cascade && service.enabled;
  return (
    <>
      <ConfirmDialog
        id="dlg-delete"
        title={cascade ? `Delete ${service.name} and its ${countText}?` : `Delete ${service.name}?`}
        description={
          cascade ? (
            <>
              This cannot be undone. The secret is destroyed, and from the next request these jobs
              get <code>404</code> from <code>{`/proxy/${service.slug}`}</code>:
            </>
          ) : (
            'The token and its stored secret are deleted. The audit log keeps its configuration, never the secret.'
          )
        }
        action={`${paths.token(service.id)}/delete`}
        hidden={ctx.hidden({
          confirm: '1',
          ...(cascade
            ? {
                with_accesses: '1',
                access_ids: accesses
                  .map((edge) => edge.grant.id)
                  .sort()
                  .join(','),
              }
            : {}),
        })}
        confirmLabel={`Delete ${service.name}`}
        affected={accesses.map((edge) => (
          <Entity
            logo={consumerLogo(edge.consumer)}
            logoSize="sm"
            name={`${edge.subject} · ${edge.context}`}
            href={paths.accessItem(edge.grant.id)}
            meta={`${edge.consumer?.name ?? 'deleted consumer'}${
              lastUsedText(edge, data, ctx.now) ? ` · ${lastUsedText(edge, data, ctx.now)}` : ''
            }`}
          />
        ))}
        confirmText={
          cascade
            ? {
                value: service.slug,
                name: 'confirm_slug',
                hint: 'The slug of this token, in lower case.',
              }
            : undefined
        }
      >
        {disableInstead ? (
          <Callout
            title="Disable instead?"
            more={`${
              data.traffic && data.traffic.requests > 0
                ? `${formatCount(data.traffic.requests)} ${data.traffic.requests === 1 ? 'request' : 'requests'} used ${service.name} in the last 24 hours. `
                : ''
            }To stop them for now, disable the token instead: nothing is deleted and you can enable it again.`}
            actions={
              <Button size="sm" type="submit" form="dlg-disable">
                Disable {service.name} instead
              </Button>
            }
          />
        ) : undefined}
      </ConfirmDialog>
      {disableInstead ? (
        // The form the dialog's "Disable instead" button submits (no nested forms).
        <form method="post" action={`${paths.token(service.id)}/toggle`} id="dlg-disable" hidden>
          <input type="hidden" name={CSRF_FIELD} value={ctx.csrf} />
          <input type="hidden" name="_return" value="detail" />
          <input type="hidden" name="enabled" value="0" />
        </form>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Rail

/** "Created service openai with a credential" after the actor: "created service openai …". */
function sentence(summary: string): string {
  return `${summary.charAt(0).toLowerCase()}${summary.slice(1)}`;
}

function shortTime(ms: number): string {
  const date = new Date(ms);
  return `${uiFormatTime(date, 'day')}, ${uiFormatTime(date, 'clock')}`;
}

function Rail(props: { ctx: ViewContext; data: TokenPageData }) {
  const { data } = props;
  const { service } = data;
  const traffic = data.traffic;
  return (
    <>
      {traffic ? (
        <Tray
          id="traffic"
          title="Last 24 hours"
          actions={
            <LinkAction href={paths.requests({ range: '24h', token: service.id })} arrow>
              Requests
            </LinkAction>
          }
        >
          <Kpis
            columns={2}
            items={[
              { label: 'Requests', value: traffic.requests },
              {
                label: 'Denied',
                value: traffic.denied,
                unit:
                  traffic.denied > 0 && traffic.requests > 0
                    ? formatPercent(traffic.denied / traffic.requests)
                    : undefined,
                worst: traffic.denied > 0,
              },
              { label: 'Errors', value: traffic.errors },
              { label: 'p95', value: percentileText(traffic.p95) },
            ]}
          />
        </Tray>
      ) : null}
      <Tray id="record" title="Details">
        <Panel>
          <RailKeyValue
            items={[
              { label: 'Token ID', value: service.id, mono: true, copyable: true },
              {
                label: 'Created',
                value: <Time datetime={new Date(service.created_at)} format="date" />,
                note: data.creator ? `by ${data.creator}` : undefined,
              },
              {
                label: 'Updated',
                value: <Time datetime={new Date(service.updated_at)} format="datetime" />,
              },
            ]}
          />
        </Panel>
      </Tray>
      <Tray id="history" title="History">
        <Panel>
          {data.recent.length > 0 ? (
            <Feed compact>
              {data.recent.map((event) => (
                <FeedItem
                  avatar={
                    event.actor_type === 'system' ? (
                      <Avatar variant="sys">
                        <Icon name="system" />
                      </Avatar>
                    ) : (
                      <Avatar name={event.actor_email ?? ''} />
                    )
                  }
                  time={<Time datetime={new Date(event.ts)}>{shortTime(event.ts)}</Time>}
                >
                  <b>{event.actor_email ?? 'System'}</b> {sentence(event.summary)}
                </FeedItem>
              ))}
            </Feed>
          ) : (
            <ZeroState>No changes recorded yet.</ZeroState>
          )}
          <RailFoot>
            <LinkAction href={paths.audit({ target: service.id })} arrow>
              Audit history
            </LinkAction>
          </RailFoot>
        </Panel>
      </Tray>
    </>
  );
}
