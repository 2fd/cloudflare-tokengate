// The token page (A13.3): the header (identity, relation line, Test and the page's one primary),
// problems as callouts, who can use the token (a WhoCanUse map with the scale rule, or the
// hand-off), then the secret (with the inline rotate form), how workloads call it, the
// destination (changed only with the secret, I-CRED-2) with the details form, the danger zone,
// and a rail with the record and its history. Viewers and access managers get the same page
// without credential forms, except the access manager's "Add credential access rule".
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
  Dialog,
  DialogClose,
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
import type { RuleUsage } from '../../db/rollups';
import type { AuditEvent, Service } from '../../db/types';
import type { Injection, VerifyCheck } from '../../policy/types';
import { CALLER_TOKEN_HEADER } from '../../proxy/caller-token';
import type { TrafficStats } from '../../telemetry/dashboard';
import { CSRF_FIELD } from '../auth/csrf';
import type { Permission } from '../auth/rbac';
import type { RuleEdge } from '../connections';
import type { StoredBinding } from '../ops/credentials';
import { KEYRING_ERROR_TEXT } from '../ops/keyring';
import { storedUpstreamHost } from '../ops/upstream-hosts';
import type { VerifyOutcome } from '../ops/verify';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { REPO_PLACEHOLDER, SERVICE_TEMPLATES, type ServiceTemplate } from '../service-templates';
import { issuerHost, issuerLogo, tenantsText } from './access-visuals';
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
  DetailFields,
  EMPTY_VALUES,
  FormIds,
  type FormState,
  InjectionFields,
  inSentence,
  PATH_WARNING,
  QUERY_WARNING,
  SAVE_ANYWAY_HINT,
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

/** The scale rule of the "Who can use" map: issuers drawn, and rules per issuer. */
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
  pair_failed_conflict: 'another change to the credentials happened at the same time',
  pair_failed_check: 'its secret check failed',
};

