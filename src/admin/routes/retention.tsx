// Admin page: data retention (Monitoring). Retention periods, the allowed-request sample rate and
// the request log row cap. Owners edit them (settings:write); everyone else sees the values.
import type { App } from '../../app';
import { getSettings, SETTING_BOUNDS, type Settings } from '../../db/settings';
import { can } from '../auth/rbac';
import { EDITABLE_SETTINGS, SETTING_LABELS, updateSettings } from '../ops/settings';
import { paths } from '../paths';
import {
  type AdminContext,
  adminActor,
  type FormFields,
  formData,
  redirectWithNotice,
  renderPage,
} from '../render';
import { Csrf, Details, Messages } from '../views/legacy';

const PAGE = paths.retention();

const NOTICES = {
  saved: 'Settings saved. The hourly maintenance job applies retention changes on its next run.',
  unchanged: 'Nothing changed: the submitted values are the current ones.',
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

type SettingValues = Partial<Record<keyof Settings, string>>;

export function registerRetentionRoutes(app: App): void {
  app.get('/admin/retention', (c) =>
    retentionPage(c, { notice: noticeKey(c.req.query('notice')) }),
  );

  app.post('/admin/retention', async (c) => {
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
      return retentionPage(c, { errors: result.errors, submitted, status });
    }
    return redirectWithNotice(c, PAGE, result.changed.length > 0 ? 'saved' : 'unchanged');
  });
}

async function retentionPage(
  c: AdminContext,
  options: {
    notice?: NoticeKey | null;
    errors?: string[];
    submitted?: SettingValues;
    status?: 400 | 409;
  },
) {
  const deps = c.get('deps');
  const viewer = c.get('viewer');
  const settings = await getSettings(deps.env.DB);
  return renderPage(
    c,
    {
      title: 'Data retention',
      section: 'monitoring',
      subsection: 'retention',
      notice: options.notice ? { text: NOTICES[options.notice] } : null,
      status: options.status,
    },
    () => (
      <>
        <Messages errors={options.errors} />
        {can(viewer.user.role, 'settings:write') ? (
          <SettingsForm csrf={viewer.csrfToken} settings={settings} submitted={options.submitted} />
        ) : (
          <>
            <Details
              rows={EDITABLE_SETTINGS.map((key) => [SETTING_LABELS[key], String(settings[key])])}
            />
            <p class="muted">Only owners can change these settings.</p>
          </>
        )}
      </>
    ),
  );
}

function SettingsForm(props: { csrf: string; settings: Settings; submitted?: SettingValues }) {
  return (
    <form method="post" action={PAGE} class="stack">
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

function noticeKey(raw: string | undefined): NoticeKey | null {
  return raw !== undefined && Object.hasOwn(NOTICES, raw) ? (raw as NoticeKey) : null;
}

function text(form: FormFields, name: string): string | undefined {
  const value = form[name];
  return typeof value === 'string' ? value : undefined;
}
