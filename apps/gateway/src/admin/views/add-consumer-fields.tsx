// "Add a consumer" fields (A14.1, A14.7.1), shared by /admin/consumers/new and the access form
// (prefix `new.`): the type as logo cards and each type's few inputs in its branch. Everything else
// (name, issuer, JWKS, algorithms, token age, audience) is derived, and the Add consumer rail says
// so (SetForYou). Every input sits in a hidden branch, so none carries native validation (A7.6);
// the server checks them.
import {
  Badge,
  Button,
  Callout,
  FieldSet,
  type LogoSpec,
  More,
  Panel,
  RadioCards,
  RailKeyValue,
  Reveal,
  Tray,
} from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import { labelFor } from '../../db/claim-labels';
import type { CallerProvider, ClaimLabel } from '../../db/types';
import { PROFILES } from '../../identity/profiles';
import { GITHUB_ACTIONS_ISSUER } from '../../identity/profiles/github-actions';
import { GITLAB_COM_ISSUER } from '../../identity/profiles/gitlab-ci';
import type { ProfileId } from '../../identity/types';
import { CLAIM_NAME_MAX_LENGTH } from '../../policy/conditions';
import { type Fields, idText, ownerFindCommand, parseOwnerList, text } from '../consumer-access';
import { type ConsumerInput, pinValues, tenantClaimOf } from '../ops/caller-providers';
import type { FieldError } from '../ops/shared';
import { paths } from '../paths';
import { Breakable, useFocusTarget } from './access-visuals';
import { Field, fieldId, IdWithLabelField } from './components';

export const CONSUMER_TYPES: readonly ProfileId[] = ['github-actions', 'gitlab-ci', 'generic'];

const TYPE_INFO: Readonly<
  Record<ProfileId, { title: string; description: string; logo: LogoSpec }>
> = {
  'github-actions': {
    title: 'GitHub Actions',
    description: 'Workflows in GitHub repositories',
    logo: 'github',
  },
  'gitlab-ci': {
    title: 'GitLab CI',
    description: 'Pipelines on GitLab.com or your own GitLab',
    logo: 'gitlab',
  },
  generic: {
    title: 'Generic OIDC',
    description: 'Buildkite, CircleCI, Kubernetes or any OIDC issuer',
    logo: 'oidc',
  },
};

/** Known generic issuers: anchor and pin claims to use when the fields are left empty. */
export const GENERIC_PRESETS: ReadonlyArray<{ host: string; anchor: string; pin: string }> = [
  { host: 'agent.buildkite.com', anchor: 'pipeline_id', pin: 'organization_id' },
  {
    host: 'oidc.circleci.com',
    anchor: 'oidc.circleci.com/project-id',
    pin: 'oidc.circleci.com/org-id',
  },
];

/** Anchor claim suggestions: those of the existing generic consumers, the presets, then `sub`. */
export function genericAnchorSuggestions(consumers: readonly CallerProvider[]): string[] {
  return [
    ...new Set([
      ...consumers
        .filter((consumer) => consumer.profile === 'generic')
        .flatMap((consumer) => consumer.anchor_claims),
      ...GENERIC_PRESETS.map((preset) => preset.anchor),
      'sub',
    ]),
  ];
}

/** "acme (1234567), acme-labs (7654321)": the organizations or groups a consumer already has. */
function alreadyAdded(provider: CallerProvider, labels: readonly ClaimLabel[]): string {
  const claim = tenantClaimOf(provider.profile);
  if (claim === null) return '';
  return pinValues(provider.tenant_pin, claim)
    .map((value) => idText(value, labelFor(labels, claim, value)))
    .join(', ');
}

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

/** How the type cards take part in the form: a live slot of the page, or a scoped branch. */
export type ConsumerFieldsLive = 1 | 'scoped';

/** The existing consumers a GitHub or GitLab add merges into (the one of the same issuer). */
function mergeTargets(existing: readonly CallerProvider[]) {
  return {
    github: existing.find(
      (provider) =>
        provider.profile === 'github-actions' && provider.issuer === GITHUB_ACTIONS_ISSUER,
    ),
    gitlab: existing.find(
      (provider) => provider.profile === 'gitlab-ci' && provider.issuer === GITLAB_COM_ISSUER,
    ),
  };
}

/**
 * The fields. The type is a FieldSet of logo cards; each type's inputs sit in its branch: a ui
 * Reveal of live slot 1 on the Add consumer page, a scoped branch (`.ga-tbranch`, page-local CSS)
 * in the access form, where `jobs` adds the type's "Which jobs" fields after its inputs.
 */
