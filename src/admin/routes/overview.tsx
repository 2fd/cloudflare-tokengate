// Admin overview (`GET /admin`): last-24 h traffic, per-service table, operational banners,
// recent denials, a getting-started checklist and the system status (`#health`). Read-only. The
// status shows names, counts and the admin hosts, never configured values that could be secret
// (I-CFG-1).
import type { App } from '../../app';
import { type Config, parseConfig } from '../../config';
import { type SchemaState, schemaStatusByDatabase } from '../../db/migrations';
import type { RecentDenial } from '../../db/rollups';
import {
  getAdminHosts,
  getAllowedUpstreamHosts,
  settingsFromRows,
  settingsStatement,
} from '../../db/settings';
import type { Role } from '../../db/types';
import type { Deps } from '../../deps';
import type { AppEnv } from '../../env';
import { cronHealth } from '../../health';
import {
  type DashboardData,
  dashboardBanners,
  loadDashboard,
  type Percentile,
  type ServiceTraffic,
  type TrafficStats,
} from '../../telemetry/dashboard';
import { can, type Permission } from '../auth/rbac';
import { paths } from '../paths';
import { renderPage } from '../render';
import { Badge, Code, Details, EmptyState } from '../views/components';
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatTime,
  loginProviderNames,
} from '../views/format';
import { docsUrl, reasonText } from '../views/reasons';

