// Structured access builders for GitHub Actions and GitLab CI (docs/policies.md, "Structured
// access form"). UI-only convenience: they produce plain conditions that still go through
// validateCredentialAccessRule. Defaults are the safe choice: numeric IDs, exact event allowlists, protected refs.
// Patterns that the validator would call broad (a leading `*`, `**`, a wildcard environment or
// workflow pin) are refused here, so the only risks of a structured access are the three explicit
// choices of RiskCode. The inverses return the builder input only when it rebuilds the exact
// condition set, so an access is edited with the form it was made with, or with the rows editor.
import { canonicalJson } from '../lib/json';
import { globError } from './glob';
import type { Condition } from './types';

/** The risks a structured selection can carry; each one is an explicit choice in the form. */
export type RiskCode = 'unprotected_ref' | 'pull_request' | 'any_ref';

export type GithubPresetContext =
  | 'environment'
  | 'branch'
  | 'tag'
  | 'protected'
  | 'release'
  | 'pull_request'
  | 'any';

export type GitlabPresetContext = 'environment' | 'branch' | 'tag' | 'protected' | 'any';

export const GITHUB_CONTEXTS: readonly GithubPresetContext[] = [
  'environment',
  'branch',
  'tag',
  'protected',
  'release',
  'pull_request',
  'any',
];

export const GITLAB_CONTEXTS: readonly GitlabPresetContext[] = [
  'environment',
  'branch',
  'tag',
  'protected',
  'any',
];

/** Contexts that take a name or pattern, and so a protected-refs choice. */
export const PATTERN_CONTEXTS: readonly string[] = [
  'environment',
  'branch',
  'tag',
  'release',
  'pull_request',
];

/** Contexts whose ref may be required to be protected. */
export const PROTECTABLE_CONTEXTS: readonly string[] = ['environment', 'branch', 'tag', 'release'];

/** Which builder input an error belongs to; the access form maps it to its field. */
export type PresetField = 'owner' | 'repository' | 'pattern' | 'workflow_ref';

export interface PresetError {
  field: PresetField;
  message: string;
}

export interface PresetResult {
  conditions: Condition[];
  /** Warnings of the chosen risks, worded for the audit row. */
  warnings: string[];
  risks: RiskCode[];
  /** Non-empty means do not save. */
  errors: PresetError[];
}

export interface GithubPresetInput {
  /** Numeric organization/user ID (`repository_owner_id`); names can be re-registered. */
  ownerId: string;
  /** Numeric repository ID; null only when `workflowRef` is set. */
  repositoryId: string | null;
  context: GithubPresetContext;
  /** Environment name, branch or tag pattern (without refs/…), or PR base branch; '' otherwise. */
  pattern: string;
  /** Ignored for the contexts outside PROTECTABLE_CONTEXTS. */
  requireProtectedRef: boolean;
  requireGithubHosted: boolean;
  /** `job_workflow_ref` pin, e.g. `acme/infra/.github/workflows/deploy.yml@refs/heads/main`. */
  workflowRef: string | null;
}

export interface GitlabPresetInput {
  /** Numeric group ID (`namespace_id`) of the project's direct group. */
  namespaceId: string;
  /** Numeric project ID; null only when `configRef` is set. */
  projectId: string | null;
  context: GitlabPresetContext;
  pattern: string;
  requireProtectedRef: boolean;
  /** `ci_config_ref_uri` pin, e.g. `gitlab.com/acme-group/app//.gitlab-ci.yml@refs/heads/main`. */
  configRef: string | null;
}

const DIGITS_RE = /^[0-9]{1,20}$/;
const PATTERN_MAX_LENGTH = 255;
export const GITHUB_WORKFLOW_REF_RE =
  /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/[^@*\s]+@(?:refs\/(?:heads|tags)\/[^*\s]+|[0-9a-f]{40})$/;
export const GITLAB_CONFIG_REF_RE =
  /^[a-z0-9.-]+(?:\/[A-Za-z0-9_.-]+)+\/\/[^@*\s]+@refs\/(?:heads|tags)\/[^*\s]+$/;

