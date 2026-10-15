// Admin pages: settings (retention, sampling, row cap), encryption key status and re-encryption,
// system status, and the configuration export download (POST /admin/export). System status shows
// names, counts and the admin hosts, never configured values that could be secret (I-CFG-1).
import type { App } from '../../app';
import { type Config, parseConfig, upstreamHostAllowed } from '../../config';
import { type SchemaState, schemaStatusByDatabase } from '../../db/migrations';
import { listServices } from '../../db/services';
import {
  getAdminHosts,
  getAllowedUpstreamHosts,
  getSettings,
  SETTING_BOUNDS,
  type Settings,
} from '../../db/settings';
import { countActiveOwners } from '../../db/users';
import { cronHealth, keyringHealth } from '../../health';
import { can } from '../auth/rbac';
import { exportConfiguration } from '../ops/export';
import { KEYRING_ERROR_TEXT, keyringStatus, rewrapCredentials } from '../ops/keyring';
import {
  EDITABLE_SETTINGS,
  SETTING_LABELS,
  updateAdminHosts,
  updateSettings,
  updateUpstreamHosts,
} from '../ops/settings';
import type { OpFailure } from '../ops/shared';
import {
  type AdminContext,
  adminActor,
  type FormFields,
  formData,
  redirectWithNotice,
  renderPage,
} from '../render';
import { Badge, Csrf, Details, Messages } from '../views/components';
import { formatTime, loginProviderNames } from '../views/format';

const SECTION = '/admin/settings';

const NOTICES = {
  saved: 'Settings saved. The hourly maintenance job applies retention changes on its next run.',
  unchanged: 'Nothing changed: the submitted values are the current ones.',
  rewrapped: 'Credentials re-encrypted with the active key.',
  rewrapped_partial:
    'Credentials re-encrypted with the active key, except some that were changed while this ran. Run it again to finish.',
  rewrap_none: 'Nothing to re-encrypt: every credential already uses the active key.',
  hosts_saved:
    'Upstream host allowlist saved. It applies to service saves and to every proxied request.',
  hosts_unchanged: 'Nothing changed: that is the current upstream host allowlist.',
  admin_hosts_saved:
    'Admin hosts saved. The admin console now answers only on these hosts. Put each new hostname behind your Cloudflare Access application.',
  admin_hosts_unchanged: 'Nothing changed: that is the current admin host list.',
  key_confirmed:
    'New key confirmed: every credential opens with it. Credentials under older keys, if any, were re-encrypted with the active key.',
} as const;
type NoticeKey = keyof typeof NOTICES;

const SETTING_HINTS: Record<keyof Settings, string> = {
  request_log_retention_days:
    'How long each proxied request record is kept before the hourly job deletes it.',
  audit_log_retention_days: 'How long the record of admin changes (the audit log) is kept.',
  rollup_retention_days:
    'How long the hourly traffic totals behind the dashboard charts are kept. They are small; keep them longer than the request log.',
  allowed_sample_rate:
    'A number from 0 to 1. 1 records every allowed request; 0.1 records about one in ten (dashboard counts are scaled up). Denied requests and errors are always recorded. On the Workers Free plan, use 0 to stay within the daily database write limit.',
  request_log_max_rows:
    'Soft upper limit on stored request records, checked every hour. When exceeded, the oldest records are deleted first, even if newer than the retention period. The last few hours are kept for the rollups, so the table can exceed this by a few hours of traffic.',
};

const SCHEMA_TEXT: Record<SchemaState, string> = {
  ok: 'up to date',
  behind: 'migrations missing: run "wrangler d1 migrations apply" (docs/operations/upgrades.md)',
  ahead: 'newer than this code (a rollback?); see docs/operations/upgrades.md',
  unknown: 'could not be read',
};

type SettingValues = Partial<Record<keyof Settings, string>>;

