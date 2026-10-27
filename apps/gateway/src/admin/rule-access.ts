// The structured credential access rule form (A14.4, A14.7.3): raw form values in, conditions, rules,
// labels, expiry and field errors out, and the reverse (a rule back into form values). Pure: no
// I/O. Every security decision is still made by validateCredentialAccessRule at save time; this module only
// builds candidate values and says which input a problem belongs to. Risks are accepted by the
// selection that causes them (coveredRiskCodes), never by a client-supplied list (A7.7).
import { labelFor, parseIdWithLabel, parseIdWithLabelList } from '../db/claim-labels';
import type { RuleSet } from '../db/suggestions';
import type { AccessShape } from '../db/suggestions';
import type { CredentialAccessRule, ClaimLabel, LabelledClaim, Service } from '../db/types';
import { getProfile } from '../identity/profiles';
import type { IssuerProfile } from '../identity/types';
import { globError } from '../policy/glob';
import {
  type GithubPresetContext,
  type GitlabPresetContext,
  githubAccessRulePreset,
  githubPresetFromConditions,
  gitlabAccessRulePreset,
  gitlabPresetFromConditions,
  type PresetResult,
  PROTECTABLE_CONTEXTS,
  RISK_WARNINGS,
  type RiskCode,
  type VercelPresetContext,
  vercelAccessRulePreset,
  vercelPresetFromConditions,
} from '../policy/presets';
import { type Condition, PROXY_METHODS, type Rule } from '../policy/types';
import type { WarningCode, WarningDetail } from '../policy/validate';
import { accessSummary } from './access-summary';
import type { Connections } from './connections';
import {
  claimIdPattern,
  pinValues,
  type RuleLabel,
  tenantWord,
} from './ops/credential-access-rules';
import type { FieldError } from './ops/shared';
import { formatValueList, parseValueList } from './rule-text';
import {
  type OperationPreset,
  presetNeedsRepository,
  presetRules,
  type ServiceTemplate,
} from './service-templates';

export type Fields = Record<string, string | string[]>;

const DAY_MS = 86_400_000;
const DIGITS_RE = /^[0-9]{1,20}$/;
const MAX_ROW_INDEX = 200;
const MAX_RULES = 50;

// ---------------------------------------------------------------------------------------------
// Field reading

export function text(fields: Fields, name: string): string {
  const value = fields[name];
  return typeof value === 'string' ? value : (value?.[0] ?? '');
}

export function all(fields: Fields, name: string): string[] {
  const value = fields[name];
  return value === undefined ? [] : typeof value === 'string' ? [value] : value;
}

/** Checkbox / hidden flag: "1" or "on" is true, anything else false. */
export function flag(fields: Fields, name: string): boolean {
  const value = text(fields, name);
  return value === '1' || value === 'on';
}

/** True when the form carries any field under `prefix` (the branch was rendered and submitted). */
export function hasPrefix(fields: Fields, prefix: string): boolean {
  return Object.keys(fields).some((name) => name.startsWith(prefix));
}

interface RawRow {
  index: number;
  get(key: string): string;
  getAll(key: string): string[];
  removed: boolean;
}

/** Rows named `${group}.${i}.${key}`, in index order; repeated names keep every value. */
function readRows(fields: Fields, group: string): RawRow[] {
  const prefix = `${group}.`;
  const byIndex = new Map<number, Record<string, string[]>>();
  for (const [name, raw] of Object.entries(fields)) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(0|[1-9][0-9]{0,2})\.([A-Za-z0-9_]+)$/.exec(name.slice(prefix.length));
    if (!match) continue;
    const index = Number(match[1]);
    if (index >= MAX_ROW_INDEX) continue;
    const row = byIndex.get(index) ?? Object.create(null);
    row[match[2] as string] = typeof raw === 'string' ? [raw] : raw;
    byIndex.set(index, row);
  }
  return [...byIndex.keys()]
    .sort((a, b) => a - b)
    .map((index) => {
      const row = byIndex.get(index) as Record<string, string[]>;
      return {
        index,
        get: (key) => row[key]?.[0] ?? '',
        getAll: (key) => row[key] ?? [],
        removed: (row.remove?.[0] ?? '') !== '',
      };
    });
}

// ---------------------------------------------------------------------------------------------
// IDs with labels (A7.8)

export interface IdRef {
  id: string;
  label: string;
}

/** The claims of a profile's repository and owner (organization, group or team). */
export function anchorClaims(
  profile: Pick<IssuerProfile, 'id'>,
): { repository: LabelledClaim; owner: LabelledClaim } | null {
  if (profile.id === 'github-actions') {
    return { repository: 'repository_id', owner: 'repository_owner_id' };
  }
  if (profile.id === 'gitlab-ci') return { repository: 'project_id', owner: 'namespace_id' };
  if (profile.id === 'vercel') return { repository: 'project_id', owner: 'owner_id' };
  return null;
}

const GITHUB_REPO_LABEL = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const GITLAB_PROJECT_LABEL = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;
const GITHUB_OWNER_LABEL = /^[A-Za-z0-9-]{1,39}$/;
const GITLAB_GROUP_LABEL = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const VERCEL_PROJECT_LABEL = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const VERCEL_TEAM_LABEL = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** Vercel keeps the IDs of a linked directory in `.vercel/project.json` (`vercel link`). */
const VERCEL_PROJECT_JSON = '.vercel/project.json';

/**
 * The command whose output is the repository input format, for `name` when known: `gh`, `glab`,
 * or `jq` over the `.vercel/project.json` of a linked Vercel project.
 */
