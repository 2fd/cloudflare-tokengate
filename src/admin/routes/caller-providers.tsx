// Admin pages: caller providers (trusted workload-identity issuers). Every change goes through
// ops/caller-providers.ts (validation, tenant pin I-TEN-1, anchors I-AUTHZ-2, audit I-AUDIT-1). An
// issuer/JWKS change under enabled grants needs the confirm checkbox; disabling never validates.
import type { Child } from 'hono/jsx';
import type { App } from '../../app';
import { getCallerProvider, listCallerProviders } from '../../db/caller-providers';
import { listGrants } from '../../db/grants';
import type { CallerProvider, Grant } from '../../db/types';
import { getProfile, PROFILES } from '../../identity/profiles';
import type { IssuerProfile, ProfileId } from '../../identity/types';
import type { Condition } from '../../policy/types';
import { ALLOWED_ALGS, validateCallerProvider } from '../../policy/validate';
import { can } from '../auth/rbac';
import { formatConditions, parseConditions } from '../grant-text';
import {
  createCallerProvider,
  defaultAudience,
  deleteCallerProvider,
  setCallerProviderEnabled,
  updateCallerProvider,
} from '../ops/caller-providers';
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
  TextArea,
  VersionField,
} from '../views/components';
import { formatTime } from '../views/format';

const SECTION = '/admin/caller-providers';

const NOTICES: Record<string, string> = {
  created: 'Caller provider created. Next: create a grant that lets its callers use a service.',
  updated: 'Caller provider saved.',
  unchanged: 'Nothing changed: the submitted values are the current ones.',
  enabled: 'Caller provider enabled.',
  disabled: 'Caller provider disabled. Its tokens are refused from the next request on.',
  deleted: 'Caller provider deleted.',
};

const PROFILE_ORDER: ProfileId[] = ['github-actions', 'gitlab-ci', 'generic'];

const PROFILE_INTRO: Record<ProfileId, string> = {
  'github-actions':
    'Workflows in your GitHub organizations (github.com or GitHub Enterprise Cloud).',
  'gitlab-ci': 'Pipelines on gitlab.com or on your self-managed GitLab.',
  generic:
    'Any other OpenID Connect issuer that signs tokens for workloads (Buildkite, CircleCI, Kubernetes, …).',
};

const FIND_GITHUB_IDS = "gh api repos/OWNER/REPO --jq '{owner_id: .owner.id, repository_id: .id}'";

// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax
const GHA_PROXY_BASE = '${{ steps.tokengate.outputs.proxy-base }}';
// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax
const GHA_TOKEN = '${{ steps.tokengate.outputs.token }}';

export function registerCallerProvidersRoutes(app: App): void {
  app.get('/admin/caller-providers', listPage);
  app.get('/admin/caller-providers/new', newPage);
  app.post('/admin/caller-providers', create);
  app.get('/admin/caller-providers/:id', detailPage);
  app.post('/admin/caller-providers/:id', update);
  app.post('/admin/caller-providers/:id/toggle', toggle);
  app.post('/admin/caller-providers/:id/delete', remove);
}

// ---------------------------------------------------------------------------------------------
// Form state

/** Raw form values, kept as text so a rejected form is re-shown exactly as submitted. */
interface ProviderForm {
  name: string;
  issuer: string;
  jwks_uri: string;
  audience: string;
  allowed_algs: string[];
  max_token_age_seconds: string;
  /** `fields`: the profile's ID inputs; `text`: condition lines (generic, or a stored pin the inputs cannot show). */
  pin_mode: 'fields' | 'text';
  owner_ids: string;
  enterprise_id: string;
  namespace_ids: string;
  tenant_pin_text: string;
  anchor_claims: string;
  /** `updated_at` the edit form was opened at; empty on create. */
  expected_updated_at: string;
}

function defaultForm(profile: IssuerProfile, audience: string): ProviderForm {
  return {
    name: profile.label,
    issuer: profile.defaults.issuer ?? '',
    jwks_uri: '',
    audience,
    allowed_algs: [...profile.defaults.allowedAlgs],
    max_token_age_seconds: String(profile.defaults.maxTokenAgeSeconds),
    pin_mode: profile.id === 'generic' ? 'text' : 'fields',
    owner_ids: '',
    enterprise_id: '',
    namespace_ids: '',
    tenant_pin_text: '',
    anchor_claims: profile.id === 'generic' ? 'sub' : '',
    expected_updated_at: '',
  };
}

