// Admin dashboard (`GET /admin`): last-24 h traffic, per-service table, operational banners,
// recent denials and a getting-started checklist. Read-only.
import type { App } from '../../app';
import type { RecentDenial } from '../../db/rollups';
import { settingsFromRows, settingsStatement } from '../../db/settings';
import type { AppEnv } from '../../env';
import {
  type DashboardData,
  dashboardBanners,
  loadDashboard,
  type Percentile,
  type ServiceTraffic,
  type TrafficStats,
} from '../../telemetry/dashboard';
import { can } from '../auth/rbac';
import { renderPage } from '../render';
import { Badge, Code, EmptyState } from '../views/components';
import { formatCount, formatDuration, formatPercent, formatTime, withQuery } from '../views/format';
import { docsUrl, reasonText } from '../views/reasons';

export function registerDashboardRoutes(app: App): void {
  app.get('/admin', async (c) => {
    const deps = c.get('deps');
    const [data, setup] = await Promise.all([loadDashboard(deps), loadSetupState(deps.env)]);
    return renderPage(
      c,
      { title: 'Dashboard', section: '/admin', banners: dashboardBanners(data) },
      <DashboardPage
        data={data}
        setup={setup}
        canConfigure={can(c.get('viewer').user.role, 'config:write')}
      />,
    );
  });
}

/**
 * Whether any verified call exists. Pre-trust rejections (claims_verified = 0, e.g. anonymous
 * probes) do not count; the partial index request_log_verified makes this a one-row read.
 */
export const VERIFIED_CALL_SQL = 'SELECT id FROM request_log WHERE claims_verified = 1 LIMIT 1';

interface SetupState {
  callerProviders: number;
  services: number;
  grants: number;
  /** A request with verified caller claims (any age): a call that reached policy evaluation. */
  verifiedCall: boolean;
  sampleRate: number;
}