export function AddConsumerFields(props: {
  prefix: string;
  form: ConsumerForm;
  errors: readonly FieldError[];
  /** Existing consumers: a GitHub or GitLab add merges into the one of the same issuer. */
  existing: readonly CallerProvider[];
  /** Labels of the existing consumers, for the organizations and groups they already have. */
  labels?: readonly ClaimLabel[];
  /** Existing generic anchor claims, offered as suggestions. */
  anchorSuggestions?: readonly string[];
  jobs?: Partial<Record<ProfileId, Child>>;
  legend?: string;
  live?: ConsumerFieldsLive;
}) {
  const { prefix, form } = props;
  const scoped = props.live === 'scoped';
  const error = (name: keyof ConsumerForm) =>
    props.errors.find((item) => item.field === `${prefix}${name}`)?.message ?? null;
  const { github, gitlab } = mergeTargets(props.existing);
  const genericIssuers = props.existing.filter((provider) => provider.profile === 'generic');
  const labelsOf = (provider: CallerProvider) =>
    (props.labels ?? []).filter((label) => label.caller_provider_id === provider.id);
  const typeId = fieldId(`${prefix}type`);
  const options = CONSUMER_TYPES.map((type, index) => ({
    value: type,
    o: index + 1,
    logo: TYPE_INFO[type].logo,
    title: TYPE_INFO[type].title,
    description:
      type === 'generic' ? (
        <>
          {TYPE_INFO[type].description}
          <span class="d-block con-preset">
            <Badge tone="accent">Presets: Buildkite, CircleCI</Badge>
          </span>
        </>
      ) : (
        TYPE_INFO[type].description
      ),
  }));
  useFocusTarget(`${prefix}type`, { id: typeId, options });
  const typeError = error('type');
  const branch = (type: ProfileId, children: Child) => {
    const o = CONSUMER_TYPES.indexOf(type) + 1;
    return scoped ? (
      <div class="ga-tbranch subbox" data-o={String(o)}>
        {children}
      </div>
    ) : (
      <Reveal field={1} option={o} box={false} class="con-fields">
        {children}
      </Reveal>
    );
  };
  const jobsBranch = (type: ProfileId) =>
    scoped && props.jobs?.[type] ? (
      <div class="ga-tbranch ga-scope" data-o={String(CONSUMER_TYPES.indexOf(type) + 1)}>
        {props.jobs[type]}
      </div>
    ) : null;
  return (
    <>
      <FieldSet
        id={typeId}
        legend={props.legend ?? 'Where do the jobs run?'}
        live={scoped ? undefined : 1}
        class={scoped ? 'ga-tf con-types' : 'con-types'}
        error={typeError}
      >
        <RadioCards
          name={`${prefix}type`}
          columns={3}
          value={form.type}
          invalid={typeError ? true : undefined}
          options={options}
        />
      </FieldSet>
      {branch(
        'github-actions',
        <>
          {github ? (
            <Callout
              title={`${github.name} already exists.`}
              actions={
                <Button size="sm" href={paths.consumer(github.id)} srSuffix={github.name}>
                  Open it
                </Button>
              }
            >
              Saving adds these organizations to it{github.enabled ? '' : ' (disabled)'}. Already
              added: {alreadyAdded(github, labelsOf(github)) || 'none'}.
            </Callout>
          ) : null}
          <IdWithLabelField
            kind="github_owner_list"
            name={`${prefix}github_org`}
            label="Organizations"
            value={form.github_org}
            example="acme (1234567), acme-labs (7654321)"
            findCommand={ownerFindCommand({ id: 'github-actions' })}
            hint="The ID keeps working after a rename. Separate several with commas."
            error={error('github_org')}
            autocomplete="off"
            conditional
          />
          <More
            summary="GitHub Enterprise Cloud with its own issuer"
            open={
              form.github_enterprise_slug !== '' ||
              form.github_enterprise_id !== '' ||
              error('github_enterprise_slug') !== null ||
              error('github_enterprise_id') !== null
            }
          >
            <Field
              name={`${prefix}github_enterprise_slug`}
              label="Enterprise slug"
              optional
              mono
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
          </More>
        </>,
      )}
      {jobsBranch('github-actions')}
      {branch(
        'gitlab-ci',
        <>
          {gitlab ? (
            <Callout
              title={`${gitlab.name} already exists.`}
              actions={
                <Button size="sm" href={paths.consumer(gitlab.id)} srSuffix={gitlab.name}>
                  Open it
                </Button>
              }
            >
              Saving adds these groups to it{gitlab.enabled ? '' : ' (disabled)'}. Already added:{' '}
              {alreadyAdded(gitlab, labelsOf(gitlab)) || 'none'}.
            </Callout>
          ) : null}
          <IdWithLabelField
            kind="gitlab_group_list"
            name={`${prefix}gitlab_group`}
            label="Groups"
            value={form.gitlab_group}
            example="acme-group (5678901), acme-group/platform (5678902)"
            findCommand={ownerFindCommand({ id: 'gitlab-ci' })}
            hint="The token names the project's direct group. Separate several with commas."
            error={error('gitlab_group')}
            autocomplete="off"
            conditional
          />
          <More
            summary="Self-managed GitLab"
            open={form.gitlab_url !== '' || error('gitlab_url') !== null}
          >
            <Field
              name={`${prefix}gitlab_url`}
              label="GitLab URL"
              optional
              mono
              type="url"
              value={form.gitlab_url}
              example="https://gitlab.example.com"
              hint="Leave empty for gitlab.com. Format: https:// and the host."
              error={error('gitlab_url')}
              autocomplete="off"
              conditional
            />
          </More>
        </>,
      )}
      {jobsBranch('gitlab-ci')}
      {branch(
        'generic',
        <>
          <Field
            name={`${prefix}generic_issuer`}
            label="Issuer"
            type="url"
            mono
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
            conditional
          />
          <More
            summary="Anchor and pin claims"
            meta="derived from the preset"
            open={
              form.generic_anchor_claims !== '' ||
              form.generic_pin_claim !== '' ||
              form.generic_pin_value !== '' ||
              error('generic_anchor_claims') !== null ||
              error('generic_pin_claim') !== null ||
              error('generic_pin_value') !== null
            }
          >
            <Field
              name={`${prefix}generic_anchor_claims`}
              label="Anchor claims"
              optional
              mono
              value={form.generic_anchor_claims}
              example="pipeline_id"
              suggestions={(
                props.anchorSuggestions ?? genericAnchorSuggestions(props.existing)
              ).map((value) => ({ value }))}
              hint="Claims that identify one workload exactly, comma-separated. Buildkite: pipeline_id. CircleCI: oidc.circleci.com/project-id. Kubernetes: sub. Empty: the issuer's usual claim, else sub."
              error={error('generic_anchor_claims')}
              autocomplete="off"
              conditional
            />
            <Field
              name={`${prefix}generic_pin_claim`}
              label="Pin claim"
              optional
              mono
              value={form.generic_pin_claim}
              example="organization_id"
              suggestions={GENERIC_PRESETS.map((preset) => ({ value: preset.pin }))}
              hint="Recommended: a claim that every token of your organization carries."
              error={error('generic_pin_claim')}
              autocomplete="off"
              conditional
            />
            <Field
              name={`${prefix}generic_pin_value`}
              label="Pin value"
              optional
              mono
              value={form.generic_pin_value}
              example="0c9f3e1a-7b2d-4c5e-9f10-123456789abc"
              hint={
                <>
                  Exact value of that claim. <strong>Risk:</strong> without a pin, every token this
                  issuer signs for this audience reaches access evaluation.
                </>
              }
              error={error('generic_pin_value')}
              autocomplete="off"
              conditional
            />
          </More>
        </>,
      )}
      {jobsBranch('generic')}
    </>
  );
}