const GITHUB_BRANCH_EVENTS = ['push', 'workflow_dispatch', 'schedule'];

export const RISK_WARNINGS: Readonly<Record<RiskCode, string>> = {
  unprotected_ref:
    'protected refs are not required: anyone who can push a matching branch or tag is admitted',
  pull_request: 'pull_request jobs run the code proposed in the pull request',
  any_ref:
    'any branch, tag or environment of the repository can use this token: anyone with write access to the repository is admitted',
};

const exact = (claim: string, values: string[]): Condition => ({ claim, match: 'exact', values });
const glob = (claim: string, values: string[]): Condition => ({ claim, match: 'glob', values });

/**
 * Errors of a branch, tag or PR-base pattern: a name, or a prefix ending in `*`. No leading `*`
 * and no `**`, which the validator would call broad, and no `refs/` prefix.
 */
export function refPatternError(pattern: string, what: 'branch' | 'tag'): string | null {
  const example = what === 'branch' ? 'main or release/*' : 'v1.2.3 or v*';
  if (pattern === '') return `Enter a ${what} like ${example}.`;
  if (pattern.length > PATTERN_MAX_LENGTH) {
    return `Use at most ${PATTERN_MAX_LENGTH} characters for the ${what}.`;
  }
  if (/\s/.test(pattern)) return `Remove the spaces: enter a ${what} like ${example}.`;
  if (pattern.startsWith('refs/')) {
    return `Enter the ${what} without the refs/${what === 'branch' ? 'heads' : 'tags'}/ prefix.`;
  }
  if (pattern.startsWith('*') || pattern.includes('**')) {
    return `A ${what} pattern cannot start with * or contain **: enter a ${what} like ${example}, or use Write conditions by hand.`;
  }
  const error = globError(pattern);
  return error === null ? null : `Enter a ${what} like ${example} (${error}).`;
}

export function environmentError(name: string): string | null {
  if (name === '') return 'Enter the environment name, like production.';
  if (name.length > PATTERN_MAX_LENGTH) {
    return `Use at most ${PATTERN_MAX_LENGTH} characters for the environment.`;
  }
  if (name.includes('*')) {
    return 'Environment names cannot contain *; use Write conditions by hand for patterns.';
  }
  return null;
}

function patternErrors(context: string, pattern: string): PresetError[] {
  let message: string | null = null;
  if (context === 'environment') message = environmentError(pattern);
  else if (context === 'branch' || context === 'pull_request') {
    message = refPatternError(pattern, 'branch');
  } else if (context === 'tag' || context === 'release') message = refPatternError(pattern, 'tag');
  return message === null ? [] : [{ field: 'pattern', message }];
}