export function registerSettingsRoutes(app: App): void {
  app.get(SECTION, (c) => settingsPage(c, { notice: noticeKey(c.req.query('notice')) }));

  app.post(SECTION, async (c) => {
    const form = await formData(c);
    const submitted: SettingValues = {};
    const input: Partial<Settings> = {};
    for (const key of EDITABLE_SETTINGS) {
      const raw = text(form, key);
      if (raw === undefined) continue;
      submitted[key] = raw;
      input[key] = raw.trim() === '' ? Number.NaN : Number(raw.trim());
    }
    const result = await updateSettings(c.get('deps'), adminActor(c), input);
    if (!result.ok) {
      const status = result.reason === 'conflict' ? 409 : 400;
      return settingsPage(c, { errors: result.errors, submitted, status });
    }
    return redirectWithNotice(c, SECTION, result.changed.length > 0 ? 'saved' : 'unchanged');
  });

  app.post(`${SECTION}/upstream-hosts`, async (c) => {
    const form = await formData(c);
    const raw = text(form, 'allowed_upstream_hosts') ?? '';
    const result = await updateUpstreamHosts(c.get('deps'), adminActor(c), raw);
    if (!result.ok) {
      const status = result.reason === 'conflict' ? 409 : 400;
      return settingsPage(c, { errors: result.errors, submittedHosts: raw, status });
    }
    return redirectWithNotice(c, SECTION, result.changed ? 'hosts_saved' : 'hosts_unchanged');
  });

  app.post(`${SECTION}/admin-hosts`, async (c) => {
    const form = await formData(c);
    const raw = text(form, 'admin_hosts') ?? '';
    const host = new URL(c.req.url).hostname;
    const result = await updateAdminHosts(c.get('deps'), adminActor(c), raw, host);
    if (!result.ok) {
      const status = result.reason === 'conflict' ? 409 : 400;
      return settingsPage(c, { errors: result.errors, submittedAdminHosts: raw, status });
    }
    return redirectWithNotice(
      c,
      SECTION,
      result.changed ? 'admin_hosts_saved' : 'admin_hosts_unchanged',
    );
  });

  app.post(`${SECTION}/rewrap`, async (c) => {
    const result = await rewrapCredentials(c.get('deps'), adminActor(c));
    if (!result.ok) return failurePage(c, result);
    const notice: NoticeKey =
      result.skipped > 0
        ? 'rewrapped_partial'
        : result.confirmedKids.length > 0
          ? 'key_confirmed'
          : result.rewrapped > 0
            ? 'rewrapped'
            : 'rewrap_none';
    return redirectWithNotice(c, SECTION, notice);
  });

  // A CSRF-checked POST (I-CSRF-1) because the export writes an audit row (I-AUDIT-1).
  app.post('/admin/export', async (c) => {
    const deps = c.get('deps');
    const result = await exportConfiguration(deps, adminActor(c));
    if (!result.ok) return failurePage(c, result);
    const date = new Date(deps.now()).toISOString().slice(0, 10);
    return c.body(result.json, 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="tokengate-export-${date}.json"`,
    });
  });
}

function failurePage(c: AdminContext, failure: OpFailure) {
  return settingsPage(c, { errors: failure.errors, status: 409 });
}

async function settingsPage(
  c: AdminContext,
  options: {
    notice?: NoticeKey | null;
    errors?: string[];
    submitted?: SettingValues;
    submittedHosts?: string;
    submittedAdminHosts?: string;
    status?: 400 | 409;
  },
) {
  const deps = c.get('deps');
  const viewer = c.get('viewer');
  const role = viewer.user.role;
  const config = parseConfig(deps.env);
  const [
    settings,
    keyring,
    health,
    cron,
    schema,
    activeOwners,
    upstreamHosts,
    adminHosts,
    services,
  ] = await Promise.all([
    getSettings(deps.env.DB),
    keyringStatus(deps),
    keyringHealth(deps),
    cronHealth(deps),
    schemaStatusByDatabase(deps),
    countActiveOwners(deps.env.DB),
    getAllowedUpstreamHosts(deps.env.DB),
    getAdminHosts(deps.env.DB),
    listServices(deps.env.DB),
  ]);
  const currentHost = new URL(c.req.url).hostname;
  const outsideAllowlist = services.filter(
    (service) => !upstreamHostAllowed(new URL(service.base_url).hostname, upstreamHosts),
  );

  return renderPage(
    c,
    {
      title: 'Settings',
      section: SECTION,
      notice: options.notice ? NOTICES[options.notice] : null,
      status: options.status,
    },
    <>
      <Messages errors={options.errors} />

      <h2>Data retention and sampling</h2>
      {can(role, 'settings:write') ? (
        <SettingsForm csrf={viewer.csrfToken} settings={settings} submitted={options.submitted} />
      ) : (
        <>
          <Details
            rows={EDITABLE_SETTINGS.map((key) => [SETTING_LABELS[key], String(settings[key])])}
          />
          <p class="muted">Only owners can change these settings.</p>
        </>
      )}

      <h2>Upstream hosts</h2>
      <p>
        Services can send their credential to any public https host by default. To restrict that,
        list the allowed hosts. The list applies when a service is saved and on every proxied
        request.
      </p>
      {outsideAllowlist.length > 0 ? (
        <p class="banner warning" role="status">
          These services point outside the allowlist, so their requests are refused:{' '}
          {outsideAllowlist.map((service) => service.slug).join(', ')}.
        </p>
      ) : null}
      {can(role, 'settings:write') ? (
        <form method="post" action={`${SECTION}/upstream-hosts`} class="stack">
          <Csrf token={viewer.csrfToken} />
          <label class="field">
            <span>Allowed upstream hosts</span>
            <textarea
              name="allowed_upstream_hosts"
              rows={4}
              placeholder={'api.github.com\n*.slack.com'}
            >
              {options.submittedHosts ?? (upstreamHosts ?? []).join('\n')}
            </textarea>
            <small>
              One per line (or separated by commas): an exact hostname such as api.github.com, or
              *.example.com for every host below example.com. Leave it empty to allow any public
              https host.
            </small>
          </label>
          <div class="actions">
            <button type="submit">Save allowlist</button>
          </div>
        </form>
      ) : (
        <p class="muted">
          {upstreamHosts === null
            ? 'Any public https host is allowed.'
            : `Allowed: ${upstreamHosts.join(', ')}.`}{' '}
          Only owners can change this.
        </p>
      )}

      <h2>Admin hosts</h2>
      <p>
        The admin console answers only on these hostnames; any other hostname gets 404. The hostname
        of the first sign-in is the first entry. Put every hostname you add behind your Cloudflare
        Access application. The admin console never answers on workers.dev.
      </p>
      {can(role, 'settings:write') ? (
        <form method="post" action={`${SECTION}/admin-hosts`} class="stack">
          <Csrf token={viewer.csrfToken} />
          <label class="field">
            <span>Admin hosts</span>
            <textarea name="admin_hosts" rows={3} placeholder={currentHost}>
              {options.submittedAdminHosts ?? (adminHosts ?? []).join('\n')}
            </textarea>
            <small>
              One per line (or separated by commas): an exact hostname such as
              tokengate.example.com, or *.example.com for every host below example.com. Keep{' '}
              {currentHost}, the host you are using now.
            </small>
          </label>
          <div class="actions">
            <button type="submit">Save admin hosts</button>
          </div>
        </form>
      ) : (
        <p class="muted">{adminHostsText(adminHosts)} Only owners can change this.</p>
      )}

      <h2>Encryption keys</h2>
      <KeyringSection
        csrf={viewer.csrfToken}
        canRewrap={can(role, 'keyring:rewrap')}
        status={keyring}
        changedKids={health.changedKids}
      />

      <h2>System status</h2>
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
              deps.env.REQUEST_LOG_QUEUE !== undefined,
              'request records are written to the database directly',
            ),
          ],
          [
            'Request archive (REQUEST_ARCHIVE)',
            bindingText(deps.env.REQUEST_ARCHIVE !== undefined, 'records are not archived to R2'),
          ],
          [
            'Proxy rate limiter (PROXY_RATE_LIMITER)',
            bindingText(deps.env.PROXY_RATE_LIMITER !== undefined, 'no per-grant request cap'),
          ],
          [
            'First owner',
            activeOwners > 0
              ? 'done: an owner exists'
              : 'not yet: the first person to sign in becomes owner',
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

      <h2>Configuration export</h2>
      <p>
        A JSON file with every caller provider, service, grant and user, for review or backup. It
        contains no credentials or other secrets. Each download is recorded in the audit log.
      </p>
      {can(role, 'config:export') ? (
        <form method="post" action="/admin/export">
          <Csrf token={viewer.csrfToken} />
          <button type="submit">Download configuration export</button>
        </form>
      ) : (
        <p class="muted">Admins and owners can download the export.</p>
      )}
    </>,
  );
}

function SettingsForm(props: { csrf: string; settings: Settings; submitted?: SettingValues }) {
  return (
    <form method="post" action={SECTION} class="stack">
      <Csrf token={props.csrf} />
      {EDITABLE_SETTINGS.map((key) => {
        const { min, max } = SETTING_BOUNDS[key];
        const value = props.submitted?.[key] ?? String(props.settings[key]);
        const fraction = key === 'allowed_sample_rate';
        return (
          <label class="field">
            <span>{SETTING_LABELS[key]}</span>
            <input
              type="number"
              name={key}
              value={value}
              min={min}
              max={max}
              step={fraction ? 'any' : 1}
              required
            />
            <small>
              {SETTING_HINTS[key]} Allowed: {min} to {max}.
            </small>
          </label>
        );
      })}
      <div class="actions">
        <button type="submit">Save settings</button>
      </div>
    </form>
  );
}

function KeyringSection(props: {
  csrf: string;
  canRewrap: boolean;
  status: Awaited<ReturnType<typeof keyringStatus>>;
  changedKids: string[];
}) {
  const { status } = props;
  // Problems that block re-encryption. A changed check value does not: re-encryption is how the
  // new key is accepted once every credential under it opens.
  const problems: string[] = [];
  const changedKidProblems: string[] = [];
  if (status.error) problems.push(KEYRING_ERROR_TEXT[status.error]);
  // Without a keyring every kid is "missing"; the error above already says so.
  for (const kid of status.error ? [] : status.missingKids) {
    problems.push(
      `Key "${kid}" is used by ${status.credentialsByKid[kid] ?? 0} credential(s) but is not in the keyring. Those services answer 503 until the key is added back.`,
    );
  }
  for (const kid of props.changedKids) {
    changedKidProblems.push(
      `Key "${kid}" is not the key that encrypted its credentials (its check value changed). Restore the original key, or set those credentials again and then re-encrypt credentials to accept the new key.`,
    );
  }
  if (status.unreadableCredentials > 0) {
    problems.push(
      `${status.unreadableCredentials} stored credential(s) are damaged. Set those credentials again on their service pages.`,
    );
  }
  return (
    <>
      <p>
        Credentials are stored encrypted with the key from the <code>TOKENGATE_KEK</code> or{' '}
        <code>TOKENGATE_KEYRING</code> secret. Compare each check value with the one printed by{' '}
        <code>node scripts/keyring.ts check</code> for the key in your vault.
      </p>
      {[...changedKidProblems, ...problems].map((problem) => (
        <p class="banner error" role="alert">
          {problem}
        </p>
      ))}
      {status.keys.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Key id</th>
              <th scope="col">Check value</th>
              <th scope="col">Used for new credentials</th>
              <th scope="col">Credentials encrypted with it</th>
            </tr>
          </thead>
          <tbody>
            {status.keys.map((key) => (
              <tr>
                <td>
                  <code>{key.kid}</code>
                </td>
                <td>
                  <code>{key.kcv}</code>
                </td>
                <td>{key.active ? <Badge tone="ok">active</Badge> : 'no'}</td>
                <td>{key.credentials}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <RewrapControl
        csrf={props.csrf}
        canRewrap={props.canRewrap}
        status={status}
        changedKids={props.changedKids}
        blocked={problems.length > 0}
      />
    </>
  );
}

/**
 * Re-encryption needs a loaded keyring and every stored credential readable (the op is
 * all-or-nothing), so the button is offered only when nothing above is reported as a problem.
 * It is also the recovery path for a changed key check value, so it is offered for that alone.
 */
function RewrapControl(props: {
  csrf: string;
  canRewrap: boolean;
  status: Awaited<ReturnType<typeof keyringStatus>>;
  changedKids: string[];
  blocked: boolean;
}) {
  const { status } = props;
  if (status.error !== null) return null;
  if (status.needsRewrap === 0 && props.changedKids.length === 0) {
    return <p class="muted">Every stored credential uses the active key.</p>;
  }
  return (
    <>
      {status.needsRewrap > 0 ? (
        <p>
          {status.needsRewrap} credential(s) are still encrypted with an older key. Re-encrypt them
          with the active key before removing old keys from the keyring
          (docs/operations/key-rotation.md).
        </p>
      ) : null}
      {props.changedKids.length > 0 ? (
        <p>
          Re-encrypting also opens every credential under key(s){' '}
          {props.changedKids.map((kid, index) => (
            <>
              {index > 0 ? ', ' : ''}
              <code>{kid}</code>
            </>
          ))}{' '}
          with the loaded key. If all of them open, the new check value is accepted and the alert
          clears; otherwise nothing changes and the services that still need the old key are listed.
        </p>
      ) : null}
      {props.blocked ? (
        <p class="muted">
          Fix the problems listed above first: re-encryption changes nothing while any stored
          credential cannot be opened.
        </p>
      ) : props.canRewrap ? (
        <form method="post" action={`${SECTION}/rewrap`} class="inline">
          <Csrf token={props.csrf} />
          <button type="submit">Re-encrypt credentials with the active key</button>
        </form>
      ) : (
        <p class="muted">Only owners can re-encrypt credentials.</p>
      )}
    </>
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

function noticeKey(raw: string | undefined): NoticeKey | null {
  return raw !== undefined && Object.hasOwn(NOTICES, raw) ? (raw as NoticeKey) : null;
}

function text(form: FormFields, name: string): string | undefined {
  const value = form[name];
  return typeof value === 'string' ? value : undefined;
}
