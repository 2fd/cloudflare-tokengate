// Admin pages: global access rules (ADR 0026, I-AUTHZ-5). A global access rule caps every credential access
// rule of its issuer key and never lets a request in by itself. Everyone who can sign in sees them
// (AR-16); changing them needs access_rules:global (Admins, Owners; AR-15). Every save goes through
// ops/global-access-rules.ts, which classifies the change for the issuer's ceiling (AR-21): a first
// ceiling or a widening re-renders the form with a confirmation that resubmits it, and the guards of
// the op keep the classification true at commit.
import { Button, Callout, PageHeader } from '@tokengate/ui';
import type { App } from '../../app';
import { listAuditEvents } from '../../db/audit';
import { labelFor, listClaimLabels } from '../../db/claim-labels';
import type { ClaimLabel, GlobalAccessRule } from '../../db/types';
import type { ProfileId } from '../../identity/types';
import { globalStatus } from '../../policy/global-status';
import { issuerKey } from '../../policy/limits';
import type { Condition, Rule } from '../../policy/types';
import { PROXY_METHODS } from '../../policy/types';
import { can } from '../auth/rbac';
import { type Connections, loadConnections } from '../connections';
import { type NoticeContext, type NoticeTable, resolveNotice } from '../notice';
import { type RuleLabel, ruleIssuer, tenantClaimOf } from '../ops/credential-access-rules';
import {
  createGlobalAccessRule,
  deleteGlobalAccessRule,
  type GlobalConfirmation,
  type GlobalRuleFailure,
  type GlobalRuleInput,
  setGlobalAccessRuleEnabled,
  updateGlobalAccessRule,
} from '../ops/global-access-rules';
import type { FieldError } from '../ops/shared';
import { paths, returnPath } from '../paths';
import {
  type AdminContext,
  adminActor,
  formData,
  redirectWithNotice,
  renderPage,
  submittedVersion,
} from '../render';
import { all, type Fields, flag, parseOwnerList, text } from '../rule-access';
import { parseValueList } from '../rule-text';
import { NotFound, notFoundText } from '../views/components';
import {
  blankGlobalForm,
  globalFormFromRule,
  type GlobalRuleForm,
  type GlobalRuleFormModel,
  GlobalRuleFormView,
  LIMIT_COLUMNS,
  type LimitColumn,
} from '../views/global-rule-form';
import {
  type AffectedRule,
  type GlobalListModel,
  GlobalRuleHeader,
  GlobalRulePage,
  type GlobalPageModel,
  GlobalRulesList,
  globalState,
  type GlobalStatusFilter,
} from '../views/global-rules';
import { LearnMore } from '../views/header';
import { ISSUER_TYPES } from '../views/issuer-fields';

const DAY_MS = 86_400_000;
const MAX_ROWS = 50;

export function registerGlobalAccessRulesRoutes(app: App): void {
  app.get('/admin/global-access-rules', listPage);
  app.get('/admin/global-access-rules/new', newPage);
  app.post('/admin/global-access-rules', create);
  app.get('/admin/global-access-rules/:id', detailPage);
  app.post('/admin/global-access-rules/:id', update);
  app.post('/admin/global-access-rules/:id/toggle', toggle);
  app.post('/admin/global-access-rules/:id/delete', remove);
}

const NOTICES: NoticeTable<NoticeContext> = {
  created: () => ({
    text: 'Global access rule saved. It caps the credential access rules of its issuer from the next request on.',
  }),
  updated: () => ({ text: 'Global access rule saved.' }),
  unchanged: () => ({ text: 'Nothing changed: the submitted values are the current ones.' }),
  enabled: () => ({ text: 'Global access rule enabled.' }),
  disabled: () => ({
    text: 'Global access rule disabled. It holds for no request, and it still caps its issuer.',
  }),
  deleted: () => ({ text: 'Global access rule deleted.' }),
  deleted_last: () => ({
    text: 'Global access rule deleted. Its issuer has no global access rule now: its credential access rules are not limited.',
  }),
};

function notice(c: AdminContext) {
  return resolveNotice(NOTICES, c.req.query('notice'), null, {});
}

// ---------------------------------------------------------------------------------------------
// List

