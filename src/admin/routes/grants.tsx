// Admin pages: grants. Mutations go through ops/grants.ts (validateGrant: anchors I-AUTHZ-2, tenant
// pin containment, event guard I-AUTHZ-3; audit I-AUDIT-1). A warning acknowledgement counts only
// for the exact warning set shown. Prefill from a request uses verified records only (I-LOG-2).
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { App } from '../../app';
import { sha256Hex } from '../../crypto/hash';
import { getCallerProvider, listCallerProviders } from '../../db/caller-providers';
import { getGrant, listGrants } from '../../db/grants';
import { getRequest } from '../../db/requests';
import { getService, listServices } from '../../db/services';
import type { CallerProvider, Grant, Service } from '../../db/types';
import { getProfile } from '../../identity/profiles';
import type { IssuerProfile } from '../../identity/types';
import { parseJson } from '../../lib/json';
import { claimText } from '../../policy/conditions';
import { type GithubPresetContext, githubGrantPreset } from '../../policy/presets';
import type { Condition, Rule } from '../../policy/types';
import { validateGrant } from '../../policy/validate';
import { can } from '../auth/rbac';
import {
  CONDITION_SYNTAX,
  eventSummary,
  formatConditions,
  formatRules,
  parseConditions,
  parseRules,
  RULE_SYNTAX,
} from '../grant-text';
import { createGrant, deleteGrant, setGrantEnabled, updateGrant } from '../ops/grants';
import type { OpFailure } from '../ops/shared';
import {
  type AdminContext,
  adminActor,
  type FormFields,
  formData,
  redirectWithNotice,
  renderPage,
  submittedVersion,
} from '../render';
import { SERVICE_TEMPLATES } from '../service-templates';
import {
  ActionButton,
  Badge,
  Checkbox,
  Csrf,
  Details,
  EmptyState,
  EnabledBadge,
  Field,
  Messages,
  Pre,
  Select,
  TextArea,
  VersionField,
} from '../views/components';
import { formatTime, withQuery } from '../views/format';

const SECTION = '/admin/grants';

const NOTICES: Record<string, string> = {
  created: 'Grant created. Matching callers can use the service from the next request on.',
  updated: 'Grant saved.',
  unchanged: 'Nothing changed: the submitted values are the current ones.',
  enabled: 'Grant enabled.',
  disabled: 'Grant disabled. It stops matching from the next request on.',
  deleted: 'Grant deleted.',
};

/**
 * Denial reasons a grant could fix; other records cannot prefill a grant. Keep in sync with
 * GRANT_FIXABLE in requests.tsx.
 */
const PREFILL_REASONS: readonly string[] = ['no_matching_grant', 'event_not_trusted'];

const PRESET_CONTEXTS: Array<{ value: GithubPresetContext; label: string }> = [
  { value: 'branch', label: 'Branch: pushes, manual runs and schedules on a branch' },
  { value: 'tag', label: 'Tag: pushes of a tag' },
  { value: 'release', label: 'Release: published releases' },
  { value: 'pr', label: 'Pull request: jobs for pull requests into a branch' },
  { value: 'environment', label: 'Environment: jobs that deploy to a GitHub environment' },
];

/** Claims copied from a request record besides the anchors, per profile. */
const PREFILL_EXTRA_CLAIMS: Record<string, string[]> = {
  'github-actions': ['ref', 'event_name', 'environment'],
  'gitlab-ci': ['ref', 'pipeline_source', 'environment'],
  generic: [],
};

export function registerGrantsRoutes(app: App): void {
  app.get('/admin/grants', listPage);
  app.get('/admin/grants/new', newPage);
  app.post('/admin/grants', create);
  app.get('/admin/grants/:id', detailPage);
  app.post('/admin/grants/:id', update);
  app.post('/admin/grants/:id/toggle', toggle);
  app.post('/admin/grants/:id/delete', remove);
}

// ---------------------------------------------------------------------------------------------
// Form state

type Mode = 'preset' | 'advanced';

/** Raw form values, kept as text so a rejected form is re-shown exactly as submitted. */
interface GrantForm {
  mode: Mode;
  name: string;
  description: string;
  /** `YYYY-MM-DDTHH:MM`, UTC; empty = never. */
  expires_at: string;
  enabled: boolean;
  conditions_text: string;
  rules_text: string;
  owner_id: string;
  repository_ids: string;
  context: GithubPresetContext;
  pattern: string;
  require_protected_ref: boolean;
  require_github_hosted: boolean;
  workflow_ref: string;
  /** `updated_at` the edit form was opened at; empty on create. */
  expected_updated_at: string;
}

interface Target {
  provider: CallerProvider;
  profile: IssuerProfile;
  service: Service;
}

function blankForm(target: Target, mode: Mode): GrantForm {
  const pinned = singlePinValue(target.provider);
  return {
    mode,
    name: '',
    description: '',
    expires_at: '',
    enabled: true,
    conditions_text: pinned ? formatConditions([exact(pinned.claim, [pinned.value])]) : '',
    rules_text: starterRules(target.service),
    owner_id: target.profile.id === 'github-actions' ? (pinned?.value ?? '') : '',
    repository_ids: '',
    context: 'branch',
    pattern: 'main',
    require_protected_ref: true,
    require_github_hosted: false,
    workflow_ref: '',
    expected_updated_at: '',
  };
}

