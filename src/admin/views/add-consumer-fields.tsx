// "Add a consumer" fields (A14.1, A14.7.1), shared by the consumer list, /admin/consumers/new and
// the access form (prefix `new.`): the type as radio cards and each type's few inputs in its
// reveal. Everything else (name, issuer, JWKS, algorithms, token age, audience) is derived. Every
// input sits in a reveal, so none carries native validation (A7.6); the server checks them.
import type { Child } from 'hono/jsx';
import type { CallerProvider } from '../../db/types';
import { GITHUB_ACTIONS_ISSUER } from '../../identity/profiles/github-actions';
import { GITLAB_COM_ISSUER } from '../../identity/profiles/gitlab-ci';
import type { ProfileId } from '../../identity/types';
import { CLAIM_NAME_MAX_LENGTH } from '../../policy/conditions';
import { type Fields, ownerFindCommand, parseOwnerList, text } from '../consumer-access';
import type { ConsumerInput } from '../ops/caller-providers';
import type { FieldError } from '../ops/shared';
import { paths } from '../paths';
import { Field, IdWithLabelField, RadioCards } from './components';

export const CONSUMER_TYPES: readonly ProfileId[] = ['github-actions', 'gitlab-ci', 'generic'];

const TYPE_INFO: Readonly<Record<ProfileId, { title: string; description: string }>> = {
  'github-actions': { title: 'GitHub Actions', description: 'Workflows in GitHub repositories' },
  'gitlab-ci': { title: 'GitLab CI', description: 'Pipelines on GitLab.com or your own GitLab' },
  generic: {
    title: 'Generic OIDC',
    description: 'Buildkite, CircleCI, Kubernetes or any OIDC issuer',
  },
};

/** Known generic issuers: anchor and pin claims to use when the fields are left empty. */
const GENERIC_PRESETS: ReadonlyArray<{ host: string; anchor: string; pin: string }> = [
  { host: 'agent.buildkite.com', anchor: 'pipeline_id', pin: 'organization_id' },
  {
    host: 'oidc.circleci.com',
    anchor: 'oidc.circleci.com/project-id',
    pin: 'oidc.circleci.com/org-id',
  },
];

export const GENERIC_ISSUER_EXAMPLES: readonly string[] = [
  'https://agent.buildkite.com',
  'https://oidc.circleci.com/org/0c9f3e1a-7b2d-4c5e-9f10-123456789abc',
];

/** Raw values of the add-consumer fields, kept as text for a re-render. */
export interface ConsumerForm {
  type: string;
  github_org: string;
  github_enterprise_slug: string;
  github_enterprise_id: string;
  gitlab_group: string;
  gitlab_url: string;
  generic_issuer: string;
  generic_anchor_claims: string;
  generic_pin_claim: string;
  generic_pin_value: string;
}

const KEYS: ReadonlyArray<keyof ConsumerForm> = [
  'type',
  'github_org',
  'github_enterprise_slug',
  'github_enterprise_id',
  'gitlab_group',
  'gitlab_url',
  'generic_issuer',
  'generic_anchor_claims',
  'generic_pin_claim',
  'generic_pin_value',
];

export function blankConsumerForm(type?: string | null): ConsumerForm {
  const form = Object.fromEntries(KEYS.map((key) => [key, ''])) as unknown as ConsumerForm;
  form.type = CONSUMER_TYPES.includes(type as ProfileId) ? (type as string) : 'github-actions';
  return form;
}

export function readConsumerForm(fields: Fields, prefix: string): ConsumerForm {
  const form = Object.fromEntries(
    KEYS.map((key) => [key, text(fields, `${prefix}${key}`)]),
  ) as unknown as ConsumerForm;
  return form;
}

/** https with no user info, query or fragment; `origin` also refuses a path. */
function httpsError(raw: string, origin: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'is not a URL';
  }
  if (url.protocol !== 'https:' || !raw.startsWith('https://')) return 'must start with https://';
  if (url.username || url.password || raw.includes('?') || raw.includes('#')) {
    return 'must not have user:password@, a query or a fragment';
  }
  if (origin && url.pathname !== '/' && url.pathname !== '') return 'must not have a path';
  return null;
}