async function listPage(c: AdminContext) {
  const deps = c.get('deps');
  const connections = await loadConnections(deps);
  const now = deps.now();
  const all_ = connections.globals;
  const query = (name: string) => c.req.query(name) ?? '';
  const notes: string[] = [];
  let issuer = query('issuer');
  if (issuer && !all_.some((rule) => rule.issuer_key === issuer)) {
    notes.push('No global access rule has that issuer.');
    issuer = '';
  }
  const status = (['enabled', 'disabled', 'expired'] as const).includes(
    query('status') as GlobalStatusFilter,
  )
    ? (query('status') as GlobalStatusFilter)
    : '';
  const rows = all_
    .filter((rule) => (issuer ? rule.issuer_key === issuer : true))
    .filter((rule) => (status ? globalState(rule, now) === status : true))
    .sort(
      (a, b) =>
        a.issuer_key.localeCompare(b.issuer_key) ||
        a.created_at - b.created_at ||
        a.id.localeCompare(b.id),
    )
    .map((global) => ({ global, affected: affectedRules(connections, global, now) }));
  const keys = new Set(all_.map((rule) => rule.issuer_key));
  const unlimited = new Map<string, GlobalListModel['unlimited'][number]>();
  for (const edge of connections.rules) {
    if (keys.has(edge.rule.issuer_key)) continue;
    const entry = unlimited.get(edge.rule.issuer_key) ?? {
      key: edge.rule.issuer_key,
      issuer: edge.rule.issuer,
      profile: edge.rule.profile,
      rules: 0,
    };
    entry.rules += 1;
    unlimited.set(edge.rule.issuer_key, entry);
  }
  const model: GlobalListModel = {
    all: all_,
    rows,
    issuer,
    status,
    unlimited: [...unlimited.values()],
    now,
  };
  const anyFilter = issuer !== '' || status !== '';
  return renderPage(
    c,
    {
      title: 'Global access rules',
      section: 'rules',
      subsection: 'global-rules',
      notice: notice(c),
      header: (ctx) => (
        <PageHeader
          title="Global access rules"
          count={anyFilter ? `${rows.length} of ${all_.length}` : all_.length}
          description={
            <>
              Ceilings on every credential access rule of an issuer. A global access rule never lets
              a workload in by itself.
              <LearnMore path="concepts.md#global-access-rule" about="global access rules" />
            </>
          }
          actions={
            ctx.can('access_rules:global') && all_.length > 0 ? (
              <Button variant="primary" plus href={paths.globalRuleNew()}>
                Add global access rule
              </Button>
            ) : undefined
          }
        />
      ),
    },
    (ctx) => (
      <>
        {notes.map((note) => (
          <Callout title={note} />
        ))}
        <GlobalRulesList model={model} ctx={ctx} />
      </>
    ),
  );
}

/** The credential access rules of a global rule's issuer key, with their status. */
function affectedRules(
  connections: Connections,
  global: GlobalAccessRule,
  now: number,
): AffectedRule[] {
  const siblings = connections.globals.filter((g) => g.issuer_key === global.issuer_key);
  return connections.rules
    .filter((edge) => edge.rule.issuer_key === global.issuer_key)
    .map((edge) => ({
      rule: edge.rule,
      credential: edge.credential,
      own: globalStatus(edge.rule, [global], now).kind,
      overall: globalStatus(edge.rule, siblings, now).kind,
    }));
}

// ---------------------------------------------------------------------------------------------
// Form

function readForm(fields: Fields, editing: GlobalAccessRule | null): GlobalRuleForm {
  const type = editing?.profile ?? text(fields, 'type');
  const cond: GlobalRuleForm['cond'] = [];
  const rule: GlobalRuleForm['rule'] = [];
  for (let index = 0; index < MAX_ROWS; index++) {
    const prefix = `cond.${index}.`;
    if (text(fields, `${prefix}remove`) === '') {
      const row = {
        claim: text(fields, `${prefix}claim`),
        match: text(fields, `${prefix}match`) || 'exact',
        not: flag(fields, `${prefix}not`),
        values: text(fields, `${prefix}values`),
      };
      if (row.claim.trim() !== '' || row.values.trim() !== '') cond.push(row);
    }
    const rulePrefix = `rule.${index}.`;
    if (text(fields, `${rulePrefix}remove`) === '') {
      const row = { m: all(fields, `${rulePrefix}m`), path: text(fields, `${rulePrefix}path`) };
      if (row.path.trim() !== '' || row.m.length > 0) rule.push(row);
    }
  }
  return {
    type: ISSUER_TYPES.includes(type as ProfileId) ? type : 'github-actions',
    issuer: editing?.issuer ?? text(fields, 'issuer'),
    name: text(fields, 'name'),
    description: text(fields, 'description'),
    limits: Object.fromEntries(
      LIMIT_COLUMNS.map((column) => [column, flag(fields, `limit.${column}`)]),
    ) as Record<LimitColumn, boolean>,
    tenants: text(fields, type === 'gitlab-ci' ? 'tenants.gitlab' : 'tenants.github'),
    pin_claim: text(fields, 'pin_claim'),
    pin_values: text(fields, 'pin_values'),
    cond,
    rule,
    anchor_claims: text(fields, 'anchor_claims'),
    audience: text(fields, 'audience'),
    jwks_uri: text(fields, 'jwks_uri'),
    allowed_algs: all(fields, 'allowed_algs'),
    max_token_age_seconds: text(fields, 'max_token_age_seconds'),
    expires_on: text(fields, 'expires_on'),
    enabled: editing ? editing.enabled : flag(fields, 'enabled'),
  };
}