/** Builds the conditions of a GitHub Actions access. */
export function githubAccessRulePreset(input: GithubPresetInput): PresetResult {
  const errors: PresetError[] = [];
  const risks: RiskCode[] = [];
  const conditions: Condition[] = [];

  const ownerId = input.ownerId.trim();
  if (!DIGITS_RE.test(ownerId)) {
    errors.push({ field: 'owner', message: 'The organization ID must be numeric.' });
  }
  conditions.push(exact('repository_owner_id', [ownerId]));
  const repositoryId = input.repositoryId?.trim() ?? '';
  if (repositoryId !== '') {
    if (!DIGITS_RE.test(repositoryId)) {
      errors.push({ field: 'repository', message: 'The repository ID must be numeric.' });
    }
    conditions.push(exact('repository_id', [repositoryId]));
  }
  const workflowRef = input.workflowRef?.trim() ?? '';
  if (repositoryId === '' && workflowRef === '') {
    errors.push({
      field: 'repository',
      message: 'Choose a repository, or pin a workflow under More constraints.',
    });
  }

  const pattern = input.pattern.trim();
  errors.push(...patternErrors(input.context, pattern));
  switch (input.context) {
    case 'environment':
      conditions.push(exact('environment', [pattern]));
      break;
    case 'branch':
      conditions.push(exact('ref_type', ['branch']));
      conditions.push(glob('ref', [`refs/heads/${pattern}`]));
      conditions.push(exact('event_name', [...GITHUB_BRANCH_EVENTS]));
      break;
    case 'tag':
      conditions.push(exact('ref_type', ['tag']));
      conditions.push(glob('ref', [`refs/tags/${pattern}`]));
      conditions.push(exact('event_name', ['push']));
      break;
    case 'release':
      conditions.push(exact('ref_type', ['tag']));
      conditions.push(glob('ref', [`refs/tags/${pattern}`]));
      conditions.push(exact('event_name', ['release']));
      break;
    case 'pull_request':
      conditions.push(exact('event_name', ['pull_request']));
      conditions.push(glob('base_ref', [pattern]));
      risks.push('pull_request');
      break;
    case 'protected':
      conditions.push(exact('ref_protected', ['true']));
      break;
    case 'any':
      risks.push('any_ref');
      break;
  }
  if (PROTECTABLE_CONTEXTS.includes(input.context)) {
    if (input.requireProtectedRef) conditions.push(exact('ref_protected', ['true']));
    else risks.push('unprotected_ref');
  }
  if (input.requireGithubHosted) conditions.push(exact('runner_environment', ['github-hosted']));
  if (workflowRef !== '') {
    if (!GITHUB_WORKFLOW_REF_RE.test(workflowRef)) {
      errors.push({
        field: 'workflow_ref',
        message:
          'Enter the workflow as owner/repo/path@ref without *, like acme/api/.github/workflows/deploy.yml@refs/heads/main.',
      });
    }
    conditions.push(exact('job_workflow_ref', [workflowRef]));
  }
  return { conditions, warnings: risks.map((risk) => RISK_WARNINGS[risk]), risks, errors };
}

/**
 * Builds the conditions of a GitLab CI access. GitLab refs are bare names with `ref_type`; the
 * pipeline source stays implicit, so only trusted sources match (I-AUTHZ-3).
 */
export function gitlabAccessRulePreset(input: GitlabPresetInput): PresetResult {
  const errors: PresetError[] = [];
  const risks: RiskCode[] = [];
  const conditions: Condition[] = [];

  const namespaceId = input.namespaceId.trim();
  if (!DIGITS_RE.test(namespaceId)) {
    errors.push({ field: 'owner', message: 'The group ID must be numeric.' });
  }
  conditions.push(exact('namespace_id', [namespaceId]));
  const projectId = input.projectId?.trim() ?? '';
  if (projectId !== '') {
    if (!DIGITS_RE.test(projectId)) {
      errors.push({ field: 'repository', message: 'The project ID must be numeric.' });
    }
    conditions.push(exact('project_id', [projectId]));
  }
  const configRef = input.configRef?.trim() ?? '';
  if (projectId === '' && configRef === '') {
    errors.push({
      field: 'repository',
      message: 'Choose a project, or pin a pipeline configuration under More constraints.',
    });
  }

  const pattern = input.pattern.trim();
  errors.push(...patternErrors(input.context, pattern));
  switch (input.context) {
    case 'environment':
      conditions.push(exact('environment', [pattern]));
      break;
    case 'branch':
      conditions.push(exact('ref_type', ['branch']));
      conditions.push(glob('ref', [pattern]));
      break;
    case 'tag':
      conditions.push(exact('ref_type', ['tag']));
      conditions.push(glob('ref', [pattern]));
      break;
    case 'protected':
      conditions.push(exact('ref_protected', ['true']));
      break;
    case 'any':
      risks.push('any_ref');
      break;
  }
  if (PROTECTABLE_CONTEXTS.includes(input.context)) {
    if (input.requireProtectedRef) conditions.push(exact('ref_protected', ['true']));
    else risks.push('unprotected_ref');
  }
  if (configRef !== '') {
    if (!GITLAB_CONFIG_REF_RE.test(configRef)) {
      errors.push({
        field: 'workflow_ref',
        message:
          'Enter the pipeline configuration without *, like gitlab.com/acme-group/app//.gitlab-ci.yml@refs/heads/main.',
      });
    }
    conditions.push(exact('ci_config_ref_uri', [configRef]));
  }
  return { conditions, warnings: risks.map((risk) => RISK_WARNINGS[risk]), risks, errors };
}