export function repositoryFindCommand(profile: Pick<IssuerProfile, 'id'>, name?: string): string {
  if (profile.id === 'gitlab-ci') {
    const path = name && GITLAB_PROJECT_LABEL.test(name) ? name : 'acme-group/app';
    return `glab api projects/${encodeURIComponent(path)} | jq -r '"\\(.path_with_namespace) (\\(.id))"'`;
  }
  if (profile.id === 'vercel') {
    return `jq -r '"\\(.projectName) (\\(.projectId))"' ${VERCEL_PROJECT_JSON}`;
  }
  const repo = name && GITHUB_REPO_LABEL.test(name) ? name : 'acme/api';
  return `gh api repos/${repo} --jq '"\\(.full_name) (\\(.id))"'`;
}

/** The command whose output is the repository input format, for a known ID. */
export function repositoryFindCommandForId(profile: Pick<IssuerProfile, 'id'>, id: string): string {
  if (profile.id === 'vercel') return repositoryFindCommand(profile);
  const value = DIGITS_RE.test(id) ? id : '89012345';
  if (profile.id === 'gitlab-ci') {
    return `glab api projects/${value} | jq -r '"\\(.path_with_namespace) (\\(.id))"'`;
  }
  return `gh api repositories/${value} --jq '"\\(.full_name) (\\(.id))"'`;
}

/**
 * The command whose output is the organization or group input format. Vercel: the team ID only;
 * its slug is the first segment of the dashboard URL (`vercel.com/acme`).
 */
export function ownerFindCommand(profile: Pick<IssuerProfile, 'id'>, name?: string): string {
  if (profile.id === 'gitlab-ci') {
    const path = name && GITLAB_GROUP_LABEL.test(name) ? name : 'acme-group';
    return `glab api groups/${encodeURIComponent(path)} | jq -r '"\\(.full_path) (\\(.id))"'`;
  }
  if (profile.id === 'vercel') return `jq -r .orgId ${VERCEL_PROJECT_JSON}`;
  const org = name && GITHUB_OWNER_LABEL.test(name) ? name : 'acme';
  return `gh api orgs/${org} --jq '"\\(.login) (\\(.id))"'`;
}

/** The input format of one ID with its label. */
export function idText(id: string, label: string | null): string {
  return label ? `${label} (${id})` : id;
}

/** Example input of a profile's repository and owner, and the label shapes they take. */
const ID_FORMS = {
  'github-actions': {
    repository: { noun: 'repository', example: 'acme/api (89012345)', shape: GITHUB_REPO_LABEL },
    owner: { example: 'acme (1234567)', shape: GITHUB_OWNER_LABEL },
  },
  'gitlab-ci': {
    repository: {
      noun: 'project',
      example: 'acme-group/app (4567890)',
      shape: GITLAB_PROJECT_LABEL,
    },
    owner: { example: 'acme-group (5678901)', shape: GITLAB_GROUP_LABEL },
  },
  vercel: {
    repository: {
      noun: 'project',
      example: 'acme-web (prj_7Gw5ZMBpQA8h9GF832KGp7nwbuh3)',
      shape: VERCEL_PROJECT_LABEL,
    },
    owner: { example: 'acme (team_7Gw5ZMzpQA8h90F832KGp7nwbuh3)', shape: VERCEL_TEAM_LABEL },
  },
} as const;

type LabelledProfile = keyof typeof ID_FORMS;

function idForms(profile: Pick<IssuerProfile, 'id'>) {
  return ID_FORMS[(profile.id in ID_FORMS ? profile.id : 'github-actions') as LabelledProfile];
}

/** True when `id` has the shape of an ID of `claim` for the profile. */
function idFits(profile: Pick<IssuerProfile, 'id'>, claim: string, id: string): boolean {
  return claimIdPattern(profile.id, claim)?.test(id) ?? false;
}

/**
 * The repository (GitHub) or project (GitLab, Vercel) typed as `name (ID)`, `name #ID`, or a bare
 * ID that already has a label for this credential access rule. Null for an empty input; a message
 * that says how to fix any other input.
 */
