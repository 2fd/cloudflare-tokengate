// Example data shared by the forms docs pages: the tokengate example install (tokens Slack and
// OpenAI, consumers GitHub Actions (acme) and GitLab CI (platform), repositories acme/*).
import type { CheckPreset, Pick, RadioCard, RowPick } from '@tokengate/ui';
import { Badge, Logo, type LogoSpec } from '@tokengate/ui';

/** Logos as data (`LogoSpec`): each component draws the tile at its own size. */
export const logos = {
  slack: 'slack',
  slackSm: 'slack',
  slackHook: { brand: 'slack', text: '#' },
  openai: 'openai',
  anthropic: 'anthropic',
  github: 'github',
  githubSm: 'github',
  gitlab: 'gitlab',
  gitlabSm: 'gitlab',
  buildkite: 'buildkite',
  buildkiteSm: 'buildkite',
  custom: 'custom',
  unknown: { brand: 'custom', text: '?' },
} as const satisfies Record<string, LogoSpec>;

/** Drawn tiles, for the phrases of a decorative LivePhrase (a SummaryRow `logoSlot`). */
export const tiles = {
  github: <Logo brand="github" />,
  gitlab: <Logo brand="gitlab" />,
  buildkite: <Logo brand="buildkite" />,
  unknown: <Logo brand="custom">?</Logo>,
};

export const consumers: readonly RowPick[] = [
  {
    value: 'gha-acme',
    title: 'GitHub Actions (acme)',
    meta: 'most used · 6 accesses',
    logo: logos.githubSm,
  },
  {
    value: 'gitlab-platform',
    title: 'GitLab CI (platform)',
    meta: '2 accesses',
    logo: logos.gitlabSm,
  },
  { value: 'buildkite-acme', title: 'Buildkite (acme)', meta: '1 access', logo: logos.buildkiteSm },
];

export const repositories: readonly RowPick[] = [
  { value: '89012345', title: 'acme/api', mono: true, detail: '(89012345)', meta: '3 accesses' },
  {
    value: '89012346',
    title: 'acme/web',
    mono: true,
    detail: '(89012346)',
    meta: '2 accesses · already has Slack',
  },
  { value: '89012347', title: 'acme/infra', mono: true, detail: '(89012347)', meta: '1 access' },
  { value: '89012348', title: 'acme/docs', mono: true, detail: '(89012348)', meta: '1 access' },
  { value: 'other', title: 'Another repository' },
];

export const contexts: readonly RadioCard[] = [
  {
    value: 'environment',
    title: 'Environment',
    badge: <Badge tone="accent">Most used</Badge>,
    description: 'Jobs that deploy to a GitHub environment',
  },
  {
    value: 'branch',
    title: 'Branch',
    description: 'Pushes, manual runs and schedules on a branch',
  },
  {
    value: 'protected',
    title: 'Any protected branch or tag',
    description: 'Every ref with protection in GitHub',
  },
  {
    value: 'pull_request',
    title: 'Pull request into',
    risk: true,
    description: 'Risk: pull_request jobs run the code proposed in the pull request.',
  },
];

export const environments: readonly Pick[] = [
  { value: 'production', label: 'production', mono: true, meta: 'most used' },
  { value: 'staging', label: 'staging', mono: true },
  { value: 'preview', label: 'preview', mono: true },
  { value: 'other', label: 'Other' },
];

export const expiries: readonly Pick[] = [
  { value: 'never', label: 'Never' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'date', label: 'On a date' },
];

export const slackOperations: readonly CheckPreset[] = [
  { value: 'post', title: 'Post messages', note: '(default)', code: 'POST /chat.postMessage' },
  {
    value: 'edit',
    title: 'Update and delete messages',
    code: 'POST /chat.update · POST /chat.delete',
  },
  { value: 'upload', title: 'Upload files', code: 'POST /files.getUploadURLExternal' },
  { value: 'channels', title: 'Read channel list', code: 'GET /conversations.list' },
];
