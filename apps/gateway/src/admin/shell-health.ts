// What the shell says about the health of the deployment, on every page, from the alert catalogue
// (telemetry/dashboard.ts overviewAlerts): the health line in the sidebar counts errors, then
// warnings, then notes; the health strip shows the error-level problems that stop calls, with one
// fix link each. Text names variables and states only, never values.
import { SCHEMA_HEAD } from '../generated/schema-head';
import type { ConfigProblem, CronHealth, KeyringHealth } from '../health';
import { type AlertData, checkHref } from '../telemetry/dashboard';
import { paths } from './paths';
import type { Alert } from './views/alerts';
import { docsUrl } from './views/docs';

/** An error-level problem in the health strip, with the link that fixes it. */
export interface HealthProblem {
  /** The short bold sentence: "The hourly job failed.". */
  title: string;
  /** Plain text after the title: what failed, or what it stops. */
  detail?: string;
  /** When it last happened (the hourly job), shown with ui Time before the detail. */
  at?: number;
  fix: { href: string; label: string };
}

/** The health line under the instance block. */
export interface HealthSummary {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
  href: string;
  /** The rest of the link name for screen readers. */
  srSuffix: string;
}

/**
 * The checks behind the strip. They are the conditions of the error-level alerts keyring_unavailable,
 * schema_behind, config_problem and cron_failing, so the strip and the health line agree. `cron`
 * is null when the hourly job's state was not read.
 */
export interface StripInput {
  keyring: Pick<KeyringHealth, 'error'>;
  schema: AlertData['schema'];
  config: readonly ConfigProblem[];
  cron: CronHealth | null;
}

/**
 * The strip problems: a keyring that did not load, a database behind on migrations, each
 * configuration error, and a failing hourly job. The fix link is shown to every role: it is a
 * link to a page or a doc, and the target page applies its own RBAC.
 */
export function stripProblems(data: StripInput): HealthProblem[] {
  const problems: HealthProblem[] = [];
  if (data.keyring.error) {
    problems.push({
      title: 'Encryption keys are not loaded.',
      detail: `Token requests fail with 503 and secrets cannot change (${data.keyring.error}).`,
      fix: { href: paths.tokenKeys(), label: 'Open encryption keys' },
    });
  }
  for (const database of ['DB', 'TELEMETRY_DB'] as const) {
    if (data.schema[database] === 'behind') {
      problems.push({
        title: `Database ${database} is missing migrations.`,
        detail: `The newest is ${SCHEMA_HEAD[database]}.`,
        fix: { href: docsUrl('operations/upgrades.md'), label: 'How to apply migrations' },
      });
    }
  }
  // One problem per error (the alert joins them in one title), so "N more" stays right.
  for (const problem of data.config) {
    problems.push({
      title: `Configuration error in ${problem.variable}.`,
      detail: sentence(problem.message),
      fix: { href: docsUrl('configuration.md'), label: 'Configuration reference' },
    });
  }
  if (data.cron?.failing) {
    problems.push({
      title: 'The hourly job failed.',
      detail: sentence(data.cron.lastError ?? 'Unknown error'),
      at: data.cron.lastErrorAt ?? undefined,
      fix: { href: checkHref('maintenance'), label: 'Hourly job check' },
    });
  }
  return problems;
}

/** `text` ending with a full stop (error messages may or may not have one). */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The health line: errors link to the Overview health checks, warnings to Needs attention, and
 * notes (or nothing) say "Healthy". It never claims more than the alert catalogue checked.
 */
export function healthSummary(alerts: readonly Alert[]): HealthSummary {
  const count = (level: Alert['level']) => alerts.filter((alert) => alert.level === level).length;
  const errors = count('error');
  if (errors > 0) {
    return {
      tone: 'bad',
      text: `${plural(errors, 'problem', 'problems')} to fix`,
      href: paths.overview({ hash: 'health' }),
      srSuffix: '. Open Overview, Health',
    };
  }
  const warnings = count('warning');
  if (warnings > 0) {
    return {
      tone: 'warn',
      text: `${plural(warnings, 'warning', 'warnings')} to review`,
      href: paths.overview({ hash: 'attention' }),
      srSuffix: '. Open Overview, Needs attention',
    };
  }
  const notes = count('info');
  return {
    tone: 'ok',
    text: notes > 0 ? `Healthy · ${plural(notes, 'note', 'notes')}` : 'Healthy',
    href: paths.overview({ hash: 'health' }),
    srSuffix: '. Open Overview, Health',
  };
}

/**
 * The health line when the alert data did not load (a query failed): the strip problems that need
 * no table still count, and otherwise it says the checks did not run. It never says "Healthy".
 */
export function uncheckedHealth(problems: number): HealthSummary {
  if (problems > 0) {
    return {
      tone: 'bad',
      text: `${plural(problems, 'problem', 'problems')} to fix`,
      href: paths.overview({ hash: 'health' }),
      srSuffix: '. Open Overview, Health',
    };
  }
  return {
    tone: 'warn',
    text: 'Health not checked',
    href: paths.overview({ hash: 'health' }),
    srSuffix: '. The checks could not read the database. Open Overview, Health',
  };
}