export function parseRepositoryInput(
  raw: string,
  profile: Pick<IssuerProfile, 'id'>,
  labels: readonly ClaimLabel[],
): { ok: true; value: IdRef | null } | { ok: false; message: string } {
  const claims = anchorClaims(profile);
  const input = raw.trim();
  if (input === '' || claims === null) return { ok: true, value: null };
  const { noun, example, shape } = idForms(profile).repository;
  const vercel = profile.id === 'vercel';
  const parsed = parseIdWithLabel(input);
  if (parsed === null || !idFits(profile, claims.repository, parsed.id)) {
    const name = input.replace(/\s*\(.*$/, '');
    const sample = vercel ? 'prj_7Gw5ZMBpQA8h9GF832KGp7nwbuh3' : '987654321';
    return {
      ok: false,
      message: `Add the ${vercel ? 'project' : 'numeric'} ID after the name, like ${shape.test(name) ? `${name} (${sample})` : example}. Find it with: ${repositoryFindCommand(profile, name)}`,
    };
  }
  const label = parsed.label ?? labelFor(labels, claims.repository, parsed.id);
  if (label === null) {
    return {
      ok: false,
      message: `Enter the ${noun} name too, like ${example}: ID ${parsed.id} has no name here yet. Find it with: ${repositoryFindCommandForId(profile, parsed.id)}`,
    };
  }
  if (!shape.test(label)) {
    return {
      ok: false,
      message:
        profile.id === 'gitlab-ci'
          ? `Enter the project as group/project (ID), like ${example}.`
          : vercel
            ? `Enter the project as name (ID) with the name in lower case, like ${example}.`
            : `Enter the repository as owner/name (ID), like ${example}.`,
    };
  }
  return { ok: true, value: { id: parsed.id, label } };
}

/**
 * Organizations, groups or a team typed as `name (ID)`, comma-separated (the `new_owner` and
 * `tenant` formats).
 */
export function parseOwnerList(
  raw: string,
  profile: Pick<IssuerProfile, 'id'>,
): { ok: true; entries: IdRef[] } | { ok: false; message: string } {
  const { example, shape } = idForms(profile).owner;
  const claims = anchorClaims(profile);
  const entries = parseIdWithLabelList(raw);
  if (
    entries === null ||
    entries.length === 0 ||
    entries.length > 20 ||
    entries.some(
      (entry) =>
        entry.label === null ||
        !shape.test(entry.label) ||
        (claims !== null && !idFits(profile, claims.owner, entry.id)),
    )
  ) {
    return {
      ok: false,
      message:
        profile.id === 'gitlab-ci'
          ? `Enter each group as path (ID), for example ${example}.`
          : profile.id === 'vercel'
            ? `Enter the team as slug (team ID), for example ${example}.`
            : `Enter each organization as name (ID), for example ${example}.`,
    };
  }
  return {
    ok: true,
    entries: entries.map((entry) => ({ id: entry.id, label: entry.label ?? '' })),
  };
}

/**
 * The org (GitHub: first segment) or group (GitLab: all but the last) of a repository label.
 * Vercel project names carry no team: ''.
 */
export function ownerPrefix(profile: Pick<IssuerProfile, 'id'>, repositoryLabel: string): string {
  if (profile.id === 'vercel') return '';
  const segments = repositoryLabel.split('/');
  return profile.id === 'gitlab-ci' ? segments.slice(0, -1).join('/') : (segments[0] ?? '');
}

/**
 * The pinned organization or group a repository belongs to, by label prefix (case-insensitive).
 * A credential access rule with one unlabelled organization uses it. Null when no pin value matches: the access
 * form then asks for `new_owner`.
 */
export function deriveOwner(
  prefix: string,
  provider: Pick<CredentialAccessRule, 'tenant_pin'>,
  profile: Pick<IssuerProfile, 'id'>,
  labels: readonly ClaimLabel[],
): IdRef | null {
  const claims = anchorClaims(profile);
  if (claims === null) return null;
  const pinned = pinOwnerValues(provider, claims.owner);
  const lower = prefix.toLowerCase();
  for (const value of pinned) {
    const label = labelFor(labels, claims.owner, value);
    if (label !== null && label.toLowerCase() === lower) return { id: value, label };
  }
  const [only] = pinned;
  if (pinned.length === 1 && only !== undefined && labelFor(labels, claims.owner, only) === null) {
    return { id: only, label: prefix };
  }
  return null;
}

/** Values of the owner claim the credential access rule's pin admits (pin conditions are ANDed). */
export function pinOwnerValues(
  provider: Pick<CredentialAccessRule, 'tenant_pin'>,
  claim: string,
): string[] {
  return pinValues(provider.tenant_pin, claim);
}

// ---------------------------------------------------------------------------------------------
// "Which jobs"

export type AccessContext = GithubPresetContext;

/** The context radios per profile, in display order. */
export function contextsFor(profile: Pick<IssuerProfile, 'id'>): AccessContext[] {
  if (profile.id === 'github-actions') {
    return ['environment', 'branch', 'tag', 'protected', 'release', 'pull_request', 'any'];
  }
  if (profile.id === 'gitlab-ci') return ['environment', 'branch', 'tag', 'protected', 'any'];
  if (profile.id === 'vercel') return ['environment', 'any'];
  return [];
}

/** The input of each context that takes a name or pattern. */
export type ContextInputKey = 'environment' | 'branch' | 'tag' | 'release_tag' | 'pr_base';

export const CONTEXT_INPUT: Readonly<Partial<Record<AccessContext, ContextInputKey>>> = {
  environment: 'environment',
  branch: 'branch',
  tag: 'tag',
  release: 'release_tag',
  pull_request: 'pr_base',
};

export interface CondRow {
  claim: string;
  match: string;
  not: boolean;
  values: string;
}

/** Raw values of the "Which jobs" fieldset of one issuer type branch, kept as text. */
export interface JobsForm {
  editor: 'structured' | 'rows';
  repository: string;
  new_owner: string;
  owner_id: string;
  context: string;
  environment: string;
  branch: string;
  tag: string;
  release_tag: string;
  pr_base: string;
  ref_protection: string;
  workflow_ref: string;
  require_github_hosted: boolean;
  cond: CondRow[];
}

export function blankJobsForm(profile: Pick<IssuerProfile, 'id'>): JobsForm {
  return {
    editor: anchorClaims(profile) === null ? 'rows' : 'structured',
    repository: '',
    new_owner: '',
    owner_id: '',
    context: 'environment',
    environment: '',
    branch: '',
    tag: '',
    release_tag: '',
    pr_base: '',
    ref_protection: 'protected',
    workflow_ref: '',
    require_github_hosted: false,
    cond: [],
  };
}

export function readJobsForm(
  fields: Fields,
  prefix: string,
  profile: Pick<IssuerProfile, 'id'>,
): JobsForm {
  const get = (name: string) => text(fields, `${prefix}${name}`);
  const rows =
    anchorClaims(profile) === null || get('editor') === 'rows' ? 'rows' : ('structured' as const);
  return {
    editor: rows,
    // A picked option wins; "Another…" posts '' and the typed value under `*_other`.
    repository: get('repository') || get('repository_other'),
    new_owner: get('new_owner'),
    owner_id: get('owner_id'),
    context: get('context') || 'environment',
    environment: get('environment') || get('environment_other'),
    branch: get('branch'),
    tag: get('tag'),
    release_tag: get('release_tag'),
    pr_base: get('pr_base'),
    ref_protection: get('ref_protection') === 'unprotected' ? 'unprotected' : 'protected',
    workflow_ref: get('workflow_ref'),
    require_github_hosted: flag(fields, `${prefix}require_github_hosted`),
    cond: readRows(fields, `${prefix}cond`)
      .filter((row) => !row.removed)
      .map((row) => ({
        claim: row.get('claim'),
        match: row.get('match'),
        not: row.get('not') === '1' || row.get('not') === 'on',
        values: row.get('values'),
      }))
      .filter((row) => row.claim.trim() !== '' || row.values.trim() !== ''),
  };
}

export interface JobsContext {
  profile: IssuerProfile;
  /** The rule's issuer and tenant pin, possibly built in memory from the form. */
  provider: Pick<CredentialAccessRule, 'profile' | 'issuer' | 'tenant_pin' | 'anchor_claims'>;
  /** Labels of this rule (stored and typed). */
  labels: readonly ClaimLabel[];
  /** Field name prefix of this issuer type's jobs fields. */
  prefix: string;
}

export interface ParsedJobs {
  conditions: Condition[] | null;
  risks: RiskCode[];
  presetWarnings: string[];
  /** Labels typed with the access (the repository), for claim_labels. */
  labels: RuleLabel[];
  repository: IdRef | null;
  /** An organization or group the rule's tenant pin does not hold yet; the save adds it (A14.4 step 4). */
  newOwner: IdRef | null;
  /** The repository's org or group prefix when it is not pinned: render `new_owner`. */
  unknownOwner: string | null;
  errors: FieldError[];
}

/** Builds the conditions of one issuer type branch (structured or rows). */
export function parseJobs(form: JobsForm, ctx: JobsContext): ParsedJobs {
  if (form.editor === 'rows') return parseRowsJobs(form, ctx);
  const { profile, provider, labels, prefix } = ctx;
  const claims = anchorClaims(profile);
  const out: ParsedJobs = {
    conditions: null,
    risks: [],
    presetWarnings: [],
    labels: [],
    repository: null,
    newOwner: null,
    unknownOwner: null,
    errors: [],
  };
  if (claims === null) return parseRowsJobs(form, ctx);
  const field = (name: string) => `${prefix}${name}`;

  const repository = parseRepositoryInput(form.repository, profile, labels);
  if (!repository.ok) out.errors.push({ field: field('repository'), message: repository.message });
  else out.repository = repository.value;

  let ownerId: string | null = null;
  const pinned = pinOwnerValues(provider, claims.owner);
  const word = tenantWord(profile.id);
  if (profile.id === 'vercel') {
    // One team per rule: the issuer names it (or the pin, under the global issuer).
    ownerId =
      pinned.length === 1
        ? (pinned[0] ?? null)
        : pinned.includes(form.owner_id)
          ? form.owner_id
          : null;
  } else if (out.repository) {
    const prefixText = ownerPrefix(profile, out.repository.label);
    const owner = deriveOwner(prefixText, provider, profile, labels);
    if (owner) ownerId = owner.id;
    // Without any owner label there is nothing to derive from: a pinned owner chosen explicitly
    // (or prefilled from a verified request or a copy) is used as is.
    else if (
      form.owner_id !== '' &&
      pinned.includes(form.owner_id) &&
      pinned.every((value) => labelFor(labels, claims.owner, value) === null)
    ) {
      ownerId = form.owner_id;
    } else if (form.new_owner.trim() !== '') {
      const parsed = parseOwnerList(form.new_owner, profile);
      const [entry] = parsed.ok ? parsed.entries : [];
      if (!parsed.ok || parsed.entries.length !== 1 || !entry) {
        out.errors.push({
          field: field('new_owner'),
          message: parsed.ok ? `Enter one ${word}: ${prefixText}.` : parsed.message,
        });
      } else if (entry.label.toLowerCase() !== prefixText.toLowerCase()) {
        out.errors.push({
          field: field('new_owner'),
          message: `Enter the ID of ${prefixText}, the ${word} of ${out.repository.label}, like ${prefixText} (7654321).`,
        });
      } else {
        out.newOwner = { id: entry.id, label: prefixText };
        ownerId = entry.id;
      }
      out.unknownOwner = prefixText;
    } else {
      out.unknownOwner = prefixText;
      out.errors.push({
        field: field('repository'),
        message: `${prefixText} is not ${word === 'organization' ? 'an' : 'a'} ${word} of this rule. Add it under Issuer and tenant.`,
      });
    }
  } else if (repository.ok) {
    // No repository: a workflow pin for every repository of one organization.
    if (pinned.length === 1) ownerId = pinned[0] ?? null;
    else if (pinned.includes(form.owner_id)) ownerId = form.owner_id;
    else if (form.workflow_ref.trim() !== '') {
      out.errors.push({
        field: field('owner_id'),
        message: `Choose the ${word} that owns the calling repositories.`,
      });
    }
  }

  const context = contextsFor(profile).find((value) => value === form.context);
  if (!context) {
    out.errors.push({
      field: field('context'),
      message: 'Choose which jobs can use the credential.',
    });
    return out;
  }
  const inputName = CONTEXT_INPUT[context];
  const pattern = inputName ? form[inputName] : '';
  const requireProtectedRef = form.ref_protection !== 'unprotected';
  let built: PresetResult;
  if (profile.id === 'github-actions') {
    built = githubAccessRulePreset({
      ownerId: ownerId ?? '',
      repositoryId: out.repository?.id ?? null,
      context,
      pattern,
      requireProtectedRef,
      requireGithubHosted: form.require_github_hosted,
      workflowRef: form.workflow_ref.trim() || null,
    });
  } else if (profile.id === 'vercel') {
    built = vercelAccessRulePreset({
      ownerId: ownerId ?? '',
      projectId: out.repository?.id ?? '',
      context: context as VercelPresetContext,
      pattern,
    });
  } else {
    built = gitlabAccessRulePreset({
      namespaceId: ownerId ?? '',
      projectId: out.repository?.id ?? null,
      context: context as GitlabPresetContext,
      pattern,
      requireProtectedRef,
      configRef: form.workflow_ref.trim() || null,
    });
  }
  const known = new Set(out.errors.map((error) => error.field));
  for (const error of built.errors) {
    const name =
      error.field === 'pattern'
        ? field(String(inputName ?? 'context'))
        : error.field === 'workflow_ref'
          ? field('workflow_ref')
          : error.field === 'repository'
            ? field('repository')
            : null;
    // Owner errors follow from a repository or new_owner error already reported.
    if (error.field === 'owner' && (out.unknownOwner !== null || out.errors.length > 0)) continue;
    if (name !== null && known.has(name)) continue;
    out.errors.push({ field: name ?? field('repository'), message: error.message });
  }
  if (out.errors.length > 0) return out;
  out.conditions = built.conditions;
  out.risks = built.risks;
  out.presetWarnings = built.warnings;
  if (out.repository) {
    out.labels.push({
      claim: claims.repository,
      value: out.repository.id,
      label: out.repository.label,
    });
  }
  return out;
}

function parseRowsJobs(form: JobsForm, ctx: JobsContext): ParsedJobs {
  const out: ParsedJobs = {
    conditions: null,
    risks: [],
    presetWarnings: [],
    labels: [],
    repository: null,
    newOwner: null,
    unknownOwner: null,
    errors: [],
  };
  const conditions: Condition[] = [];
  form.cond.forEach((row, index) => {
    const name = (key: string) => `${ctx.prefix}cond.${index}.${key}`;
    const claim = row.claim.trim();
    if (claim === '') {
      out.errors.push({
        field: name('claim'),
        message: 'Enter the claim name, like repository_id.',
      });
      return;
    }
    const match =
      row.match === 'glob' ? 'glob' : row.match === 'exact' || row.match === '' ? 'exact' : null;
    if (match === null) {
      out.errors.push({
        field: name('match'),
        message: 'Choose "is exactly" or "matches pattern".',
      });
      return;
    }
    const values = parseValueList(row.values);
    if (!values.ok) {
      out.errors.push({ field: name('values'), message: values.error });
      return;
    }
    if (values.values.length === 0) {
      out.errors.push({
        field: name('values'),
        message: `Enter at least one value for ${claim}, separated by commas.`,
      });
      return;
    }
    const condition: Condition = { claim, match, values: values.values };
    if (row.not) condition.negate = true;
    conditions.push(condition);
  });
  if (conditions.length === 0 && out.errors.length === 0) {
    out.errors.push({
      field: `${ctx.prefix}cond.0.values`,
      message: 'Enter at least one condition, like repository_id is exactly 89012345.',
    });
  }
  if (out.errors.length === 0) out.conditions = conditions;
  return out;
}

/**
 * The risk codes the structured selection accepts (A7.7). Computed from the chosen context and
 * protection of the submitted branch only; a value in another, hidden branch covers nothing.
 */
export function coveredRiskCodes(
  form: Pick<JobsForm, 'editor' | 'context' | 'ref_protection'>,
): Set<WarningCode> {
  const covered = new Set<WarningCode>();
  if (form.editor !== 'structured') return covered;
  if (form.ref_protection === 'unprotected' && PROTECTABLE_CONTEXTS.includes(form.context)) {
    covered.add('unprotected_ref');
  }
  if (form.context === 'pull_request') covered.add('pull_request');
  if (form.context === 'any') covered.add('any_ref');
  return covered;
}

/** The structured form of stored conditions, or null when only the rows editor can show them. */
export function jobsFormFromConditions(
  conditions: readonly Condition[],
  profile: Pick<IssuerProfile, 'id'>,
  labels: readonly ClaimLabel[],
): JobsForm | null {
  const claims = anchorClaims(profile);
  if (claims === null) return null;
  const form = blankJobsForm(profile);
  const repositoryText = (id: string | null) => {
    if (id === null) return '';
    const label = labelFor(labels, claims.repository, id);
    return label === null ? id : idText(id, label);
  };
  if (profile.id === 'github-actions') {
    const input = githubPresetFromConditions(conditions);
    if (input === null) return null;
    Object.assign(form, {
      repository: repositoryText(input.repositoryId),
      owner_id: input.ownerId,
      context: input.context,
      ref_protection: input.requireProtectedRef ? 'protected' : 'unprotected',
      workflow_ref: input.workflowRef ?? '',
      require_github_hosted: input.requireGithubHosted,
    });
    const inputName = CONTEXT_INPUT[input.context];
    if (inputName) form[inputName] = input.pattern;
    return form;
  }
  if (profile.id === 'vercel') {
    const input = vercelPresetFromConditions(conditions);
    if (input === null) return null;
    Object.assign(form, {
      repository: repositoryText(input.projectId),
      owner_id: input.ownerId,
      context: input.context,
      environment: input.pattern,
    });
    return form;
  }
  const input = gitlabPresetFromConditions(conditions);
  if (input === null) return null;
  Object.assign(form, {
    repository: repositoryText(input.projectId),
    owner_id: input.namespaceId,
    context: input.context,
    ref_protection: input.requireProtectedRef ? 'protected' : 'unprotected',
    workflow_ref: input.configRef ?? '',
  });
  const inputName = CONTEXT_INPUT[input.context];
  if (inputName) form[inputName] = input.pattern;
  return form;
}

/** Stored conditions as rows-editor rows. */
export function condRows(conditions: readonly Condition[]): CondRow[] {
  return conditions.map((condition) => ({
    claim: condition.claim,
    match: condition.match,
    not: condition.negate === true,
    values: formatValueList(condition.values),
  }));
}

/** The jobs form of an access: structured when it round-trips, else the rows editor. */
export function jobsFormFromRule(
  rule: { conditions: Condition[] },
  profile: Pick<IssuerProfile, 'id'>,
  labels: readonly ClaimLabel[],
): JobsForm {
  return (
    jobsFormFromConditions(rule.conditions, profile, labels) ?? {
      ...blankJobsForm(profile),
      editor: 'rows',
      cond: condRows(rule.conditions),
    }
  );
}

/** The structured input converted to rows ("Write conditions by hand"), losing nothing. */
export function jobsToRows(form: JobsForm, ctx: JobsContext): JobsForm {
  if (form.editor === 'rows') return form;
  const parsed = parseJobs(form, ctx);
  const conditions =
    parsed.conditions ?? partialConditions(form, ctx.profile, parsed.repository?.id ?? null);
  return { ...form, editor: 'rows', cond: condRows(conditions) };
}

/** What can be kept of an invalid structured input when it moves to rows. */
function partialConditions(
  form: JobsForm,
  profile: Pick<IssuerProfile, 'id'>,
  repositoryId: string | null,
): Condition[] {
  const claims = anchorClaims(profile);
  const out: Condition[] = [];
  if (claims && repositoryId)
    out.push({ claim: claims.repository, match: 'exact', values: [repositoryId] });
  const inputName = CONTEXT_INPUT[form.context as AccessContext];
  const value = inputName ? form[inputName].trim() : '';
  if (form.context === 'environment' && value) {
    out.push({ claim: 'environment', match: 'exact', values: [value] });
  }
  return out;
}

/** Contexts whose selection accepts a risk; prefill never picks one silently (A7.7.4). */
const RISKY_CONTEXTS: ReadonlySet<AccessContext> = new Set<AccessContext>(['pull_request', 'any']);

/** The safe context the credential access rule's accesses use most, else environment (A14.7.3 default). */
export function mostUsedContext(
  shapes: readonly AccessShape[],
  profile: Pick<IssuerProfile, 'id'>,
): AccessContext {
  const counts = new Map<AccessContext, number>();
  for (const shape of shapes) {
    const input =
      profile.id === 'github-actions'
        ? githubPresetFromConditions(shape.conditions)
        : profile.id === 'gitlab-ci'
          ? gitlabPresetFromConditions(shape.conditions)
          : profile.id === 'vercel'
            ? vercelPresetFromConditions(shape.conditions)
            : null;
    if (input) counts.set(input.context, (counts.get(input.context) ?? 0) + 1);
  }
  let best: AccessContext = 'environment';
  let bestCount = 0;
  for (const context of contextsFor(profile)) {
    // A risky context is never the default: its selection accepts the risk (A7.7).
    if (RISKY_CONTEXTS.has(context)) continue;
    const count = counts.get(context) ?? 0;
    if (count > bestCount) {
      best = context;
      bestCount = count;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// "Allowed operations"

export interface RuleRow {
  m: string[];
  path: string;
}

export interface OpsForm {
  op: string[];
  rule: RuleRow[];
}

export function readOpsForm(fields: Fields, prefix: string): OpsForm {
  return {
    op: all(fields, `${prefix}op`),
    rule: readRows(fields, `${prefix}rule`)
      .filter((row) => !row.removed)
      .map((row) => ({ m: row.getAll('m'), path: row.get('path') }))
      .filter((row) => row.path.trim() !== '' || row.m.length > 0),
  };
}

export interface OpsContext {
  token: Pick<Service, 'injection' | 'base_url'>;
  template: ServiceTemplate | null;
  ruleSets: readonly RuleSet[];
  /** The repository label for `{repo}`, or null when the access has none. */
  repositoryLabel: string | null;
  prefix: string;
}

/** The only operation of a token that injects its credential into the URL path (a webhook). */
export const WEBHOOK_RULE: Rule = { methods: ['POST'], path: '/' };

export function isPathInjected(token: Pick<Service, 'injection'>): boolean {
  return token.injection.kind === 'path';
}

/** The rules of one token branch: chosen presets and rule sets, then the custom rows. */
export function parseOps(
  form: OpsForm,
  ctx: OpsContext,
): { rules: Rule[] | null; errors: FieldError[] } {
  if (isPathInjected(ctx.token))
    return { rules: [{ ...WEBHOOK_RULE, methods: ['POST'] }], errors: [] };
  const errors: FieldError[] = [];
  const rules: Rule[] = [];
  const opField = `${ctx.prefix}op`;
  for (const id of new Set(form.op)) {
    const preset = ctx.template?.operation_presets.find((p) => p.id === id);
    if (preset) {
      if (presetNeedsRepository(preset) && ctx.repositoryLabel === null) {
        errors.push({
          field: opField,
          message: `${preset.label} needs a repository; choose one or write the path in Other operations.`,
        });
        continue;
      }
      rules.push(...presetRules(preset, ctx.repositoryLabel ?? ''));
      continue;
    }
    const set = ctx.ruleSets.find((candidate) => candidate.id === id);
    if (set)
      rules.push(...set.rules.map((rule) => ({ methods: [...rule.methods], path: rule.path })));
  }
  form.rule.forEach((row, index) => {
    const name = (key: string) => `${ctx.prefix}rule.${index}.${key}`;
    const path = row.path.trim();
    if (path === '') {
      errors.push({ field: name('path'), message: 'Enter the path, like /v1/resource.' });
      return;
    }
    const pathError = rulePathError(path);
    if (pathError !== null) {
      errors.push({ field: name('path'), message: pathError });
      return;
    }
    const methods = row.m.includes('*')
      ? (['*'] as Rule['methods'])
      : (PROXY_METHODS.filter((method) => row.m.includes(method)) as Rule['methods']);
    if (methods.length === 0) {
      errors.push({ field: name('m'), message: `Choose a method for ${path}.` });
      return;
    }
    rules.push({ methods, path });
  });
  const unique = dedupeRules(rules);
  if (errors.length === 0 && unique.length === 0) {
    errors.push({
      field: hasCheckboxes(ctx) ? opField : `${ctx.prefix}rule.0.path`,
      message: 'Choose at least one operation.',
    });
  }
  if (unique.length > MAX_RULES) {
    errors.push({ field: opField, message: `Allow at most ${MAX_RULES} operations.` });
  }
  return errors.length > 0 ? { rules: null, errors } : { rules: unique, errors };
}

/** True when the token branch renders operation checkboxes. */
export function hasCheckboxes(ctx: Pick<OpsContext, 'template' | 'ruleSets' | 'token'>): boolean {
  return (
    !isPathInjected(ctx.token) &&
    ((ctx.template?.operation_presets.length ?? 0) > 0 || ctx.ruleSets.length > 0)
  );
}

function rulePathError(path: string): string | null {
  if (!path.startsWith('/')) return `Start the path with /, like /${path.replace(/^\/*/, '')}.`;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return 'Use printable characters without spaces in the path.';
  }
  const error = globError(path);
  return error === null ? null : `Fix the path: ${error}.`;
}

function dedupeRules(rules: readonly Rule[]): Rule[] {
  const seen = new Set<string>();
  const out: Rule[] = [];
  for (const rule of rules) {
    const key = `${[...rule.methods].sort().join(',')} ${rule.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
}

/** The default operations of a new access: template defaults, else a token's only rule set. */
export function defaultOpsForm(
  template: ServiceTemplate | null,
  ruleSets: readonly RuleSet[],
): OpsForm {
  if (template && template.operation_presets.length > 0) {
    return { op: template.operation_presets.filter((p) => p.default).map((p) => p.id), rule: [] };
  }
  const [only] = ruleSets;
  return { op: ruleSets.length === 1 && only ? [only.id] : [], rule: [] };
}

/**
 * Stored rules as operation choices: every preset whose rules (for this repository) are all
 * present, then a rule set that equals the rest, then the remainder as custom rows. Lossless.
 */
export function opsFormFromRules(
  rules: readonly Rule[],
  template: ServiceTemplate | null,
  ruleSets: readonly RuleSet[],
  repositoryLabel: string | null,
): OpsForm {
  const key = (rule: Rule) => `${[...rule.methods].sort().join(',')} ${rule.path}`;
  const remaining = new Map(rules.map((rule) => [key(rule), rule]));
  const op: string[] = [];
  const presets: OperationPreset[] = template?.operation_presets ?? [];
  for (const preset of presets) {
    if (presetNeedsRepository(preset) && repositoryLabel === null) continue;
    const presetKeys = presetRules(preset, repositoryLabel ?? '').map(key);
    if (presetKeys.length > 0 && presetKeys.every((k) => remaining.has(k))) {
      op.push(preset.id);
      for (const k of presetKeys) remaining.delete(k);
    }
  }
  if (remaining.size > 0) {
    const restKeys = [...remaining.keys()].sort().join('\n');
    const set = ruleSets.find(
      (candidate) => candidate.rules.map(key).sort().join('\n') === restKeys,
    );
    if (set) {
      op.push(set.id);
      remaining.clear();
    }
  }
  return {
    op,
    rule: [...remaining.values()].map((rule) => ({ m: [...rule.methods], path: rule.path })),
  };
}

// ---------------------------------------------------------------------------------------------
// Expiry

export const EXPIRY_CHOICES = ['never', '7d', '30d', '90d', 'date'] as const;

export interface ExpiryForm {
  expires: string;
  expires_on: string;
}

export function readExpiryForm(fields: Fields): ExpiryForm {
  return { expires: text(fields, 'expires') || 'never', expires_on: text(fields, 'expires_on') };
}

/** Start of the UTC day of `ms`. */
function dayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * The expiry of an access: never, 7/30/90 days from now, or the end of a chosen UTC day (stored
 * as the next day 00:00 UTC), from tomorrow to 5 years ahead. `keep` is the stored value (edit).
 */
export function parseExpiry(
  form: ExpiryForm,
  now: number,
  keep?: number | null,
): { ok: true; value: number | null } | { ok: false; error: FieldError } {
  switch (form.expires) {
    case 'never':
      return { ok: true, value: null };
    case '7d':
      return { ok: true, value: now + 7 * DAY_MS };
    case '30d':
      return { ok: true, value: now + 30 * DAY_MS };
    case '90d':
      return { ok: true, value: now + 90 * DAY_MS };
    case 'keep':
      if (keep !== undefined) return { ok: true, value: keep };
      break;
    case 'date': {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(form.expires_on.trim());
      const ms = match
        ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
        : Number.NaN;
      const valid =
        match !== null && new Date(ms).toISOString().slice(0, 10) === form.expires_on.trim();
      if (!valid) {
        return {
          ok: false,
          error: {
            field: 'expires_on',
            message:
              form.expires_on.trim() === ''
                ? 'Choose the last day of access.'
                : 'Use a date like 2027-01-31.',
          },
        };
      }
      const tomorrow = dayStart(now) + DAY_MS;
      if (ms < tomorrow || ms > now + 5 * 366 * DAY_MS) {
        return {
          ok: false,
          error: { field: 'expires_on', message: 'Choose a day from tomorrow to 5 years ahead.' },
        };
      }
      return { ok: true, value: ms + DAY_MS };
    }
  }
  return { ok: false, error: { field: 'expires', message: 'Choose when the access stops.' } };
}

// ---------------------------------------------------------------------------------------------
// Naming

/**
 * The name of a new access (A7.1): "Slack for acme/api (environment production)", at most 100
 * characters. Derived from the conditions, so an edit can tell whether it was ever renamed.
 */
export function deriveAccessName(
  tokenName: string,
  conditions: Condition[],
  labels: readonly ClaimLabel[],
): string {
  const summary = accessSummary({ conditions, rules: [] }, labels);
  return `${tokenName} for ${summary.subject} (${summary.context})`.slice(0, 100);
}

/** Labels of one rule with the typed ones on top (for derivation before they are stored). */
export function withTypedLabels(
  labels: readonly ClaimLabel[],
  providerId: string,
  typed: readonly RuleLabel[],
): ClaimLabel[] {
  const extra: ClaimLabel[] = typed.map((label) => ({
    access_rule_id: providerId,
    claim: label.claim,
    value: label.value,
    label: label.label,
    updated_at: 0,
    updated_by: null,
  }));
  return [
    ...extra,
    ...labels.filter(
      (label) => !extra.some((e) => e.claim === label.claim && e.value === label.value),
    ),
  ];
}

/** True when `value` is a numeric ID (claim values of labelled claims). */
export function isNumericId(value: string): boolean {
  return DIGITS_RE.test(value);
}

// ---------------------------------------------------------------------------------------------
// Risks of stored conditions

/** Claims that narrow which jobs of a repository match (ref, environment, protection, PR base). */
const JOB_CLAIMS: readonly string[] = [
  'ref',
  'ref_path',
  'environment',
  'ref_type',
  'ref_protected',
  'base_ref',
];

/**
 * Claims whose exact value names the job's own ref or commit: `sub` (GitHub
 * `repo:acme/api:environment:production`, GitLab `project_path:…:ref:main`), the calling
 * workflow file at its ref, the commit and the pull request's head branch. `job_workflow_ref` and
 * `ci_config_ref_uri` are not here: they name the ref of a reusable workflow or of a pipeline
 * configuration that may live in another repository, so the caller's ref stays open.
 */
const EXACT_REF_CLAIMS: readonly string[] = ['sub', 'workflow_ref', 'sha', 'head_ref'];

/**
 * A GitHub repository can customize its `sub` template to leave the ref out, so a `sub` value
 * constrains the ref only when it names one (or the environment, or the pull_request context).
 */
const SUB_NAMES_REF = /:(?:ref|environment):|:pull_request(?::|$)/;

function constrainsRef(c: Condition): boolean {
  if (c.match !== 'exact' || !EXACT_REF_CLAIMS.includes(c.claim)) return false;
  return c.claim !== 'sub' || c.values.every((value) => SUB_NAMES_REF.test(value));
}

/**
 * True when GitHub, GitLab or Vercel conditions constrain no ref, environment, protection, commit or event,
 * so every job of the repository matches: the `any_ref` risk (A7.7). validateCredentialAccessRule does
 * not emit it (the ops accept such rules without acknowledgement), so the pages add it from the
 * conditions, the same way for the structured form, the rows editor and stored rules.
 */
export function isAnyRef(
  conditions: readonly Condition[],
  profile: Pick<IssuerProfile, 'id' | 'eventClaim'>,
): boolean {
  if (anchorClaims(profile) === null) return false;
  return !conditions.some(
    (c) =>
      c.negate !== true &&
      (JOB_CLAIMS.includes(c.claim) ||
        constrainsRef(c) ||
        (profile.eventClaim !== undefined && c.claim === profile.eventClaim)),
  );
}

/** The validator's warning details plus `any_ref` when the conditions carry it. */
export function accessWarningDetails(
  details: readonly WarningDetail[],
  conditions: readonly Condition[],
  profile: Pick<IssuerProfile, 'id' | 'eventClaim'>,
): WarningDetail[] {
  if (!isAnyRef(conditions, profile) || details.some((d) => d.code === 'any_ref')) {
    return [...details];
  }
  return [...details, { code: 'any_ref', message: RISK_WARNINGS.any_ref }];
}

/** Connections whose any-ref rules also carry the risk_accepted flag (the rule page agrees). */
export function withAnyRefFlags(connections: Connections): Connections {
  return {
    ...connections,
    rules: connections.rules.map((edge) => {
      const profile = getProfile(edge.rule.profile);
      if (
        !profile ||
        edge.flags.some((f) => f.status === 'risk_accepted') ||
        !isAnyRef(edge.rule.conditions, profile)
      ) {
        return edge;
      }
      return { ...edge, flags: [...edge.flags, { status: 'risk_accepted' }] };
    }),
  };
}