async function loadSetupState(env: Pick<AppEnv, 'DB' | 'TELEMETRY_DB'>): Promise<SetupState> {
  const db = env.DB;
  const [[providers, services, grants, settings], first] = await Promise.all([
    db.batch([
      db.prepare('SELECT COUNT(*) AS n FROM caller_providers'),
      db.prepare('SELECT COUNT(*) AS n FROM services'),
      db.prepare('SELECT COUNT(*) AS n FROM grants'),
      settingsStatement(db),
    ]),
    env.TELEMETRY_DB.prepare(VERIFIED_CALL_SQL).first(),
  ]);
  const count = (result: D1Result | undefined) =>
    Number((result?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  return {
    callerProviders: count(providers),
    services: count(services),
    grants: count(grants),
    verifiedCall: first !== null,
    sampleRate: settingsFromRows((settings?.results ?? []) as Array<{ key: string; value: string }>)
      .allowed_sample_rate,
  };
}

function DashboardPage(props: { data: DashboardData; setup: SetupState; canConfigure: boolean }) {
  const { data, setup, canConfigure } = props;
  const setupDone =
    setup.callerProviders > 0 && setup.services > 0 && setup.grants > 0 && setup.verifiedCall;
  return (
    <>
      {setupDone ? null : <SetupChecklist setup={setup} canConfigure={canConfigure} />}

      <h2>Last 24 hours</h2>
      <p class="muted">
        Traffic through the proxy since {formatTime(data.window.from)}.
        {setup.sampleRate <= 0
          ? ' Allowed requests are not recorded (sample rate 0 in Settings), so allowed counts and latency stay at zero.'
          : setup.sampleRate < 1
            ? ` Allowed requests are sampled at ${formatPercent(setup.sampleRate)}, so counts are estimates.`
            : null}
      </p>
      <Metrics totals={data.totals} />

      <h2>Services</h2>
      {data.services.length === 0 ? (
        <EmptyState>
          No requests in the last 24 hours. Requests appear here once a caller uses the proxy at{' '}
          <Code>/proxy/&lt;service slug&gt;/…</Code>.
        </EmptyState>
      ) : (
        <ServiceTable services={data.services} />
      )}

      <h2>Recent denials</h2>
      <p class="muted">
        Requests the gateway refused in the last 24 hours. Open one to see why and, when a grant is
        missing, to create it from the request.
      </p>
      {data.recentDenials.length === 0 ? (
        <EmptyState>No denied requests in the last 24 hours.</EmptyState>
      ) : (
        <DenialTable denials={data.recentDenials} />
      )}
    </>
  );
}

function SetupChecklist(props: { setup: SetupState; canConfigure: boolean }) {
  const { setup, canConfigure } = props;
  const steps: Array<{ done: boolean; title: string; what: string; href: string; action: string }> =
    [
      {
        done: setup.callerProviders > 0,
        title: 'Add a caller provider',
        what: 'Tells the gateway which CI tokens to trust, for example GitHub Actions in your organization.',
        href: '/admin/caller-providers/new',
        action: 'Add a caller provider',
      },
      {
        done: setup.services > 0,
        title: 'Add a service',
        what: 'The upstream API (Slack, OpenAI, GitHub, …) and the credential the gateway attaches for callers.',
        href: '/admin/services/new',
        action: 'Add a service',
      },
      {
        done: setup.grants > 0,
        title: 'Create a grant',
        what: 'Decides which callers (for example, which repositories and branches) may call which service.',
        href: '/admin/grants/new',
        action: 'Create a grant',
      },
    ];
  return (
    <section aria-labelledby="setup-heading">
      <h2 id="setup-heading">Get started</h2>
      <ol class="checklist">
        {steps.map((step) => (
          <li class={step.done ? 'done' : undefined}>
            <b>{step.title}</b> {step.done ? <Badge tone="ok">done</Badge> : null}
            <br />
            <span class="muted">{step.what}</span>
            {step.done ? null : (
              <>
                <br />
                {canConfigure ? (
                  <a href={step.href}>{step.action}</a>
                ) : (
                  <span>Ask an admin or owner to do this step.</span>
                )}
              </>
            )}
          </li>
        ))}
        <li class={setup.verifiedCall ? 'done' : undefined}>
          <b>Make the first call</b> {setup.verifiedCall ? <Badge tone="ok">done</Badge> : null}
          <br />
          <span class="muted">
            Call the gateway from a workflow. The request then shows up under Requests, including
            the reason when it is denied.
          </span>
          {setup.verifiedCall ? null : (
            <>
              <br />
              <a href={docsUrl('callers/github-actions.md')}>
                How to call the gateway from GitHub Actions
              </a>
            </>
          )}
        </li>
      </ol>
    </section>
  );
}

function Metrics(props: { totals: TrafficStats }) {
  const t = props.totals;
  const tiles: Array<[string, string, string]> = [
    [formatCount(t.requests), 'Requests', 'All calls that reached the gateway.'],
    [formatCount(t.allowed), 'Allowed', 'Forwarded to the upstream API.'],
    [formatCount(t.denied), 'Denied', 'Refused: bad token, wrong tenant or no matching grant.'],
    [
      `${formatCount(t.errors)} (${formatPercent(t.errorRate)})`,
      'Errors',
      'Gateway errors plus upstream 5xx answers.',
    ],
    [percentileText(t.p50), 'Median latency (p50)', 'Time to response headers, allowed requests.'],
    [percentileText(t.p95), 'p95 latency', '95% of allowed requests were faster than this.'],
  ];
  return (
    <div class="metrics">
      {tiles.map(([value, label, hint]) => (
        <div class="metric">
          <span>{label}</span>
          <b>{value}</b>
          <small class="muted">{hint}</small>
        </div>
      ))}
    </div>
  );
}

/** Percentiles in the open-ended bucket only have a lower bound. */
export function percentileText(p: Percentile | null): string {
  if (p === null) return '—';
  if (p.overflow) return `≥ ${Math.round(p.ms / 1000)} s`;
  return formatDuration(p.ms);
}

function ServiceTable(props: { services: ServiceTraffic[] }) {
  return (
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Requests</th>
            <th scope="col">Allowed</th>
            <th scope="col">Denied</th>
            <th scope="col">Errors</th>
            <th scope="col">Error rate</th>
            <th scope="col">p50</th>
            <th scope="col">p95</th>
          </tr>
        </thead>
        <tbody>
          {props.services.map((s) => (
            <tr>
              <td>
                <ServiceLabel service={s} />
              </td>
              <td>
                {s.serviceId ? (
                  <a href={withQuery('/admin/requests', { service: s.serviceId })}>
                    {formatCount(s.requests)}
                  </a>
                ) : (
                  formatCount(s.requests)
                )}
              </td>
              <td>{formatCount(s.allowed)}</td>
              <td>{formatCount(s.denied)}</td>
              <td>{formatCount(s.errors)}</td>
              <td>{formatPercent(s.errorRate)}</td>
              <td>{percentileText(s.p50)}</td>
              <td>{percentileText(s.p95)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ServiceLabel(props: { service: ServiceTraffic }) {
  const s = props.service;
  if (!s.serviceId) {
    return <span class="muted">No service (refused before the service was looked up)</span>;
  }
  if (s.slug === null) {
    return (
      <span>
        Deleted service <Code>{s.serviceId}</Code>
      </span>
    );
  }
  return (
    <a href={`/admin/services/${encodeURIComponent(s.serviceId)}`}>
      {s.name ?? s.slug} <Code>{s.slug}</Code>
    </a>
  );
}

function DenialTable(props: { denials: RecentDenial[] }) {
  return (
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Reason</th>
            <th scope="col">Service</th>
            <th scope="col">Caller</th>
            <th scope="col">Request</th>
          </tr>
        </thead>
        <tbody>
          {props.denials.map((d) => (
            <tr>
              <td>
                <a href={`/admin/requests/${encodeURIComponent(d.id)}`}>{formatTime(d.ts)}</a>
              </td>
              <td>
                <Code>{d.reason ?? '—'}</Code> <span class="muted">(HTTP {d.status})</span>
                {reasonText(d.reason) ? (
                  <>
                    <br />
                    <small class="muted">{reasonText(d.reason)}</small>
                  </>
                ) : null}
              </td>
              <td>{d.service_slug ? <Code>{d.service_slug}</Code> : '—'}</td>
              <td class="wrap">
                {Number(d.claims_verified) === 1 ? (
                  (d.caller_repository ?? d.caller_subject ?? '—')
                ) : (
                  <span class="muted">
                    unverified{d.untrusted_iss ? ` token from ${d.untrusted_iss}` : ''}
                  </span>
                )}
              </td>
              <td class="wrap">
                <Code>
                  {d.method} {d.path}
                </Code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