function grantForm(grant: Grant): GrantForm {
  return {
    mode: 'advanced',
    name: grant.name,
    description: grant.description,
    expires_at: grant.expires_at === null ? '' : toDateTimeLocal(grant.expires_at),
    enabled: grant.enabled,
    conditions_text: formatConditions(grant.conditions),
    rules_text: formatRules(grant.rules),
    owner_id: '',
    repository_ids: '',
    context: 'branch',
    pattern: '',
    require_protected_ref: true,
    require_github_hosted: false,
    workflow_ref: '',
    expected_updated_at: String(grant.updated_at),
  };
}

function submittedForm(fields: FormFields, profile: IssuerProfile | null): GrantForm {
  const context = text(fields, 'context');
  return {
    mode:
      text(fields, 'mode') === 'preset' && profile?.id === 'github-actions' ? 'preset' : 'advanced',
    name: text(fields, 'name'),
    description: text(fields, 'description'),
    expires_at: text(fields, 'expires_at').trim(),
    enabled: flag(fields, 'enabled'),
    conditions_text: text(fields, 'conditions_text'),
    rules_text: text(fields, 'rules_text'),
    owner_id: text(fields, 'owner_id'),
    repository_ids: text(fields, 'repository_ids'),
    context: PRESET_CONTEXTS.some((option) => option.value === context)
      ? (context as GithubPresetContext)
      : 'branch',
    pattern: text(fields, 'pattern'),
    require_protected_ref: flag(fields, 'require_protected_ref'),
    require_github_hosted: flag(fields, 'require_github_hosted'),
    workflow_ref: text(fields, 'workflow_ref'),
    expected_updated_at: text(fields, 'expected_updated_at'),
  };
}

/** Grant content from the form, or the reasons it cannot be built. */
interface Built {
  errors: string[];
  /** Warnings from the GitHub builder (validateGrant adds its own). */
  presetWarnings: string[];
  conditions: Condition[] | null;
  rules: Rule[] | null;
  expiresAt: number | null;
}

function buildGrant(form: GrantForm): Built {
  const errors: string[] = [];
  let presetWarnings: string[] = [];
  let conditions: Condition[] | null = null;
  if (form.mode === 'preset') {
    const preset = githubGrantPreset({
      ownerId: form.owner_id,
      repositoryIds: form.repository_ids.split(/[\s,]+/),
      context: form.context,
      pattern: form.pattern,
      requireProtectedRef: form.require_protected_ref,
      requireGithubHosted: form.require_github_hosted,
      workflowRef: form.workflow_ref.trim() || null,
    });
    errors.push(...preset.errors);
    presetWarnings = preset.warnings;
    if (preset.errors.length === 0) conditions = preset.conditions;
  } else {
    const parsed = parseConditions(form.conditions_text);
    if (parsed.ok) conditions = parsed.conditions;
    else errors.push(...parsed.errors);
  }
  const rules = parseRules(form.rules_text);
  if (!rules.ok) errors.push(...rules.errors);
  const expires = parseExpiry(form.expires_at);
  if (!expires.ok) errors.push(expires.error);
  return {
    errors,
    presetWarnings,
    conditions,
    rules: rules.ok ? rules.rules : null,
    expiresAt: expires.ok ? expires.value : null,
  };
}

/**
 * Warnings for the grant and whether the operator acknowledged exactly these warnings: the form
 * carries a digest of the warnings it showed, so editing the grant after ticking the box (which
 * may produce new warnings) asks again.
 */
async function acknowledgement(
  fields: FormFields,
  warnings: string[],
): Promise<{ acknowledged: boolean; digest: string }> {
  const digest = await sha256Hex(JSON.stringify(warnings));
  const acknowledged =
    warnings.length === 0 ||
    (flag(fields, 'acknowledge_warnings') && text(fields, 'warnings_digest') === digest);
  return { acknowledged, digest };
}

// ---------------------------------------------------------------------------------------------
// Handlers

