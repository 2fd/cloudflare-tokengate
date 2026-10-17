// Monitoring › Overview (`GET /admin`): what needs attention (every alert, with its fix), where
// calls went (the request pipeline), the top denied callers, which consumers use which token (the
// connections map), traffic per hour and the latest changes, then every health check, collapsed.
// An empty install shows the getting-started steps instead. Read-only. Only names, counts and
// states are shown, never configured values that could be secret (I-CFG-1, I-CRED-1). Denials
// from unverified tokens never prefill a form (I-LOG-2).
import {
  Badge,
  Callout,
  Chart,
  type ChartBar,
  Checklist,
  ChecklistProgress,
  type ChecklistStep,
  Chip,
  Chips,
  CodeBlock,
  Column,
  ConnectionsMap,
  Disclosure,
  Dot,
  EmptyState,
  Feed,
  FeedDay,
  FeedItem,
  Grid,
  Stack,
  Legend,
  LinkAction,
  LiveSummary,
  type MapAccess,
  type MapConsumer,
  type MapToken,
  PageHeader,
  Panel,
  Pipeline,
  Segmented,
  SummaryRow,
  SummaryWire,
  Button,
  Cell,
  Row,
  RowHeader,
  Table,
  Time as UiTime,
  Tray,
  ZeroState,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import type { App } from '../../app';
import { parseConfig } from '../../config';
import { getAdminHosts } from '../../db/settings';
import type { Service } from '../../db/types';
import type { AppEnv } from '../../env';
import { SCHEMA_HEAD } from '../../generated/schema-head';
import { PROFILES } from '../../identity/profiles';
import {
  type AlertData,
  alertsFor,
  EXPIRY_WARNING_MS,
  loadOverview,
  type OverviewData,
  outsideAllowedHosts,
  overviewAlerts,
  type SeriesBucket,
} from '../../telemetry/dashboard';
import {
  OVERVIEW_RANGES,
  type OverviewRange,
  parseRange,
  RANGE_LABEL,
} from '../../telemetry/ranges';
import { hourStart } from '../../telemetry/rollup';
import { type AccessEdge, type Connections, loadConnections } from '../connections';
import { loadDone, type NoticeTable, resolveNotice } from '../notice';
import { paths } from '../paths';
import { renderPage, type ViewContext } from '../render';
import type { Alert } from '../views/alerts';
import { AskSomeone } from '../views/components';
import {
  formatCount,
  formatPercent,
  formatShortTime,
  loginProviderNames,
  relativeTime,
} from '../views/format';
import {
  ActorAvatar,
  ApproveOwnerDialogs,
  AttentionCards,
  actionText,
  AuditTarget,
  auditActorText,
  byUtcDay,
  consumerLogo,
  dayLabel,
  FindRequest,
  pipelineStages,
  TopDenied,
  toAttentionItems,
  tokenLogo,
} from '../views/monitoring';
import { type StatusKey, STATUS, statusLabel, uiTone } from '../views/status';
import { auditTargetNames, loadAuditPeople } from './audit';

export { percentileText } from '../views/monitoring';

/**
 * Whether any verified call exists. Pre-trust rejections (claims_verified = 0, e.g. anonymous
 * probes) do not count; the partial index request_log_verified makes this a one-row read.
 */
export const VERIFIED_CALL_SQL = 'SELECT id FROM request_log WHERE claims_verified = 1 LIMIT 1';

/** Notices of the row actions that return to the Overview (`_return=overview`). */
const NOTICES: NoticeTable = {
  rewrapped: () => ({ text: 'Secrets re-encrypted with the active key.' }),
  rewrapped_partial: () => ({
    text: 'Secrets re-encrypted with the active key, except some that changed while this ran. Run it again to finish.',
  }),
  rewrap_none: () => ({ text: 'Nothing to re-encrypt: every secret already uses the active key.' }),
  key_confirmed: () => ({ text: 'New key confirmed: every secret opens with it.' }),
  approved: () => ({
    text: 'Person approved. They can use the admin console from their next request.',
  }),
  rejected: () => ({ text: 'Person rejected and suspended.' }),
};

/** Bar unit and label column of the chart, per range. */
const CHART = {
  '24h': { unit: 'hour', tickEvery: 3, column: 'Hour (UTC)' },
  '7d': { unit: '6 hours', tickEvery: 4, column: 'From (UTC)' },
  '30d': { unit: 'day', tickEvery: 5, column: 'Day (UTC)' },
} as const;

export function registerOverviewRoutes(app: App): void {
  app.get('/admin', async (c) => {
    const deps = c.get('deps');
    const rawRange = c.req.query('range');
    const parsed = parseRange(rawRange, OVERVIEW_RANGES);
    const range: OverviewRange = parsed ?? '24h';
    const [overview, connections, verifiedCall, adminHosts, people, done] = await Promise.all([
      loadOverview(deps, range),
      loadConnections(deps),
      deps.env.TELEMETRY_DB.prepare(VERIFIED_CALL_SQL)
        .first()
        .then((row) => row !== null)
        .catch(() => false),
      getAdminHosts(deps.env.DB),
      loadAuditPeople(deps.env.DB),
      loadDone(deps, { userId: c.get('viewer').user.id }, c.req.query('done')),
    ]);
    // `?focus=` is a credential access rule id of the map; anything else is ignored, never echoed.
    const rawFocus = c.req.query('focus');
    const focus = connections.consumers.some((consumer) => consumer.id === rawFocus)
      ? rawFocus
      : undefined;
    const steps = setupSteps(connections, overview.alertData, verifiedCall);
    const doneCount = Object.values(steps).filter(Boolean).length;
    // Fresh: nothing set up and nothing to show. Refused calls on a new install are worth showing
    // (Top denied offers "Add credential access rule"), so any traffic or denial means the setup layout.
    const fresh =
      doneCount === 0 &&
      overview.telemetryAvailable &&
      overview.totals.requests === 0 &&
      overview.denials.groups.length === 0;
    const rangeQuery = range === '24h' ? undefined : { range };
    return renderPage(
      c,
      {
        title: `Overview (last ${RANGE_LABEL[range]})`,
        section: 'monitoring',
        subsection: 'overview',
        notice: resolveNotice(NOTICES, c.req.query('notice'), done),
        alertData: overview.alertData,
        header: (ctx) =>
          fresh ? (
            <PageHeader
              title="Overview"
              description={`Nothing calls through ${ctx.host} yet. Four steps connect a CI job to an upstream API without putting the API key in the job.`}
            />
          ) : (
            <PageHeader
              title="Overview"
              description={
                <>
                  Since <UiTime datetime={new Date(overview.window.from)} format="datetime" /> UTC:
                  what needs you, where calls went, and who uses which token.
                </>
              }
              actions={
                <>
                  <span class="meta">
                    Updated <UiTime datetime={new Date(overview.generatedAt)} format="clock" />{' '}
                    <span class="sep" aria-hidden="true">
                      ·
                    </span>{' '}
                    <a href={paths.overview(rangeQuery)}>Refresh</a>
                  </span>
                  <Segmented
                    label="Time range"
                    size="sm"
                    items={OVERVIEW_RANGES.map((key) => ({
                      label: RANGE_LABEL[key],
                      href: paths.overview(key === '24h' ? undefined : { range: key }),
                      current: key === range,
                    }))}
                  />
                </>
              }
            />
          ),
      },
      (ctx) => {
        const page = {
          ctx,
          data: overview,
          connections,
          adminHosts,
          env: deps.env,
          rangeNote: rawRange !== undefined && parsed === null,
          names: auditTargetNames(connections, people),
          suspended: new Set(people.filter((p) => p.status === 'suspended').map((p) => p.id)),
          steps,
          doneCount,
          focus,
        };
        return fresh ? <FreshOverview {...page} /> : <OverviewPage {...page} />;
      },
    );
  });
}

interface PageData {
  ctx: ViewContext;
  data: OverviewData;
  connections: Connections;
  adminHosts: string[] | null;
  env: AppEnv;
  rangeNote: boolean;
  names: ReadonlyMap<string, string>;
  suspended: ReadonlySet<string>;
  steps: SetupSteps;
  doneCount: number;
  focus: string | undefined;
}

function RangeNote(props: { show: boolean }) {
  return props.show ? (
    <Callout title="That time range is not available; showing the last 24 hours." />
  ) : null;
}

/** The sampling note: counts are estimates below 100 %, and unknown at 0 %. */
function SamplingNote(props: { rate: number }) {
  const { rate } = props;
  if (rate >= 1) return null;
  return (
    <Callout
      tone={rate <= 0 ? 'warn' : 'info'}
      title={
        rate <= 0
          ? 'Allowed requests are not recorded (sample rate 0). Allowed counts and "last used" are not available.'
          : `Allowed requests are sampled at ${formatPercent(rate)}, so counts are estimates.`
      }
      actions={<LinkAction href={paths.retention()}>Change in Data retention</LinkAction>}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Populated and setup layouts

function OverviewPage(props: PageData) {
  const { ctx, data, connections } = props;
  const { range } = data;
  const alerts = overviewAlerts(data.alertData);
  const items = toAttentionItems(alerts, ctx);
  const checks = healthChecks(data.alertData, props.adminHosts, props.env);
  const problems = checks.filter((check) => !check.ok).length;
  const warnings = alerts.filter((alert) => alert.level === 'warning').length;
  const notes = alerts.filter((alert) => alert.level === 'info').length;
  const errors = alerts.filter((alert) => alert.level === 'error').length;
  const tokenNames = new Map(connections.tokens.map((t) => [t.id, t.name]));
  const { totals } = data;
  return (
    <>
      <RangeNote show={props.rangeNote} />
      {props.doneCount < 4 ? (
        <GetStarted
          ctx={ctx}
          connections={connections}
          steps={props.steps}
          doneCount={props.doneCount}
        />
      ) : null}
      <Tray
        id="attention"
        title="Needs attention"
        count={items.length}
        actions={
          <span class="meta">
            {[
              errors > 0 ? `${errors} ${errors === 1 ? 'error' : 'errors'}` : null,
              `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`,
              `${notes} ${notes === 1 ? 'note' : 'notes'}`,
            ]
              .filter(Boolean)
              .join(' · ')}{' '}
            ·{' '}
            <a href={paths.overview({ hash: 'health' })}>
              health checks{' '}
              {problems > 0 ? `${problems} ${problems === 1 ? 'problem' : 'problems'}` : 'all OK'}
            </a>
          </span>
        }
      >
        <Panel>
          {items.length === 0 ? (
            <ZeroState>No problems found.</ZeroState>
          ) : (
            <AttentionCards items={items} layout="cols" />
          )}
          <ApproveOwnerDialogs alerts={alerts} ctx={ctx} />
        </Panel>
      </Tray>
      <Tray
        id="flow"
        title="Where calls went"
        description={
          !data.telemetryAvailable ? undefined : (
            <>
              {formatCount(totals.requests)} {totals.requests === 1 ? 'call' : 'calls'} in the last{' '}
              {RANGE_LABEL[range]}.{' '}
              {totals.denied > 0 ? (
                <b class="t-bad">
                  {formatCount(totals.denied)} {totals.denied === 1 ? 'was' : 'were'} denied (
                  {formatPercent(totals.requests > 0 ? totals.denied / totals.requests : 0)}).
                </b>
              ) : (
                'None were denied.'
              )}{' '}
              Select a stage to see its requests.
            </>
          )
        }
        bar={<FindRequest placement="tray" />}
      >
        {data.alertData.sampleRate < 1 ? (
          <Panel variant="pad">
            <SamplingNote rate={data.alertData.sampleRate} />
          </Panel>
        ) : null}
        <Panel variant={data.telemetryAvailable ? undefined : 'pad'}>
          {data.telemetryAvailable ? (
            <Pipeline stages={pipelineStages(totals, data.tokens, range, tokenNames)} />
          ) : (
            <Callout
              tone="warn"
              title="The request log could not be read, so traffic is not shown."
            />
          )}
        </Panel>
      </Tray>
      {data.telemetryAvailable ? <TopDeniedTray {...props} /> : null}
      <TokensInUse {...props} />
      <Grid>
        <Column span={8}>
          <Stack>
            {data.telemetryAvailable ? (
              <TrafficTray data={data} />
            ) : (
              <Tray id="traffic" title={`Requests per ${CHART[range].unit}`}>
                <Panel variant="pad">
                  <ZeroState>The request log could not be read, so traffic is not shown.</ZeroState>
                </Panel>
              </Tray>
            )}
            <HealthTray checks={checks} alerts={alerts} />
          </Stack>
        </Column>
        <Column span={4}>
          <RecentChanges data={data} names={props.names} suspended={props.suspended} />
        </Column>
      </Grid>
    </>
  );
}

function TopDeniedTray(props: PageData) {
  const { data, connections, ctx } = props;
  const { range, denials } = data;
  const since = formatShortTime(data.window.from);
  return (
    <Tray
      id="denials"
      title="Top denied callers"
      description={
        denials.groups.length > 0
          ? `The ${denials.groups.length} ${denials.groups.length === 1 ? 'group' : 'groups'} behind the newest denials since ${since}. Fix them from here.`
          : undefined
      }
      actions={
        <LinkAction href={paths.requests({ range, outcome: 'denied' })} arrow>
          All {formatCount(data.totals.denied)} denied
        </LinkAction>
      }
      footer={denials.bounded ? 'Grouped from the newest 2,000 denials.' : undefined}
    >
      {denials.groups.length === 0 ? (
        <Panel variant="pad">
          <ZeroState>No denied requests in the selected range.</ZeroState>
        </Panel>
      ) : (
        <Panel variant="flush">
          <TopDenied
            groups={denials.groups}
            range={range}
            caption={`Top denied callers since ${since}`}
            now={data.generatedAt}
            consumers={new Map(connections.consumers.map((c) => [c.id, c]))}
            tokens={new Map(connections.tokens.map((t) => [t.id, t]))}
            ctx={ctx}
          />
        </Panel>
      )}
    </Tray>
  );
}

/** The numbers of the chart bars: label, tooltip range and the "so far" bar. */
function chartBars(series: readonly SeriesBucket[], range: OverviewRange): ChartBar[] {
  const two = (n: number) => String(n).padStart(2, '0');
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const clock = (ms: number) => {
    const d = new Date(ms);
    return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  };
  const day = (ms: number) => {
    const d = new Date(ms);
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
  };
  return series.map((bucket) => {
    const label =
      range === '24h'
        ? clock(bucket.start)
        : range === '7d'
          ? `${day(bucket.start)} ${clock(bucket.start)}`
          : day(bucket.start);
    const end = bucket.start + (range === '24h' ? 3_600_000 : range === '7d' ? 21_600_000 : 0);
    return {
      label,
      range: range === '30d' ? label : `${label}–${clock(end)}`,
      allowed: bucket.allowed,
      denied: bucket.denied,
      errors: bucket.errors,
      partial: bucket.partial,
    };
  });
}

function TrafficTray(props: { data: OverviewData }) {
  const { data } = props;
  const { range } = data;
  const bars = chartBars(data.series, range);
  const total = (bar: ChartBar) => bar.allowed + bar.denied + bar.errors;
  const peak = bars.reduce<ChartBar | null>(
    (best, bar) => (best === null || total(bar) > total(best) ? bar : best),
    null,
  );
  const sum = (key: 'allowed' | 'denied' | 'errors') => bars.reduce((n, bar) => n + bar[key], 0);
  const all = sum('allowed') + sum('denied') + sum('errors');
  const title = `Requests per ${CHART[range].unit}, last ${RANGE_LABEL[range]}`;
  if (all === 0 || peak === null) {
    return (
      <Tray id="traffic" title={`Requests per ${CHART[range].unit}`}>
        <Panel variant="pad">
          <ZeroState>
            No requests in the selected range. Requests appear once a credential access rule calls{' '}
            <code>/proxy/&lt;token slug&gt;/…</code>.
          </ZeroState>
        </Panel>
      </Tray>
    );
  }
  return (
    <Tray
      id="traffic"
      title={`Requests per ${CHART[range].unit}`}
      description={`Peak ${formatCount(total(peak))} at ${peak.label}. ${formatCount(sum('denied'))} denied, ${formatCount(sum('errors'))} ${sum('errors') === 1 ? 'error' : 'errors'}. UTC; the last bar is so far.`}
      actions={
        <Legend
          decorative
          items={[
            { mark: 'allowed', label: 'Allowed' },
            { mark: 'denied', label: 'Denied' },
            { mark: 'error', label: 'Errors' },
          ]}
        />
      }
    >
      <Chart
        id="traffic-chart"
        title={title}
        description={`Peak: ${formatCount(total(peak))} requests at ${peak.label}${peak.partial ? ' (so far)' : ''}. Total: ${formatCount(all)} requests, ${formatCount(sum('allowed'))} allowed, ${formatCount(sum('denied'))} denied, ${formatCount(sum('errors'))} errors.`}
        bars={bars}
        tickEvery={CHART[range].tickEvery}
        columnLabel={CHART[range].column}
      />
    </Tray>
  );
}

function RecentChanges(props: {
  data: OverviewData;
  names: ReadonlyMap<string, string>;
  suspended: ReadonlySet<string>;
}) {
  const { data } = props;
  return (
    <Tray
      id="changes"
      title="Recent changes"
      actions={
        <LinkAction href={paths.audit()} arrow>
          Audit log
        </LinkAction>
      }
    >
      {data.recentChanges.length === 0 ? (
        <Panel variant="pad">
          <ZeroState>No changes yet.</ZeroState>
        </Panel>
      ) : (
        <Panel variant="flush">
          {byUtcDay(data.recentChanges).map((events) => (
            <>
              <FeedDay>{dayLabel(events[0]?.ts ?? 0, data.generatedAt)}</FeedDay>
              <Feed compact>
                {events.map((e) => (
                  <FeedItem
                    avatar={<ActorAvatar event={e} />}
                    time={<UiTime datetime={new Date(e.ts)} format="clock" />}
                  >
                    <b>{auditActorText(e, props.suspended)}</b> {actionText(e.action) ?? e.action}
                    {e.target_type ? (
                      <>
                        : <AuditTarget event={e} names={props.names} />
                      </>
                    ) : null}
                    .
                  </FeedItem>
                ))}
              </Feed>
            </>
          ))}
        </Panel>
      )}
    </Tray>
  );
}

// ---------------------------------------------------------------------------------------------
// Empty install

function FreshOverview(props: PageData) {
  const { ctx, data } = props;
  const alerts = overviewAlerts(data.alertData);
  const urgent = alerts.filter((alert) => alert.level !== 'info');
  const notes = alerts.filter((alert) => alert.level === 'info');
  const checks = healthChecks(data.alertData, props.adminHosts, props.env);
  return (
    <>
      <RangeNote show={props.rangeNote} />
      <Grid>
        <Column span={8}>
          <Stack>
            <GetStarted
              ctx={ctx}
              connections={props.connections}
              steps={props.steps}
              doneCount={props.doneCount}
            />
            {urgent.length > 0 ? (
              <Tray id="attention" title="Needs attention" count={urgent.length}>
                <Panel>
                  <AttentionCards items={toAttentionItems(urgent, ctx)} layout="list" />
                  <ApproveOwnerDialogs alerts={urgent} ctx={ctx} />
                </Panel>
              </Tray>
            ) : null}
            {notes.length > 0 ? (
              <div class="notes" id="notes">
                {notes.map((alert) => (
                  <p class="hint">
                    <Dot tone="info" /> <span class="vh">Note: </span>
                    {alert.title}
                    {alert.detail ? ` ${alert.detail}` : null}
                    {alert.objects.map((object) => (
                      <>
                        {' '}
                        <a href={object.href}>{object.label}</a>
                      </>
                    ))}
                    {alert.fix && ctx.can(alert.fix.permission) ? (
                      <>
                        {' '}
                        <a href={alert.fix.href}>{alert.fix.label}</a>
                      </>
                    ) : null}
                  </p>
                ))}
              </div>
            ) : null}
            <HealthTray checks={checks} alerts={alerts} />
          </Stack>
        </Column>
        <Column span={4} rail>
          <LiveSummary
            id="plan"
            variant="plan"
            title="What you are building"
            description="The map on this page fills in as you finish each step."
          >
            <SummaryRow
              logo="github"
              title={
                <>
                  Credential access rule <Badge>Step 2</Badge>
                </>
              }
              meta="for example GitHub Actions"
            />
            <SummaryWire />
            <SummaryRow
              icon="gate"
              title="tokengate"
              meta="Checks every call against an issuer access rule (step 3)"
            />
            <SummaryWire />
            <SummaryRow
              logo="slack"
              title={
                <>
                  Credential <Badge>Step 1</Badge>
                </>
              }
              meta="for example Slack or OpenAI. The upstream secret stays here."
            />
          </LiveSummary>
          <Tray id="traffic" title="Traffic">
            <Panel variant="pad">
              <p class="muted">
                No requests yet. They appear here once a credential access rule calls{' '}
                <code>/proxy/&lt;token slug&gt;/…</code>.
              </p>
              <Chips label="Where calls went, all zero">
                <Chip tone="off">
                  Received <b>0</b>
                </Chip>
                <Chip tone="off">
                  Verified <b>0</b>
                </Chip>
                <Chip tone="off">
                  Matched <b>0</b>
                </Chip>
                <Chip tone="off">
                  Upstream OK <b>0</b>
                </Chip>
              </Chips>
              <SamplingNote rate={data.alertData.sampleRate} />
              <FindRequest placement="panel" />
            </Panel>
          </Tray>
        </Column>
      </Grid>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Get started

interface SetupSteps {
  token: boolean;
  consumer: boolean;
  access: boolean;
  call: boolean;
}

function setupSteps(
  connections: Connections,
  alertData: AlertData,
  verifiedCall: boolean,
): SetupSteps {
  return {
    token: alertData.credentials.some((s) => s.has_credential),
    consumer: connections.consumers.length > 0,
    access: connections.accesses.some((edge) => edge.grant.enabled),
    call: verifiedCall,
  };
}

function GetStarted(props: {
  ctx: ViewContext;
  connections: Connections;
  steps: SetupSteps;
  doneCount: number;
}) {
  const { ctx, connections, steps } = props;
  const [newest] = connections.accesses
    .filter((edge) => edge.grant.enabled)
    .sort(
      (a, b) => b.grant.created_at - a.grant.created_at || b.grant.id.localeCompare(a.grant.id),
    );
  const guide = paths.docs('callers/github-actions.md');
  const draft: Array<Omit<ChecklistStep, 'state'> & { done: boolean; usable: boolean }> = [
    {
      done: steps.token,
      usable: ctx.can('tokens:write'),
      title: 'Add a credential',
      why: 'Load one upstream API key, for example a Slack bot token or an OpenAI key. You paste it once; nobody can read it again.',
      ...(ctx.can('tokens:write')
        ? {
            action: {
              href: paths.tokenNew(),
              label: (
                <>
                  <span class="plus" aria-hidden="true">
                    +
                  </span>
                  Add a credential
                </>
              ),
            },
          }
        : {
            ask: <AskSomeone permission="tokens:write" ctx={ctx} verb="add a credential" />,
          }),
    },
    {
      done: steps.consumer,
      usable: ctx.can('access:write'),
      title: 'Add a credential access rule',
      why: (
        <>
          Trust the CI system that will call, for example GitHub Actions for your organization.{' '}
          <b>Can be a different person</b>, such as an access manager.
        </>
      ),
      ...(ctx.can('access:write')
        ? {
            action: {
              href:
                connections.tokens.length > 0
                  ? paths.accessNew({ consumer: 'new' })
                  : paths.consumerNew({ type: 'github-actions' }),
              label: 'Add a credential access rule',
            },
          }
        : {
            ask: (
              <AskSomeone permission="access:write" ctx={ctx} verb="add a credential access rule" />
            ),
          }),
    },
    {
      done: steps.access,
      usable: ctx.can('access:write'),
      title: 'Add issuer access rule',
      why: 'Say which repository and environment may use which token, and for which operations. Best after steps 1 and 2.',
      ...(ctx.can('access:write')
        ? { action: { href: paths.accessNew(), label: 'Give access' } }
        : {
            ask: (
              <AskSomeone permission="access:write" ctx={ctx} verb="give an issuer access rule" />
            ),
          }),
    },
    {
      done: steps.call,
      usable: true,
      title: 'Make the first call',
      why: (
        <>
          Add the tokengate step to a workflow. The job gets a short-lived token and calls the API
          through <code>/proxy/&lt;token slug&gt;/…</code>; the call shows up here.
        </>
      ),
      action: newest
        ? {
            href: paths.accessItem(newest.grant.id, { hash: 'use' }),
            label: (
              <>
                Copy the workflow step<span class="vh"> for {newest.grant.name}</span>
              </>
            ),
          }
        : { href: guide, label: 'Read the GitHub Actions guide' },
      detail: newest ? (
        <a href={guide}>
          How to call the gateway from GitHub Actions<span class="vh"> (GitHub docs)</span>
        </a>
      ) : (
        <CodeBlock
          label="Workflow snippet preview"
          caption="Preview of the workflow step. The exact snippet, with your audience, appears on the access page after step 3."
        >
          {`- id: tokengate
  uses: 2fd/cloudflare-tokengate/actions/get-token@main
  with:
    url: https://${ctx.host}
- run: curl "\${{ steps.tokengate.outputs.proxy-base }}/<token slug>/…" \\
    -H "x-tokengate-token: \${{ steps.tokengate.outputs.token }}"`}
        </CodeBlock>
      ),
    },
  ];
  // The one primary: the first step to do whose action the viewer can take.
  const next = draft.findIndex((step) => !step.done && step.usable && step.action);
  const checklist: ChecklistStep[] = draft.map(({ done, usable: _usable, ...step }, index) => ({
    ...step,
    state: done ? 'done' : index === next ? 'next' : 'todo',
  }));
  return (
    <Tray
      id="get-started"
      title="Get started: your first connection"
      description="Steps 1 and 2 can be done in any order, and by different people."
      actions={<ChecklistProgress done={props.doneCount} total={4} />}
    >
      <Panel>
        <Checklist steps={checklist} />
      </Panel>
    </Tray>
  );
}

// ---------------------------------------------------------------------------------------------
// Health

const SCHEMA_TEXT = {
  ok: 'Up to date.',
  behind: 'Migrations missing.',
  ahead: 'Newer than this code (a rollback?).',
  unknown: 'Could not be read.',
} as const;

interface Check {
  id: string;
  name: string;
  ok: boolean;
  detail: Child;
}

/** Every check, collapsed under one line: open while a check fails or an alert links to a row. */
function HealthTray(props: { checks: Check[]; alerts: readonly Alert[] }) {
  const { checks } = props;
  const problems = checks.filter((check) => !check.ok).length;
  const ok = checks.length - problems;
  // An alert can link to a row that passes (cron_never: the job has not run yet, which is ok).
  const linksToCheck = props.alerts.some((alert) =>
    alert.objects.some((object) => object.href.includes('#check-')),
  );
  return (
    <Tray
      id="health"
      title="Health"
      hideTitle
      bar={
        <Disclosure
          id="checks"
          summary={`All checks (${ok} ok, ${problems} ${problems === 1 ? 'problem' : 'problems'})`}
          hint={
            problems > 0 ? (
              <Badge tone="bad" glyph="✕">
                {problems} {problems === 1 ? 'problem' : 'problems'}
              </Badge>
            ) : (
              <Badge tone="ok" glyph="✓">
                {ok} OK
              </Badge>
            )
          }
          open={problems > 0 || linksToCheck}
        >
          <Table
            label="All checks"
            caption="All checks"
            columns={[{ label: 'Check' }, { label: 'State' }, { label: 'Detail' }]}
          >
            {checks.map((check) => (
              <Row>
                <RowHeader>
                  <span id={`check-${check.id}`}>{check.name}</span>
                </RowHeader>
                <Cell label="State">
                  {check.ok ? (
                    <Badge tone="ok" glyph="✓">
                      OK
                    </Badge>
                  ) : (
                    <Badge tone="bad" glyph="✕">
                      Problem
                    </Badge>
                  )}
                </Cell>
                <Cell label="Detail">{check.detail}</Cell>
              </Row>
            ))}
          </Table>
        </Disclosure>
      }
    />
  );
}

function healthChecks(data: AlertData, adminHosts: string[] | null, env: AppEnv): Check[] {
  const { cron, keyring } = data;
  const nextRun = hourStart(data.now) + 3_600_000;
  const login = loginProviderNames(parseConfig(env));
  const binding = (
    id: string,
    name: string,
    bound: boolean,
    missing: string,
    anchor: string,
  ): Check => ({
    id,
    name,
    ok: true,
    detail: (
      <>
        {bound ? 'Bound.' : `Not bound: ${missing}.`}{' '}
        <a href={paths.docs(`configuration.md#${anchor}`)}>
          About {name}
          <span class="vh"> (GitHub docs)</span>
        </a>
      </>
    ),
  });
  return [
    {
      id: 'schema',
      name: 'Control-plane schema (DB)',
      ok: data.schema.DB === 'ok',
      detail: <SchemaDetail database="DB" state={data.schema.DB} />,
    },
    {
      id: 'telemetry-schema',
      name: 'Telemetry schema (TELEMETRY_DB)',
      ok: data.schema.TELEMETRY_DB === 'ok',
      detail: <SchemaDetail database="TELEMETRY_DB" state={data.schema.TELEMETRY_DB} />,
    },
    {
      id: 'maintenance',
      name: 'Hourly maintenance job',
      ok: !cron.failing && !(cron.stale && cron.lastSuccessAt !== null),
      detail: (
        <>
          Last success:{' '}
          {cron.lastSuccessAt === null ? (
            'never'
          ) : (
            <UiTime datetime={new Date(cron.lastSuccessAt)} />
          )}
          .
          {cron.failing ? (
            <>
              {' '}
              Last failure
              {cron.lastErrorAt === null ? (
                ''
              ) : (
                <>
                  {' '}
                  at <UiTime datetime={new Date(cron.lastErrorAt)} />
                </>
              )}
              : <code>{cron.lastError ?? 'unknown'}</code>.
            </>
          ) : null}{' '}
          Next run expected a few minutes after {formatShortTime(nextRun)}.
        </>
      ),
    },
    {
      id: 'keys',
      name: 'Encryption keys',
      ok: keyring.ok,
      detail: (
        <>
          {keyring.error
            ? `Not loaded (${keyring.error}).`
            : `${formatCount(data.keyCount)} ${data.keyCount === 1 ? 'key' : 'keys'}, active ${keyring.activeKid ?? '—'}, ${formatCount(data.sealedKids.length)} ${data.sealedKids.length === 1 ? 'secret' : 'secrets'}.`}{' '}
          <a href={paths.tokenKeys()}>Open encryption keys</a>
        </>
      ),
    },
    {
      id: 'sign-in',
      name: 'Sign-in',
      ok: login.length > 0,
      detail: (
        <>
          {login.length > 0 ? `${login.join(', ')}.` : 'No login configured: nobody can sign in.'}{' '}
          <a href={paths.signIn('login')}>Open sign-in</a>
        </>
      ),
    },
    {
      id: 'admin-hosts',
      name: 'Admin hosts',
      ok: true,
      detail: (
        <>
          {adminHosts === null
            ? 'Not set yet: set on the first sign-in.'
            : `${adminHosts.join(', ')}.`}{' '}
          <a href={paths.signIn('hosts')}>Open admin hosts</a>
        </>
      ),
    },
    binding(
      'queue',
      'REQUEST_LOG_QUEUE',
      env.REQUEST_LOG_QUEUE !== undefined,
      'request records are written to the database directly',
      'request_log_queue',
    ),
    binding(
      'archive',
      'REQUEST_ARCHIVE',
      env.REQUEST_ARCHIVE !== undefined,
      'records are not archived to R2',
      'request_archive',
    ),
    binding(
      'rate-limiter',
      'PROXY_RATE_LIMITER',
      env.PROXY_RATE_LIMITER !== undefined,
      'no per-access request cap',
      'proxy_rate_limiter',
    ),
    {
      id: 'config',
      name: 'Configuration',
      ok: data.config.length === 0,
      detail:
        data.config.length === 0 ? (
          'No problems.'
        ) : (
          <ul>
            {data.config.map((problem) => (
              <li>
                <code>{problem.variable}</code>: {problem.message}{' '}
                <a href={paths.docs(`configuration.md#${problem.anchor}`)}>
                  Reference<span class="vh"> for {problem.variable} (GitHub docs)</span>
                </a>
              </li>
            ))}
          </ul>
        ),
    },
  ];
}

function SchemaDetail(props: { database: 'DB' | 'TELEMETRY_DB'; state: keyof typeof SCHEMA_TEXT }) {
  return (
    <>
      {SCHEMA_TEXT[props.state]}
      {props.state === 'behind' ? (
        <>
          {' '}
          Missing {SCHEMA_HEAD[props.database]}. Run:{' '}
          <code>wrangler d1 migrations apply {props.database} --remote</code>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Tokens in use (the connections map)

/** The map wire tone of an access: active, needs attention, broken, or not in use. */
function accessTone(edge: AccessEdge): MapAccess['tone'] {
  if (edge.status === 'disabled' || edge.status === 'inactive') return 'off';
  if (edge.status === 'expired') return 'bad';
  if (edge.status === 'expiring' || edge.flags.some((flag) => flag.status !== 'unused')) {
    return 'warn';
  }
  return 'ok';
}

function TokensInUse(props: PageData) {
  const { ctx, data, connections } = props;
  const { range } = data;
  const traffic = new Map(data.tokens.map((t) => [t.serviceId, t]));
  const currentHour = hourStart(data.generatedAt);
  const consumers: MapConsumer[] = connections.consumers.map((consumer) => {
    const issuer_access_rules = connections.accesses.filter(
      (edge) => edge.grant.credential_access_rule_id === consumer.id,
    );
    const requests = issuer_access_rules.reduce(
      (sum, edge) => sum + (data.accessRequests.get(edge.grant.id) ?? 0),
      0,
    );
    return {
      id: consumer.id,
      name: consumer.name,
      logo: consumerLogo(consumer),
      line: consumer.enabled
        ? (PROFILES[consumer.profile]?.label ?? consumer.profile)
        : `${PROFILES[consumer.profile]?.label ?? consumer.profile} · Disabled`,
      idle: !consumer.enabled || requests === 0,
      weight: issuer_access_rules.length,
    };
  });
  const rows = connections.tokens.map((token) => {
    const accesses = connections.accesses.filter((edge) => edge.grant.service_id === token.id);
    const { status, detail } = tokenStatus(token, data, connections);
    const problem =
      PROBLEM_STATUSES.has(status) || alertsFor(data.alertData, { tokenId: token.id }).length > 0;
    return { token, accesses, status, detail, problem, traffic: traffic.get(token.id) };
  });
  // Problems first, then the busiest: the map keeps this order between tokens of equal traffic.
  rows.sort(
    (a, b) =>
      Number(b.problem) - Number(a.problem) ||
      (b.traffic?.requests ?? 0) - (a.traffic?.requests ?? 0) ||
      a.token.name.localeCompare(b.token.name),
  );
  const idleRows = rows.filter((row) => !row.problem && (row.traffic?.requests ?? 0) === 0);
  const tokens: MapToken[] = rows.map((row) => {
    const { token, accesses } = row;
    const lastUsedHour = accesses.reduce<number | null>(
      (max, edge) =>
        edge.lastUsedHour !== null && (max === null || edge.lastUsedHour > max)
          ? edge.lastUsedHour
          : max,
      null,
    );
    const consumerCount = new Set(accesses.map((edge) => edge.grant.credential_access_rule_id))
      .size;
    const tone = uiTone(STATUS[row.status].tone);
    const idle = idleRows.includes(row);
    return {
      id: token.id,
      name: token.name,
      slug: token.slug,
      logo: tokenLogo(token),
      requests: row.traffic?.requests ?? 0,
      denied: row.traffic?.denied ?? 0,
      errors: row.traffic?.errors ?? 0,
      hrefs: {
        requests: paths.requests({ token: token.id, range }),
        denied: paths.requests({ token: token.id, range, outcome: 'denied' }),
        errors: paths.requests({ token: token.id, range, outcome: 'error' }),
      },
      lastUsed:
        connections.sampleRate <= 0
          ? 'use not recorded'
          : lastUsedHour === null
            ? '—'
            : lastUsedHour >= currentHour
              ? 'this hour'
              : relativeTime(lastUsedHour, data.generatedAt),
      line:
        row.status !== 'active' ? (
          statusLabel(row.status, row.detail)
        ) : accesses.length === 0 ? (
          <>
            No access yet<span class="vh">: no consumer can use this token yet.</span>
          </>
        ) : (
          `${consumerCount} ${consumerCount === 1 ? 'consumer' : 'consumers'}`
        ),
      ...(row.status !== 'active' && (tone === 'warn' || tone === 'bad') ? { lineTone: tone } : {}),
      idle: idle || !token.enabled,
      ...(idle && idleRows[0] === row
        ? { tag: `${idleRows.length} idle ${idleRows.length === 1 ? 'token' : 'tokens'}` }
        : {}),
    };
  });
  const accesses: MapAccess[] = connections.accesses.map((edge) => {
    const flag = edge.flags[0];
    return {
      consumer: edge.grant.credential_access_rule_id,
      token: edge.grant.service_id,
      tone: accessTone(edge),
      status: `${statusLabel(edge.status, edge.statusDetail)}${flag ? `, ${statusLabel(flag.status, flag.detail)}` : ''}`,
      consumerLabel: `${edge.consumer?.name ?? 'Deleted credential access rule'} › ${edge.subject}`,
      context: edge.context,
      operation: edge.operations.join(', ') || undefined,
      href: paths.accessItem(edge.grant.id),
    };
  });
  const refused = traffic.get('')?.requests ?? 0;
  const deleted = data.tokens
    .filter(
      (t) => t.serviceId !== '' && !connections.tokens.some((token) => token.id === t.serviceId),
    )
    .reduce((sum, t) => sum + t.requests, 0);
  const lonely = rows.filter((row) => row.accesses.length === 0);
  const footer: Child[] = [];
  if (refused > 0) {
    footer.push(
      <>
        Refused before a token was chosen: <b class="t-bad">{formatCount(refused)}</b> ·{' '}
        <a href={paths.requests({ token: 'none', range })}>
          See them<span class="vh"> (requests refused before a token was chosen)</span>
        </a>
      </>,
    );
  }
  if (deleted > 0)
    footer.push(<>Traffic of deleted credentials: {formatCount(deleted)} requests</>);
  if (ctx.can('access:write')) {
    for (const row of lonely) {
      footer.push(
        <a href={paths.accessNew({ token: row.token.id })}>
          Add issuer access rule<span class="vh"> to {row.token.name}</span>
        </a>,
      );
    }
  }
  return (
    <Tray
      id="tokens"
      title="Tokens in use"
      description={`Who calls which token through tokengate, with the traffic in the last ${RANGE_LABEL[range]}. Each line is an issuer access rule.`}
      actions={
        <>
          <LinkAction href={paths.access()} arrow>
            Open issuer access rules ({formatCount(connections.accesses.length)})
          </LinkAction>
          <Segmented
            label="View"
            size="sm"
            items={[
              {
                label: 'Map',
                href: `${paths.overview(range === '24h' ? undefined : { range })}#tokens`,
                current: true,
              },
              { label: 'Matrix', href: paths.access({ view: 'matrix' }) },
            ]}
          />
        </>
      }
    >
      {tokens.length === 0 ? (
        <Panel>
          <EmptyState
            title="No credentials yet"
            icon="token"
            description="A credential holds one upstream API key. Consumers get access to it."
            actions={
              ctx.can('tokens:write') ? (
                <Button variant="primary" plus href={paths.tokenNew()}>
                  Add credential
                </Button>
              ) : (
                <AskSomeone permission="tokens:write" ctx={ctx} verb="add a credential" />
              )
            }
          />
        </Panel>
      ) : (
        <ConnectionsMap
          id="ov-map"
          baseHref={paths.access()}
          focusHref={paths.overview(range === '24h' ? undefined : { range })}
          focus={props.focus}
          consumers={consumers}
          tokens={tokens}
          accesses={accesses}
          rangeLabel={{
            short: `Req ${range === '24h' ? '24 h' : range === '7d' ? '7 d' : '30 d'}`,
            long: `requests in ${RANGE_LABEL[range]}`,
          }}
          footer={
            footer.length > 0 ? (
              <>
                {footer.map((fact, index) => (
                  <>
                    {index > 0 ? ' · ' : null}
                    {fact}
                  </>
                ))}
              </>
            ) : undefined
          }
        />
      )}
    </Tray>
  );
}

const DAY_MS = 86_400_000;
const PROBLEM_STATUSES: ReadonlySet<StatusKey> = new Set([
  'no_credential',
  'credential_unreadable',
  'upstream_rejecting',
  'outside_hosts',
  'expired',
  'expiring',
]);

function tokenStatus(
  token: Service,
  data: OverviewData,
  connections: Connections,
): { status: StatusKey; detail?: string } {
  const now = data.generatedAt;
  if (!token.enabled) return { status: 'disabled' };
  if (token.credential_sealed === null) return { status: 'no_credential' };
  if (connections.unreadableTokenIds.has(token.id)) return { status: 'credential_unreadable' };
  if (data.alertData.upstreamAuthFailures.some((row) => row.service_id === token.id)) {
    return { status: 'upstream_rejecting' };
  }
  if (outsideAllowedHosts(token.base_url, data.alertData.allowedHosts)) {
    return { status: 'outside_hosts' };
  }
  const expires = token.credential_expires_at;
  if (expires !== null && expires <= now) return { status: 'expired' };
  if (expires !== null && expires - now <= EXPIRY_WARNING_MS) {
    return { status: 'expiring', detail: String(Math.ceil((expires - now) / DAY_MS)) };
  }
  return { status: 'active' };
}
