// The consumer access form (A14.4): Consumer, Which jobs, Token, Allowed operations, Expires, and
// the risk acknowledgement when one is needed. A choice between several consumers or tokens is a
// set of radio cards whose reveals hold that choice's own fields, prefixed with its id, so hidden
// branches never share a field name and the server reads only the chosen one. The primary submit
// is the first submit in tree order; "Write conditions by hand", "Add 2 more rows" and "Show
// fields" are secondary submits after it (formnovalidate), and write nothing.
import type { Child } from 'hono/jsx';
import type { ConsumerSuggestions, RuleSet } from '../../db/suggestions';
import type { CallerProvider, ClaimLabel, Service } from '../../db/types';
import type { IssuerProfile, ProfileId } from '../../identity/types';
import { PROXY_METHODS } from '../../policy/types';
import {
  type AccessContext,
  anchorClaims,
  CONTEXT_INPUT,
  contextsFor,
  type ExpiryForm,
  hasCheckboxes,
  isNumericId,
  isPathInjected,
  type JobsForm,
  type OpsForm,
  ownerFindCommand,
  pinOwnerValues,
  repositoryFindCommand,
  repositoryFindCommandForId,
} from '../consumer-access';
import type { FieldError } from '../ops/shared';
import { REPO_PLACEHOLDER, type ServiceTemplate } from '../service-templates';
import {
  AddConsumerFields,
  type ConsumerForm,
  genericAnchorSuggestions,
} from './add-consumer-fields';
import {
  Checkbox,
  CheckboxGroup,
  Field,
  fieldId,
  IdWithLabelField,
  PostForm,
  RadioCards,
  Select,
  type Suggestion,
  VersionField,
} from './components';
import { formatTime } from './format';
import { AddRowsButton, BLANK_ROWS, RepeatingRows } from './rows';

export interface ConsumerBranch {
  provider: CallerProvider;
  profile: IssuerProfile;
  prefix: string;
  jobs: JobsForm;
  labels: ClaimLabel[];
  suggestions: ConsumerSuggestions;
  repositoryOptions: Suggestion[];
  /** The repository's organization or group prefix that is not pinned yet (new_owner). */
  unknownOwner: string | null;
  accessCount: number;
  /** Extra blank condition rows (after "Add 2 more rows"). */
  extraRows?: number;
}

export interface NewConsumerBranch {
  form: ConsumerForm;
  /** The "Which jobs" fieldset of each type, prefix `new.<type>.`. */
  jobs: Record<ProfileId, ConsumerBranch>;
}

export interface TokenBranch {
  token: Service;
  template: ServiceTemplate | null;
  ruleSets: RuleSet[];
  pathSuggestions: string[];
  prefix: string;
  ops: OpsForm;
  credential: string;
  extraRows?: number;
}

export type ConsumerChoice =
  | { kind: 'fixed'; branch: ConsumerBranch; changeHref: string | null; newHref: string | null }
  | { kind: 'cards'; branches: ConsumerBranch[]; selected: string; newBranch: NewConsumerBranch }
  | {
      kind: 'select';
      options: CallerProvider[];
      selected: string;
      branch: ConsumerBranch | null;
    }
  | { kind: 'new'; newBranch: NewConsumerBranch; existingHref: string | null };

export type TokenChoice =
  | { kind: 'fixed'; branch: TokenBranch; changeHref: string | null }
  | { kind: 'cards'; branches: TokenBranch[]; selected: string }
  | { kind: 'select'; options: Service[]; selected: string; branch: TokenBranch | null };

export interface AccessFormModel {
  action: string;
  csrf: string;
  mode: 'create' | 'edit';
  /** Edit: the access's version. */
  version?: string;
  consumer: ConsumerChoice;
  token: TokenChoice;
  existingConsumers: CallerProvider[];
  expiry: ExpiryForm;
  /** Edit: the stored expiry ("Keep"). */
  keep?: number | null;
  now: number;
  /** Warnings the admin must acknowledge on this render (A7.7). */
  ack: { digest: string; warnings: string[] } | null;
  errors: FieldError[];
  /** Hidden fields to carry (e.g. `from_request`, `copy`). */
  hidden?: Record<string, string>;
  /** Page-level focus: the first new row after "Add 2 more rows" (ErrorSummary and notices win). */
  focus?: { group: string; index: number } | null;
}