export function registerOverviewRoutes(app: App): void {
  app.get('/admin', async (c) => {
    const deps = c.get('deps');
    const [data, setup, status] = await Promise.all([
      loadDashboard(deps),
      loadSetupState(deps.env),
      loadSystemStatus(deps),
    ]);
    return renderPage(
      c,
      { title: 'Dashboard', section: paths.overview(), banners: dashboardBanners(data) },
      <>
        <DashboardPage data={data} setup={setup} role={c.get('viewer').user.role} />
        <SystemStatus status={status} env={deps.env} />
      </>,
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

function DashboardPage(props: { data: DashboardData; setup: SetupState; role: Role }) {
  const { data, setup, role } = props;
  const setupDone =
    setup.callerProviders > 0 && setup.services > 0 && setup.grants > 0 && setup.verifiedCall;
  return (
    <>
      {setupDone ? null : <SetupChecklist setup={setup} role={role} />}

      <h2>Last 24 hours</h2>
      <p class="muted">
        Traffic through the proxy since {formatTime(data.window.from)}.
        {setup.sampleRate <= 0
          ? ' Allowed requests are not recorded (sample rate 0 in Data retention), so allowed counts and latency stay at zero.'
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

/** Who holds the permission of a setup step, for viewers who cannot do it themselves. */
const ASK_WHOM: Partial<Record<Permission, string>> = {
  'tokens:write': 'a token manager, admin or owner',
  'access:write': 'an access manager, admin or owner',
};

function SetupChecklist(props: { setup: SetupState; role: Role }) {
  const { setup, role } = props;
  const steps: Array<{
    done: boolean;
    title: string;
    what: string;
    href: string;
    action: string;
    permission: Permission;
  }> = [
    {
      done: setup.callerProviders > 0,
      title: 'Add a caller provider',
      what: 'Tells the gateway which CI tokens to trust, for example GitHub Actions in your organization.',
      href: paths.consumerNew(),
      action: 'Add a caller provider',
      permission: 'access:write',
    },
    {
      done: setup.services > 0,
      title: 'Add a service',
      what: 'The upstream API (Slack, OpenAI, GitHub, …) and the credential the gateway attaches for callers.',
      href: paths.tokenNew(),
      action: 'Add a service',
      permission: 'tokens:write',
    },
    {
      done: setup.grants > 0,
      title: 'Create a grant',
      what: 'Decides which callers (for example, which repositories and branches) may call which service.',
      href: paths.accessNew(),
      action: 'Create a grant',
      permission: 'access:write',
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
                {can(role, step.permission) ? (
                  <a href={step.href}>{step.action}</a>
                ) : (
                  <span>Ask {ASK_WHOM[step.permission]} to do this step.</span>
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
                  <a href={paths.requests({ token: s.serviceId })}>{formatCount(s.requests)}</a>
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
    <a href={paths.token(s.serviceId)}>
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
                <a href={paths.request(d.id)}>{formatTime(d.ts)}</a>
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

// ---------------------------------------------------------------------------------------------
// System status (moved from the removed Settings page)

const SCHEMA_TEXT: Record<SchemaState, string> = {
  ok: 'up to date',
  behind: 'migrations missing: run "wrangler d1 migrations apply" (docs/operations/upgrades.md)',
  ahead: 'newer than this code (a rollback?); see docs/operations/upgrades.md',
  unknown: 'could not be read',
};

interface SystemStatusData {
  config: Config;
  cron: Awaited<ReturnType<typeof cronHealth>>;
  schema: Awaited<ReturnType<typeof schemaStatusByDatabase>>;
  upstreamHosts: string[] | null;
  adminHosts: string[] | null;
}

async function loadSystemStatus(deps: Deps): Promise<SystemStatusData> {
  const [cron, schema, upstreamHosts, adminHosts] = await Promise.all([
    cronHealth(deps),
    schemaStatusByDatabase(deps),
    getAllowedUpstreamHosts(deps.env.DB),
    getAdminHosts(deps.env.DB),
  ]);
  return { config: parseConfig(deps.env), cron, schema, upstreamHosts, adminHosts };
}

function SystemStatus(props: { status: SystemStatusData; env: AppEnv }) {
  const { config, cron, schema, upstreamHosts, adminHosts } = props.status;
  const env = props.env;
  return (
    <details id="health">
      <summary>System status</summary>
      <Details
        rows={[
          [
            'Database schema',
            <>
              Control plane (DB): {SCHEMA_TEXT[schema.DB]}
              <br />
              Telemetry (TELEMETRY_DB): {SCHEMA_TEXT[schema.TELEMETRY_DB]}
            </>,
          ],
          ['Hourly maintenance job', <CronStatus cron={cron} />],
          ['Admin hosts', adminHostsText(adminHosts)],
          ['Login providers', loginStatusText(config)],
          [
            'Upstream host allowlist',
            upstreamHosts === null
              ? 'not set: services may use any public https host'
              : `set (${upstreamHosts.length} entries)`,
          ],
          [
            'Request log queue (REQUEST_LOG_QUEUE)',
            bindingText(
              env.REQUEST_LOG_QUEUE !== undefined,
              'request records are written to the database directly',
            ),
          ],
          [
            'Request archive (REQUEST_ARCHIVE)',
            bindingText(env.REQUEST_ARCHIVE !== undefined, 'records are not archived to R2'),
          ],
          [
            'Proxy rate limiter (PROXY_RATE_LIMITER)',
            bindingText(env.PROXY_RATE_LIMITER !== undefined, 'no per-grant request cap'),
          ],
        ]}
      />
      {config.errors.length > 0 ? (
        <>
          <h3>Configuration problems</h3>
          <p>
            These features are turned off until the variables are fixed (docs/configuration.md):
          </p>
          <ul>
            {config.errors.map((error) => (
              <li>
                <code>{error.variable}</code>: {error.message}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </details>
  );
}

function CronStatus(props: { cron: Awaited<ReturnType<typeof cronHealth>> }) {
  const { cron } = props;
  return (
    <>
      {cron.failing ? (
        <Badge tone="bad">failing</Badge>
      ) : cron.lastSuccessAt === null ? (
        <Badge tone="muted">not run yet</Badge>
      ) : cron.stale ? (
        <Badge tone="warn">late</Badge>
      ) : (
        <Badge tone="ok">running</Badge>
      )}{' '}
      Last success: {cron.lastSuccessAt === null ? 'never' : formatTime(cron.lastSuccessAt)}
      {cron.failing ? (
        <div>
          Last failure at {formatTime(cron.lastErrorAt)}: <code>{cron.lastError ?? 'unknown'}</code>
        </div>
      ) : null}
      {cron.lastSuccessAt === null && !cron.failing ? (
        <div class="muted">It runs a few minutes past every hour.</div>
      ) : null}
    </>
  );
}

function loginStatusText(config: Config): string {
  const names = loginProviderNames(config);
  return names.length > 0
    ? names.join(', ')
    : 'none configured: nobody can sign in (docs/configuration.md)';
}

function adminHostsText(hosts: string[] | null): string {
  if (hosts === null) return 'not set yet: set on the first sign-in.';
  return `${hosts.join(', ')}.`;
}

function bindingText(bound: boolean, whenMissing: string): string {
  return bound ? 'bound' : `not bound: ${whenMissing}`;
}
