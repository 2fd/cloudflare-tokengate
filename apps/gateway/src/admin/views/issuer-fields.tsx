// The issuer fields of the credential access rule form (A14.1, A14.7.1, prefix `new.`): the issuer type as
// logo cards (IssuerCards, shared with the global access rule form) and each type's few inputs in its
// branch: organizations or groups (the tenant pin, I-TEN-1), a GitHub Enterprise or self-managed
// GitLab issuer, or a generic issuer with its anchor and pin claims. The token settings (JWKS,
// algorithms, token age, audience) are derived and sit in the form's "Token settings" disclosure.
// Every input sits in a hidden branch, so none carries native validation (A7.6); the server checks
// them.
import { Badge, FieldSet, type LogoSpec, More, RadioCards, Reveal } from '@tokengate/ui';
import type { Child } from 'hono/jsx';
import { labelFor } from '../../db/claim-labels';
import type { ClaimLabel, CredentialAccessRule } from '../../db/types';
import { GITHUB_ACTIONS_ISSUER } from '../../identity/profiles/github-actions';
import { GITLAB_COM_ISSUER } from '../../identity/profiles/gitlab-ci';
import type { ProfileId } from '../../identity/types';
import { CLAIM_NAME_MAX_LENGTH } from '../../policy/conditions';
import type { Condition } from '../../policy/types';
import {
  pinValues,
  type RuleLabel,
  type TenantEntry,
  tenantClaimOf,
} from '../ops/credential-access-rules';
import type { FieldError } from '../ops/shared';
import { type Fields, ownerFindCommand, parseOwnerList, text } from '../rule-access';
import { useFocusTarget } from './access-visuals';
import { Field, fieldId, IdWithLabelField } from './components';

export const ISSUER_TYPES: readonly ProfileId[] = ['github-actions', 'gitlab-ci', 'generic'];

export const TYPE_INFO: Readonly<
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

/** Anchor claim suggestions: those of the existing generic rules, the presets, then `sub`. */
export function genericAnchorSuggestions(rules: readonly CredentialAccessRule[]): string[] {
  return [
    ...new Set([
      ...rules
        .filter((rule) => rule.profile === 'generic')
        .flatMap((rule) => rule.anchor_claims.filter((claim) => claim !== '')),
      ...GENERIC_PRESETS.map((preset) => preset.anchor),
      'sub',
    ]),
  ];
}

export const GENERIC_ISSUER_EXAMPLES: readonly string[] = [
  'https://agent.buildkite.com',
  'https://oidc.circleci.com/org/0c9f3e1a-7b2d-4c5e-9f10-123456789abc',
];

