// Monitoring › Overview (`GET /admin`): health (every alert, and every check), the getting-started
// steps, traffic for a range (KPIs and a chart), which consumers use which token, the top denials
// and the latest changes. Read-only. Only names, counts and states are shown, never configured
// values that could be secret (I-CFG-1, I-CRED-1). Denials from unverified tokens never prefill a
// form (I-LOG-2).
import type { Child } from 'hono/jsx';
import type { App } from '../../app';
import { parseConfig } from '../../config';
import { getAdminHosts } from '../../db/settings';
import type { Service } from '../../db/types';
import type { AppEnv } from '../../env';
import { SCHEMA_HEAD } from '../../generated/schema-head';
import {
  type AlertData,
  alertsFor,
  EXPIRY_WARNING_MS,
  loadOverview,
  type OverviewData,
  outsideAllowedHosts,
  overviewAlerts,
  type TokenTraffic,
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
import { TrafficChart } from '../views/chart';
import {
  AlertList,
  AskSomeone,
  type ChipProps,
  ChipList,
  DataTable,
  EmptyState,
  StatusBadge,
  Tabs,
  Time,
} from '../views/components';
import { formatCount, formatPercent, formatShortTime, loginProviderNames } from '../views/format';
import {
  actionText,
  AuditTarget,
  auditActorText,
  DenialTable,
  FindRequestForm,
  KpiList,
  percentileText,
} from '../views/monitoring';
import { type StatusKey, statusLabel } from '../views/status';
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
    return renderPage(
      c,
      {
        title: `Overview (last ${RANGE_LABEL[range]})`,
        section: 'monitoring',
        subsection: 'overview',
        notice: resolveNotice(NOTICES, c.req.query('notice'), done),
        subnavExtra: <FindRequestForm />,
      },
      (ctx) => (
        <OverviewPage
          ctx={ctx}
          data={overview}
          connections={connections}
          verifiedCall={verifiedCall}
          adminHosts={adminHosts}
          env={deps.env}
          rangeNote={rawRange !== undefined && parsed === null}
          names={auditTargetNames(connections, people)}
          suspended={new Set(people.filter((p) => p.status === 'suspended').map((p) => p.id))}
        />
      ),
    );
  });
}

