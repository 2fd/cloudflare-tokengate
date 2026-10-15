// Short human description of a consumer access (a grant): who may call ("acme/api"), in which
// context ("environment production") and what ("POST /chat.postMessage"). Derived from the stored
// conditions and rules only, with claim labels for numeric IDs. Display only: it never decides
// anything, and an unrecognised condition set still gets a truthful (if generic) summary.
import { labelFor } from '../db/claim-labels';
import type { ClaimLabel, Grant } from '../db/types';
import type { Condition, Rule } from '../policy/types';

export interface AccessSummary {
  /** The workload: repositories or projects, a workflow pin, an organization, or a subject. */
  subject: string;
  /** The ref or deployment context, e.g. "environment production", "branch main", "any ref". */
  context: string;
  /** One "METHOD[,METHOD] /path" entry per rule, in stored order. */
  operations: string[];
}

/** `labels` should be those of the grant's consumer (caller provider). */
export function accessSummary(
  grant: Pick<Grant, 'conditions' | 'rules'>,
  labels: readonly ClaimLabel[],
): AccessSummary {
  return {
    subject: subjectOf(grant.conditions, labels),
    context: contextOf(grant.conditions),
    operations: grant.rules.map(operationText),
  };
}

export function operationText(rule: Rule): string {
  return `${rule.methods.join(',')} ${rule.path}`;
}

/** Values of the positive conditions on `claim` (exact or glob). */
function values(conditions: readonly Condition[], claim: string, match?: 'exact' | 'glob') {
  return conditions
    .filter((c) => c.claim === claim && c.negate !== true && (!match || c.match === match))
    .flatMap((c) => c.values);
}

function labelled(labels: readonly ClaimLabel[], claim: string, ids: string[]): string {
  return ids.map((id) => labelFor(labels, claim, id) ?? id).join(', ');
}

function subjectOf(conditions: readonly Condition[], labels: readonly ClaimLabel[]): string {
  for (const claim of ['repository_id', 'project_id']) {
    const ids = values(conditions, claim, 'exact');
    if (ids.length > 0) return labelled(labels, claim, ids);
  }
  for (const claim of ['repository', 'project_path']) {
    const names = values(conditions, claim);
    if (names.length > 0) return names.join(', ');
  }
  for (const claim of ['job_workflow_ref', 'ci_config_ref_uri']) {
    const pins = values(conditions, claim, 'exact');
    if (pins.length > 0) return `workflow ${pins.join(', ')}`;
  }
  for (const claim of ['repository_owner_id', 'namespace_id']) {
    const ids = values(conditions, claim, 'exact');
    if (ids.length > 0) return `any repository of ${labelled(labels, claim, ids)}`;
  }
  const subjects = values(conditions, 'sub');
  if (subjects.length > 0) return subjects.join(', ');
  const first = conditions.find((c) => c.negate !== true && c.match === 'exact');
  return first ? `${first.claim} ${first.values.join(', ')}` : 'any caller of the consumer';
}

function contextOf(conditions: readonly Condition[]): string {
  const environments = values(conditions, 'environment');
  if (environments.length > 0) return `environment ${environments.join(', ')}`;

  const events = values(conditions, 'event_name', 'exact');
  const baseRefs = values(conditions, 'base_ref');
  if (events.length === 1 && events[0] === 'pull_request') {
    return baseRefs.length > 0 ? `PR into ${baseRefs.join(', ')}` : 'pull requests';
  }

  const refTypes = values(conditions, 'ref_type', 'exact');
  const refs = values(conditions, 'ref');
  const tags = refs.filter((r) => r.startsWith('refs/tags/')).map((r) => r.slice(10));
  const branches = refs.filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice(11));
  // GitLab refs are bare names; ref_type says which kind.
  const bare = refs.filter((r) => !r.startsWith('refs/'));
  if (tags.length > 0 || (refTypes[0] === 'tag' && bare.length > 0)) {
    const names = [...tags, ...(refTypes[0] === 'tag' ? bare : [])].join(', ');
    return events.length === 1 && events[0] === 'release' ? `release ${names}` : `tag ${names}`;
  }
  if (branches.length > 0 || (refTypes[0] === 'branch' && bare.length > 0)) {
    return `branch ${[...branches, ...(refTypes[0] === 'branch' ? bare : [])].join(', ')}`;
  }
  if (refs.length > 0) return `ref ${refs.join(', ')}`;
  if (values(conditions, 'ref_protected', 'exact').includes('true')) return 'protected refs';
  return 'any ref';
}