function errorFor(errors: readonly FieldError[], name: string): string | null {
  return errors.find((error) => error.field === name)?.message ?? null;
}

export function AccessForm(props: { model: AccessFormModel }) {
  const { model } = props;
  const err = (name: string) => errorFor(model.errors, name);
  const selectedJobs = selectedConsumerBranch(model.consumer);
  const selectedToken = selectedTokenBranch(model.token);
  const formId = model.mode === 'edit' ? 'access-edit' : 'access-form';
  return (
    <PostForm action={model.action} csrf={model.csrf} class="stack access-form" id={formId}>
      {model.version !== undefined ? <VersionField value={model.version} /> : null}
      {Object.entries(model.hidden ?? {}).map(([name, value]) => (
        <input type="hidden" name={name} value={value} />
      ))}
      {model.mode === 'create' ? <ConsumerFieldset model={model} /> : null}
      {model.mode === 'edit' && model.consumer.kind === 'fixed' ? (
        // The edit form sits in a <details> that is closed by default: no native validation.
        <JobsFieldset branch={model.consumer.branch} errors={model.errors} focus={model.focus} />
      ) : null}
      {model.mode === 'create' ? <TokenFieldset model={model} /> : null}
      {model.mode === 'edit' && model.token.kind === 'fixed' ? (
        <OpsFieldset
          branch={model.token.branch}
          errors={model.errors}
          repositoryLabel={repositoryLabelOf(selectedJobs)}
          focus={model.focus}
        />
      ) : null}
      <ExpiryFieldset model={model} />
      {model.ack ? (
        <fieldset class="ack">
          <legend>Accept these risks</legend>
          <input type="hidden" name="warnings_digest" value={model.ack.digest} />
          <ul class="warnings">
            {model.ack.warnings.map((warning) => (
              <li>
                <strong>Risk:</strong> {warning}
              </li>
            ))}
          </ul>
          <Checkbox
            name="acknowledge_warnings"
            label="I have read these risks and want to save this access anyway"
            hint="If you change the constraints or operations, the list may change and you are asked again."
            // The edit form sits in a <details> closed by default (A7.6): the server enforces it.
            required={model.mode === 'create'}
            error={err('acknowledge_warnings')}
          />
        </fieldset>
      ) : null}
      <div class="actions">
        <button
          type="submit"
          class="primary"
          name={model.mode === 'edit' ? 'intent' : undefined}
          value={model.mode === 'edit' ? 'save' : undefined}
        >
          {model.mode === 'edit' ? 'Save changes' : 'Give access'}
        </button>
        {selectedJobs && selectedJobs.jobs.editor === 'structured' ? (
          <button type="submit" name="_action" value="rows" formnovalidate class="secondary">
            Write conditions by hand
          </button>
        ) : null}
        {selectedJobs && selectedJobs.jobs.editor === 'rows' ? (
          <AddRowsButton group="cond" />
        ) : null}
        {selectedToken && !isPathInjected(selectedToken.token) ? (
          <button type="submit" name="_action" value="add:rule" formnovalidate class="secondary">
            Add {BLANK_ROWS} more operation rows
          </button>
        ) : null}
        {model.consumer.kind === 'select' || model.token.kind === 'select' ? (
          <button type="submit" name="_action" value="refresh" formnovalidate class="secondary">
            Show fields for the chosen consumer and token
          </button>
        ) : null}
      </div>
    </PostForm>
  );
}

export function selectedConsumerBranch(choice: ConsumerChoice): ConsumerBranch | null {
  switch (choice.kind) {
    case 'fixed':
      return choice.branch;
    case 'cards':
      return (
        choice.branches.find((branch) => branch.provider.id === choice.selected) ??
        (choice.selected === 'new'
          ? (choice.newBranch.jobs[choice.newBranch.form.type as ProfileId] ?? null)
          : null)
      );
    case 'select':
      return choice.branch;
    case 'new':
      return choice.newBranch.jobs[choice.newBranch.form.type as ProfileId] ?? null;
  }
}

export function selectedTokenBranch(choice: TokenChoice): TokenBranch | null {
  switch (choice.kind) {
    case 'fixed':
      return choice.branch;
    case 'cards':
      return choice.branches.find((branch) => branch.token.id === choice.selected) ?? null;
    case 'select':
      return choice.branch;
  }
}

