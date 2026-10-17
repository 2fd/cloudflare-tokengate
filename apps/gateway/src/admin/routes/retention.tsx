// Monitoring › Data retention (`/admin/retention`), a settings page: how long request records,
// hourly summaries and the audit log are kept, the share of allowed requests recorded, and the
// request record cap. Three read-only cards for everyone; owners (settings:write) get "Edit…" on
// each card, which opens one dialog holding the whole form (one POST, so the cross-field rule
// reports where it belongs). Every value is prefilled and the numbers have suggestion lists; the
// sample rate is a pick from presets. A failed save re-renders the dialog open in the page flow.
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DialogClose,
  DialogTrigger,
  FieldSet,
  KeyValue,
  PageHeader,
  Panel,
  Tray,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import type { App } from '../../app';
import { HOUR_MS, outcomeTotalsStatement } from '../../db/rollups';
import { getSettings, SETTING_BOUNDS, type Settings } from '../../db/settings';
import { ROWS_ESTIMATE_SQL } from '../../telemetry/retention';
import { hourStart } from '../../telemetry/rollup';
import { type NoticeTable, resolveNotice } from '../notice';
import { EDITABLE_SETTINGS, SETTING_LABELS, updateSettings } from '../ops/settings';
import type { FieldError } from '../ops/shared';
import { paths } from '../paths';
import {
  type AdminContext,
  adminActor,
  type FormFields,
  formData,
  redirectWithNotice,
  renderPage,
  type ViewContext,
} from '../render';
import { AskSomeone, Field, RadioCards } from '../views/components';
import { formatCount, formatPercent } from '../views/format';
import { FindRequest } from '../views/monitoring';

const PAGE = paths.retention();
const DIALOG = 'retention-edit';

const NOTICES: NoticeTable = {
  saved: () => ({
    text: 'Settings saved. The hourly maintenance job applies retention changes on its next run.',
  }),
  unchanged: () => ({ text: 'Nothing changed: the submitted values are the current ones.' }),
};

/** Suggestions of the number fields (a pick instead of typing). */
const SUGGESTIONS: Partial<Record<keyof Settings, number[]>> = {
  request_log_retention_days: [7, 14, 30, 90, 180, 365],
  request_log_max_rows: [100_000, 1_000_000, 5_000_000, 20_000_000],
  rollup_retention_days: [30, 90, 400, 730],
  audit_log_retention_days: [90, 365, 730, 1825],
};

const SAMPLE_PRESETS: ReadonlyArray<{ value: number; title: string; description?: string }> = [
  { value: 1, title: '100 % (all)' },
  { value: 0.5, title: '50 %' },
  { value: 0.1, title: '10 %' },
  { value: 0.01, title: '1 %' },
  { value: 0, title: '0 % (none)', description: 'Recommended on the Workers Free plan.' },
];

const GROUPS: ReadonlyArray<{
  id: 'records' | 'summaries' | 'audit';
  legend: string;
  keys: ReadonlyArray<keyof Settings>;
}> = [
  {
    id: 'records',
    legend: 'Request records',
    keys: ['request_log_retention_days', 'allowed_sample_rate', 'request_log_max_rows'],
  },
  { id: 'summaries', legend: 'Hourly summaries', keys: ['rollup_retention_days'] },
  { id: 'audit', legend: 'Audit log', keys: ['audit_log_retention_days'] },
];

type SettingValues = Partial<Record<keyof Settings, string>>;

interface Usage {
  /** Upper estimate of the stored request records. */
  stored: number | null;
  /** Records a day kept in the last 7 days at the current sample rate. */
  perDay: number | null;
}

export function registerRetentionRoutes(app: App): void {
  app.get('/admin/retention', (c) => retentionPage(c, { notice: c.req.query('notice') }));

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
      return retentionPage(c, {
        errors: result.fieldErrors ?? result.errors.map((message) => ({ field: null, message })),
        submitted,
        status: result.reason === 'conflict' ? 409 : 400,
      });
    }
    return redirectWithNotice(c, PAGE, result.changed.length > 0 ? 'saved' : 'unchanged');
  });
}