async function listPage(c: AdminContext) {
  const db = c.get('deps').env.DB;
  const serviceFilter = c.req.query('service') || undefined;
  const providerFilter = c.req.query('caller_provider') || undefined;
  const [grants, providers, services] = await Promise.all([
    listGrants(db, { service_id: serviceFilter, caller_provider_id: providerFilter }),
    listCallerProviders(db),
    listServices(db),
  ]);
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const serviceById = new Map(services.map((service) => [service.id, service]));
  const canWrite = can(c.get('viewer').user.role, 'config:write');
  const now = c.get('deps').now();
  const filtered = serviceFilter !== undefined || providerFilter !== undefined;

  return renderPage(
    c,
    { title: 'Grants', section: SECTION, notice: noticeText(c) },
    <>
      <p class="muted">
        A grant lets callers of one caller provider whose token claims match its conditions call one
        service, for the methods and paths in its rules. Anything no grant allows is refused.
      </p>
      {canWrite ? (
        <p class="actions">
          <a
            href={withQuery(`${SECTION}/new`, {
              caller_provider: providerFilter,
              service: serviceFilter,
            })}
          >
            Create a grant
          </a>
        </p>
      ) : null}
      <form method="get" action={SECTION} class="filters">
        <Select
          label="Service"
          name="service"
          value={serviceFilter ?? ''}
          options={[
            { value: '', label: 'All services' },
            ...services.map((service) => ({ value: service.id, label: service.name })),
          ]}
        />
        <Select
          label="Caller provider"
          name="caller_provider"
          value={providerFilter ?? ''}
          options={[
            { value: '', label: 'All caller providers' },
            ...providers.map((provider) => ({ value: provider.id, label: provider.name })),
          ]}
        />
        <button type="submit" class="secondary">
          Filter
        </button>
      </form>
      {grants.length === 0 ? (
        <EmptyState>
          {filtered
            ? 'No grants match these filters. '
            : 'No grants yet, so every caller is refused. '}
          {canWrite ? <NextStep providers={providers} services={services} /> : null}
        </EmptyState>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Caller provider</th>
              <th>Service</th>
              <th>Conditions</th>
              <th>Rules</th>
              <th>Status</th>
              <th>Expires</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((grant) => (
              <tr>
                <td>
                  <a href={`${SECTION}/${grant.id}`}>{grant.name}</a>
                </td>
                <td>
                  {providerById.get(grant.caller_provider_id)?.name ?? (
                    <code>{grant.caller_provider_id}</code>
                  )}
                </td>
                <td>
                  {serviceById.get(grant.service_id)?.name ?? <code>{grant.service_id}</code>}
                </td>
                <td>
                  <code>{summarizeConditions(grant.conditions)}</code>
                </td>
                <td>{grant.rules.length}</td>
                <td>
                  <GrantStatus grant={grant} now={now} />
                </td>
                <td>{grant.expires_at === null ? 'never' : formatTime(grant.expires_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>,
  );
}

async function newPage(c: AdminContext) {
  const db = c.get('deps').env.DB;
  const duplicateOf = c.req.query('duplicate');
  if (duplicateOf) {
    const source = await getGrant(db, duplicateOf);
    const target = source
      ? await loadTarget(c, source.caller_provider_id, source.service_id)
      : null;
    if (!source || !target) return notFound(c);
    const form = grantForm(source);
    form.name = `${source.name} (copy)`.slice(0, 100);
    return renderCreateForm(c, target, form, {
      info: `Copy of “${source.name}”. Review it and save to create a new grant.`,
    });
  }

  const fromRequest = c.req.query('from_request');
  if (fromRequest) return prefillFromRequest(c, fromRequest);

  const providerId = c.req.query('caller_provider') ?? '';
  const serviceId = c.req.query('service') ?? '';
  const target = providerId && serviceId ? await loadTarget(c, providerId, serviceId) : null;
  if (!target) return renderChooser(c, providerId, serviceId);
  const mode: Mode =
    target.profile.id === 'github-actions' && c.req.query('mode') !== 'advanced'
      ? 'preset'
      : 'advanced';
  return renderCreateForm(c, target, blankForm(target, mode), {});
}

async function create(c: AdminContext) {
  const fields = await formData(c);
  const target = await loadTarget(
    c,
    text(fields, 'caller_provider_id'),
    text(fields, 'service_id'),
  );
  if (!target) {
    return renderChooser(c, text(fields, 'caller_provider_id'), text(fields, 'service_id'), 422, [
      'Choose an existing caller provider and service.',
    ]);
  }
  const form = submittedForm(fields, target.profile);
  const built = buildGrant(form);
  if (built.errors.length > 0 || !built.conditions || !built.rules) {
    return renderCreateForm(c, target, form, { errors: built.errors }, 422, built.conditions);
  }
  const validation = validateGrant(
    { conditions: built.conditions, rules: built.rules },
    target.profile,
    target.provider,
    target.service,
  );
  const warnings = [...built.presetWarnings, ...validation.warnings];
  const ack = await acknowledgement(fields, warnings);
  if (validation.errors.length === 0 && !ack.acknowledged) {
    return renderCreateForm(
      c,
      target,
      form,
      { warnings, digest: ack.digest },
      422,
      built.conditions,
    );
  }

  const result = await createGrant(c.get('deps'), adminActor(c), {
    name: form.name,
    description: form.description,
    caller_provider_id: target.provider.id,
    service_id: target.service.id,
    conditions: built.conditions,
    rules: built.rules,
    enabled: form.enabled,
    expires_at: built.expiresAt,
    acknowledge_warnings: ack.acknowledged,
  });
  if (result.ok) return redirectWithNotice(c, `${SECTION}/${result.grant.id}`, 'created');
  return renderCreateForm(
    c,
    target,
    form,
    { ...failureMessages(result, warnings), digest: ack.digest },
    failureStatus(result),
    built.conditions,
  );
}

async function detailPage(c: AdminContext) {
  const loaded = await loadGrant(c);
  if (!loaded) return notFound(c);
  return renderDetail(c, loaded.grant, loaded.target, {});
}

async function update(c: AdminContext) {
  const loaded = await loadGrant(c);
  if (!loaded) return notFound(c);
  const { grant, target } = loaded;
  const fields = await formData(c);
  const form = { ...submittedForm(fields, null), enabled: grant.enabled };
  const built = buildGrant(form);
  if (built.errors.length > 0 || !built.conditions || !built.rules) {
    return renderEditPage(c, grant, target, form, { errors: built.errors }, 422, built.conditions);
  }
  const validation = validateGrant(
    { conditions: built.conditions, rules: built.rules },
    target.profile,
    target.provider,
    target.service,
  );
  const ack = await acknowledgement(fields, validation.warnings);
  if (validation.errors.length === 0 && !ack.acknowledged) {
    return renderEditPage(
      c,
      grant,
      target,
      form,
      { warnings: validation.warnings, digest: ack.digest },
      422,
      built.conditions,
    );
  }

  const result = await updateGrant(c.get('deps'), adminActor(c), grant.id, {
    name: form.name,
    description: form.description,
    conditions: built.conditions,
    rules: built.rules,
    expires_at: built.expiresAt,
    acknowledge_warnings: ack.acknowledged,
    expected_updated_at: submittedVersion(form.expected_updated_at),
  });
  if (result.ok) {
    return redirectWithNotice(
      c,
      `${SECTION}/${grant.id}`,
      result.changed === false ? 'unchanged' : 'updated',
    );
  }
  if (result.reason === 'not_found') return notFound(c);
  return renderEditPage(
    c,
    grant,
    target,
    form,
    { ...failureMessages(result, validation.warnings), digest: ack.digest },
    failureStatus(result),
    built.conditions,
  );
}

async function toggle(c: AdminContext) {
  const id = c.req.param('id') ?? '';
  const enabled = flag(await formData(c), 'enabled');
  const result = await setGrantEnabled(c.get('deps'), adminActor(c), id, enabled);
  if (result.ok) return redirectWithNotice(c, `${SECTION}/${id}`, enabled ? 'enabled' : 'disabled');
  return rerenderDetail(c, result);
}

async function remove(c: AdminContext) {
  if (!flag(await formData(c), 'confirm')) {
    const loaded = await loadGrant(c);
    if (!loaded) return notFound(c);
    return renderDetail(
      c,
      loaded.grant,
      loaded.target,
      { errors: ['Tick the confirmation box to delete the grant.'] },
      400,
    );
  }
  const result = await deleteGrant(c.get('deps'), adminActor(c), c.req.param('id') ?? '');
  if (result.ok) return redirectWithNotice(c, SECTION, 'deleted');
  return rerenderDetail(c, result);
}

async function rerenderDetail(c: AdminContext, failure: OpFailure) {
  const loaded = await loadGrant(c);
  if (!loaded || failure.reason === 'not_found') return notFound(c);
  return renderDetail(
    c,
    loaded.grant,
    loaded.target,
    failureMessages(failure, failure.warnings),
    failureStatus(failure),
  );
}

/** `?from_request=`: a new grant matching exactly the caller of a denied, verified request. */
async function prefillFromRequest(c: AdminContext, requestId: string) {
  const deps = c.get('deps');
  const record = await getRequest(deps.env.TELEMETRY_DB, requestId);
  const claims = record ? parseJson(record.caller_claims) : null;
  const usable =
    record !== null &&
    record.claims_verified === 1 &&
    record.reason !== null &&
    PREFILL_REASONS.includes(record.reason) &&
    record.caller_provider_id !== null &&
    record.service_id !== null &&
    isRecord(claims);
  const target =
    usable && record.caller_provider_id && record.service_id
      ? await loadTarget(c, record.caller_provider_id, record.service_id)
      : null;
  if (!usable || !target || !isRecord(claims)) {
    return renderPage(
      c,
      { title: 'Cannot create a grant from this request', section: SECTION, status: 400 },
      <>
        <p>
          Only requests that were denied with “no matching grant” or “event not trusted”, whose
          token was verified, and whose caller provider and service still exist can prefill a grant.
        </p>
        <p>
          <a href={`${SECTION}/new`}>Create a grant from scratch</a>
        </p>
      </>,
    );
  }

  const conditions = prefillConditions(target, claims);
  const form = blankForm(target, 'advanced');
  form.conditions_text = formatConditions(conditions);
  // Rule paths have no escape syntax: a "*" in the call's path would become a wildcard, and a
  // "%2F" path is matched only through "**" (src/policy/evaluate.ts). Neither gets a prefilled rule.
  const literalPath = !/\*|%2f/i.test(record.path);
  form.rules_text = literalPath ? `${record.method} ${record.path}` : '';
  const who =
    claimText(claims, 'repository') ??
    claimText(claims, 'project_path') ??
    claimText(claims, 'sub');
  form.name = `${target.service.name} for ${who ?? 'caller'}`.slice(0, 100);
  const callerText = `Prefilled from request ${record.id}: these conditions match exactly that caller (same IDs, ref and event)`;
  return renderCreateForm(
    c,
    target,
    form,
    {
      prefillWarning: literalPath
        ? `${callerText} and the rule matches exactly that call. Review them, widen only what you need, then save.`
        : `${callerText}. No rule was prefilled: the call's path contains "*" or "%2F", which a rule cannot match literally ("*" is a wildcard; "%2F" needs "**"). Write the narrowest rule by hand, then save.`,
    },
    200,
    conditions,
  );
}

/** Exact conditions on the first anchor rule the stored claims satisfy, plus ref/event/environment. */
function prefillConditions(target: Target, claims: Record<string, unknown>): Condition[] {
  const anchorRules = target.profile.anchorRules(target.provider);
  const anchors =
    anchorRules.find((rule) => rule.every((claim) => claimText(claims, claim) !== null)) ??
    anchorRules[0] ??
    [];
  const conditions: Condition[] = [];
  for (const claim of [...anchors, ...(PREFILL_EXTRA_CLAIMS[target.profile.id] ?? [])]) {
    const value = claimText(claims, claim);
    if (value !== null && !conditions.some((c) => c.claim === claim)) {
      conditions.push(exact(claim, [value]));
    }
  }
  return conditions;
}

// ---------------------------------------------------------------------------------------------
// Pages

async function renderChooser(
  c: AdminContext,
  providerId: string,
  serviceId: string,
  status: ContentfulStatusCode = 200,
  errors: string[] = [],
) {
  const db = c.get('deps').env.DB;
  const [providers, services] = await Promise.all([listCallerProviders(db), listServices(db)]);
  if (providers.length === 0 || services.length === 0) {
    return renderPage(
      c,
      { title: 'Create a grant', section: SECTION, status },
      <EmptyState>
        A grant connects a caller provider to a service.{' '}
        <NextStep providers={providers} services={services} />
      </EmptyState>,
    );
  }
  return renderPage(
    c,
    { title: 'Create a grant', section: SECTION, status },
    <>
      <Messages errors={errors} />
      <p>Step 1 of 2: who may call, and which service?</p>
      <form method="get" action={`${SECTION}/new`} class="stack">
        <Select
          label="Caller provider"
          name="caller_provider"
          value={providerId}
          options={providers.map((provider) => ({
            value: provider.id,
            label: `${provider.name} (${getProfile(provider.profile)?.label ?? provider.profile})`,
          }))}
          hint="The platform whose workloads will call, e.g. your GitHub organization's Actions."
        />
        <Select
          label="Service"
          name="service"
          value={serviceId}
          options={services.map((service) => ({
            value: service.id,
            label: `${service.name} (/proxy/${service.slug})`,
          }))}
          hint="The upstream API they may call through the gateway."
        />
        <p class="actions">
          <button type="submit">Continue</button>
        </p>
      </form>
    </>,
  );
}

interface FormMessages {
  errors?: string[];
  warnings?: string[];
  /** Digest of `warnings`; present when they need acknowledgement. */
  digest?: string;
  conflict?: boolean;
  info?: string;
  prefillWarning?: string;
}

function renderCreateForm(
  c: AdminContext,
  target: Target,
  form: GrantForm,
  messages: FormMessages,
  status: ContentfulStatusCode = 200,
  computed: Condition[] | null = null,
) {
  const { provider, profile, service } = target;
  const preset = form.mode === 'preset';
  const base = { caller_provider: provider.id, service: service.id };
  return renderPage(
    c,
    { title: 'Create a grant', section: SECTION, status },
    <>
      <FormBanners messages={messages} />
      <Details
        rows={[
          [
            'Caller provider',
            <a href={`/admin/caller-providers/${provider.id}`}>{provider.name}</a>,
          ],
          ['Service', <a href={`/admin/services/${service.id}`}>{service.name}</a>],
        ]}
      />
      <p>
        <a href={`${SECTION}/new`}>Choose another caller provider or service</a>
      </p>
      {profile.id === 'github-actions' ? (
        <p class="muted">
          {preset ? (
            <>
              Using the GitHub builder.{' '}
              <a href={withQuery(`${SECTION}/new`, { ...base, mode: 'advanced' })}>
                Write conditions as text instead
              </a>{' '}
              (clears this form).
            </>
          ) : (
            <>
              Writing conditions as text.{' '}
              <a href={withQuery(`${SECTION}/new`, { ...base, mode: 'preset' })}>
                Use the GitHub builder instead
              </a>{' '}
              (clears this form).
            </>
          )}
        </p>
      ) : null}
      <form method="post" action={SECTION} class="stack">
        <Csrf token={c.get('viewer').csrfToken} />
        <input type="hidden" name="caller_provider_id" value={provider.id} />
        <input type="hidden" name="service_id" value={service.id} />
        <input type="hidden" name="mode" value={form.mode} />
        <NameFields form={form} />
        {preset ? (
          <PresetFields form={form} provider={provider} />
        ) : (
          <ConditionsField form={form} target={target} />
        )}
        {computed ? (
          <EventLine conditions={computed} profile={profile} />
        ) : (
          <TrustedEventsNote profile={profile} />
        )}
        {preset && computed ? (
          <div>
            <p>The builder produces these conditions:</p>
            <Pre>{formatConditions(computed)}</Pre>
          </div>
        ) : null}
        <RulesField form={form} service={service} />
        <Field
          label="Expires (UTC, optional)"
          name="expires_at"
          value={form.expires_at}
          type="datetime-local"
          hint="After this time the grant stops matching. Leave empty for no expiry."
        />
        <Checkbox
          name="enabled"
          checked={form.enabled}
          label="Enable this grant now"
          hint="Leave unchecked to save it disabled and enable it later."
        />
        <AcknowledgeField messages={messages} />
        <p class="actions">
          <button type="submit">Create grant</button>
        </p>
      </form>
    </>,
  );
}

function renderEditPage(
  c: AdminContext,
  grant: Grant,
  target: Target,
  form: GrantForm,
  messages: FormMessages,
  status: ContentfulStatusCode,
  computed: Condition[] | null,
) {
  return renderPage(
    c,
    { title: `Edit ${grant.name}`, section: SECTION, status },
    <>
      <FormBanners messages={messages} grantId={grant.id} />
      <EditForm
        grant={grant}
        target={target}
        form={form}
        csrf={c.get('viewer').csrfToken}
        messages={messages}
        computed={computed}
      />
      <p>
        <a href={`${SECTION}/${grant.id}`}>Cancel</a>
      </p>
    </>,
  );
}

async function renderDetail(
  c: AdminContext,
  grant: Grant,
  target: Target,
  messages: FormMessages,
  status: ContentfulStatusCode = 200,
) {
  const viewer = c.get('viewer');
  const canWrite = can(viewer.user.role, 'config:write');
  const { provider, profile, service } = target;
  const now = c.get('deps').now();
  return renderPage(
    c,
    { title: grant.name, section: SECTION, notice: noticeText(c), status },
    <>
      <FormBanners messages={messages} grantId={grant.id} />
      <InactiveBanners grant={grant} target={target} now={now} />
      <Details
        rows={[
          ['ID', <code>{grant.id}</code>],
          ['Status', <GrantStatus grant={grant} now={now} />],
          [
            'Caller provider',
            <a href={`/admin/caller-providers/${provider.id}`}>{provider.name}</a>,
          ],
          [
            'Service',
            <>
              <a href={`/admin/services/${service.id}`}>{service.name}</a>{' '}
              <code>/proxy/{service.slug}</code>
            </>,
          ],
          ['Description', grant.description || '—'],
          ['Expires', grant.expires_at === null ? 'never' : formatTime(grant.expires_at)],
          ['Created by', grant.created_by ?? '—'],
          ['Created', formatTime(grant.created_at)],
          ['Last changed', formatTime(grant.updated_at)],
        ]}
      />
      {canWrite ? (
        <div class="actions">
          <ActionButton
            action={`${SECTION}/${grant.id}/toggle`}
            csrf={viewer.csrfToken}
            label={grant.enabled ? 'Disable' : 'Enable'}
            fields={{ enabled: grant.enabled ? '0' : '1' }}
            danger={grant.enabled}
          />
          <a href={withQuery(`${SECTION}/new`, { duplicate: grant.id })}>Duplicate</a>
        </div>
      ) : null}
      <p class="muted">
        <a href={withQuery('/admin/requests', { service: service.id })}>
          Recent requests to this service
        </a>
      </p>

      <h2>Conditions (all must match)</h2>
      <EventLine conditions={grant.conditions} profile={profile} />
      <table>
        <thead>
          <tr>
            <th>Claim</th>
            <th>Match</th>
            <th>Values (any)</th>
          </tr>
        </thead>
        <tbody>
          {grant.conditions.map((condition) => (
            <tr>
              <td>
                <code>{condition.claim}</code>
              </td>
              <td>
                {condition.negate ? 'not ' : ''}
                {condition.match}
              </td>
              <td>
                {condition.values.map((value, index) => (
                  <>
                    {index > 0 ? ', ' : ''}
                    <code>{value}</code>
                  </>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pre>{formatConditions(grant.conditions)}</Pre>

      <h2>Rules (any may match)</h2>
      <table>
        <thead>
          <tr>
            <th>Methods</th>
            <th>Path</th>
          </tr>
        </thead>
        <tbody>
          {grant.rules.map((rule) => (
            <tr>
              <td>{rule.methods.join(', ')}</td>
              <td>
                <code>{rule.path}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pre>{formatRules(grant.rules)}</Pre>

      {canWrite ? (
        <>
          <h2>Edit</h2>
          <EditForm
            grant={grant}
            target={target}
            form={grantForm(grant)}
            csrf={viewer.csrfToken}
            messages={{}}
            computed={null}
          />
          <h2>Delete</h2>
          <form method="post" action={`${SECTION}/${grant.id}/delete`} class="stack">
            <Csrf token={viewer.csrfToken} />
            <Checkbox
              name="confirm"
              label="Delete this grant permanently"
              hint="Callers it allowed are refused from the next request on. To stop it temporarily, disable it instead. The audit log keeps a copy of its conditions and rules."
            />
            <p class="actions">
              <button type="submit" class="danger">
                Delete grant
              </button>
            </p>
          </form>
        </>
      ) : null}
    </>,
  );
}

/** Why an existing grant currently matches nothing, so the operator is not misled by "enabled". */
function InactiveBanners(props: { grant: Grant; target: Target; now: number }) {
  const { grant, target, now } = props;
  const reasons: string[] = [];
  if (grant.expires_at !== null && grant.expires_at <= now) {
    reasons.push('This grant has expired. Set a later expiry (or none) below to use it again.');
  }
  if (!target.provider.enabled) {
    reasons.push(
      `The caller provider “${target.provider.name}” is disabled, so this grant matches nothing until it is enabled.`,
    );
  }
  if (!target.service.enabled) {
    reasons.push(
      `The service “${target.service.name}” is disabled, so calls through this grant are refused until it is enabled.`,
    );
  }
  return (
    <>
      {reasons.map((reason) => (
        <p class="banner warning">{reason}</p>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Components

function EditForm(props: {
  grant: Grant;
  target: Target;
  form: GrantForm;
  csrf: string;
  messages: FormMessages;
  computed: Condition[] | null;
}) {
  const { grant, target, form } = props;
  return (
    <form method="post" action={`${SECTION}/${grant.id}`} class="stack">
      <Csrf token={props.csrf} />
      <VersionField value={form.expected_updated_at} />
      <NameFields form={form} />
      <ConditionsField form={form} target={target} />
      {props.computed ? <EventLine conditions={props.computed} profile={target.profile} /> : null}
      <RulesField form={form} service={target.service} />
      <Field
        label="Expires (UTC, optional)"
        name="expires_at"
        value={form.expires_at}
        type="datetime-local"
        hint="After this time the grant stops matching. Leave empty for no expiry."
      />
      <AcknowledgeField messages={props.messages} />
      <p class="actions">
        <button type="submit">Save changes</button>
      </p>
    </form>
  );
}

function FormBanners(props: { messages: FormMessages; grantId?: string }) {
  const { messages } = props;
  return (
    <>
      {messages.prefillWarning ? (
        <p class="banner warning" role="alert">
          {messages.prefillWarning}
        </p>
      ) : null}
      {messages.info ? <p class="banner info">{messages.info}</p> : null}
      {messages.conflict && !props.grantId ? (
        <p class="banner error" role="alert">
          The caller provider or service was changed by someone else while you were saving. Review
          the form and save again.
        </p>
      ) : (
        <Messages errors={messages.errors} />
      )}
      {messages.warnings && messages.warnings.length > 0 ? (
        <>
          <p>
            <strong>Review these warnings before saving:</strong>
          </p>
          <Messages warnings={messages.warnings} />
        </>
      ) : null}
    </>
  );
}

function AcknowledgeField(props: { messages: FormMessages }) {
  const { warnings, digest } = props.messages;
  if (!warnings || warnings.length === 0 || !digest) return null;
  return (
    <fieldset>
      <legend>Warnings</legend>
      <input type="hidden" name="warnings_digest" value={digest} />
      <Checkbox
        name="acknowledge_warnings"
        label="I have read the warnings above and want to save this grant anyway"
        hint="If you change the conditions or rules, new warnings may appear and you will be asked again."
      />
    </fieldset>
  );
}

function NameFields(props: { form: GrantForm }) {
  return (
    <>
      <Field
        label="Name"
        name="name"
        value={props.form.name}
        required
        hint="Describe who may do what, e.g. “deploy workflow posts to #releases”. Shown in logs."
      />
      <TextArea
        label="Description (optional)"
        name="description"
        value={props.form.description}
        rows={2}
        hint="Why this access exists, a ticket link, or an owner to ask."
      />
    </>
  );
}

function PresetFields(props: { form: GrantForm; provider: CallerProvider }) {
  const { form } = props;
  return (
    <fieldset>
      <legend>Which GitHub workflows</legend>
      <Field
        label="Organization ID"
        name="owner_id"
        value={form.owner_id}
        required
        hint={
          <>
            Numeric ID of the organization or user that owns the repositories. Must be one of this
            caller provider's allowed organization IDs. Find IDs with{' '}
            <code>
              {"gh api repos/OWNER/REPO --jq '{owner_id: .owner.id, repository_id: .id}'"}
            </code>
            .
          </>
        }
      />
      <TextArea
        label="Repository IDs"
        name="repository_ids"
        value={form.repository_ids}
        rows={3}
        hint="Numeric ID of each repository, one per line (names can be reused after a rename; IDs cannot). May be empty only when you pin a workflow below."
      />
      <Select
        label="When"
        name="context"
        value={form.context}
        options={PRESET_CONTEXTS}
        hint="Which kind of run may use this grant. Each choice also limits the triggering events."
      />
      <Field
        label="Branch, tag or environment"
        name="pattern"
        value={form.pattern}
        required
        hint={
          <>
            Branch: e.g. <code>main</code> or <code>release/*</code>. Tag and release: e.g.{' '}
            <code>v*</code>. Pull request: the base branch, e.g. <code>main</code>. Environment: its
            exact name, e.g. <code>production</code>. Without <code>refs/heads/</code>;{' '}
            <code>*</code> matches within one path segment and <code>**</code> across segments.
          </>
        }
      />
      <Checkbox
        name="require_protected_ref"
        checked={form.require_protected_ref}
        label="Only protected branches and tags"
        hint="Recommended. Without it, anyone who can push a matching branch or tag gets access; turning it off asks you to confirm a warning."
      />
      <Checkbox
        name="require_github_hosted"
        checked={form.require_github_hosted}
        label="Only GitHub-hosted runners"
        hint="Refuses jobs on self-hosted runners."
      />
      <Field
        label="Workflow pin (optional)"
        name="workflow_ref"
        value={form.workflow_ref}
        placeholder="OWNER/REPO/.github/workflows/deploy.yml@refs/heads/main"
        hint="Only this exact (reusable) workflow file at this ref may use the grant. No wildcards."
      />
    </fieldset>
  );
}

function ConditionsField(props: { form: GrantForm; target: Target }) {
  const anchors = props.target.profile
    .anchorRules(props.target.provider)
    .map((rule) => rule.join(' + '));
  return (
    <TextArea
      label="Conditions"
      name="conditions_text"
      value={props.form.conditions_text}
      rows={6}
      required
      hint={
        <>
          Claims the caller's token must have; all lines must match. One per line:{' '}
          <code>{CONDITION_SYNTAX}</code>. Example: <code>ref glob refs/heads/release/*</code>. The
          grant needs exact conditions on{' '}
          {anchors.length > 0 ? anchors.join(', or on ') : 'an anchor claim'}. Quote values
          containing commas as JSON strings; lines starting with # are ignored.
        </>
      }
    />
  );
}

function RulesField(props: { form: GrantForm; service: Service }) {
  const template = templateFor(props.service);
  return (
    <TextArea
      label="Rules"
      name="rules_text"
      value={props.form.rules_text}
      rows={4}
      required
      hint={
        <>
          Calls the grant allows, relative to the service base URL; any line may match. One per
          line: <code>{RULE_SYNTAX}</code>, e.g. <code>GET,POST /repos/acme/app/**</code>.{' '}
          {template
            ? `Prefilled with the ${template.label} starter rules; narrow them to what callers need.`
            : null}
        </>
      }
    />
  );
}

/** Which events the grant accepts and which it excludes without saying so (I-AUTHZ-3). */
function EventLine(props: { conditions: Condition[]; profile: IssuerProfile }) {
  const summary = eventSummary(props.conditions, props.profile);
  if (!summary) return null;
  const accepted = [
    ...summary.trusted.map((event) => `${event} (trusted)`),
    ...summary.optedIn.map((event) => `${event} (opted in)`),
  ];
  const unlisted = summary.restricted
    ? props.profile.trustedEvents.filter((event) => !summary.trusted.includes(event))
    : [];
  return (
    <p class="muted">
      <strong>Events accepted ({summary.claim}):</strong>{' '}
      {accepted.length > 0 ? accepted.join(', ') : 'none'}.{' '}
      <strong>Implicitly excluded events:</strong>{' '}
      {unlisted.length > 0 ? `${unlisted.join(', ')} and ` : ''}every other {summary.claim} value
      {summary.restricted
        ? ''
        : ' (an untrusted event is accepted only if an exact condition lists it)'}
      .
    </p>
  );
}

function TrustedEventsNote(props: { profile: IssuerProfile }) {
  const claim = props.profile.eventClaim;
  if (claim === undefined) return null;
  return (
    <p class="muted">
      Trusted events ({claim}): {props.profile.trustedEvents.join(', ')}. Any other event is refused
      unless a condition lists it exactly, e.g. <code>{claim} exact pull_request</code>.
    </p>
  );
}

function NextStep(props: { providers: CallerProvider[]; services: Service[] }) {
  if (props.providers.length === 0) {
    return (
      <>
        First <a href="/admin/caller-providers/new">add a caller provider</a> (e.g. GitHub Actions).
        See <code>docs/getting-started.md</code>.
      </>
    );
  }
  if (props.services.length === 0) {
    return (
      <>
        First <a href="/admin/services/new">add a service</a> to call.
      </>
    );
  }
  return (
    <>
      <a href={`${SECTION}/new`}>Create a grant</a>, or open a denied request in{' '}
      <a href="/admin/requests?outcome=denied">Requests</a> and create one from it.
    </>
  );
}

function GrantStatus(props: { grant: Grant; now: number }) {
  if (props.grant.expires_at !== null && props.grant.expires_at <= props.now) {
    return <Badge tone="bad">expired</Badge>;
  }
  return <EnabledBadge enabled={props.grant.enabled} />;
}

// ---------------------------------------------------------------------------------------------
// Helpers

async function loadTarget(
  c: AdminContext,
  providerId: string,
  serviceId: string,
): Promise<Target | null> {
  if (!providerId || !serviceId) return null;
  const db = c.get('deps').env.DB;
  const [provider, service] = await Promise.all([
    getCallerProvider(db, providerId),
    getService(db, serviceId),
  ]);
  const profile = provider ? getProfile(provider.profile) : null;
  return provider && profile && service ? { provider, profile, service } : null;
}

async function loadGrant(c: AdminContext): Promise<{ grant: Grant; target: Target } | null> {
  const grant = await getGrant(c.get('deps').env.DB, c.req.param('id') ?? '');
  const target = grant ? await loadTarget(c, grant.caller_provider_id, grant.service_id) : null;
  return grant && target ? { grant, target } : null;
}

function notFound(c: AdminContext) {
  return renderPage(
    c,
    { title: 'Grant not found', section: SECTION, status: 404 },
    <p>
      It may have been deleted. <a href={SECTION}>Back to grants</a>
    </p>,
  );
}

function failureMessages(failure: OpFailure, warnings: string[]): FormMessages {
  if (failure.reason === 'conflict') return { conflict: true, errors: failure.errors };
  // `warnings` are the ones the route computed (and digested); the op reports a subset.
  return { errors: failure.errors, warnings: warnings.length > 0 ? warnings : failure.warnings };
}

function failureStatus(failure: OpFailure): ContentfulStatusCode {
  return failure.reason === 'conflict' ? 409 : 422;
}

function noticeText(c: AdminContext): string | null {
  const key = c.req.query('notice');
  return key !== undefined && Object.hasOwn(NOTICES, key) ? (NOTICES[key] ?? null) : null;
}

function exact(claim: string, values: string[]): Condition {
  return { claim, match: 'exact', values };
}

/** The provider's single pinned tenant value (e.g. one GitHub organization ID), if any. */
function singlePinValue(provider: CallerProvider): { claim: string; value: string } | null {
  const [only, ...rest] = provider.tenant_pin;
  if (!only || rest.length > 0 || only.values.length !== 1 || only.claim === 'enterprise_id') {
    return null;
  }
  return { claim: only.claim, value: only.values[0] ?? '' };
}

/** The service template with the same base URL, whose starter rules prefill new grants. */
function templateFor(service: Service) {
  return SERVICE_TEMPLATES.find((template) => template.base_url === service.base_url) ?? null;
}

function starterRules(service: Service): string {
  const template = templateFor(service);
  return template ? formatRules(template.starter_rules) : '';
}

/** Up to three conditions in short form, for the list. */
function summarizeConditions(conditions: Condition[]): string {
  const shown = conditions.slice(0, 3).map((c) => {
    const operator = c.match === 'exact' ? (c.negate ? '≠' : '=') : c.negate ? '!~' : '~';
    return `${c.claim} ${operator} ${c.values.join('|')}`;
  });
  const more = conditions.length - shown.length;
  return more > 0 ? `${shown.join('; ')}; +${more} more` : shown.join('; ');
}

function parseExpiry(
  value: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === '') return { ok: true, value: null };
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value);
  const ms = match ? Date.parse(`${value}Z`) : Number.NaN;
  return Number.isNaN(ms)
    ? { ok: false, error: 'expiry must be a date and time (UTC)' }
    : { ok: true, value: ms };
}

function toDateTimeLocal(ms: number): string {
  return new Date(ms).toISOString().slice(0, ms % 60_000 === 0 ? 16 : 19);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(form: FormFields, name: string): string {
  const value = form[name];
  return typeof value === 'string' ? value : (value?.[0] ?? '');
}

/** Checkbox / hidden flag: "1" or "on" is true, anything else false. */
function flag(form: FormFields, name: string): boolean {
  const value = text(form, name);
  return value === '1' || value === 'on';
}