function repositoryLabelOf(branch: ConsumerBranch | null): string | null {
  const text = branch?.jobs.repository.trim() ?? '';
  const match = /^(.+?)\s*(?:\(\d+\)|#\d+)$/.exec(text);
  return match?.[1] ?? null;
}

function consumerDescription(branch: ConsumerBranch): string {
  const claims = anchorClaims(branch.profile);
  const tenants =
    claims === null
      ? []
      : pinOwnerValues(branch.provider, claims.owner).map((value) => {
          const label = branch.labels.find((l) => l.claim === claims.owner && l.value === value);
          return label ? `${label.label} (${value})` : value;
        });
  return [
    branch.profile.label,
    ...(tenants.length > 0 ? [tenants.join(', ')] : []),
    `${branch.accessCount} ${branch.accessCount === 1 ? 'access' : 'accesses'}`,
  ].join(' · ');
}

function ConsumerFieldset(props: { model: AccessFormModel }) {
  const { model } = props;
  const choice = model.consumer;
  const err = (name: string) => errorFor(model.errors, name);
  return (
    <fieldset class="group">
      <legend>Consumer</legend>
      {choice.kind === 'fixed' ? (
        <>
          <p class="fixed" id={fieldId('consumer_id')}>
            <span class="label">Consumer:</span> {choice.branch.provider.name}
            {choice.branch.provider.enabled ? '' : ' (disabled)'}
          </p>
          {choice.changeHref || choice.newHref ? (
            <p class="actions">
              {choice.changeHref ? <a href={choice.changeHref}>Change consumer</a> : null}
              {choice.newHref ? <a href={choice.newHref}>Use a new consumer</a> : null}
            </p>
          ) : null}
          <input type="hidden" name="consumer_id" value={choice.branch.provider.id} />
          <JobsFieldset branch={choice.branch} errors={model.errors} fixed focus={model.focus} />
        </>
      ) : choice.kind === 'new' ? (
        <>
          {choice.existingHref ? (
            <p class="actions">
              <a href={choice.existingHref}>Use an existing consumer</a>
            </p>
          ) : null}
          <input type="hidden" name="consumer_id" value="new" />
          <NewConsumerFields
            branch={choice.newBranch}
            model={model}
            legend="Add the consumer: its type"
          />
        </>
      ) : choice.kind === 'cards' ? (
        <RadioCards
          name="consumer_id"
          legend="Which consumer"
          value={choice.selected}
          error={err('consumer_id')}
          options={[
            ...choice.branches.map((branch) => ({
              value: branch.provider.id,
              title: `${branch.provider.name}${branch.provider.enabled ? '' : ' (disabled)'}`,
              description: consumerDescription(branch),
              reveal: <JobsFieldset branch={branch} errors={model.errors} focus={model.focus} />,
            })),
            {
              value: 'new',
              title: 'New consumer',
              description: 'Add a CI system and give it access in the same step',
              reveal: (
                <NewConsumerFields branch={choice.newBranch} model={model} legend="Its type" />
              ),
            },
          ]}
        />
      ) : (
        <>
          <Select
            name="consumer_id"
            label="Which consumer"
            value={choice.selected}
            placeholder="Choose a consumer"
            options={[
              ...choice.options.map((provider) => ({
                value: provider.id,
                label: `${provider.name}${provider.enabled ? '' : ' (disabled)'}`,
              })),
              { value: 'new', label: 'New consumer' },
            ]}
            hint="After choosing, use Show fields for the chosen consumer and token below the form."
            error={err('consumer_id')}
          />
          {choice.branch ? (
            <JobsFieldset branch={choice.branch} errors={model.errors} focus={model.focus} />
          ) : null}
        </>
      )}
    </fieldset>
  );
}

function NewConsumerFields(props: {
  branch: NewConsumerBranch;
  model: AccessFormModel;
  legend: string;
}) {
  const jobs = Object.fromEntries(
    Object.entries(props.branch.jobs).map(([type, branch]) => [
      type,
      <JobsFieldset branch={branch} errors={props.model.errors} focus={props.model.focus} />,
    ]),
  ) as Partial<Record<ProfileId, Child>>;
  // Each type's branch holds the labels of the consumer a save would merge into.
  const labels = Object.values(props.branch.jobs).flatMap((branch) => branch.labels);
  return (
    <AddConsumerFields
      prefix="new."
      form={props.branch.form}
      errors={props.model.errors}
      existing={props.model.existingConsumers}
      labels={labels}
      anchorSuggestions={genericAnchorSuggestions(props.model.existingConsumers)}
      jobs={jobs}
      legend={props.legend}
    />
  );
}

const CONTEXT_TEXT: Readonly<
  Record<AccessContext, { title: string; description: string; risk?: string }>
> = {
  environment: {
    title: 'Environment',
    description: 'Jobs that deploy to a GitHub environment',
  },
  branch: { title: 'Branch', description: 'Pushes, manual runs and schedules on a branch' },
  tag: { title: 'Tag', description: 'Pushes of a tag' },
  protected: { title: 'Any protected branch or tag', description: 'Every protected ref' },
  release: { title: 'Release', description: 'Published releases' },
  pull_request: {
    title: 'Pull request into',
    description: 'Pull requests into a branch.',
    risk: 'pull_request jobs run the code proposed in the pull request.',
  },
  any: {
    title: 'Any branch, tag or environment',
    description: 'Every job of the repository.',
    risk: 'anyone with write access to the repository gets the token.',
  },
};

const GITLAB_CONTEXT_TEXT: Partial<Record<AccessContext, { description: string }>> = {
  environment: { description: 'Jobs that deploy to a GitLab environment' },
  branch: { description: 'Pipelines on a branch' },
  tag: { description: 'Pipelines of a tag' },
};

function suggestions(values: readonly string[]): Suggestion[] {
  return values.map((value) => ({ value }));
}

/** "Which jobs": the structured fields, or the conditions rows editor. */
export function JobsFieldset(props: {
  branch: ConsumerBranch;
  errors: readonly FieldError[];
  /** The consumer is fixed and existing: the repository may carry `pattern`. */
  fixed?: boolean;
  focus?: AccessFormModel['focus'];
}) {
  const { branch, errors } = props;
  const { prefix, jobs, profile } = branch;
  const name = (key: string) => `${prefix}${key}`;
  const err = (key: string) => errorFor(errors, name(key));
  const conditional = props.fixed !== true;
  if (jobs.editor === 'rows') {
    return <ConditionRows branch={branch} errors={errors} focus={props.focus} />;
  }
  const claims = anchorClaims(profile);
  const owners =
    claims === null
      ? []
      : pinOwnerValues(branch.provider, claims.owner).map((value) => ({
          value,
          label: branch.labels.find((l) => l.claim === claims.owner && l.value === value)?.label,
        }));
  const firstOwner = owners.find((owner) => owner.label)?.label;
  const gitlab = profile.id === 'gitlab-ci';
  const exampleRepo = gitlab
    ? `${firstOwner ?? 'acme-group'}/app (4567890)`
    : `${firstOwner ?? 'acme'}/api (89012345)`;
  const moreOpen =
    jobs.workflow_ref !== '' ||
    jobs.require_github_hosted ||
    err('workflow_ref') !== null ||
    err('owner_id') !== null;
  const contextOptions = contextsFor(profile).map((context) => {
    const info = CONTEXT_TEXT[context];
    const input = CONTEXT_INPUT[context];
    return {
      value: context,
      title: info.title,
      description: gitlab
        ? (GITLAB_CONTEXT_TEXT[context]?.description ?? info.description)
        : info.description,
      ...(info.risk ? { risk: info.risk } : {}),
      reveal: input ? (
        <ContextInput
          context={context}
          name={name(input)}
          value={jobs[input]}
          error={err(input)}
          suggestions={branch.suggestions}
          gitlab={gitlab}
        />
      ) : undefined,
    };
  });
  return (
    <fieldset class="jobs">
      <legend>Which jobs</legend>
      <input type="hidden" name={name('editor')} value="structured" />
      <IdWithLabelField
        kind={gitlab ? 'gitlab_project' : 'github_repo'}
        name={name('repository')}
        label={gitlab ? 'Project' : 'Repository'}
        value={jobs.repository}
        example={exampleRepo}
        findCommand={
          // A prefilled bare ID without a stored name: the command that prints its name.
          isNumericId(jobs.repository.trim())
            ? repositoryFindCommandForId(profile, jobs.repository.trim())
            : repositoryFindCommand(
                profile,
                gitlab ? `${firstOwner ?? 'acme-group'}/app` : `${firstOwner ?? 'acme'}/api`,
              )
        }
        suggestions={branch.repositoryOptions}
        error={err('repository')}
        autocomplete="off"
        // Not required: an empty repository is valid with a workflow pin (More constraints).
        conditional={conditional}
      />
      {branch.unknownOwner !== null ? (
        <IdWithLabelField
          kind={gitlab ? 'gitlab_group_list' : 'github_owner_list'}
          name={name('new_owner')}
          label={`Add ${gitlab ? 'group' : 'organization'} ${branch.unknownOwner} to this consumer`}
          value={jobs.new_owner}
          example={`${branch.unknownOwner} (7654321)`}
          findCommand={ownerFindCommand(profile, branch.unknownOwner)}
          hint={`Saving adds this ${gitlab ? 'group' : 'organization'} to the consumer, then creates the access.`}
          error={err('new_owner')}
          autocomplete="off"
          required
          conditional={conditional}
        />
      ) : null}
      <RadioCards
        name={name('context')}
        idPrefix={fieldId(name('context'))}
        legend="When"
        value={jobs.context}
        error={err('context')}
        options={contextOptions}
      />
      <div class="protection">
        <RadioCards
          name={name('ref_protection')}
          legend="Protected refs"
          value={jobs.ref_protection}
          options={[
            {
              value: 'protected',
              title: 'Only protected branches and tags (recommended)',
              description: gitlab
                ? 'Protect the branch or tag in GitLab: Settings › Repository.'
                : 'Add required reviewers or branch protection in GitHub.',
            },
            {
              value: 'unprotected',
              title: 'Also unprotected branches and tags',
              risk: 'anyone who can push a branch gets the token.',
            },
          ]}
        />
      </div>
      <details class="more" open={moreOpen}>
        <summary>More constraints</summary>
        <Field
          name={name('workflow_ref')}
          label={gitlab ? 'Pipeline configuration pin' : 'Workflow pin'}
          optional
          value={jobs.workflow_ref}
          example={
            gitlab
              ? 'gitlab.com/acme-group/app//.gitlab-ci.yml@refs/heads/main'
              : 'acme/api/.github/workflows/deploy.yml@refs/heads/main'
          }
          suggestions={suggestions(branch.suggestions.workflowRefs)}
          hint={
            gitlab
              ? 'Only jobs from this pipeline configuration at this ref get the token. With an empty project, every project of the group that uses it gets it.'
              : 'Only jobs from this workflow file at this ref get the token. With an empty repository, every repository of the organization that calls this reusable workflow gets it.'
          }
          error={err('workflow_ref')}
          autocomplete="off"
          spellcheck={false}
          autocapitalize="none"
          conditional
        />
        {owners.length > 1 ? (
          <Select
            name={name('owner_id')}
            label={
              gitlab ? 'Group of the calling projects' : 'Organization of the calling repositories'
            }
            value={jobs.owner_id}
            placeholder="Only needed for a pin without a repository"
            options={owners.map((owner) => ({
              value: owner.value,
              label: owner.label ? `${owner.label} (${owner.value})` : owner.value,
            }))}
            hint="Used only when the repository is empty."
            error={err('owner_id')}
            conditional
          />
        ) : null}
        {profile.id === 'github-actions' ? (
          <Checkbox
            name={name('require_github_hosted')}
            label="Only GitHub-hosted runners"
            hint="Refuse self-hosted runners."
            checked={jobs.require_github_hosted}
          />
        ) : null}
      </details>
    </fieldset>
  );
}

function ContextInput(props: {
  context: AccessContext;
  name: string;
  value: string;
  error: string | null;
  suggestions: ConsumerSuggestions;
  gitlab: boolean;
}) {
  const common = {
    name: props.name,
    value: props.value,
    error: props.error,
    autocomplete: 'off',
    spellcheck: false,
    autocapitalize: 'none' as const,
    conditional: true,
  };
  switch (props.context) {
    case 'environment':
      return (
        <Field
          {...common}
          label="Environment"
          example="production"
          suggestions={suggestions(props.suggestions.environments)}
          hint={
            props.gitlab
              ? "Exact name from the job's environment: key. Protect it in GitLab. Start typing to see values used before."
              : "Exact name from the job's environment: key. Add required reviewers to it in GitHub. Start typing to see values used before."
          }
        />
      );
    case 'branch':
      return (
        <Field
          {...common}
          label="Branch"
          example="main"
          suggestions={suggestions(props.suggestions.branches)}
          hint={`Branch name without ${props.gitlab ? 'a prefix' : 'refs/heads/'}. A trailing * matches a prefix: release/*.`}
        />
      );
    case 'tag':
      return (
        <Field
          {...common}
          label="Tag"
          example="v*"
          suggestions={suggestions(props.suggestions.tags)}
          hint={`Tag name without ${props.gitlab ? 'a prefix' : 'refs/tags/'}. v* matches v1.2.3.`}
        />
      );
    case 'release':
      return (
        <Field
          {...common}
          label="Release tag"
          example="v*"
          suggestions={suggestions(props.suggestions.tags)}
          hint="Tag of the published release. v* matches v1.2.3."
        />
      );
    case 'pull_request':
      return (
        <Field
          {...common}
          label="Base branch"
          example="main"
          suggestions={suggestions(props.suggestions.baseRefs)}
          hint="Branch the pull request targets."
        />
      );
    default:
      return null;
  }
}

const CLAIM_HINT = 'Literal top-level claim name.';

function ConditionRows(props: {
  branch: ConsumerBranch;
  errors: readonly FieldError[];
  focus?: AccessFormModel['focus'];
}) {
  const { branch, errors } = props;
  const group = `${branch.prefix}cond`;
  const claimOptions = [
    ...new Set([
      ...branch.profile.anchorRules(branch.provider).flat(),
      ...branch.profile.tenantClaims,
      ...branch.profile.logClaimAllowlist(branch.provider),
    ]),
  ].map((value) => ({ value }));
  const rows = branch.jobs.cond.length > 0 ? branch.jobs.cond : starterRows(branch);
  const anchors = new Set(branch.profile.anchorRules(branch.provider).flat());
  return (
    <fieldset class="jobs rows-editor">
      <legend>Which jobs: conditions</legend>
      <input type="hidden" name={`${branch.prefix}editor`} value="rows" />
      <p class="hint">
        Every condition must hold. Anchor claims ({' '}
        {branch.profile
          .anchorRules(branch.provider)
          .map((rule) => rule.join(' + '))
          .join('; or ')}
        ) need an exact, non-negated condition.
      </p>
      <RepeatingRows
        group={group}
        legend="Conditions"
        keys={['claim', 'match', 'not', 'values']}
        rows={rows.map((row) => ({ ...row, not: row.not ? '1' : '' }))}
        blank={BLANK_ROWS + (branch.extraRows ?? 0)}
        focusIndex={props.focus?.group === group ? props.focus.index : undefined}
        render={(index, row, rowPrefix) => (
          <>
            {anchors.has(row.claim ?? '') ? (
              // An anchor claim's name is fixed (I-AUTHZ-2): only its values are typed.
              <p class="fixed" id={fieldId(`${rowPrefix}claim`)}>
                <span class="label">Claim {index + 1}:</span> <code>{row.claim}</code>
                <input type="hidden" name={`${rowPrefix}claim`} value={row.claim ?? ''} />
              </p>
            ) : (
              <Field
                name={`${rowPrefix}claim`}
                label={`Claim ${index + 1}`}
                value={row.claim ?? ''}
                example="repository_id"
                suggestions={claimOptions}
                hint={CLAIM_HINT}
                error={errorFor(errors, `${rowPrefix}claim`)}
                autocomplete="off"
                spellcheck={false}
                autocapitalize="none"
                conditional
              />
            )}
            <Select
              name={`${rowPrefix}match`}
              label={`Match ${index + 1}`}
              value={row.match || 'exact'}
              options={[
                { value: 'exact', label: 'is exactly' },
                { value: 'glob', label: 'matches pattern' },
              ]}
              error={errorFor(errors, `${rowPrefix}match`)}
            />
            <Checkbox
              name={`${rowPrefix}not`}
              label={
                <>
                  Not<span class="vh"> (condition {index + 1})</span>
                </>
              }
              hint="True when the value differs. A missing claim never matches."
              checked={row.not === '1'}
            />
            <Field
              name={`${rowPrefix}values`}
              label={`Values ${index + 1}`}
              value={row.values ?? ''}
              example="89012345, 89012346"
              suggestions={suggestions(branch.suggestions.claimValues(row.claim ?? ''))}
              hint='Comma-separated alternatives. Quote a value that contains a comma: "a,b".'
              error={errorFor(errors, `${rowPrefix}values`)}
              autocomplete="off"
              spellcheck={false}
              autocapitalize="none"
              conditional
            />
          </>
        )}
      />
    </fieldset>
  );
}

/** Empty rows editor: one row per anchor claim of the first anchor rule. */
function starterRows(branch: ConsumerBranch): JobsForm['cond'] {
  const [rule] = branch.profile.anchorRules(branch.provider);
  return (rule ?? []).map((claim) => ({ claim, match: 'exact', not: false, values: '' }));
}

function TokenFieldset(props: { model: AccessFormModel }) {
  const { model } = props;
  const choice = model.token;
  const err = (name: string) => errorFor(model.errors, name);
  const repositoryLabel = repositoryLabelOf(selectedConsumerBranch(model.consumer));
  return (
    <fieldset class="group">
      <legend>Token</legend>
      {choice.kind === 'fixed' ? (
        <>
          <p class="fixed" id={fieldId('token_id')}>
            <span class="label">Token:</span> {choice.branch.token.name}{' '}
            <code>/proxy/{choice.branch.token.slug}</code>{' '}
            <span class="secondary-text">
              {hostOf(choice.branch.token)} · {credentialSentence(choice.branch.credential)}
            </span>
          </p>
          {choice.changeHref ? (
            <p class="actions">
              <a href={choice.changeHref}>Change token</a>
            </p>
          ) : null}
          <input type="hidden" name="token_id" value={choice.branch.token.id} />
          <OpsFieldset
            branch={choice.branch}
            errors={model.errors}
            repositoryLabel={repositoryLabel}
            focus={model.focus}
          />
        </>
      ) : choice.kind === 'cards' ? (
        <RadioCards
          name="token_id"
          legend="Which token"
          value={choice.selected}
          error={err('token_id')}
          options={choice.branches.map((branch) => ({
            value: branch.token.id,
            title: `${branch.token.name}${branch.token.enabled ? '' : ' (disabled)'}`,
            description: (
              <>
                <code>/proxy/{branch.token.slug}</code> · {hostOf(branch.token)} ·{' '}
                {credentialSentence(branch.credential)}
              </>
            ),
            reveal: (
              <OpsFieldset
                branch={branch}
                errors={model.errors}
                repositoryLabel={repositoryLabel}
                focus={model.focus}
              />
            ),
          }))}
        />
      ) : (
        <>
          <Select
            name="token_id"
            label="Which token"
            value={choice.selected}
            placeholder="Choose a token"
            options={choice.options.map((token) => ({
              value: token.id,
              label: `${token.name} (/proxy/${token.slug})`,
            }))}
            hint="After choosing, use Show fields for the chosen consumer and token below the form."
            error={err('token_id')}
          />
          {choice.branch ? (
            <OpsFieldset
              branch={choice.branch}
              errors={model.errors}
              repositoryLabel={repositoryLabel}
              focus={model.focus}
            />
          ) : null}
        </>
      )}
    </fieldset>
  );
}

function hostOf(token: Pick<Service, 'base_url'>): string {
  try {
    return new URL(token.base_url).host;
  } catch {
    return token.base_url;
  }
}

function credentialSentence(credential: string): string {
  return credential === 'No credential yet'
    ? 'No credential yet: calls fail until a token manager loads it'
    : credential;
}

/** "Allowed operations" of one token. */
export function OpsFieldset(props: {
  branch: TokenBranch;
  errors: readonly FieldError[];
  repositoryLabel: string | null;
  focus?: AccessFormModel['focus'];
}) {
  const { branch, errors } = props;
  const { prefix } = branch;
  if (isPathInjected(branch.token)) {
    return (
      <fieldset class="ops">
        <legend>Allowed operations</legend>
        <p>Allowed operation: POST / (the only safe operation on a webhook URL).</p>
      </fieldset>
    );
  }
  const repo = props.repositoryLabel ?? '‹repository›';
  const presets = branch.template?.operation_presets ?? [];
  const options = [
    ...presets.map((preset) => ({
      value: preset.id,
      label: `${preset.label}: ${preset.rules
        .map((rule) => `${rule.methods.join(', ')} ${rule.path.replaceAll(REPO_PLACEHOLDER, repo)}`)
        .join('; ')}`,
      checked: branch.ops.op.includes(preset.id),
    })),
    ...branch.ruleSets.map((set) => ({
      value: set.id,
      label: `Used by ${set.count === 1 ? '1 other access' : `${set.count} other accesses`}: ${set.rules
        .map((rule) => `${rule.methods.join(', ')} ${rule.path}`)
        .join('; ')}`,
      checked: branch.ops.op.includes(set.id),
    })),
  ];
  const withBoxes = hasCheckboxes(branch);
  const group = `${prefix}rule`;
  const rows = branch.ops.rule;
  // The placeholder is an exact example, so {repo} becomes a real-looking name, never ‹repository›.
  const firstPath =
    presets[0]?.rules[0]?.path.replaceAll(REPO_PLACEHOLDER, props.repositoryLabel ?? 'acme/api') ??
    '/v1/resource';
  const otherOpen =
    rows.length > 0 ||
    !withBoxes ||
    errors.some((error) => error.field?.startsWith(`${group}.`)) ||
    (branch.extraRows ?? 0) > 0;
  return (
    <fieldset class="ops">
      <legend>Allowed operations</legend>
      {withBoxes ? (
        <CheckboxGroup
          name={`${prefix}op`}
          legend="Operations"
          options={options}
          error={errorFor(errors, `${prefix}op`)}
        />
      ) : null}
      <details class="other-ops" open={otherOpen}>
        <summary>Other operations</summary>
        <RepeatingRows
          group={group}
          legend="Methods and paths"
          keys={['m', 'path']}
          rows={rows.map((row) => ({ m: row.m.join(','), path: row.path }))}
          blank={BLANK_ROWS + (branch.extraRows ?? 0)}
          focusIndex={props.focus?.group === group ? props.focus.index : undefined}
          render={(index, row, rowPrefix) => {
            const methods = (row.m ?? '').split(',').filter((m) => m !== '');
            return (
              <>
                <CheckboxGroup
                  name={`${rowPrefix}m`}
                  legend={`Methods of operation ${index + 1}`}
                  options={[
                    ...PROXY_METHODS.map((method) => ({
                      value: method,
                      label: method,
                      checked: methods.includes(method),
                    })),
                    { value: '*', label: 'All methods', checked: methods.includes('*') },
                  ]}
                  error={errorFor(errors, `${rowPrefix}m`)}
                />
                <Field
                  name={`${rowPrefix}path`}
                  label={`Path of operation ${index + 1}`}
                  value={row.path ?? ''}
                  example={firstPath}
                  suggestions={suggestions(branch.pathSuggestions)}
                  hint={`Path under ${branch.token.base_url}. * matches one segment, ** any depth.`}
                  error={errorFor(errors, `${rowPrefix}path`)}
                  autocomplete="off"
                  spellcheck={false}
                  autocapitalize="none"
                  conditional
                />
              </>
            );
          }}
        />
      </details>
    </fieldset>
  );
}

const DAY_MS = 86_400_000;

function ExpiryFieldset(props: { model: AccessFormModel }) {
  const { model } = props;
  // "Keep" only for a stored date: for an access that never expires it would repeat "Never".
  const keep = model.mode === 'edit' && model.keep !== undefined && model.keep !== null;
  const keepText =
    model.keep === null || model.keep === undefined
      ? ''
      : `Keep: ${formatTime(model.keep)} (in ${Math.max(0, Math.ceil((model.keep - model.now) / DAY_MS))} days)`;
  return (
    <RadioCards
      name="expires"
      legend="Expires"
      value={!keep && model.expiry.expires === 'keep' ? 'never' : model.expiry.expires}
      error={errorFor(model.errors, 'expires')}
      options={[
        ...(keep ? [{ value: 'keep', title: keepText }] : []),
        { value: 'never', title: 'Never' },
        { value: '7d', title: 'In 7 days' },
        { value: '30d', title: 'In 30 days' },
        { value: '90d', title: 'In 90 days' },
        {
          value: 'date',
          title: 'On a date',
          reveal: (
            <Field
              name="expires_on"
              label="Last day of access"
              type="date"
              value={model.expiry.expires_on}
              example="2027-01-31"
              hint="Access stops at the end of this day (UTC)."
              error={errorFor(model.errors, 'expires_on')}
              autocomplete="off"
              conditional
            />
          ),
        },
      ]}
    />
  );
}