function OverviewPage(props: {
  ctx: ViewContext;
  data: OverviewData;
  connections: Connections;
  verifiedCall: boolean;
  adminHosts: string[] | null;
  env: AppEnv;
  rangeNote: boolean;
  names: ReadonlyMap<string, string>;
  suspended: ReadonlySet<string>;
}) {
  const { ctx, data, connections } = props;
  const { range } = data;
  const sampleRate = data.alertData.sampleRate;
  const alerts = overviewAlerts(data.alertData);
  return (
    <>
      <p class="meta">
        Updated <Time ms={data.generatedAt} /> ·{' '}
        <a href={paths.overview({ range: range === '24h' ? undefined : range })}>Refresh</a>
      </p>
      <div class="range">
        <Tabs
          label="Time range"
          current={range}
          items={OVERVIEW_RANGES.map((key) => ({
            key,
            href: paths.overview(key === '24h' ? undefined : { range: key }),
            label: RANGE_LABEL[key],
          }))}
        />
        <p class="since">
          since <Time ms={data.window.from} />
        </p>
      </div>
      {props.rangeNote ? (
        <p class="muted">That time range is not available; showing the last 24 hours.</p>
      ) : null}
      {sampleRate <= 0 ? (
        <p class="note">
          Allowed requests are not recorded (sample rate 0). Allowed counts and "last used" are not
          available. <a href={paths.retention()}>Change in Data retention</a>
        </p>
      ) : sampleRate < 1 ? (
        <p class="note">
          Allowed requests are sampled at {formatPercent(sampleRate)}, so counts are estimates.{' '}
          <a href={paths.retention()}>Change in Data retention</a>
        </p>
      ) : null}

      <HealthSection
        ctx={ctx}
        alerts={alerts}
        alertData={data.alertData}
        adminHosts={props.adminHosts}
        env={props.env}
      />
      <GetStarted
        ctx={ctx}
        connections={connections}
        alertData={data.alertData}
        verifiedCall={props.verifiedCall}
      />

      <section aria-labelledby="traffic-h">
        <h2 id="traffic-h">Traffic</h2>
        {!data.telemetryAvailable ? (
          <p class="note">The request log could not be read, so traffic is not shown.</p>
        ) : null}
        <KpiList totals={data.totals} range={range} />
        {data.totals.requests === 0 ? (
          <EmptyState>
            No requests in the selected range. Requests appear once a consumer calls{' '}
            <code>/proxy/&lt;token slug&gt;/…</code>.
          </EmptyState>
        ) : null}
        <TrafficChart
          id="traffic-chart"
          title={`Requests per ${range === '24h' ? 'hour' : range === '7d' ? '6 hours' : 'day'}, last ${RANGE_LABEL[range]}`}
          buckets={data.series}
        />
      </section>

      <TokensInUse ctx={ctx} data={data} connections={connections} />

      <section aria-labelledby="denials-h">
        <h2 id="denials-h">Top denials</h2>
        {data.denials.groups.length === 0 ? (
          <EmptyState>No denied requests in the selected range.</EmptyState>
        ) : (
          <DenialTable
            groups={data.denials.groups}
            range={range}
            since={data.window.from}
            consumers={new Map(connections.consumers.map((c) => [c.id, c]))}
            tokens={new Map(connections.tokens.map((t) => [t.id, t]))}
            ctx={ctx}
          />
        )}
        <p>
          <a href={paths.requests({ range, outcome: 'denied' })}>See all denied requests</a>
          {data.denials.bounded ? (
            <span class="muted"> Grouped from the newest 2,000 denials.</span>
          ) : null}
        </p>
      </section>

      <section aria-labelledby="changes-h">
        <h2 id="changes-h">Recent changes</h2>
        <DataTable
          id="recent-changes"
          caption="The last 5 changes"
          captionHidden
          rowHeader="what"
          rows={data.recentChanges}
          empty={<EmptyState>No changes yet.</EmptyState>}
          columns={[
            { key: 'when', header: 'When', render: (e) => <Time ms={e.ts} /> },
            { key: 'who', header: 'Who', render: (e) => auditActorText(e, props.suspended) },
            {
              key: 'what',
              header: 'What',
              render: (e) => (
                <>
                  {actionText(e.action) ?? e.action} <code>{e.action}</code>
                </>
              ),
            },
            {
              key: 'target',
              header: 'Target',
              render: (e) => <AuditTarget event={e} names={props.names} />,
            },
          ]}
        />
        <p>
          <a href={paths.audit()}>Open the audit log</a>
        </p>
      </section>
    </>
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

function HealthSection(props: {
  ctx: ViewContext;
  alerts: ReturnType<typeof overviewAlerts>;
  alertData: AlertData;
  adminHosts: string[] | null;
  env: AppEnv;
}) {
  const checks = healthChecks(props.alertData, props.adminHosts, props.env);
  const problems = checks.filter((check) => !check.ok).length;
  // An alert can link to a row that passes (cron_never: the job has not run yet, which is ok).
  const linksToCheck = props.alerts.some((alert) =>
    alert.objects.some((object) => object.href.includes('#check-')),
  );
  return (
    <section id="health" aria-labelledby="health-h">
      <h2 id="health-h">Health</h2>
      {props.alerts.length === 0 ? (
        <p>No problems found.</p>
      ) : (
        <AlertList alerts={props.alerts} ctx={props.ctx} />
      )}
      {/* Open while a check fails or an alert links to a row (#check-…), so the link lands on it. */}
      <details open={problems > 0 || linksToCheck}>
        <summary>
          All checks ({checks.length - problems} ok, {problems}{' '}
          {problems === 1 ? 'problem' : 'problems'})
        </summary>
        <DataTable
          id="checks"
          caption="All checks"
          captionHidden
          rowHeader="name"
          rows={checks}
          columns={[
            {
              key: 'name',
              header: 'Check',
              render: (check) => <span id={`check-${check.id}`}>{check.name}</span>,
            },
            {
              key: 'state',
              header: 'State',
              render: (check) =>
                check.ok ? (
                  <span class="badge ok">OK</span>
                ) : (
                  <span class="badge bad">Problem</span>
                ),
            },
            { key: 'detail', header: 'Detail', render: (check) => check.detail },
          ]}
        />
      </details>
    </section>
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
          Last success: {cron.lastSuccessAt === null ? 'never' : <Time ms={cron.lastSuccessAt} />}.
          {cron.failing ? (
            <>
              {' '}
              Last failure
              {cron.lastErrorAt === null ? (
                ''
              ) : (
                <>
                  {' '}
                  at <Time ms={cron.lastErrorAt} />
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
// Get started

function GetStarted(props: {
  ctx: ViewContext;
  connections: Connections;
  alertData: AlertData;
  verifiedCall: boolean;
}) {
  const { ctx, connections, alertData } = props;
  const tokenDone = alertData.services.some((s) => s.has_credential);
  const consumerDone = connections.consumers.length > 0;
  const enabled = connections.accesses
    .filter((edge) => edge.grant.enabled)
    .sort(
      (a, b) => b.grant.created_at - a.grant.created_at || b.grant.id.localeCompare(a.grant.id),
    );
  const accessDone = enabled.length > 0;
  if (tokenDone && consumerDone && accessDone && props.verifiedCall) return null;
  const [newest] = enabled;
  const steps: Array<{
    done: boolean;
    title: string;
    why: string;
    action: Child;
  }> = [
    {
      done: tokenDone,
      title: 'Add a service token',
      why: 'The upstream API (Slack, OpenAI, GitHub, …) and the secret the gateway attaches for callers.',
      action: ctx.can('tokens:write') ? (
        <a class="button" href={paths.tokenNew()}>
          Add a service token
        </a>
      ) : (
        <AskSomeone permission="tokens:write" ctx={ctx} verb="add a service token" />
      ),
    },
    {
      done: consumerDone,
      title: 'Add a service consumer',
      why: 'Tells the gateway which CI tokens to trust, for example GitHub Actions in your organization.',
      action: ctx.can('access:write') ? (
        <a
          class="button"
          href={
            connections.tokens.length > 0
              ? paths.accessNew({ consumer: 'new' })
              : paths.consumerNew({ type: 'github-actions' })
          }
        >
          Add a service consumer
        </a>
      ) : (
        <AskSomeone permission="access:write" ctx={ctx} verb="add a service consumer" />
      ),
    },
    {
      done: accessDone,
      title: 'Give a consumer access',
      why: 'Decides which workloads (for example, which repositories and branches) may call which token.',
      action: ctx.can('access:write') ? (
        <a class="button" href={paths.accessNew()}>
          Give access
        </a>
      ) : (
        <AskSomeone permission="access:write" ctx={ctx} verb="give a consumer access" />
      ),
    },
    {
      done: props.verifiedCall,
      title: 'Make the first call',
      why: 'Call the gateway from a workflow. The request then shows up under Requests, with the reason when it is denied.',
      action: (
        <>
          {newest ? (
            <a class="button" href={paths.accessItem(newest.grant.id, { hash: 'use' })}>
              Copy the workflow step
              <span class="vh"> for {newest.grant.name}</span>
            </a>
          ) : null}{' '}
          <a href={paths.docs('callers/github-actions.md')}>
            How to call the gateway from GitHub Actions<span class="vh"> (GitHub docs)</span>
          </a>
        </>
      ),
    },
  ];
  return (
    <section id="get-started" aria-labelledby="gs-h">
      <h2 id="gs-h">Get started</h2>
      <p class="muted">Steps 1 and 2 can be done in any order, and by different people.</p>
      <ol class="steps">
        {steps.map((step) => (
          <li class={step.done ? 'done' : undefined}>
            <p class="step-title">
              <StatusBadge status={step.done ? 'done' : 'todo'} /> <strong>{step.title}</strong>
            </p>
            <p class="hint">{step.why}</p>
            {step.done ? null : <div class="actions">{step.action}</div>}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Tokens in use

interface TokenRow {
  id: string;
  token: Service | null;
  traffic: TokenTraffic | null;
  status: StatusKey;
  statusDetail?: string;
  accesses: AccessEdge[];
  lastUsedHour: number | null;
  problem: boolean;
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

function TokensInUse(props: { ctx: ViewContext; data: OverviewData; connections: Connections }) {
  const { ctx, data, connections } = props;
  const traffic = new Map(data.tokens.map((t) => [t.serviceId, t]));
  const rows: TokenRow[] = connections.tokens.map((token) => {
    const accesses = connections.accesses.filter((edge) => edge.grant.service_id === token.id);
    const { status, detail } = tokenStatus(token, data, connections);
    const lastUsedHour = accesses.reduce<number | null>(
      (max, edge) =>
        edge.lastUsedHour !== null && (max === null || edge.lastUsedHour > max)
          ? edge.lastUsedHour
          : max,
      null,
    );
    return {
      id: token.id,
      token,
      traffic: traffic.get(token.id) ?? null,
      status,
      ...(detail === undefined ? {} : { statusDetail: detail }),
      accesses,
      lastUsedHour,
      problem:
        PROBLEM_STATUSES.has(status) || alertsFor(data.alertData, { tokenId: token.id }).length > 0,
    };
  });
  // Traffic of tokens deleted since.
  for (const t of data.tokens) {
    if (t.serviceId !== '' && !connections.tokens.some((token) => token.id === t.serviceId)) {
      rows.push({
        id: t.serviceId,
        token: null,
        traffic: t,
        status: 'disabled',
        accesses: [],
        lastUsedHour: null,
        problem: false,
      });
    }
  }
  rows.sort(
    (a, b) =>
      Number(b.problem) - Number(a.problem) ||
      (b.traffic?.requests ?? 0) - (a.traffic?.requests ?? 0) ||
      (a.token?.name ?? a.id).localeCompare(b.token?.name ?? b.id),
  );
  const busy = rows.filter((row) => row.problem || (row.traffic?.requests ?? 0) > 0);
  const idle = rows.filter((row) => !busy.includes(row));
  const refused = traffic.get('')?.requests ?? 0;
  const columns = tokenColumns(ctx, data, connections);
  return (
    <section aria-labelledby="tokens-h">
      <h2 id="tokens-h">Tokens in use</h2>
      <p class="muted">
        Which service consumers can use which token, and the traffic in the selected range.
      </p>
      {rows.length === 0 ? (
        <EmptyState>No service tokens yet.</EmptyState>
      ) : (
        <>
          {busy.length > 0 ? (
            <DataTable
              id="tokens-in-use"
              caption="Tokens with traffic or problems"
              rowHeader="token"
              rows={busy}
              columns={columns}
            />
          ) : null}
          {idle.length > 0 ? (
            <details>
              <summary>
                {idle.length} idle {idle.length === 1 ? 'token' : 'tokens'}
              </summary>
              <DataTable
                id="idle-tokens"
                caption="Idle tokens: no traffic in the selected range"
                rowHeader="token"
                rows={idle}
                columns={columns}
              />
            </details>
          ) : null}
        </>
      )}
      {refused > 0 ? (
        <p>
          Refused before a token was chosen: {formatCount(refused)}{' '}
          <a href={paths.requests({ token: 'none', range: data.range })}>
            See them<span class="vh"> (requests refused before a token was chosen)</span>
          </a>
        </p>
      ) : null}
      <p>
        <a href={paths.access()}>Open the access matrix</a>
      </p>
    </section>
  );
}

/** Consumers named in a "Used by" cell; the rest is one link naming the token (2.4.4). */
const USED_BY_CHIPS = 3;

function tokenColumns(ctx: ViewContext, data: OverviewData, connections: Connections) {
  const range = data.range;
  const currentHour = hourStart(data.generatedAt);
  const count = (row: TokenRow, n: number, outcome?: 'denied' | 'error') =>
    row.token || row.traffic ? (
      <a href={paths.requests({ token: row.id, range, outcome })}>
        {formatCount(n)}
        <span class="vh">
          {' '}
          {outcome === undefined ? 'requests' : outcome === 'denied' ? 'denied' : 'errors'} on{' '}
          {row.token?.name ?? row.id}
        </span>
      </a>
    ) : (
      formatCount(n)
    );
  return [
    {
      key: 'token',
      header: 'Token',
      render: (row: TokenRow) =>
        row.token ? (
          <>
            <a href={paths.token(row.id)}>{row.token.name}</a> <code>{row.token.slug}</code>{' '}
            <StatusBadge status={row.status} detail={row.statusDetail} />
          </>
        ) : (
          <>
            Deleted token <code>{row.id}</code>
          </>
        ),
    },
    {
      key: 'used',
      header: 'Used by',
      render: (row: TokenRow) =>
        !row.token ? (
          '—'
        ) : row.accesses.length === 0 ? (
          <>
            No consumer can use this token yet.
            {ctx.can('access:write') ? (
              <>
                {' '}
                <a href={paths.accessNew({ token: row.id })}>
                  Give a consumer access<span class="vh"> to {row.token.name}</span>
                </a>
              </>
            ) : null}
          </>
        ) : (
          <ChipList
            label={`Consumers that can use ${row.token.name}`}
            max={USED_BY_CHIPS}
            moreHref={paths.access({ token: row.id })}
            moreText={`and ${row.accesses.length - USED_BY_CHIPS} more for ${row.token.name}`}
            items={row.accesses.map((edge) => accessChip(edge, row.token as Service))}
          />
        ),
    },
    {
      key: 'requests',
      header: 'Requests',
      numeric: true,
      render: (row: TokenRow) => count(row, row.traffic?.requests ?? 0),
    },
    {
      key: 'denied',
      header: 'Denied',
      numeric: true,
      render: (row: TokenRow) => count(row, row.traffic?.denied ?? 0, 'denied'),
    },
    {
      key: 'errors',
      header: 'Errors',
      numeric: true,
      render: (row: TokenRow) => count(row, row.traffic?.errors ?? 0, 'error'),
    },
    {
      key: 'p95',
      header: 'p95',
      numeric: true,
      render: (row: TokenRow) => percentileText(row.traffic?.p95 ?? null),
    },
    {
      key: 'last',
      header: 'Last used',
      render: (row: TokenRow) =>
        connections.sampleRate <= 0 ? (
          'use not recorded'
        ) : row.lastUsedHour === null ? (
          '—'
        ) : row.lastUsedHour >= currentHour ? (
          'this hour'
        ) : (
          <Time ms={row.lastUsedHour} relative now={data.generatedAt} />
        ),
    },
  ];
}

function accessChip(edge: AccessEdge, token: Service): ChipProps {
  const consumer = edge.consumer?.name ?? 'deleted consumer';
  const flag = edge.flags[0];
  return {
    href: paths.accessItem(edge.grant.id),
    text: `${consumer} · ${edge.subject} · ${edge.context}`,
    status: edge.status,
    ...(edge.statusDetail === undefined ? {} : { statusDetail: edge.statusDetail }),
    srText: `${edge.subject} (${edge.context}) through ${consumer} can use ${token.name}: ${statusLabel(edge.status, edge.statusDetail)}${flag ? `, ${statusLabel(flag.status, flag.detail)}` : ''}.`,
  };
}