/** The ConsumerInput the fields describe, or the field errors (names prefixed). */
export function parseConsumerForm(
  form: ConsumerForm,
  prefix: string,
): { ok: true; input: ConsumerInput } | { ok: false; errors: FieldError[] } {
  const field = (name: keyof ConsumerForm) => `${prefix}${name}`;
  const errors: FieldError[] = [];
  const type = CONSUMER_TYPES.find((id) => id === form.type);
  if (!type)
    return { ok: false, errors: [{ field: field('type'), message: 'Choose a consumer type.' }] };
  if (type === 'github-actions') {
    const orgs = parseOwnerList(form.github_org, { id: type });
    if (!orgs.ok) errors.push({ field: field('github_org'), message: orgs.message });
    const slug = form.github_enterprise_slug.trim();
    if (slug !== '' && !/^[a-z0-9-]{1,100}$/.test(slug)) {
      errors.push({
        field: field('github_enterprise_slug'),
        message: 'Enter the enterprise slug in lower case, like acme-corp.',
      });
    }
    const enterpriseId = form.github_enterprise_id.trim();
    if (enterpriseId !== '' && !/^[0-9]{1,20}$/.test(enterpriseId)) {
      errors.push({
        field: field('github_enterprise_id'),
        message: 'Enter the numeric enterprise ID, like 12345.',
      });
    }
    if (errors.length > 0 || !orgs.ok) return { ok: false, errors };
    return {
      ok: true,
      input: {
        profile: type,
        issuer: slug === '' ? GITHUB_ACTIONS_ISSUER : `${GITHUB_ACTIONS_ISSUER}/${slug}`,
        tenants: orgs.entries.map((entry) => ({ value: entry.id, label: entry.label })),
        ...(enterpriseId === '' ? {} : { enterprise_id: enterpriseId }),
      },
    };
  }
  if (type === 'gitlab-ci') {
    const groups = parseOwnerList(form.gitlab_group, { id: type });
    if (!groups.ok) errors.push({ field: field('gitlab_group'), message: groups.message });
    const url = form.gitlab_url.trim().replace(/\/$/, '');
    const urlError = url === '' ? null : httpsError(url, true);
    if (urlError !== null) {
      errors.push({
        field: field('gitlab_url'),
        message: `The GitLab URL ${urlError}: enter it like https://gitlab.example.com.`,
      });
    }
    if (errors.length > 0 || !groups.ok) return { ok: false, errors };
    return {
      ok: true,
      input: {
        profile: type,
        issuer: url === '' ? GITLAB_COM_ISSUER : url,
        tenants: groups.entries.map((entry) => ({ value: entry.id, label: entry.label })),
      },
    };
  }
  const issuer = form.generic_issuer.trim();
  const issuerError = issuer === '' ? 'is required' : httpsError(issuer, false);
  if (issuerError !== null) {
    errors.push({
      field: field('generic_issuer'),
      message:
        issuer === ''
          ? 'Enter the issuer URL, like https://agent.buildkite.com.'
          : `The issuer ${issuerError}: enter it like https://agent.buildkite.com.`,
    });
  }
  const preset = presetFor(issuer);
  const anchors = (form.generic_anchor_claims.trim() || preset?.anchor || 'sub')
    .split(',')
    .map((claim) => claim.trim())
    .filter((claim) => claim !== '');
  if (
    anchors.length === 0 ||
    anchors.length > 8 ||
    new Set(anchors).size !== anchors.length ||
    anchors.some((claim) => claim.length > CLAIM_NAME_MAX_LENGTH)
  ) {
    errors.push({
      field: field('generic_anchor_claims'),
      message: 'Enter 1 to 8 different claim names, separated by commas, like pipeline_id.',
    });
  }
  const pinValue = form.generic_pin_value.trim();
  const pinClaim = form.generic_pin_claim.trim() || (pinValue !== '' ? (preset?.pin ?? '') : '');
  if (pinClaim !== '' && pinValue === '') {
    errors.push({ field: field('generic_pin_value'), message: `Enter the value of ${pinClaim}.` });
  }
  if (pinValue !== '' && pinClaim === '') {
    errors.push({
      field: field('generic_pin_claim'),
      message: 'Enter the claim name for this value, like organization_id.',
    });
  }
  if (pinClaim.length > CLAIM_NAME_MAX_LENGTH || pinValue.length > 512) {
    errors.push({ field: field('generic_pin_value'), message: 'Use at most 512 characters.' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: {
      profile: 'generic',
      issuer,
      tenants: [],
      anchor_claims: anchors,
      pin: pinClaim === '' ? null : { claim: pinClaim, value: pinValue },
    },
  };
}

function presetFor(issuer: string): (typeof GENERIC_PRESETS)[number] | null {
  try {
    const host = new URL(issuer).host;
    return GENERIC_PRESETS.find((preset) => preset.host === host) ?? null;
  } catch {
    return null;
  }
}

/** The fields. `jobs` puts a type's "Which jobs" fieldset inside its reveal (access form). */
export function AddConsumerFields(props: {
  prefix: string;
  form: ConsumerForm;
  errors: readonly FieldError[];
  /** Existing consumers: a GitHub or GitLab add merges into the one of the same issuer. */
  existing: readonly CallerProvider[];
  /** Existing generic anchor claims, offered as suggestions. */
  anchorSuggestions?: readonly string[];
  jobs?: Partial<Record<ProfileId, Child>>;
  legend?: string;
}) {
  const { prefix, form } = props;
  const error = (name: keyof ConsumerForm) =>
    props.errors.find((item) => item.field === `${prefix}${name}`)?.message ?? null;
  const github = props.existing.find(
    (provider) =>
      provider.profile === 'github-actions' && provider.issuer === GITHUB_ACTIONS_ISSUER,
  );
  const gitlab = props.existing.find(
    (provider) => provider.profile === 'gitlab-ci' && provider.issuer === GITLAB_COM_ISSUER,
  );
  const genericIssuers = props.existing.filter((provider) => provider.profile === 'generic');
  return (
    <RadioCards
      name={`${prefix}type`}
      legend={props.legend ?? 'Consumer type'}
      value={form.type}
      error={error('type')}
      options={CONSUMER_TYPES.map((type) => ({
        value: type,
        title: TYPE_INFO[type].title,
        description: TYPE_INFO[type].description,
        reveal: (
          <>
            {type === 'github-actions' ? (
              <>
                <IdWithLabelField
                  kind="github_owner_list"
                  name={`${prefix}github_org`}
                  label="Organizations"
                  value={form.github_org}
                  example="acme (1234567), acme-labs (7654321)"
                  findCommand={ownerFindCommand({ id: type })}
                  hint="Organizations or user accounts that own the calling repositories, as name (ID). Separate several with commas."
                  error={error('github_org')}
                  autocomplete="off"
                  conditional
                />
                {github ? (
                  <p class="hint">
                    <a href={paths.consumer(github.id)}>{github.name}</a> already exists. Saving
                    adds these organizations to it{github.enabled ? '' : ' (disabled)'}.
                  </p>
                ) : null}
                <details
                  open={
                    form.github_enterprise_slug !== '' ||
                    form.github_enterprise_id !== '' ||
                    error('github_enterprise_slug') !== null ||
                    error('github_enterprise_id') !== null
                  }
                >
                  <summary>GitHub Enterprise Cloud with its own issuer</summary>
                  <Field
                    name={`${prefix}github_enterprise_slug`}
                    label="Enterprise slug"
                    optional
                    value={form.github_enterprise_slug}
                    example="acme-corp"
                    hint={
                      <>
                        Only for GitHub Enterprise Cloud with its own OIDC issuer (
                        <code>{GITHUB_ACTIONS_ISSUER}/acme-corp</code>).
                      </>
                    }
                    error={error('github_enterprise_slug')}
                    autocomplete="off"
                    spellcheck={false}
                    autocapitalize="none"
                    conditional
                  />
                  <Field
                    name={`${prefix}github_enterprise_id`}
                    label="Enterprise ID"
                    optional
                    value={form.github_enterprise_id}
                    example="12345"
                    inputmode="numeric"
                    hint={
                      <>
                        An extra pin:{' '}
                        <code>
                          {
                            'gh api graphql -f query=\'{enterprise(slug:"acme-corp"){databaseId}}\' --jq .data.enterprise.databaseId'
                          }
                        </code>
                      </>
                    }
                    error={error('github_enterprise_id')}
                    autocomplete="off"
                    conditional
                  />
                </details>
              </>
            ) : type === 'gitlab-ci' ? (
              <>
                <IdWithLabelField
                  kind="gitlab_group_list"
                  name={`${prefix}gitlab_group`}
                  label="Groups"
                  value={form.gitlab_group}
                  example="acme-group (5678901), acme-group/platform (5678902)"
                  findCommand={ownerFindCommand({ id: type })}
                  hint="The token names the project's direct group. Separate several with commas."
                  error={error('gitlab_group')}
                  autocomplete="off"
                  conditional
                />
                {gitlab ? (
                  <p class="hint">
                    <a href={paths.consumer(gitlab.id)}>{gitlab.name}</a> already exists. Saving
                    adds these groups to it{gitlab.enabled ? '' : ' (disabled)'}.
                  </p>
                ) : null}
                <details open={form.gitlab_url !== '' || error('gitlab_url') !== null}>
                  <summary>Self-managed GitLab</summary>
                  <Field
                    name={`${prefix}gitlab_url`}
                    label="GitLab URL"
                    optional
                    type="url"
                    value={form.gitlab_url}
                    example="https://gitlab.example.com"
                    hint="Only for self-managed GitLab: your instance URL."
                    error={error('gitlab_url')}
                    autocomplete="off"
                    spellcheck={false}
                    autocapitalize="none"
                    conditional
                  />
                </details>
              </>
            ) : (
              <>
                <Field
                  name={`${prefix}generic_issuer`}
                  label="Issuer"
                  type="url"
                  value={form.generic_issuer}
                  example="https://agent.buildkite.com"
                  suggestions={GENERIC_ISSUER_EXAMPLES.map((value) => ({ value }))}
                  hint={
                    <>
                      The <code>iss</code> claim of the tokens. When you save, the gateway reads{' '}
                      <code>&lt;issuer&gt;/.well-known/openid-configuration</code>.
                      {genericIssuers.length > 0
                        ? ` Already added: ${genericIssuers.map((p) => p.issuer).join(', ')}.`
                        : ''}
                    </>
                  }
                  error={error('generic_issuer')}
                  autocomplete="off"
                  spellcheck={false}
                  autocapitalize="none"
                  conditional
                />
                <Field
                  name={`${prefix}generic_anchor_claims`}
                  label="Anchor claims"
                  optional
                  value={form.generic_anchor_claims}
                  example="pipeline_id"
                  suggestions={[
                    ...new Set([
                      ...(props.anchorSuggestions ?? []),
                      ...GENERIC_PRESETS.map((preset) => preset.anchor),
                      'sub',
                    ]),
                  ].map((value) => ({ value }))}
                  hint="Claims that identify one workload exactly, comma-separated. Buildkite: pipeline_id. CircleCI: oidc.circleci.com/project-id. Kubernetes: sub. Empty: the issuer's usual claim, else sub."
                  error={error('generic_anchor_claims')}
                  autocomplete="off"
                  spellcheck={false}
                  autocapitalize="none"
                  conditional
                />
                <Field
                  name={`${prefix}generic_pin_claim`}
                  label="Pin claim"
                  optional
                  value={form.generic_pin_claim}
                  example="organization_id"
                  suggestions={GENERIC_PRESETS.map((preset) => ({ value: preset.pin }))}
                  hint="Recommended: a claim that every token of your organization carries."
                  error={error('generic_pin_claim')}
                  autocomplete="off"
                  spellcheck={false}
                  autocapitalize="none"
                  conditional
                />
                <Field
                  name={`${prefix}generic_pin_value`}
                  label="Pin value"
                  optional
                  value={form.generic_pin_value}
                  example="0c9f3e1a-7b2d-4c5e-9f10-123456789abc"
                  hint={
                    <>
                      Exact value of that claim. <strong>Risk:</strong> without a pin, every token
                      this issuer signs for this audience reaches access evaluation.
                    </>
                  }
                  error={error('generic_pin_value')}
                  autocomplete="off"
                  spellcheck={false}
                  autocapitalize="none"
                  conditional
                />
              </>
            )}
            {props.jobs?.[type] ?? null}
          </>
        ),
      }))}
    />
  );
}