/** The op input of the form, or its field errors. Unticked limits are null (no limit). */
function parseForm(
  form: GlobalRuleForm,
  now: number,
  editing: GlobalAccessRule | null,
): { ok: true; input: GlobalRuleInput } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const type = form.type as ProfileId;
  const on = (column: LimitColumn) => form.limits[column];
  let tenantPin: Condition[] | null = null;
  const labels: RuleLabel[] = [];
  if (on('tenant_pin')) {
    const claim = tenantClaimOf(type);
    if (claim !== null) {
      const field = type === 'gitlab-ci' ? 'tenants.gitlab' : 'tenants.github';
      const parsed = parseOwnerList(form.tenants, { id: type });
      if (!parsed.ok) errors.push({ field, message: parsed.message });
      else {
        tenantPin = [{ claim, match: 'exact', values: parsed.entries.map((entry) => entry.id) }];
        labels.push(
          ...parsed.entries.map((entry) => ({ claim, value: entry.id, label: entry.label })),
        );
      }
    } else {
      const claimName = form.pin_claim.trim();
      const values = parseValueList(form.pin_values);
      if (claimName === '') {
        errors.push({ field: 'pin_claim', message: 'Enter the claim name, like organization_id.' });
      } else if (!values.ok || values.values.length === 0) {
        errors.push({
          field: 'pin_values',
          message: values.ok ? `Enter at least one value of ${claimName}.` : values.error,
        });
      } else {
        tenantPin = [{ claim: claimName, match: 'exact', values: values.values }];
      }
    }
  }
  let conditions: Condition[] | null = null;
  if (on('conditions')) {
    conditions = [];
    form.cond.forEach((row, index) => {
      const field = (key: string) => `cond.${index}.${key}`;
      const values = parseValueList(row.values);
      if (row.claim.trim() === '') {
        errors.push({ field: field('claim'), message: 'Enter the claim name.' });
      } else if (!values.ok || values.values.length === 0) {
        errors.push({
          field: field('values'),
          message: values.ok ? `Enter at least one value for ${row.claim}.` : values.error,
        });
      } else {
        const condition: Condition = {
          claim: row.claim.trim(),
          match: row.match === 'glob' ? 'glob' : 'exact',
          values: values.values,
        };
        if (row.not) condition.negate = true;
        conditions?.push(condition);
      }
    });
    if (conditions.length === 0 && !errors.some((e) => e.field?.startsWith('cond.'))) {
      errors.push({
        field: 'cond.0.claim',
        message: 'Enter at least one condition, or untick Limit jobs.',
      });
    }
  }
  let rules: Rule[] | null = null;
  if (on('rules')) {
    rules = [];
    form.rule.forEach((row, index) => {
      const methods = row.m.filter(
        (m): m is Rule['methods'][number] =>
          m === '*' || (PROXY_METHODS as readonly string[]).includes(m),
      );
      if (methods.length === 0) {
        errors.push({ field: `rule.${index}.m`, message: 'Tick at least one method.' });
      } else if (row.path.trim() === '') {
        errors.push({
          field: `rule.${index}.path`,
          message: 'Enter the path, like /chat.postMessage.',
        });
      } else {
        rules?.push({ methods, path: row.path.trim() });
      }
    });
    if (rules.length === 0 && !errors.some((e) => e.field?.startsWith('rule.'))) {
      errors.push({
        field: 'rule.0.path',
        message: 'Enter at least one operation, or untick Limit operations.',
      });
    }
  }
  const anchors = on('anchor_claims')
    ? form.anchor_claims
        .split(',')
        .map((claim) => claim.trim())
        .filter((claim) => claim !== '')
    : null;
  let maxAge: number | null = null;
  if (on('max_token_age_seconds')) {
    const raw = form.max_token_age_seconds.trim();
    if (!/^[0-9]{1,7}$/.test(raw)) {
      errors.push({
        field: 'max_token_age_seconds',
        message: 'Enter the maximum token age in whole seconds, like 300.',
      });
    } else maxAge = Number(raw);
  }
  let expiresAt: number | null = null;
  const day = form.expires_on.trim();
  if (day !== '') {
    const stored =
      editing?.expires_at != null ? new Date(editing.expires_at).toISOString().slice(0, 10) : null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    const ms = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
    if (stored !== null && editing?.expires_at != null && day === stored) {
      expiresAt = editing.expires_at;
    } else if (!match || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) {
      errors.push({ field: 'expires_on', message: 'Use a date like 2027-01-31.' });
    } else if (ms + DAY_MS <= now) {
      errors.push({ field: 'expires_on', message: 'Choose a day from today on.' });
    } else {
      expiresAt = ms + DAY_MS;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: {
      name: form.name,
      description: form.description,
      profile: type,
      issuer: form.issuer.trim(),
      jwks_uri: on('jwks_uri') ? form.jwks_uri.trim() : null,
      audience: on('audience') ? form.audience.trim() : null,
      allowed_algs: on('allowed_algs') ? form.allowed_algs : null,
      max_token_age_seconds: maxAge,
      tenant_pin: tenantPin,
      anchor_claims: anchors,
      conditions,
      rules,
      enabled: form.enabled,
      expires_at: expiresAt,
      labels,
    },
  };
}