/**
 * The rail of the Add consumer page: what tokengate derives for the chosen type, so the form asks
 * only for what it cannot derive. One Reveal of live slot 1 per type.
 */
export function SetForYou(props: { existing: readonly CallerProvider[] }) {
  const { github, gitlab } = mergeTargets(props.existing);
  const age = (type: ProfileId) => `${PROFILES[type].defaults.maxTokenAgeSeconds / 60} minutes`;
  const keys = 'Read from the issuer, refreshed automatically';
  const audience = (existing: CallerProvider | undefined) =>
    existing
      ? { label: 'Audience', value: <Breakable text={existing.audience} />, mono: true }
      : { label: 'Audience', value: 'A new value only for this consumer' };
  return (
    <aside class="rail" aria-labelledby="ad-set-h">
      <Tray
        id="ad-set"
        title="Set for you"
        description="Derived from the type. You can change them later under Advanced trust settings."
      >
        <Panel>
          <Reveal field={1} option={1} box={false}>
            <RailKeyValue
              items={[
                github
                  ? {
                      label: 'Name',
                      value: github.name,
                      note: 'Kept. The new organizations join it.',
                    }
                  : { label: 'Name', value: 'GitHub Actions (first organization)' },
                { label: 'Issuer', value: <Breakable text={GITHUB_ACTIONS_ISSUER} />, mono: true },
                { label: 'Signing keys', value: keys },
                audience(github),
                { label: 'Max token age', value: age('github-actions') },
              ]}
            />
          </Reveal>
          <Reveal field={1} option={2} box={false}>
            <RailKeyValue
              items={[
                gitlab
                  ? { label: 'Name', value: gitlab.name, note: 'Kept. The new groups join it.' }
                  : { label: 'Name', value: 'GitLab (first group)' },
                {
                  label: 'Issuer',
                  value: GITLAB_COM_ISSUER,
                  mono: true,
                  note: 'Or your GitLab URL (self-managed)',
                },
                { label: 'Signing keys', value: keys },
                audience(gitlab),
                { label: 'Max token age', value: age('gitlab-ci') },
              ]}
            />
          </Reveal>
          <Reveal field={1} option={3} box={false}>
            <RailKeyValue
              items={[
                { label: 'Name', value: 'From the issuer host' },
                { label: 'Signing keys', value: keys },
                { label: 'Audience', value: 'A new value only for this consumer' },
                { label: 'Max token age', value: age('generic') },
              ]}
            />
          </Reveal>
        </Panel>
      </Tray>
    </aside>
  );
}