async function retentionPage(
  c: AdminContext,
  options: {
    notice?: string;
    errors?: FieldError[];
    submitted?: SettingValues;
    status?: 400 | 409;
  },
) {
  const deps = c.get('deps');
  const telemetry = deps.env.TELEMETRY_DB;
  const now = deps.now();
  const [settings, usage] = await Promise.all([
    getSettings(deps.env.DB),
    telemetry
      .batch([
        telemetry.prepare(ROWS_ESTIMATE_SQL),
        outcomeTotalsStatement(telemetry, hourStart(now) - 7 * 24 * HOUR_MS),
      ])
      .then(([stored, totals]) => {
        const row = (totals?.results[0] ?? {}) as { allowed?: number; other?: number };
        return {
          stored: Number((stored?.results[0] as { n?: number } | undefined)?.n ?? 0),
          allowed: Number(row.allowed ?? 0),
          other: Number(row.other ?? 0),
        };
      })
      .catch(() => null),
  ]);
  // Rollups count requests (weights undo sampling), so the records kept are the denied and error
  // ones plus the allowed ones at the current sample rate.
  const kept: Usage = usage
    ? {
        stored: usage.stored,
        perDay: (usage.other + usage.allowed * settings.allowed_sample_rate) / 7,
      }
    : { stored: null, perDay: null };
  const errors = options.errors ?? [];
  return renderPage(
    c,
    {
      title: 'Data retention',
      section: 'monitoring',
      subsection: 'retention',
      notice: resolveNotice(NOTICES, options.notice, null),
      errors,
      status: options.status,
      header: (
        <PageHeader
          title="Data retention"
          description="How long tokengate keeps what it records, and how much of it. The hourly maintenance job deletes older data."
          actions={<FindRequest placement="header" />}
        />
      ),
    },
    (ctx) => {
      const canEdit = ctx.can('settings:write');
      const edit = (what: string) =>
        canEdit ? (
          <DialogTrigger dialog={DIALOG} size="sm" srSuffix={what}>
            Edit…
          </DialogTrigger>
        ) : undefined;
      return (
        <>
          {canEdit ? null : (
            <AskSomeone permission="settings:write" ctx={ctx} verb="change these settings" />
          )}
          {kept.stored === null ? (
            <Callout tone="warn" title="The request log could not be read." />
          ) : null}
          <Tray
            id="records"
            title="Request records"
            description={kept.stored === null ? undefined : <UsageLine usage={kept} />}
            actions={edit('request records')}
          >
            <Panel variant="pad">
              <KeyValue items={valueItems(GROUPS[0]?.keys ?? [], settings)} />
            </Panel>
          </Tray>
          <Tray
            id="summaries"
            title="Hourly summaries"
            description="Summaries feed the Overview and 'last used'."
            actions={edit('hourly summaries')}
          >
            <Panel variant="pad">
              <KeyValue items={valueItems(GROUPS[1]?.keys ?? [], settings)} />
            </Panel>
          </Tray>
          <Tray
            id="audit"
            title="Audit log"
            description="The 90-day floor protects the audit trail."
            actions={edit('audit log')}
          >
            <Panel variant="pad">
              <KeyValue items={valueItems(GROUPS[2]?.keys ?? [], settings)} />
            </Panel>
          </Tray>
          {canEdit ? (
            <SettingsDialog
              ctx={ctx}
              settings={settings}
              submitted={options.submitted}
              errors={errors}
              usage={kept}
            />
          ) : null}
        </>
      );
    },
  );
}

/** "Stored now: up to about N records (upper estimate). Last 7 days: …" */
function UsageLine(props: { usage: Usage }) {
  const { usage } = props;
  const perDay = usage.perDay;
  return (
    <>
      Stored now: up to about {compact(usage.stored ?? 0)} records (upper estimate).
      {perDay !== null
        ? ` Last 7 days: about ${compact(perDay)} records a day kept after sampling.`
        : ''}
    </>
  );
}

/** The read-only values of a card: plain text, a badge only when allowed requests are sampled. */
function valueItems(keys: ReadonlyArray<keyof Settings>, settings: Settings) {
  return keys.map((key) => {
    if (key !== 'allowed_sample_rate') {
      return { label: SETTING_LABELS[key], value: formatCount(settings[key]) };
    }
    const rate = settings.allowed_sample_rate;
    // No trailing space at 100 %: the value is exactly the text.
    const value: Child =
      rate < 1 ? (
        <>
          {sampleText(rate)}{' '}
          <Badge tone="warn" glyph="⚠">
            {rate === 0 ? 'Not recorded' : 'Sampled'}
          </Badge>
        </>
      ) : (
        sampleText(rate)
      );
    return { label: SETTING_LABELS[key], value };
  });
}

