// GitHub Actions grant builder (docs/policies.md). UI-only convenience: produces plain conditions that
// still go through validateGrant. Defaults are the safe choice: numeric IDs, exact event
// allowlists, protected refs; wildcard workflow pins are refused.
import type { Condition } from './types';

export type GithubPresetContext = 'branch' | 'tag' | 'release' | 'pr' | 'environment';

export interface GithubPresetInput {
  /** Numeric organization/user ID (`repository_owner_id`); names can be re-registered. */
  ownerId: string;
  /** Numeric repository IDs; may be empty only when `workflowRef` is set. */
  repositoryIds: string[];
  context: GithubPresetContext;
  /** Branch/tag glob (without refs/heads/ or refs/tags/), PR base branch glob, or environment. */
  pattern: string;
  requireProtectedRef: boolean;
  requireGithubHosted: boolean;
  /** `job_workflow_ref` pin, e.g. `acme/infra/.github/workflows/deploy.yml@refs/heads/main`. */
  workflowRef: string | null;
}

const DIGITS_RE = /^[0-9]{1,20}$/;

/** Builds the conditions for a GitHub grant. `errors` non-empty means do not save. */
export function githubGrantPreset(input: GithubPresetInput): {
  conditions: Condition[];
  warnings: string[];
  errors: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const conditions: Condition[] = [];
  const exact = (claim: string, values: string[]): Condition => ({ claim, match: 'exact', values });
  const glob = (claim: string, values: string[]): Condition => ({ claim, match: 'glob', values });

  const ownerId = input.ownerId.trim();
  if (!DIGITS_RE.test(ownerId)) {
    errors.push('owner ID must be the numeric ID (gh api orgs/OWNER --jq .id)');
  }
  conditions.push(exact('repository_owner_id', [ownerId]));

  const repositoryIds = input.repositoryIds.map((id) => id.trim()).filter((id) => id !== '');
  for (const id of repositoryIds) {
    if (!DIGITS_RE.test(id)) {
      errors.push(
        `repository ID ${JSON.stringify(id)} must be numeric (gh api repos/OWNER/REPO --jq .id)`,
      );
    }
  }
  if (repositoryIds.length > 0) {
    conditions.push(exact('repository_id', [...new Set(repositoryIds)]));
  }

  const workflowRef = input.workflowRef?.trim() ?? '';
  if (repositoryIds.length === 0 && workflowRef === '') {
    errors.push('list at least one repository ID or pin a workflow');
  }

  const pattern = input.pattern.trim();
  if (pattern === '') errors.push('a pattern or name is required');
  if (input.context !== 'environment' && pattern.startsWith('refs/')) {
    errors.push('enter the branch or tag name without the refs/heads/ or refs/tags/ prefix');
  }

  switch (input.context) {
    case 'branch':
      conditions.push(exact('ref_type', ['branch']));
      conditions.push(glob('ref', [`refs/heads/${pattern}`]));
      conditions.push(exact('event_name', ['push', 'workflow_dispatch', 'schedule']));
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
    case 'pr':
      conditions.push(exact('event_name', ['pull_request']));
      conditions.push(glob('base_ref', [pattern]));
      warnings.push('pull_request jobs run the code proposed in the pull request');
      break;
    case 'environment':
      if (pattern.includes('*')) {
        conditions.push(glob('environment', [pattern]));
        warnings.push(
          'environment glob: GitHub creates unprotected environments on first use, so any matching name a writer picks is admitted',
        );
      } else {
        conditions.push(exact('environment', [pattern]));
      }
      break;
  }

  if (input.requireProtectedRef) {
    conditions.push(exact('ref_protected', ['true']));
    if (input.context === 'pr') {
      warnings.push(
        'pull request refs (refs/pull/N/merge) are not protected; this grant may never match',
      );
    }
  } else if (input.context !== 'pr') {
    warnings.push(
      'protected refs are not required: anyone who can push a matching branch or tag is admitted',
    );
  }

  if (input.requireGithubHosted) conditions.push(exact('runner_environment', ['github-hosted']));

  if (workflowRef !== '') {
    const at = workflowRef.lastIndexOf('@');
    if (workflowRef.includes('*')) {
      errors.push('workflow pin must be exact; a wildcard admits workflows from any branch');
    } else if (at <= 0 || at === workflowRef.length - 1 || workflowRef.split('/').length < 3) {
      errors.push('workflow pin must look like OWNER/REPO/PATH@REF');
    }
    conditions.push(exact('job_workflow_ref', [workflowRef]));
  }

  return { conditions, warnings, errors };
}