/** The field an op or validator error belongs to. */
function errorField(message: string): string | null {
  const lower = message.toLowerCase();
  if (lower.startsWith('name')) return 'name';
  if (lower.startsWith('description')) return 'description';
  if (
    lower.startsWith('issuer') ||
    lower.startsWith('write the issuer') ||
    lower.includes('issuers on')
  ) {
    return 'issuer';
  }
  if (lower.startsWith('audience')) return 'audience';
  if (lower.startsWith('jwks uri')) return 'jwks_uri';
  if (lower.includes('signing algorithm')) return 'allowed_algs';
  if (lower.includes('maximum token age')) return 'max_token_age_seconds';
  if (lower.startsWith('tenant pin')) return 'pin_claim';
  if (lower.startsWith('anchor claim')) return 'anchor_claims';
  if (lower.startsWith('condition')) return 'cond.0.claim';
  if (lower.startsWith('operations') || lower.startsWith('rule ')) return 'rule.0.path';
  if (lower.startsWith('expiry')) return 'expires_on';
  return null;
}

function failureErrors(failure: GlobalRuleFailure): FieldError[] {
  return failure.errors.map((message) => ({ field: errorField(message), message }));
}

interface FormState {
  form: GlobalRuleForm;
  errors: FieldError[];
  confirm: { kind: GlobalConfirmation; text: string } | null;
}

async function formModel(
  c: AdminContext,
  state: FormState,
  editing: GlobalAccessRule | null,
  connections: Connections,
): Promise<GlobalRuleFormModel> {
  const issuer =
    editing?.issuer ?? ruleIssuer(state.form.type as ProfileId, state.form.issuer || undefined);
  const key = issuer ? issuerKey(issuer) : '';
  return {
    action: editing ? paths.globalRule(editing.id) : paths.globalRules(),
    csrf: c.get('viewer').csrfToken,
    mode: editing ? 'edit' : 'create',
    ...(editing ? { version: String(editing.updated_at) } : {}),
    form: state.form,
    errors: state.errors,
    siblings: connections.globals.filter((g) => g.issuer_key === key && g.id !== editing?.id),
    ruleCount: key ? connections.rules.filter((edge) => edge.rule.issuer_key === key).length : null,
    confirm: state.confirm,
    cancelHref: editing ? paths.globalRule(editing.id) : paths.globalRules(),
  };
}