/** 1.2 M, 85 k, 312: rounded counts for estimates. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')} M`;
  if (n >= 10_000) return `${Math.round(n / 1000)} k`;
  return formatCount(n);
}

function sampleText(rate: number): string {
  const preset = SAMPLE_PRESETS.find((p) => p.value === rate);
  return preset ? preset.title : formatPercent(rate);
}

function hintFor(key: keyof Settings, settings: Settings, usage: Usage): Child {
  switch (key) {
    case 'request_log_retention_days':
      return 'How long request records are kept. 1 to 3650 days. Older records are deleted every hour.';
    case 'allowed_sample_rate':
      return "Denied and error records are always kept. Below 100 %, counts are estimates. At 0 %, 'last used' is not available.";
    case 'request_log_max_rows': {
      const perDay = usage.perDay;
      const base =
        '10,000 to 50,000,000. Upper limit on stored request records, checked every hour.';
      if (perDay === null || perDay <= 0) return base;
      const days = settings.request_log_retention_days;
      return `${base} At last week's rate (about ${formatCount(perDay)} a day), ${days} days needs about ${formatCount(perDay * days)} rows.`;
    }
    case 'rollup_retention_days':
      return "Hourly summaries for the Overview and 'last used'. 30 to 3650 days, and at least as long as the request record retention.";
    case 'audit_log_retention_days':
      return '90 to 3650 days. The 90-day floor protects the audit trail.';
  }
}

/**
 * The edit dialog: the whole form, one fieldset per card. Opened by every card's "Edit…"; after a
 * failed save it renders open in the page flow, so the ErrorSummary links land on visible fields.
 */
function SettingsDialog(props: {
  ctx: ViewContext;
  settings: Settings;
  submitted?: SettingValues;
  errors: FieldError[];
  usage: Usage;
}) {
  const { settings } = props;
  const error = (key: string) => props.errors.find((e) => e.field === key)?.message ?? null;
  const value = (key: keyof Settings) => props.submitted?.[key] ?? String(settings[key]);
  return (
    <Dialog
      id={DIALOG}
      title="Edit data retention"
      description="The hourly maintenance job applies retention changes on its next run."
      wide
      action={PAGE}
      hidden={props.ctx.hidden()}
      open={props.errors.length > 0}
      footer={
        <>
          <DialogClose dialog={DIALOG} />
          <Button variant="primary" type="submit">
            Save
          </Button>
        </>
      }
    >
      {GROUPS.map((group) => (
        <FieldSet id={`g-${group.id}`} legend={group.legend}>
          {group.keys.map((key) => {
            if (key === 'allowed_sample_rate') {
              const current = settings.allowed_sample_rate;
              const chosen = value(key);
              const presets = SAMPLE_PRESETS.some((p) => p.value === current)
                ? SAMPLE_PRESETS
                : [...SAMPLE_PRESETS, { value: current, title: formatPercent(current) }];
              return (
                <RadioCards
                  name={key}
                  legend={SETTING_LABELS[key]}
                  value={chosen}
                  hint={hintFor(key, settings, props.usage)}
                  error={error(key)}
                  options={presets.map((preset) => ({
                    value: String(preset.value),
                    title: preset.value === current ? `${preset.title} (current)` : preset.title,
                    ...('description' in preset && preset.description
                      ? { description: preset.description }
                      : {}),
                  }))}
                />
              );
            }
            const { min, max } = SETTING_BOUNDS[key];
            return (
              <Field
                name={key}
                type="number"
                label={SETTING_LABELS[key]}
                value={value(key)}
                example={String(settings[key])}
                hint={hintFor(key, settings, props.usage)}
                error={error(key)}
                inputmode="numeric"
                step={1}
                min={min}
                max={max}
                required
                autocomplete="off"
                suggestions={(SUGGESTIONS[key] ?? []).map((n) => ({ value: String(n) }))}
              />
            );
          })}
        </FieldSet>
      ))}
    </Dialog>
  );
}

function text(form: FormFields, name: string): string | undefined {
  const value = form[name];
  return typeof value === 'string' ? value : undefined;
}