function storedForm(provider: CallerProvider, profile: IssuerProfile): ProviderForm {
  const fields = pinFields(profile, provider.tenant_pin);
  return {
    name: provider.name,
    issuer: provider.issuer,
    jwks_uri: provider.jwks_uri,
    audience: provider.audience,
    allowed_algs: [...provider.allowed_algs],
    max_token_age_seconds: String(provider.max_token_age_seconds),
    pin_mode: fields ? 'fields' : 'text',
    owner_ids: fields?.owner_ids ?? '',
    enterprise_id: fields?.enterprise_id ?? '',
    namespace_ids: fields?.namespace_ids ?? '',
    tenant_pin_text: fields ? '' : formatConditions(provider.tenant_pin),
    anchor_claims: provider.anchor_claims.join('\n'),
    expected_updated_at: String(provider.updated_at),
  };
}

/**
 * The stored pin as the profile's ID inputs, or null when they cannot show it exactly (then the
 * form falls back to condition lines, so editing never drops a pin condition silently).
 */
function pinFields(
  profile: IssuerProfile,
  pin: Condition[],
): Pick<ProviderForm, 'owner_ids' | 'enterprise_id' | 'namespace_ids'> | null {
  if (profile.id === 'generic') return null;
  const simple = pin.every((c) => c.match === 'exact' && c.negate !== true);
  const claims = pin.map((c) => c.claim);
  if (!simple || new Set(claims).size !== claims.length) return null;
  const valuesOf = (claim: string) => pin.find((c) => c.claim === claim)?.values ?? [];
  if (profile.id === 'github-actions') {
    if (!claims.every((c) => c === 'repository_owner_id' || c === 'enterprise_id')) return null;
    const enterprise = valuesOf('enterprise_id');
    if (enterprise.length > 1) return null;
    return {
      owner_ids: valuesOf('repository_owner_id').join('\n'),
      enterprise_id: enterprise[0] ?? '',
      namespace_ids: '',
    };
  }
  if (!claims.every((c) => c === 'namespace_id')) return null;
  return { owner_ids: '', enterprise_id: '', namespace_ids: valuesOf('namespace_id').join('\n') };
}

function submittedForm(form: FormFields): ProviderForm {
  return {
    name: text(form, 'name'),
    issuer: text(form, 'issuer'),
    jwks_uri: text(form, 'jwks_uri'),
    audience: text(form, 'audience'),
    allowed_algs: all(form, 'allowed_algs'),
    max_token_age_seconds: text(form, 'max_token_age_seconds'),
    pin_mode: text(form, 'pin_mode') === 'text' ? 'text' : 'fields',
    owner_ids: text(form, 'owner_ids'),
    enterprise_id: text(form, 'enterprise_id'),
    namespace_ids: text(form, 'namespace_ids'),
    tenant_pin_text: text(form, 'tenant_pin_text'),
    anchor_claims: text(form, 'anchor_claims'),
    expected_updated_at: text(form, 'expected_updated_at'),
  };
}

/** Tenant pin conditions from the form, or parse errors. */
function tenantPinFrom(
  profile: IssuerProfile,
  form: ProviderForm,
): { ok: true; pin: Condition[] } | { ok: false; errors: string[] } {
  if (profile.id === 'generic' || form.pin_mode === 'text') {
    const parsed = parseConditions(form.tenant_pin_text);
    return parsed.ok ? { ok: true, pin: parsed.conditions } : { ok: false, errors: parsed.errors };
  }
  const exact = (claim: string, values: string[]): Condition => ({ claim, match: 'exact', values });
  const pin: Condition[] = [];
  if (profile.id === 'github-actions') {
    const owners = idList(form.owner_ids);
    if (owners.length > 0) pin.push(exact('repository_owner_id', owners));
    const enterprise = form.enterprise_id.trim();
    if (enterprise !== '') pin.push(exact('enterprise_id', [enterprise]));
  } else {
    const namespaces = idList(form.namespace_ids);
    if (namespaces.length > 0) pin.push(exact('namespace_id', namespaces));
  }
  return { ok: true, pin };
}