async function renderNew(c: AdminContext, state: FormState, status: 200 | 409 | 422 = 200) {
  const connections = await loadConnections(c.get('deps'));
  const model = await formModel(c, state, null, connections);
  return renderPage(
    c,
    {
      title: 'Add global access rule',
      section: 'rules',
      subsection: 'global-rules',
      errors: state.errors,
      errorSummary:
        state.errors.length > 0 ? { title: 'The global access rule was not saved' } : undefined,
      status,
      header: (
        <PageHeader
          crumbs={[
            { label: 'Global access rules', href: paths.globalRules() },
            { label: 'Add global access rule' },
          ]}
          title="Add global access rule"
          description="A ceiling on every credential access rule of one issuer. Tick only what you limit."
        />
      ),
    },
    () => <GlobalRuleFormView model={model} />,
  );
}

async function newPage(c: AdminContext) {
  const type = c.req.query('type') ?? '';
  const issuer = (c.req.query('issuer') ?? '').slice(0, 2048);
  const form = blankGlobalForm(
    (ISSUER_TYPES as readonly string[]).includes(type) ? type : null,
    issuer,
  );
  return renderNew(c, { form, errors: [], confirm: null });
}

async function create(c: AdminContext) {
  const deps = c.get('deps');
  const fields = await formData(c);
  const form = readForm(fields, null);
  const parsed = parseForm(form, deps.now(), null);
  if (!parsed.ok) return renderNew(c, { form, errors: parsed.errors, confirm: null }, 422);
  const result = await createGlobalAccessRule(deps, adminActor(c), {
    ...parsed.input,
    confirm_new_ceiling: flag(fields, 'confirm_new_ceiling'),
    confirm_widening: flag(fields, 'confirm_widening'),
  });
  if (result.ok) return redirectWithNotice(c, paths.globalRule(result.rule.id), 'created');
  if (result.confirm) {
    return renderNew(
      c,
      { form, errors: [], confirm: { kind: result.confirm, text: result.errors[0] ?? '' } },
      422,
    );
  }
  return renderNew(
    c,
    { form, errors: failureErrors(result), confirm: null },
    result.reason === 'conflict' ? 409 : 422,
  );
}

// ---------------------------------------------------------------------------------------------
// Detail

async function loadGlobal(c: AdminContext) {
  const connections = await loadConnections(c.get('deps'));
  const rule = connections.globals.find((g) => g.id === (c.req.param('id') ?? ''));
  return rule ? { rule, connections } : null;
}

interface DetailState {
  edit?: FormState;
  errors?: FieldError[];
  status?: 200 | 400 | 409 | 422;
}

async function renderDetail(
  c: AdminContext,
  loaded: NonNullable<Awaited<ReturnType<typeof loadGlobal>>>,
  state: DetailState,
) {
  const { rule, connections } = loaded;
  const deps = c.get('deps');
  const labels: ClaimLabel[] = await listClaimLabels(deps.env.DB, rule.id);
  const tenantLabels = new Map(
    labels
      .filter((label) => label.claim === tenantClaimOf(rule.profile))
      .map((label) => [label.value, label.label]),
  );
  const events = await listAuditEvents(deps.env.DB, { targetId: rule.id, limit: 5 });
  const editing =
    state.edit ??
    (c.req.query('open') === 'edit'
      ? {
          form: globalFormFromRule(rule, (value) =>
            labelFor(labels, tenantClaimOf(rule.profile) ?? '', value),
          ),
          errors: [],
          confirm: null,
        }
      : undefined);
  const viewer = c.get('viewer');
  const mayEdit = viewer !== undefined && can(viewer.user.role, 'access_rules:global');
  const model: GlobalPageModel = {
    rule,
    siblings: connections.globals.filter(
      (g) => g.issuer_key === rule.issuer_key && g.id !== rule.id,
    ),
    affected: affectedRules(connections, rule, deps.now()),
    tenantLabels,
    history: events.map((event) => ({
      ts: event.ts,
      actor: event.actor_email ?? (event.actor_type === 'system' ? 'tokengate' : 'Someone'),
      summary: event.summary,
    })),
    edit: editing && mayEdit ? await formModel(c, editing, rule, connections) : null,
    editOpen: editing !== undefined,
  };
  const errors = [...(state.errors ?? []), ...(editing?.errors ?? [])];
  return renderPage(
    c,
    {
      title: rule.name,
      section: 'rules',
      subsection: 'global-rules',
      errors,
      status: state.status ?? 200,
      notice: errors.length > 0 ? null : notice(c),
      header: (ctx) => <GlobalRuleHeader model={model} ctx={ctx} />,
    },
    (ctx) => <GlobalRulePage model={model} ctx={ctx} />,
  );
}