/** Raw values of the issuer fields, kept as text for a re-render. */
export interface IssuerForm {
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

const KEYS: ReadonlyArray<keyof IssuerForm> = [
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

export function blankIssuerForm(type?: string | null): IssuerForm {
  const form = Object.fromEntries(KEYS.map((key) => [key, ''])) as unknown as IssuerForm;
  form.type = ISSUER_TYPES.includes(type as ProfileId) ? (type as string) : 'github-actions';
  return form;
}

export function readIssuerForm(fields: Fields, prefix: string): IssuerForm {
  const form = Object.fromEntries(
    KEYS.map((key) => [key, text(fields, `${prefix}${key}`)]),
  ) as unknown as IssuerForm;
  return form;
}

/** What the issuer fields describe. */
export interface IssuerInput {
  profile: ProfileId;
  /** The exact issuer: the platform default, a GitHub Enterprise slug issuer, or as typed. */
  issuer: string;
  /** Organizations (GitHub) or groups (GitLab), at least one; generic: none. */
  tenants: TenantEntry[];
  /** GitHub Enterprise ID, an extra pin; empty for none. */
  enterprise_id?: string;
  /** Generic only. */
  anchor_claims?: string[];
  /** Generic only: one exact pin condition, or null. */
  pin?: { claim: string; value: string } | null;
}

/** The tenant pin and the labels of its IDs that an issuer input stands for (I-TEN-1). */
export function issuerPin(input: IssuerInput): { tenant_pin: Condition[]; labels: RuleLabel[] } {
  const claim = tenantClaimOf(input.profile);
  const pin: Condition[] = [];
  if (claim !== null && input.tenants.length > 0) {
    pin.push({ claim, match: 'exact', values: [...new Set(input.tenants.map((t) => t.value))] });
  }
  if (input.profile === 'github-actions' && input.enterprise_id) {
    pin.push({ claim: 'enterprise_id', match: 'exact', values: [input.enterprise_id] });
  }
  if (input.profile === 'generic' && input.pin) {
    pin.push({ claim: input.pin.claim, match: 'exact', values: [input.pin.value] });
  }
  return {
    tenant_pin: pin,
    labels:
      claim === null
        ? []
        : input.tenants.map((entry) => ({ claim, value: entry.value, label: entry.label })),
  };
}

/** The issuer fields of a stored rule (edit, copy): its type, tenants with labels and issuer. */
export function issuerFormFromRule(
  rule: Pick<CredentialAccessRule, 'profile' | 'issuer' | 'tenant_pin' | 'anchor_claims'>,
  labels: readonly ClaimLabel[],
): IssuerForm {
  const form = blankIssuerForm(rule.profile);
  const claim = tenantClaimOf(rule.profile);
  const pin = rule.tenant_pin.filter((c) => typeof c === 'object' && c !== null);
  const tenants =
    claim === null
      ? ''
      : pinValues(pin, claim)
          .map((value) => {
            const label = labelFor(labels, claim, value);
            return label ? `${label} (${value})` : value;
          })
          .join(', ');
  if (rule.profile === 'github-actions') {
    form.github_org = tenants;
    const slug = rule.issuer.startsWith(`${GITHUB_ACTIONS_ISSUER}/`)
      ? rule.issuer.slice(GITHUB_ACTIONS_ISSUER.length + 1)
      : '';
    form.github_enterprise_slug = slug;
    form.github_enterprise_id = pinValues(pin, 'enterprise_id')[0] ?? '';
  } else if (rule.profile === 'gitlab-ci') {
    form.gitlab_group = tenants;
    form.gitlab_url = rule.issuer.replace(/\/$/, '') === GITLAB_COM_ISSUER ? '' : rule.issuer;
  } else {
    form.generic_issuer = rule.issuer;
    form.generic_anchor_claims = rule.anchor_claims.join(', ');
    const [first] = pin;
    if (first) {
      form.generic_pin_claim = first.claim;
      form.generic_pin_value = first.values[0] ?? '';
    }
  }
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

/** The IssuerInput the fields describe, or the field errors (names prefixed). */
export function parseIssuerForm(
  form: IssuerForm,
  prefix: string,
): { ok: true; input: IssuerInput } | { ok: false; errors: FieldError[] } {
  const field = (name: keyof IssuerForm) => `${prefix}${name}`;
  const errors: FieldError[] = [];
  const type = ISSUER_TYPES.find((id) => id === form.type);
  if (!type)
    return {
      ok: false,
      errors: [{ field: field('type'), message: 'Choose where the jobs run.' }],
    };
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
export type IssuerFieldsLive = 1 | 'scoped';

/**
 * The issuer type as logo cards (`name` = `${prefix}type`). `fixed` shows only the card of a stored
 * type (an edit: the profile never changes), still checked, so its branch stays open.
 */
export function IssuerCards(props: {
  prefix: string;
  value: string;
  error: string | null;
  legend?: string;
  live?: IssuerFieldsLive;
  fixed?: boolean;
}) {
  const { prefix } = props;
  const scoped = props.live === 'scoped';
  const typeId = fieldId(`${prefix}type`);
  const options = ISSUER_TYPES.map((type, index) => ({
    value: type,
    o: index + 1,
    logo: TYPE_INFO[type].logo,
    title: TYPE_INFO[type].title,
    description:
      type === 'generic' && !props.fixed ? (
        <>
          {TYPE_INFO[type].description}
          <span class="d-block con-preset">
            <Badge tone="accent">Presets: Buildkite, CircleCI</Badge>
          </span>
        </>
      ) : (
        TYPE_INFO[type].description
      ),
  })).filter((option) => !props.fixed || option.value === props.value);
  useFocusTarget(`${prefix}type`, { id: typeId, options });
  return (
    <FieldSet
      id={typeId}
      legend={props.legend ?? 'Where do the jobs run?'}
      live={scoped ? undefined : 1}
      class={scoped ? 'ga-tf con-types' : 'con-types'}
      error={props.error}
      hint={props.fixed ? 'The issuer type of a rule cannot change.' : undefined}
    >
      <RadioCards
        name={`${prefix}type`}
        columns={props.fixed ? 1 : 3}
        value={props.value}
        invalid={props.error ? true : undefined}
        options={options}
      />
    </FieldSet>
  );
}

/**
 * The fields. The type is IssuerCards; each type's inputs sit in its branch: a ui Reveal of live
 * slot 1 on a page of its own, or a scoped branch (`.ga-tbranch`, page-local CSS) in the rule form,
 * where `jobs` adds the type's "Which jobs" fields after its inputs.
 */
export function IssuerFields(props: {
  prefix: string;
  form: IssuerForm;
  errors: readonly FieldError[];
  /** Other credential access rules, used only for suggestions. */
  existing: readonly CredentialAccessRule[];
  /** Existing generic anchor claims, offered as suggestions. */
  anchorSuggestions?: readonly string[];
  jobs?: Partial<Record<ProfileId, Child>>;
  legend?: string;
  live?: IssuerFieldsLive;
  /** Edit: the stored type, the only card shown. */
  fixedType?: boolean;
}) {
  const { prefix, form } = props;
  const scoped = props.live === 'scoped';
  const error = (name: keyof IssuerForm) =>
    props.errors.find((item) => item.field === `${prefix}${name}`)?.message ?? null;
  const genericIssuers = [
    ...new Set(
      props.existing.filter((rule) => rule.profile === 'generic').map((rule) => rule.issuer),
    ),
  ];
  const branch = (type: ProfileId, children: Child) => {
    const o = ISSUER_TYPES.indexOf(type) + 1;
    if (props.fixedType && type !== form.type) return null;
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
    scoped && props.jobs?.[type] && (!props.fixedType || type === form.type) ? (
      <div class="ga-tbranch ga-scope" data-o={String(ISSUER_TYPES.indexOf(type) + 1)}>
        {props.jobs[type]}
      </div>
    ) : null;
  return (
    <>
      <IssuerCards
        prefix={prefix}
        value={form.type}
        error={error('type')}
        legend={props.legend}
        live={props.live}
        fixed={props.fixedType}
      />
      {branch(
        'github-actions',
        <>
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
                {genericIssuers.length > 0 ? ` Already used: ${genericIssuers.join(', ')}.` : ''}
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