// ---------------------------------------------------------------------------------------------
// Handlers

async function listPage(c: AdminContext) {
  const db = c.get('deps').env.DB;
  const [providers, grants] = await Promise.all([listCallerProviders(db), listGrants(db)]);
  const grantCounts = countBy(grants, (grant) => grant.caller_provider_id);
  const canWrite = can(c.get('viewer').user.role, 'config:write');
  return renderPage(
    c,
    { title: 'Caller providers', section: SECTION, notice: noticeText(c) },
    <>
      <p class="muted">
        A caller provider tells the gateway which workload tokens to trust: who signs them (the
        issuer), which audience they must carry, and which organization they must come from (the
        tenant pin). Grants then decide what each caller may do.
      </p>
      {canWrite ? (
        <p class="actions">
          <a href="/admin/caller-providers/new">Add a caller provider</a>
        </p>
      ) : null}
      {providers.length === 0 ? (
        <EmptyState>
          No caller providers yet.{' '}
          {canWrite ? (
            <>
              Start with{' '}
              <a href="/admin/caller-providers/new?profile=github-actions">GitHub Actions</a>,{' '}
              <a href="/admin/caller-providers/new?profile=gitlab-ci">GitLab CI</a> or{' '}
              <a href="/admin/caller-providers/new?profile=generic">another OIDC issuer</a>.
            </>
          ) : (
            'Ask an admin to add one.'
          )}{' '}
          See <code>docs/getting-started.md</code> for a walkthrough.
        </EmptyState>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Issuer</th>
              <th>Tenant pin</th>
              <th>Grants</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <tr>
                <td>
                  <a href={`${SECTION}/${provider.id}`}>{provider.name}</a>
                </td>
                <td>{profileLabel(provider.profile)}</td>
                <td>
                  <code>{provider.issuer}</code>
                </td>
                <td>
                  {provider.tenant_pin.length === 0 ? (
                    <Badge tone="warn">none</Badge>
                  ) : (
                    <code>{formatConditions(provider.tenant_pin)}</code>
                  )}
                </td>
                <td>
                  <a href={`/admin/grants?caller_provider=${provider.id}`}>
                    {grantCounts.get(provider.id) ?? 0}
                  </a>
                </td>
                <td>
                  <EnabledBadge enabled={provider.enabled} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>,
  );
}

async function newPage(c: AdminContext) {
  const profile = getProfile(c.req.query('profile') ?? '');
  if (!profile) return renderProfileChooser(c);
  const form = defaultForm(profile, defaultAudience(c.get('deps').random));
  return renderCreateForm(c, profile, form, {});
}

async function create(c: AdminContext) {
  const fields = await formData(c);
  const profile = getProfile(text(fields, 'profile'));
  if (!profile) return renderProfileChooser(c, 422);
  const form = submittedForm(fields);
  const pin = tenantPinFrom(profile, form);
  if (!pin.ok) return renderCreateForm(c, profile, form, { errors: pin.errors }, 422);

  const result = await createCallerProvider(c.get('deps'), adminActor(c), {
    name: form.name,
    profile: profile.id,
    issuer: form.issuer,
    jwks_uri: profile.id === 'generic' ? form.jwks_uri : null,
    audience: form.audience,
    allowed_algs: form.allowed_algs,
    max_token_age_seconds: Number(form.max_token_age_seconds),
    tenant_pin: pin.pin,
    anchor_claims: profile.id === 'generic' ? lines(form.anchor_claims) : [],
    enabled: true,
  });
  if (result.ok) return redirectWithNotice(c, `${SECTION}/${result.callerProvider.id}`, 'created');
  return renderCreateForm(c, profile, form, result, failureStatus(result));
}

async function detailPage(c: AdminContext) {
  const loaded = await loadProvider(c);
  if (!loaded) return notFound(c);
  return renderDetail(c, loaded.provider, loaded.profile, {});
}

async function update(c: AdminContext) {
  const loaded = await loadProvider(c);
  if (!loaded) return notFound(c);
  const { provider, profile } = loaded;
  const fields = await formData(c);
  const form = submittedForm(fields);
  // Platform profiles show the discovered JWKS URI read-only; it is not a form field.
  if (profile.id !== 'generic') form.jwks_uri = provider.jwks_uri;
  const pin = tenantPinFrom(profile, form);
  if (!pin.ok) return renderEditPage(c, provider, profile, form, { errors: pin.errors }, 422);

  const result = await updateCallerProvider(c.get('deps'), adminActor(c), provider.id, {
    name: form.name,
    issuer: form.issuer,
    // Null or empty: keep the stored URI, or rediscover it when the issuer changes.
    jwks_uri: profile.id === 'generic' ? form.jwks_uri : null,
    audience: form.audience,
    allowed_algs: form.allowed_algs,
    max_token_age_seconds: Number(form.max_token_age_seconds),
    tenant_pin: pin.pin,
    anchor_claims: profile.id === 'generic' ? lines(form.anchor_claims) : undefined,
    confirm_trust_change: flag(fields, 'confirm_trust_change'),
    expected_updated_at: submittedVersion(form.expected_updated_at),
  });
  if (result.ok) {
    return redirectWithNotice(
      c,
      `${SECTION}/${provider.id}`,
      result.changed === false ? 'unchanged' : 'updated',
    );
  }
  if (result.reason === 'not_found') return notFound(c);
  const affected =
    result.reason === 'confirmation_required'
      ? await listGrants(c.get('deps').env.DB, { caller_provider_id: provider.id, enabled: true })
      : null;
  return renderEditPage(c, provider, profile, form, { ...result, affected }, failureStatus(result));
}

async function toggle(c: AdminContext) {
  const id = c.req.param('id') ?? '';
  const enabled = flag(await formData(c), 'enabled');
  const result = await setCallerProviderEnabled(c.get('deps'), adminActor(c), id, enabled);
  if (result.ok) return redirectWithNotice(c, `${SECTION}/${id}`, enabled ? 'enabled' : 'disabled');
  return rerenderDetail(c, result);
}

async function remove(c: AdminContext) {
  if (!flag(await formData(c), 'confirm')) {
    const loaded = await loadProvider(c);
    if (!loaded) return notFound(c);
    return renderDetail(
      c,
      loaded.provider,
      loaded.profile,
      { errors: ['Tick the confirmation box to delete the caller provider.'] },
      400,
    );
  }
  const result = await deleteCallerProvider(c.get('deps'), adminActor(c), c.req.param('id') ?? '');
  if (result.ok) return redirectWithNotice(c, SECTION, 'deleted');
  return rerenderDetail(c, result);
}

async function rerenderDetail(c: AdminContext, failure: OpFailure) {
  const loaded = await loadProvider(c);
  if (!loaded || failure.reason === 'not_found') return notFound(c);
  return renderDetail(c, loaded.provider, loaded.profile, failure, failureStatus(failure));
}

// ---------------------------------------------------------------------------------------------
// Pages

function renderProfileChooser(c: AdminContext, status: 200 | 422 = 200) {
  return renderPage(
    c,
    { title: 'Add a caller provider', section: SECTION, status },
    <>
      <p>Where do the workloads that will call the gateway run?</p>
      <ul>
        {PROFILE_ORDER.map((id) => (
          <li>
            <a href={`${SECTION}/new?profile=${id}`}>{PROFILES[id].label}</a>
            {' — '}
            {PROFILE_INTRO[id]}
          </li>
        ))}
      </ul>
    </>,
  );
}

interface FormMessages {
  errors?: string[];
  warnings?: string[];
}

function renderCreateForm(
  c: AdminContext,
  profile: IssuerProfile,
  form: ProviderForm,
  messages: FormMessages,
  status: 200 | 409 | 422 = 200,
) {
  const csrf = c.get('viewer').csrfToken;
  return renderPage(
    c,
    { title: `Add a ${profile.label} caller provider`, section: SECTION, status },
    <>
      <p class="muted">{PROFILE_INTRO[profile.id]}</p>
      <Messages errors={messages.errors} warnings={messages.warnings} />
      <form method="post" action={SECTION} class="stack">
        <Csrf token={csrf} />
        <input type="hidden" name="profile" value={profile.id} />
        <ProviderFields profile={profile} form={form} editing={false} />
        <p class="actions">
          <button type="submit">Create caller provider</button>
          <a href={`${SECTION}/new`}>Choose another type</a>
        </p>
      </form>
    </>,
  );
}

function renderEditPage(
  c: AdminContext,
  provider: CallerProvider,
  profile: IssuerProfile,
  form: ProviderForm,
  messages: FormMessages & { affected?: Grant[] | null },
  status: 200 | 409 | 422 = 200,
) {
  return renderPage(
    c,
    { title: `Edit ${provider.name}`, section: SECTION, status },
    <>
      <Messages errors={messages.errors} warnings={messages.warnings} />
      <EditForm
        provider={provider}
        profile={profile}
        form={form}
        csrf={c.get('viewer').csrfToken}
        affected={messages.affected ?? null}
      />
      <p>
        <a href={`${SECTION}/${provider.id}`}>Cancel</a>
      </p>
    </>,
  );
}

async function renderDetail(
  c: AdminContext,
  provider: CallerProvider,
  profile: IssuerProfile,
  messages: FormMessages,
  status: 200 | 400 | 409 | 422 = 200,
) {
  const deps = c.get('deps');
  const viewer = c.get('viewer');
  const canWrite = can(viewer.user.role, 'config:write');
  const grants = await listGrants(deps.env.DB, { caller_provider_id: provider.id });
  const origin = new URL(c.req.url).origin;
  // Re-check the stored configuration so standing risks (e.g. no tenant pin) stay visible.
  const stored = validateCallerProvider(provider, profile, provider);

  return renderPage(
    c,
    { title: provider.name, section: SECTION, notice: noticeText(c), status },
    <>
      <Messages errors={messages.errors} warnings={messages.warnings} />
      {[...stored.errors, ...stored.warnings].map((warning) => (
        <p class="banner warning">{warning}</p>
      ))}
      <Details
        rows={[
          ['ID', <code>{provider.id}</code>],
          ['Type', profile.label],
          ['Status', <EnabledBadge enabled={provider.enabled} />],
          ['Issuer', <code>{provider.issuer}</code>],
          ['JWKS URI', <code>{provider.jwks_uri}</code>],
          ['Audience', <code>{provider.audience}</code>],
          ['Signature algorithms', provider.allowed_algs.join(', ')],
          ['Maximum token age', `${provider.max_token_age_seconds} seconds`],
          [
            'Tenant pin',
            provider.tenant_pin.length === 0 ? (
              <Badge tone="warn">none</Badge>
            ) : (
              <Pre>{formatConditions(provider.tenant_pin)}</Pre>
            ),
          ],
          ...(profile.id === 'generic'
            ? ([['Anchor claims', <code>{provider.anchor_claims.join(', ')}</code>]] as Array<
                [string, Child]
              >)
            : []),
          ['Created', formatTime(provider.created_at)],
          ['Last changed', formatTime(provider.updated_at)],
        ]}
      />
      {canWrite ? (
        <div class="actions">
          <ActionButton
            action={`${SECTION}/${provider.id}/toggle`}
            csrf={viewer.csrfToken}
            label={provider.enabled ? 'Disable' : 'Enable'}
            fields={{ enabled: provider.enabled ? '0' : '1' }}
            danger={provider.enabled}
          />
        </div>
      ) : null}

      <h2>Use it from CI</h2>
      <CallerSnippet provider={provider} origin={origin} />

      <h2>Grants for these callers</h2>
      {grants.length === 0 ? (
        <EmptyState>
          No grants yet, so every caller is refused.{' '}
          {canWrite ? (
            <a href={`/admin/grants/new?caller_provider=${provider.id}`}>Create a grant</a>
          ) : null}
        </EmptyState>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Grant</th>
                <th>Status</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <tr>
                  <td>
                    <a href={`/admin/grants/${grant.id}`}>{grant.name}</a>
                  </td>
                  <td>
                    <EnabledBadge enabled={grant.enabled} />
                  </td>
                  <td>{grant.expires_at === null ? 'never' : formatTime(grant.expires_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {canWrite ? (
            <p>
              <a href={`/admin/grants/new?caller_provider=${provider.id}`}>Create another grant</a>
            </p>
          ) : null}
        </>
      )}

      {canWrite ? (
        <>
          <h2>Edit</h2>
          <EditForm
            provider={provider}
            profile={profile}
            form={storedForm(provider, profile)}
            csrf={viewer.csrfToken}
            affected={null}
          />
          <h2>Delete</h2>
          {grants.length > 0 ? (
            <p class="muted">
              This caller provider is used by {grants.length} grant(s). Delete those grants first;
              then it can be deleted. To refuse its tokens right away, disable it instead.
            </p>
          ) : (
            <form method="post" action={`${SECTION}/${provider.id}/delete`} class="stack">
              <Csrf token={viewer.csrfToken} />
              <Checkbox
                name="confirm"
                label="Delete this caller provider permanently"
                hint="The audit log keeps a copy of its configuration."
              />
              <p class="actions">
                <button type="submit" class="danger">
                  Delete caller provider
                </button>
              </p>
            </form>
          )}
        </>
      ) : null}
    </>,
  );
}

// ---------------------------------------------------------------------------------------------
// Components

function EditForm(props: {
  provider: CallerProvider;
  profile: IssuerProfile;
  form: ProviderForm;
  csrf: string;
  /** Enabled grants whose trust changes; non-null shows the confirm checkbox. */
  affected: Grant[] | null;
}) {
  const { provider, profile, form, affected } = props;
  return (
    <form method="post" action={`${SECTION}/${provider.id}`} class="stack">
      <Csrf token={props.csrf} />
      <VersionField value={form.expected_updated_at} />
      <ProviderFields profile={profile} form={form} editing />
      {affected !== null ? (
        <fieldset>
          <legend>Confirm the trust change</legend>
          <p>
            A new issuer or JWKS URI changes which tokens these enabled grants accept. Check that
            the new issuer belongs to you before confirming:
          </p>
          <ul>
            {affected.map((grant) => (
              <li>
                <a href={`/admin/grants/${grant.id}`}>{grant.name}</a>
              </li>
            ))}
          </ul>
          <Checkbox
            name="confirm_trust_change"
            label="I confirm these grants should trust the new issuer or keys"
          />
        </fieldset>
      ) : null}
      <p class="actions">
        <button type="submit">Save changes</button>
      </p>
    </form>
  );
}

function ProviderFields(props: { profile: IssuerProfile; form: ProviderForm; editing: boolean }) {
  const { profile, form, editing } = props;
  const ageLimit = profile.defaults.maxTokenAgeLimitSeconds;
  return (
    <>
      {editing ? (
        <Field
          label="Type"
          name="profile_display"
          value={profile.label}
          readonly
          hint="The type cannot change. Create a new caller provider for another platform."
        />
      ) : null}
      <Field
        label="Name"
        name="name"
        value={form.name}
        required
        hint="A label for you, e.g. “GitHub Actions (acme)”. Shown in grants and logs."
      />
      <Field
        label="Issuer"
        name="issuer"
        value={form.issuer}
        type="url"
        required
        hint={ISSUER_HINT[profile.id]}
      />
      {profile.id === 'generic' ? (
        <Field
          label="JWKS URI (optional)"
          name="jwks_uri"
          value={form.jwks_uri}
          type="url"
          hint={
            editing
              ? 'Where the issuer publishes its signing keys. If you change the issuer, clear this field to look the keys up again from the new issuer; otherwise the URI shown here is kept.'
              : 'Where the issuer publishes its signing keys. Leave empty to read it from <issuer>/.well-known/openid-configuration.'
          }
        />
      ) : editing ? (
        <Field
          label="JWKS URI"
          name="jwks_uri_display"
          value={form.jwks_uri}
          readonly
          hint="Read from the issuer's discovery document; it is looked up again when the issuer changes."
        />
      ) : null}
      <Field
        label="Audience"
        name="audience"
        value={form.audience}
        required
        hint={
          editing
            ? 'The aud value callers request. Changing it breaks every workflow that uses the old value.'
            : 'The aud value callers must request. It is random so that tokens minted for other services are never accepted here. Keep it unless you have a reason to change it; you copy it into your CI configuration later.'
        }
      />
      <fieldset>
        <legend>Tenant pin: whose tokens are accepted</legend>
        <TenantPinFields profile={profile} form={form} />
      </fieldset>
      {profile.id === 'generic' ? (
        <TextArea
          label="Anchor claims"
          name="anchor_claims"
          value={form.anchor_claims}
          rows={3}
          hint="Claims that identify a workload and never change, one per line (e.g. sub, project_id). Every grant must match at least one of them exactly."
        />
      ) : null}
      <fieldset>
        <legend>Advanced: token checks</legend>
        <fieldset>
          <legend>Signature algorithms</legend>
          {ALLOWED_ALGS.map((alg) => (
            <label class="checkbox">
              <input
                type="checkbox"
                name="allowed_algs"
                value={alg}
                checked={form.allowed_algs.includes(alg)}
              />
              <span>{alg}</span>
            </label>
          ))}
          <small class="muted">
            Algorithms the issuer signs with. GitHub and GitLab use RS256. Default:{' '}
            {profile.defaults.allowedAlgs.join(', ')}.
          </small>
        </fieldset>
        <Field
          label="Maximum token age (seconds)"
          name="max_token_age_seconds"
          value={form.max_token_age_seconds}
          type="number"
          hint={`Tokens issued longer ago than this are refused, even if not expired. Between 60 and ${ageLimit}; default ${profile.defaults.maxTokenAgeSeconds}.`}
        />
      </fieldset>
    </>
  );
}

const ISSUER_HINT: Record<ProfileId, string> = {
  'github-actions':
    'Who signs the tokens. Keep the default for github.com. GitHub Enterprise Cloud with a customized issuer uses https://token.actions.githubusercontent.com/<enterprise-slug>.',
  'gitlab-ci':
    'Who signs the tokens: https://gitlab.com, or the URL of your self-managed GitLab (e.g. https://gitlab.example.com).',
  generic: 'The iss value of the tokens, exactly as the issuer writes it (an https URL).',
};

function TenantPinFields(props: { profile: IssuerProfile; form: ProviderForm }) {
  const { profile, form } = props;
  if (profile.id === 'generic' || form.pin_mode === 'text') {
    return (
      <>
        <input type="hidden" name="pin_mode" value="text" />
        <TextArea
          label="Required claims"
          name="tenant_pin_text"
          value={form.tenant_pin_text}
          rows={3}
          hint={
            <>
              Claims every token must carry, one per line: <code>claim exact value[, value]</code>.
              Example: <code>organization_id exact 1234</code>.{' '}
              {profile.id === 'generic'
                ? 'Leave empty only if this issuer signs tokens for your company alone.'
                : `Allowed claims: ${profile.tenantClaims.join(', ')}.`}
            </>
          }
        />
      </>
    );
  }
  if (profile.id === 'github-actions') {
    return (
      <>
        <input type="hidden" name="pin_mode" value="fields" />
        <TextArea
          label="Allowed organization IDs"
          name="owner_ids"
          value={form.owner_ids}
          rows={2}
          hint={
            <>
              Numeric ID of each GitHub organization (or user account) whose workflows may call the
              gateway, one per line. Required for github.com: anyone on GitHub can get a token from
              this issuer. Find it with <code>gh api orgs/ORG --jq .id</code> or{' '}
              <code>{FIND_GITHUB_IDS}</code>.
            </>
          }
        />
        <Field
          label="Enterprise ID (optional)"
          name="enterprise_id"
          value={form.enterprise_id}
          hint="Numeric GitHub Enterprise Cloud ID. When set, tokens must also come from this enterprise."
        />
      </>
    );
  }
  return (
    <>
      <input type="hidden" name="pin_mode" value="fields" />
      <TextArea
        label="Allowed group (namespace) IDs"
        name="namespace_ids"
        value={form.namespace_ids}
        rows={2}
        hint="Numeric ID of each GitLab group or user namespace whose pipelines may call the gateway, one per line. It is the group that directly contains the project (shown as “Group ID” on the group page). Required for gitlab.com."
      />
    </>
  );
}

function CallerSnippet(props: { provider: CallerProvider; origin: string }) {
  const { provider, origin } = props;
  if (provider.profile === 'github-actions') {
    return (
      <>
        <p>
          Add this to a workflow job. Later steps call{' '}
          <code>{`${GHA_PROXY_BASE}/<service-slug>/<path>`}</code> with the header{' '}
          <code>{`x-tokengate-token: ${GHA_TOKEN}`}</code>.
        </p>
        <Pre>
          {`permissions: { id-token: write, contents: read }
steps:
  - id: tokengate
    uses: 2fd/cloudflare-tokengate/actions/get-token@main   # pin to a full commit SHA in production
    with: { audience: ${yamlScalar(provider.audience)}, url: ${yamlScalar(origin)} }`}
        </Pre>
        <p class="muted">
          Grants need numeric IDs. Find them with <code>{FIND_GITHUB_IDS}</code>.
        </p>
      </>
    );
  }
  if (provider.profile === 'gitlab-ci') {
    return (
      <>
        <p>Request a token with this audience in the job and send it in a header:</p>
        <Pre>
          {`my-job:
  id_tokens:
    TOKENGATE_TOKEN:
      aud: ${yamlScalar(provider.audience)}
  script:
    - curl -sS --fail-with-body -H "x-tokengate-token: $TOKENGATE_TOKEN" "${origin}/proxy/<service-slug>/<path>"`}
        </Pre>
        <p class="muted">
          Grants need numeric IDs: the project ID is shown on the project overview page.
        </p>
      </>
    );
  }
  return (
    <p>
      Have the issuer mint a token with audience <code>{provider.audience}</code> and send it in the{' '}
      <code>x-tokengate-token</code> header to{' '}
      <code>{`${origin}/proxy/<service-slug>/<path>`}</code>.
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// Helpers

async function loadProvider(
  c: AdminContext,
): Promise<{ provider: CallerProvider; profile: IssuerProfile } | null> {
  const provider = await getCallerProvider(c.get('deps').env.DB, c.req.param('id') ?? '');
  const profile = provider ? getProfile(provider.profile) : null;
  return provider && profile ? { provider, profile } : null;
}

function notFound(c: AdminContext) {
  return renderPage(
    c,
    { title: 'Caller provider not found', section: SECTION, status: 404 },
    <p>
      It may have been deleted. <a href={SECTION}>Back to caller providers</a>
    </p>,
  );
}

function failureStatus(failure: OpFailure): 409 | 422 {
  return failure.reason === 'conflict' ? 409 : 422;
}

function noticeText(c: AdminContext): string | null {
  const key = c.req.query('notice');
  return key !== undefined && Object.hasOwn(NOTICES, key) ? (NOTICES[key] ?? null) : null;
}

function profileLabel(id: string): string {
  return getProfile(id)?.label ?? id;
}

function text(form: FormFields, name: string): string {
  const value = form[name];
  return typeof value === 'string' ? value : (value?.[0] ?? '');
}

function all(form: FormFields, name: string): string[] {
  const value = form[name];
  return value === undefined ? [] : typeof value === 'string' ? [value] : value;
}

/** Checkbox / hidden flag: "1" or "on" is true, anything else false. */
function flag(form: FormFields, name: string): boolean {
  const value = text(form, name);
  return value === '1' || value === 'on';
}

/** Non-empty trimmed lines. */
function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** IDs separated by whitespace or commas, de-duplicated (shape checked by validation). */
function idList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((id) => id.trim())
        .filter((id) => id !== ''),
    ),
  ];
}

/**
 * A value for the copy-ready YAML snippets: plain when it cannot be misread (the default
 * `tokengate:<base32>` audience, https origins), else a double-quoted (JSON) string. Audiences are
 * printable ASCII and may contain YAML indicators such as `,`, `}`, `#`, `*` or a leading `&`.
 */
function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._~/:+=@-]*$/.test(value) && !/:(\s|$)/.test(value)
    ? value
    : JSON.stringify(value);
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}