async function detailPage(c: AdminContext) {
  const loaded = await loadGlobal(c);
  if (!loaded) return notFound(c);
  return renderDetail(c, loaded, {});
}

async function update(c: AdminContext) {
  const deps = c.get('deps');
  const loaded = await loadGlobal(c);
  if (!loaded) return notFound(c);
  const { rule } = loaded;
  const fields = await formData(c);
  const form = readForm(fields, rule);
  const parsed = parseForm(form, deps.now(), rule);
  if (!parsed.ok) {
    return renderDetail(c, loaded, {
      edit: { form, errors: parsed.errors, confirm: null },
      status: 422,
    });
  }
  const version = submittedVersion(text(fields, 'expected_updated_at'));
  const { profile: _profile, ...changes } = parsed.input;
  const result = await updateGlobalAccessRule(deps, adminActor(c), rule.id, {
    ...changes,
    confirm_widening: flag(fields, 'confirm_widening'),
    ...(version === undefined ? {} : { expected_updated_at: version }),
  });
  if (result.ok) {
    return redirectWithNotice(
      c,
      paths.globalRule(rule.id),
      result.changed === false ? 'unchanged' : 'updated',
    );
  }
  if (result.reason === 'not_found') return notFound(c);
  return renderDetail(c, loaded, {
    edit: {
      form,
      errors: result.confirm ? [] : failureErrors(result),
      confirm: result.confirm ? { kind: result.confirm, text: result.errors[0] ?? '' } : null,
    },
    status: result.reason === 'conflict' ? 409 : 422,
  });
}

async function toggle(c: AdminContext) {
  const id = c.req.param('id') ?? '';
  const fields = await formData(c);
  const enabled = flag(fields, 'enabled');
  const version = submittedVersion(text(fields, 'expected_updated_at'));
  const result = await setGlobalAccessRuleEnabled(c.get('deps'), adminActor(c), id, enabled, {
    confirm_widening: flag(fields, 'confirm_widening'),
    confirm_last_disable: flag(fields, 'confirm_last_disable'),
    ...(version === undefined ? {} : { expected_updated_at: version }),
  });
  if (result.ok) {
    const back = returnPath('POST /admin/global-access-rules/:id/toggle', fields._return, { id });
    return redirectWithNotice(c, back, enabled ? 'enabled' : 'disabled');
  }
  return rerender(c, result);
}

async function remove(c: AdminContext) {
  const fields = await formData(c);
  if (!flag(fields, 'confirm')) {
    const loaded = await loadGlobal(c);
    if (!loaded) return notFound(c);
    return renderDetail(c, loaded, {
      errors: [{ field: null, message: 'Confirm the deletion in the Delete dialog.' }],
      status: 400,
    });
  }
  const version = submittedVersion(text(fields, 'expected_updated_at'));
  const result = await deleteGlobalAccessRule(
    c.get('deps'),
    adminActor(c),
    c.req.param('id') ?? '',
    {
      confirm_widening: flag(fields, 'confirm_widening'),
      ...(version === undefined ? {} : { expected_updated_at: version }),
    },
  );
  if (result.ok) {
    return redirectWithNotice(c, paths.globalRules(), result.last ? 'deleted_last' : 'deleted');
  }
  return rerender(c, result);
}

async function rerender(c: AdminContext, failure: GlobalRuleFailure) {
  const loaded = await loadGlobal(c);
  if (!loaded || failure.reason === 'not_found') return notFound(c);
  return renderDetail(c, loaded, {
    errors: failure.errors.map((message) => ({ field: null, message })),
    status: failure.reason === 'conflict' ? 409 : 422,
  });
}

function notFound(c: AdminContext) {
  return renderPage(
    c,
    {
      title: 'Global access rule not found',
      section: 'rules',
      subsection: 'global-rules',
      status: 404,
      header: (
        <PageHeader
          crumbs={[
            { href: paths.globalRules(), label: 'Global access rules' },
            { label: 'Not found' },
          ]}
          title="Global access rule not found"
          description={notFoundText('global')}
        />
      ),
    },
    () => <NotFound />,
  );
}