/** One token's status in the A9 vocabulary, most severe first. */
export function tokenStatus(
  service: Pick<Service, 'enabled' | 'credential_sealed'>,
  o: { unreadable: boolean; outside: boolean },
): { status: StatusKey; detail?: string } {
  if (!service.enabled) return { status: 'disabled' };
  if (service.credential_sealed === null) return { status: 'no_credential' };
  if (o.unreadable) return { status: 'credential_unreadable' };
  if (o.outside) return { status: 'outside_hosts' };
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

/** Credential access rules that let jobs call: enabled, unexpired, not inactive or blocked. */
export function usableAccesses(rules: readonly RuleEdge[], now: number): RuleEdge[] {
  return rules.filter(
    (edge) =>
      edge.rule.enabled &&
      (edge.rule.expires_at === null || edge.rule.expires_at > now) &&
      edge.status !== 'inactive' &&
      edge.status !== 'global_blocked',
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
  rules: RuleEdge[];
  /** Allowed requests per credential access rule in the last 30 days (map order, relation line). */
  usage: ReadonlyMap<string, RuleUsage>;
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

/** Allowed requests through the credential's rules in the last 30 days. */
function usage30d(data: TokenPageData): number {
  return data.rules.reduce((sum, edge) => sum + (data.usage.get(edge.rule.id)?.requests ?? 0), 0);
}

/** The people to ask for an access, and one mail to all of them with the link in the body. */
function handoffMail(ctx: ViewContext, service: Service, url: string): string | null {
  const people = ctx.askers('access:write');
  if (people.length === 0) return null;
  const query = new URLSearchParams({
    subject: `Access to credential ${service.name}`,
    body: `Please add a credential access rule to the credential ${service.name}: ${url}`,
  })
    .toString()
    .replace(/\+/g, '%20');
  return `mailto:${people.map((person) => person.email).join(',')}?${query}`;
}

/**
 * The header of a token page: breadcrumb, identity (logo, name, status, type, slug, ID, host),
 * Test, and the one primary: "Add credential access rule" for access managers, else "Ask an access
 * manager" (a mail with the link) for credential managers. Then the relation line.
 */
export function TokenHeader(props: { ctx: ViewContext; data: TokenPageData }) {
  const { ctx, data } = props;
  const { service } = data;
  const status = tokenStatus(service, {
    unreadable: unreadable(data),
    outside: data.outside,
  });
  const attested = data.binding.status === 'attested';
  const giveHref = paths.accessRuleNew({ credential: service.id });
  const mail = ctx.can('tokens:write')
    ? handoffMail(ctx, service, `${data.proxyOrigin}${giveHref}`)
    : null;
  const test = ctx.can('tokens:write') && service.verify !== null && attested;
  const primary = ctx.can('access:write') ? (
    <Button variant="primary" plus href={giveHref}>
      Add credential access rule
    </Button>
  ) : mail ? (
    <Button variant="primary" href={mail}>
      Ask an access manager
    </Button>
  ) : null;
  return (
    <PageHeader
      crumbs={[{ href: paths.tokens(), label: 'Credentials' }, { label: service.name }]}
      identity={
        <Identity
          logo={templateLogo(data.template, { disabled: !service.enabled })}
          title={service.name}
          status={<StatusBadge status={status.status} detail={status.detail} />}
          type={typeLabel(data.template)}
          slug={service.slug}
          entityId={{ value: service.id, kind: 'Credential' }}
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
  const usable = usableAccesses(data.rules, ctx.now);
  const issuers = new Set(usable.map((edge) => edge.rule.issuer_key)).size;
  const reason = unusableReason(data);
  const reasonText = reason !== null ? ` The credential is not usable now: ${reason}.` : '';
  const requests = data.usageAvailable && data.sampleRate > 0 ? usage30d(data) : 0;
  const listHref = paths.accessRules({ credential: service.id });
  if (usable.length === 0) {
    return (
      <>
        No workload can use {service.name} yet.{reasonText}
      </>
    );
  }
  return (
    <>
      Workloads of <a href={listHref}>{plural(issuers, 'issuer')}</a> can use {service.name} through{' '}
      <a href={listHref}>{plural(usable.length, 'credential access rule')}</a>.{reasonText}
      {requests > 0
        ? ` ${formatCount(requests)} allowed ${requests === 1 ? 'request' : 'requests'} in the last 30 days.`
        : ''}
    </>
  );
}

export function TokenPage(props: { ctx: ViewContext; data: TokenPageData; state: TokenPageState }) {
  const { ctx, data, state } = props;
  const { service } = data;
  const canDelete = ctx.can('tokens:write') && (data.rules.length === 0 || ctx.can('access:write'));
  return (
    <>
      <Problems ctx={ctx} data={data} />
      <RulesTray ctx={ctx} data={data} />
      <DetailLayout railLabel={`${service.name} details`} rail={<Rail ctx={ctx} data={data} />}>
        <SecretTray ctx={ctx} data={data} state={state} />
        <UseTray data={data} />
        <DestinationTray ctx={ctx} data={data} state={state} />
        <Danger ctx={ctx} data={data} />
        {ctx.can('tokens:write') && data.binding.status === 'attested' ? (
          <ReplaceDialog ctx={ctx} data={data} state={state.secret} />
        ) : null}
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
      title: 'No secret is stored, so requests through this credential fail.',
      more: 'Set it under Destination; you will be asked to confirm the host.',
      fix: destinationFix,
    });
  }
  if (data.keyringError !== null) {
    problems.push({
      tone: 'bad',
      title: 'Encryption keys are not loaded: the secret cannot be used or changed.',
      more: KEYRING_ERROR_TEXT[data.keyringError],
      fix: { href: paths.tokenKeys(), label: 'Open rotate encryption' },
    });
  }
  if (storedUpstreamHost(service.base_url) === null) {
    problems.push({
      tone: 'bad',
      title: 'The stored base URL cannot be read, so requests through this credential are refused.',
      more: 'Set the destination again under Change destination.',
      fix: destinationFix,
    });
  } else if (data.outside) {
    problems.push({
      tone: 'bad',
      title: `${upstreamHost(service.base_url)} is not an allowed host, so requests through this credential are refused.`,
      fix: { href: paths.tokenHosts(), label: 'Open allowed hosts', permission: 'settings:write' },
    });
  }
  const pairReason = data.also === null ? undefined : PAIR_FAILURE_REASONS[data.also];
  if (pairReason !== undefined) {
    problems.push({
      tone: 'warn',
      title: `The GitHub release asset uploads credential was not created: ${pairReason}.`,
      more: 'This credential was saved; add the uploads credential on its own.',
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
        : 'The stored secret does not match this credential: either its base URL or the way the secret is sent was changed outside the admin UI, or the key behind its key id was replaced (see Settings › Rotate encryption).'
      : binding.error === 'keyring_missing_key'
        ? 'The stored secret was encrypted with a key that is no longer in the keyring, so the stored base URL and injection cannot be confirmed.'
        : 'The stored secret is damaged, so the stored base URL and injection cannot be confirmed.';
  return `${cause} Treat this as possible tampering: a secret entered now goes to the base URL you submit. Check the base URL and injection against an out-of-band source (the provider's documentation, your configuration as code) before you enter the secret again. The audit log is not a reliable reference: anyone who can edit the database can edit it too.`;
}

/** Why a credential with a secret and rules still cannot serve them, or null. */
function unusableReason(data: TokenPageData): string | null {
  const { service } = data;
  if (!service.enabled) return 'the credential is disabled';
  if (service.credential_sealed === null) return 'no secret is stored';
  if (unreadable(data)) return 'the stored secret does not open';
  if (storedUpstreamHost(service.base_url) === null) return 'its base URL cannot be read';
  if (data.outside) return `${upstreamHost(service.base_url)} is not an allowed host`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Who can use it

function lastUsedText(edge: RuleEdge, data: TokenPageData, now: number): string | null {
  if (data.sampleRate === 0 || !data.usageAvailable) return null;
  return edge.lastUsedHour === null
    ? 'not used in 30 days'
    : `last used ${relativeTime(edge.lastUsedHour, now)}`;
}

function ruleRow(
  edge: RuleEdge,
  data: TokenPageData,
  ctx: ViewContext,
  tokenName: string,
): WhoAccess {
  const [first, ...more] = edge.operations;
  const used = lastUsedText(edge, data, ctx.now);
  const expires = edge.rule.expires_at;
  const risky = edge.flags.some((flag) => flag.status === 'risk_accepted');
  const global =
    edge.globalStatus.kind === 'blocked'
      ? 'blocked by global access rules'
      : edge.globalStatus.kind === 'limited'
        ? 'limited by global access rules'
        : null;
  return {
    name: edge.rule.name,
    href: paths.accessRule(edge.rule.id),
    context: `${edge.subject} · ${edge.context}`,
    meta: (
      <>
        {first ? <code>{first}</code> : 'no operations'}
        {more.length > 0 ? ` +${more.length}` : ''} ·{' '}
        {expires === null ? 'never expires' : `ends ${uiFormatTime(new Date(expires), 'day')}`}
        {global ? (
          <>
            {' · '}
            <span class={edge.globalStatus.kind === 'blocked' ? 't-bad' : 't-warn'}>{global}</span>
          </>
        ) : null}
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
        <a class="sm" href={paths.accessRule(edge.rule.id, { open: 'edit' })}>
          Extend
          <span class="vh">
            {' '}
            {edge.rule.name} → {tokenName}
          </span>
        </a>
      ) : undefined,
    warn:
      edge.status === 'expiring' ||
      edge.status === 'inactive' ||
      edge.status === 'expired' ||
      edge.status === 'global_blocked',
  };
}

/**
 * Who can use the credential (A7.9): its credential access rules grouped by issuer and tenant, the
 * busiest group first, with each rule's jobs, operations, global status and state.
 */
function RulesTray(props: { ctx: ViewContext; data: TokenPageData }) {
  const { ctx, data } = props;
  const { service } = data;
  const groupKey = (edge: RuleEdge) => `${edge.rule.issuer_key}\u0000${tenantsText(edge.rule, [])}`;
  const byIssuer = new Map<string, RuleEdge[]>();
  for (const edge of data.rules) {
    const list = byIssuer.get(groupKey(edge)) ?? [];
    list.push(edge);
    byIssuer.set(groupKey(edge), list);
  }
  const requests = (edge: RuleEdge) => data.usage.get(edge.rule.id)?.requests ?? 0;
  const ordered = [...byIssuer.entries()]
    .map(([id, edges]) => ({
      id,
      edges: [...edges].sort((a, b) => requests(b) - requests(a)),
      total: edges.reduce((sum, edge) => sum + requests(edge), 0),
      name: edges[0] ? issuerHost(edges[0].rule.issuer) : 'Unknown issuer',
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const shown = ordered.slice(0, MAP_GROUPS);
  const hidden = ordered.slice(MAP_GROUPS);
  const groups: WhoGroup[] = shown.map((group) => {
    const first = group.edges[0]?.rule ?? null;
    const rows = group.edges.slice(0, MAP_ROWS);
    const rest = group.edges.slice(MAP_ROWS);
    const restExpiring = rest.filter((edge) => edge.status === 'expiring').length;
    const tenants = first ? tenantsText(first, []) : '';
    return {
      consumer: {
        name: group.name,
        href: paths.accessRules({
          credential: service.id,
          ...(first ? { issuer: first.issuer_key } : {}),
        }),
        line: `${plural(group.edges.length, 'access rule')}${tenants && tenants !== 'No pin' ? ` · ${tenants}` : ''}`,
        logo: issuerLogo(first),
        count: group.edges.length,
      },
      accesses: rows.map((edge) => ruleRow(edge, data, ctx, service.name)),
      more:
        rest.length > 0
          ? {
              href: paths.accessRules({
                credential: service.id,
                ...(first ? { issuer: first.issuer_key } : {}),
              }),
              label: `+ ${plural(rest.length, 'more access rule')}`,
              srSuffix: `of ${group.name} to ${service.name}`,
              meta: restExpiring > 0 ? `${restExpiring} expiring` : undefined,
            }
          : undefined,
    };
  });
  const hiddenRules = hidden.reduce((sum, group) => sum + group.edges.length, 0);
  const cut = hidden.length > 0 || shown.some((group) => group.edges.length > MAP_ROWS);
  const giveHref = paths.accessRuleNew({ credential: service.id });
  const canGive = ctx.can('access:write');
  const listHref = paths.accessRules({ credential: service.id });
  return (
    <Tray
      id="rules"
      title={`Who can use ${service.name}`}
      count={data.rules.length}
      description={
        <>
          Each line is one credential access rule, grouped by issuer. Workloads call{' '}
          <code>{`/proxy/${service.slug}`}</code>; they never see the secret.
        </>
      }
      actions={
        <>
          <LinkAction href={paths.requests({ token: service.id })} arrow>
            Requests through {service.name}
          </LinkAction>
          <LinkAction href={listHref} arrow>
            All its access rules
          </LinkAction>
        </>
      }
    >
      <WhoCanUse
        label={`Credential access rules of ${service.name}, grouped by issuer`}
        token={{
          name: service.name,
          logo: templateLogo(data.template, { disabled: !service.enabled }),
          path: `/proxy/${service.slug}`,
        }}
        groups={groups}
        rest={
          hidden.length > 0
            ? {
                href: listHref,
                label: `+ ${plural(hidden.length, 'more issuer')} · ${plural(hiddenRules, 'access rule')}`,
                line: `Open them in the list, filtered to ${service.name}`,
              }
            : undefined
        }
        empty={{
          title: 'No credential access rules yet',
          children: canGive ? (
            <>
              <p>
                Add a credential access rule so that workloads can call{' '}
                <code>{`/proxy/${service.slug}`}</code>.
              </p>
              <div>
                <Button size="sm" plus href={giveHref}>
                  Add credential access rule
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
                {plural(byIssuer.size, 'issuer')}, {plural(data.rules.length, 'access rule')}.
              </b>{' '}
              The map shows the {plural(shown.length, 'issuer')} with the most requests and up to{' '}
              {MAP_ROWS} rules each. The <a href={listHref}>list</a> shows all of them.
            </>
          ) : undefined
        }
        footerAction={
          canGive && groups.length > 0 ? (
            <Button variant="ghost" size="sm" plus href={giveHref}>
              Add another credential access rule
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
  const absolute = `${data.proxyOrigin}${paths.accessRuleNew({ credential: service.id })}`;
  return (
    <div class="stack-sm">
      <p>Access managers add credential access rules. Send them this link:</p>
      <Field
        id="handoff"
        label={`Link that opens “Add credential access rule” for ${service.name}`}
        hint="Select to copy."
      >
        <Input name="handoff" mono readonly value={absolute} />
      </Field>
      <AskSomeone
        permission="access:write"
        ctx={ctx}
        verb="add a credential access rule"
        subject={`Access to credential ${service.name}`}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Secret

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
      {canWrite && !attested ? (
        <Panel variant="pad">
          {data.keyringError !== null ? (
            <p>
              Secrets cannot be changed while the encryption keys are not loaded.{' '}
              <a href={paths.tokenKeys()}>Open rotate encryption</a>
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
          by {data.lastSet?.actor_email ?? 'someone (not recorded)'}
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

/**
 * Replacing a secret is rare, so it is a danger zone action: the dialog posts the new secret.
 * After a failed check or a refused secret the page renders the dialog open, in the page flow.
 */
function ReplaceDialog(props: { ctx: ViewContext; data: TokenPageData; state?: FormState }) {
  const { ctx, data, state } = props;
  const { service, template } = data;
  const ids = new FormIds('secret', state?.errors ?? []);
  const secret = secretPlaceholder(template);
  const submitted = state ? new Set(state.values.also_replace.split(',')) : null;
  const failedCheck = !!state?.verify;
  const context = `of ${service.name}`;
  return (
    <Dialog
      id="dlg-replace"
      wide
      open={state !== undefined}
      title={`Replace the secret of ${service.name}`}
      description={`Replaces ${service.credential_hint ?? 'the stored secret'}. Callers keep working, with the new secret from the next request.`}
      action={`${paths.token(service.id)}/secret`}
      // The destination shown here, so a token repointed since is refused (I-CRED-2).
      hidden={ctx.hidden({ expected_destination: data.destinationFingerprint })}
      footer={
        <>
          {state ? (
            <a class="btn secondary" href={paths.token(service.id)}>
              Cancel
            </a>
          ) : (
            <DialogClose dialog="dlg-replace" />
          )}
          {failedCheck ? (
            <Button type="submit" name="save_anyway" value="1" srSuffix={context}>
              Save without a passing check
            </Button>
          ) : null}
          <Button variant="primary" type="submit" srSuffix={context}>
            {failedCheck
              ? 'Check again and save'
              : service.verify
                ? 'Check and replace'
                : 'Replace secret'}
          </Button>
        </>
      }
    >
      <SecretField
        ids={ids}
        label={`New ${inSentence(secret.label)}`}
        placeholder={secret.placeholder}
        hint={`Sent to ${upstreamHost(service.base_url)}.`}
        pattern={template?.secret.pattern}
        draft={state?.draft ?? null}
      />
      {state?.verify ? <CheckResult verify={state.verify} /> : null}
      {failedCheck ? <p class="hint">{SAVE_ANYWAY_HINT}</p> : null}
      {data.siblings.map((sibling) => (
        <Checkbox
          name="also_replace"
          id={ids.id(`also_replace.${sibling.id}`)}
          value={sibling.id}
          checked={submitted ? submitted.has(sibling.id) : true}
          label={`Also replace in ${sibling.slug} (same secret, ${sibling.credential_hint ?? 'stored'})`}
        />
      ))}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// How workloads call it

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
      title="How workloads call it"
      description="Workloads send their identity token; tokengate adds the secret on the way out."
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
              caption="Example call from a workload that has access (select to copy)"
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
  // A type's destination is fixed: its form only sets a secret that is missing or does not open.
  const fixed = template !== null;
  const editDestination =
    unattested || none || !!state.destination || (!fixed && state.open === 'destination');
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
      title={fixed ? 'Settings' : 'Destination'}
      description={
        template
          ? `${template.label}: the destination is fixed.`
          : 'Set when the credential was added.'
      }
      actions={
        canWrite && !(editDestination && editDetails) ? (
          <>
            {editDestination || fixed ? null : (
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
            // A type's own destination goes unsaid; one that does not open is shown, unconfirmed.
            ...(fixed && !unattested
              ? []
              : [
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
                ]),
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
            summary={template ? 'Set the secret' : 'Change destination'}
            hint={
              template
                ? `sent to ${upstreamHost(template.base_url)}`
                : 'base URL and how the secret is sent'
            }
            open
          >
            <DestinationForm ctx={ctx} data={data} state={state.destination} />
          </Disclosure>
        </Panel>
      ) : null}
      {canWrite && editDetails ? (
        <Panel variant="pad">
          <Disclosure id="details" summary="Edit name and options" open>
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
  // A type's host is always typed: its form sets a secret only after that confirmation.
  const confirm =
    data.binding.status === 'unattested' || service.credential_sealed === null || template !== null;
  const ids = new FormIds('destination', state?.errors ?? []);
  // An unattested or absent binding is not prefilled: the admin types the destination from an
  // out-of-band source instead of resubmitting a possibly tampered value (I-CRED-2).
  const defaults: TokenFormValues = attested ? valuesFromService(service) : { ...EMPTY_VALUES };
  const values = state ? { ...state.values, confirm_destination: '' } : defaults;
  const listed = data.allowlist !== null && data.allowlist.length > 0;
  const canAllow = ctx.can('settings:write');
  // Shown from the start, as on the custom card, so a new host needs one submit: the server
  // applies it only when the submitted host is not covered (A13.8.3). A type's host is its own.
  const showAllow = canAllow && listed && template === null;
  // Unattested or none: only code-sourced suggestions; D1 values could be the attacker's.
  const suggestions = attested
    ? baseUrlSuggestions(data.allowlist, data.tokens)
    : SERVICE_TEMPLATES.map((t) => ({ value: t.base_url, label: t.label }));
  const secret = secretPlaceholder(template);
  return (
    <PostForm action={`${paths.token(service.id)}/destination`} csrf={ctx.csrf} class="stack-sm">
      {/* A type's destination comes from the type on the server; only a custom one is typed. */}
      {template ? null : (
        <>
          <Field
            id={ids.id('base_url')}
            label="Base URL"
            hint={
              <>
                https only, no query string. Changing it requires the secret again: the secret is
                bound to its destination.
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
        </>
      )}
      {confirm ? (
        <Field
          id={ids.id('confirm_destination')}
          label="Confirm destination host"
          hint={
            template
              ? `Type ${upstreamHost(template.base_url)}, the host the secret is sent to. Nothing is sent upstream until this matches.`
              : "Check the base URL against the provider's docs, then type its host only, without https:// or a path. Nothing is sent upstream until this matches."
          }
          error={ids.error('confirm_destination') ?? undefined}
        >
          <Input
            name="confirm_destination"
            mono
            required
            value=""
            placeholder={template ? upstreamHost(template.base_url) : 'api.example.com'}
            pattern={HOST_PATTERN}
          />
        </Field>
      ) : null}
      <SecretField
        ids={ids}
        label={secret.label}
        placeholder={secret.placeholder}
        hint={template ? undefined : 'Required: a new destination needs the secret again.'}
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
          hint="Only when the base URL's host is not allowed yet. Applies to every credential."
          error={ids.error('allow_host')}
        />
      ) : null}
      <SecretSubmits
        label={
          template
            ? service.verify
              ? 'Check and save the secret'
              : 'Save the secret'
            : service.verify
              ? 'Check and change destination'
              : 'Change destination'
        }
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
  const usable = usableAccesses(data.rules, ctx.now);
  const workloads = new Set(usable.map((edge) => edge.rule.issuer_key)).size;
  const rules = data.rules;
  const toggle = `${paths.token(service.id)}/toggle`;
  const countText = plural(rules.length, 'credential access rule');
  return (
    <DangerZone id="danger">
      {data.binding.status === 'attested' ? (
        <DangerRow
          title="Replace secret"
          description="When the secret leaked or the provider issued a new one. Callers keep working, with the new secret from the next request."
          action={
            <DialogTrigger dialog="dlg-replace" variant="danger">
              Replace secret…
            </DialogTrigger>
          }
        />
      ) : null}
      {service.enabled ? (
        <DangerRow
          title="Disable credential"
          description={`The workloads of ${plural(workloads, 'issuer')} lose access until you enable it again. Nothing is deleted.`}
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
          title="Enable credential"
          description="Its credential access rules allow calls again."
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
      {rules.length === 0 ? (
        <DangerRow
          title={`Delete ${service.name}`}
          description="The credential and its stored secret are deleted. The audit log keeps its configuration, never the secret."
          action={
            <DialogTrigger dialog="dlg-delete" variant="danger">
              Delete {service.name}…
            </DialogTrigger>
          }
        />
      ) : ctx.can('access:write') ? (
        <DangerRow
          title={`Delete ${service.name} and its ${countText}`}
          description="The secret and the credential access rules are removed. This cannot be undone."
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
              {service.name} cannot be deleted while credential access rules use it. Disable the
              credential now; an access manager can delete the rules, or an admin can delete both.
              Rules:{' '}
              {rules.map((edge, index) => (
                <>
                  {index > 0 ? ' · ' : null}
                  <a href={paths.accessRule(edge.rule.id)}>{edge.rule.name}</a>
                </>
              ))}
            </>
          }
          action={<AskSomeone permission="access:write" ctx={ctx} verb="delete these rules" />}
        />
      )}
    </DangerZone>
  );
}

function DeleteDialog(props: { ctx: ViewContext; data: TokenPageData }) {
  const { ctx, data } = props;
  const { service } = data;
  const rules = data.rules;
  const countText = plural(rules.length, 'credential access rule');
  const cascade = rules.length > 0;
  const disableInstead = cascade && service.enabled;
  return (
    <>
      <ConfirmDialog
        id="dlg-delete"
        title={cascade ? `Delete ${service.name} and its ${countText}?` : `Delete ${service.name}?`}
        description={
          cascade ? (
            <>
              This cannot be undone. The secret is destroyed, and from the next request these
              workloads get <code>404</code> from <code>{`/proxy/${service.slug}`}</code>:
            </>
          ) : (
            'The credential and its stored secret are deleted. The audit log keeps its configuration, never the secret.'
          )
        }
        action={`${paths.token(service.id)}/delete`}
        hidden={ctx.hidden({
          confirm: '1',
          ...(cascade
            ? {
                with_rules: '1',
                rule_ids: rules
                  .map((edge) => edge.rule.id)
                  .sort()
                  .join(','),
              }
            : {}),
        })}
        confirmLabel={`Delete ${service.name}`}
        affected={rules.map((edge) => (
          <Entity
            logo={issuerLogo(edge.rule)}
            logoSize="sm"
            name={`${edge.rule.name} · ${edge.subject}`}
            href={paths.accessRule(edge.rule.id)}
            meta={`${issuerHost(edge.rule.issuer)} · ${edge.context}${
              lastUsedText(edge, data, ctx.now) ? ` · ${lastUsedText(edge, data, ctx.now)}` : ''
            }`}
          />
        ))}
        confirmText={
          cascade
            ? {
                value: service.slug,
                name: 'confirm_slug',
                hint: 'The slug of this credential, in lower case.',
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
            }To stop them for now, disable the credential instead: nothing is deleted and you can enable it again.`}
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

/** "Created credential openai with a secret" after the actor: "created credential openai …". */
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
              { label: 'Credential ID', value: service.id, mono: true, copyable: true },
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