/** Order-insensitive identity of a condition set (values sorted, `negate` only when true). */
export function conditionSetKey(conditions: readonly Condition[]): string {
  return JSON.stringify(
    conditions
      .map((c) =>
        canonicalJson({
          claim: c.claim,
          match: c.match,
          values: [...new Set(c.values)].sort(),
          ...(c.negate === true ? { negate: true } : {}),
        }),
      )
      .sort(),
  );
}

/** The single value of the one non-negated exact condition on `claim`, or undefined/null. */
function only(conditions: readonly Condition[], claim: string): string | null | undefined {
  const matching = conditions.filter((c) => c.claim === claim);
  if (matching.length === 0) return undefined;
  const [first] = matching;
  if (matching.length > 1 || !first || first.negate === true || first.values.length !== 1) {
    return null;
  }
  return first.values[0] ?? null;
}

/** Name candidates for the pattern of a condition set: environment, ref without prefix, base. */
function patternCandidates(conditions: readonly Condition[]): string[] {
  const out = new Set<string>(['']);
  for (const claim of ['environment', 'base_ref', 'ref']) {
    const value = only(conditions, claim);
    if (typeof value !== 'string') continue;
    out.add(value);
    for (const prefix of ['refs/heads/', 'refs/tags/']) {
      if (value.startsWith(prefix)) out.add(value.slice(prefix.length));
    }
  }
  return [...out];
}

/** The GitHub builder input that rebuilds exactly these conditions, or null (rows editor). */
export function githubPresetFromConditions(
  conditions: readonly Condition[],
): GithubPresetInput | null {
  const ownerId = only(conditions, 'repository_owner_id');
  if (typeof ownerId !== 'string') return null;
  const repositoryId = only(conditions, 'repository_id');
  const workflowRef = only(conditions, 'job_workflow_ref');
  if (repositoryId === null || workflowRef === null) return null;
  const hosted = only(conditions, 'runner_environment');
  const key = conditionSetKey(conditions);
  for (const context of GITHUB_CONTEXTS) {
    for (const pattern of PATTERN_CONTEXTS.includes(context)
      ? patternCandidates(conditions)
      : ['']) {
      for (const requireProtectedRef of [true, false]) {
        const input: GithubPresetInput = {
          ownerId,
          repositoryId: repositoryId ?? null,
          context,
          pattern,
          requireProtectedRef: PROTECTABLE_CONTEXTS.includes(context) ? requireProtectedRef : true,
          requireGithubHosted: hosted === 'github-hosted',
          workflowRef: workflowRef ?? null,
        };
        const built = githubAccessRulePreset(input);
        if (built.errors.length === 0 && conditionSetKey(built.conditions) === key) return input;
      }
    }
  }
  return null;
}

/** The GitLab builder input that rebuilds exactly these conditions, or null (rows editor). */
export function gitlabPresetFromConditions(
  conditions: readonly Condition[],
): GitlabPresetInput | null {
  const namespaceId = only(conditions, 'namespace_id');
  if (typeof namespaceId !== 'string') return null;
  const projectId = only(conditions, 'project_id');
  const configRef = only(conditions, 'ci_config_ref_uri');
  if (projectId === null || configRef === null) return null;
  const key = conditionSetKey(conditions);
  for (const context of GITLAB_CONTEXTS) {
    for (const pattern of PATTERN_CONTEXTS.includes(context)
      ? patternCandidates(conditions)
      : ['']) {
      for (const requireProtectedRef of [true, false]) {
        const input: GitlabPresetInput = {
          namespaceId,
          projectId: projectId ?? null,
          context,
          pattern,
          requireProtectedRef: PROTECTABLE_CONTEXTS.includes(context) ? requireProtectedRef : true,
          configRef: configRef ?? null,
        };
        const built = gitlabAccessRulePreset(input);
        if (built.errors.length === 0 && conditionSetKey(built.conditions) === key) return input;
      }
    }
  }
  return null;
}
