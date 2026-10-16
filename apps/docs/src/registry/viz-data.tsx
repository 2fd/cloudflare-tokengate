// Sample data of the "viz" docs pages: the shared tokengate data set (3 consumers, 6 tokens,
// 9 accesses), the same install at scale (14 consumers, 9 tokens, 31 accesses), 24 hours of
// traffic and the access matrix. Only the viz group agent edits this file.
import type {
  ChartBar,
  MapAccess,
  MapConsumer,
  MapToken,
  MatrixColumn,
  MatrixGroup,
  SplitItem,
} from '@tokengate/ui';

// --- Shared data set ------------------------------------------------------------------------

export const consumers: MapConsumer[] = [
  {
    id: 'github-acme',
    name: 'GitHub Actions (acme)',
    line: 'org acme (1234567)',
    logo: { brand: 'github' },
  },
  {
    id: 'gitlab-platform',
    name: 'GitLab CI (platform)',
    line: 'group platform (5678901)',
    logo: { brand: 'gitlab' },
  },
  {
    id: 'buildkite-acme',
    name: 'Buildkite (acme)',
    line: 'Generic OIDC · idle 41 days',
    logo: { brand: 'buildkite' },
    idle: true,
  },
];

export const tokens: MapToken[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    slug: 'openai',
    line: '⌛ Secret expires in 6 days',
    lineTone: 'warn',
    logo: { brand: 'openai' },
    requests: 3902,
    denied: 21,
    errors: 11,
    lastUsed: '1 min ago',
  },
  {
    id: 'slack',
    name: 'Slack',
    slug: 'slack',
    line: (
      <>
        2 consumers · <span class="t-warn">⌛ 1 access expires in 9 days</span>
      </>
    ),
    logo: { brand: 'slack' },
    requests: 2140,
    denied: 38,
    errors: 0,
    lastUsed: '2 min ago',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    slug: 'anthropic',
    line: '✕ 1 of 2 accesses expired',
    lineTone: 'bad',
    logo: { brand: 'anthropic' },
    requests: 1630,
    denied: 0,
    errors: 1,
    lastUsed: '3 min ago',
  },
  {
    id: 'github',
    name: 'GitHub',
    slug: 'github',
    line: '⚠ Risk accepted on 1 access',
    lineTone: 'warn',
    logo: { brand: 'github' },
    requests: 311,
    denied: 0,
    errors: 0,
    lastUsed: '22 min ago',
  },
  {
    id: 'discord-alerts',
    name: 'Discord alerts',
    slug: 'discord-alerts',
    line: '1 consumer',
    logo: { brand: 'discord' },
    requests: 49,
    denied: 0,
    errors: 0,
    lastUsed: '3 h ago',
  },
  {
    id: 'slack-legacy',
    name: 'Slack (legacy)',
    slug: 'slack-legacy',
    line: '⏸ Disabled · its access is inactive',
    logo: { brand: 'slack' },
    requests: 0,
    denied: 0,
    errors: 0,
    lastUsed: '41 days ago',
    idle: true,
    tag: '1 idle token',
  },
];

const acme = 'GitHub Actions (acme)';
const platform = 'GitLab CI (platform) › platform/deploy-tools';

export const accesses: MapAccess[] = [
  {
    consumer: 'github-acme',
    token: 'openai',
    status: 'Active',
    consumerLabel: `${acme} › acme/api`,
    context: 'environment production',
    operation: 'Chat completions',
  },
  {
    consumer: 'github-acme',
    token: 'slack',
    status: 'Active',
    consumerLabel: `${acme} › acme/api`,
    context: 'environment production',
    operation: 'Post messages',
  },
  {
    consumer: 'github-acme',
    token: 'slack',
    status: 'Active',
    consumerLabel: `${acme} › acme/web`,
    context: 'branch main',
    operation: 'Post messages',
  },
  {
    consumer: 'github-acme',
    token: 'anthropic',
    tone: 'bad',
    status: 'Expired',
    consumerLabel: `${acme} › acme/api`,
    context: 'tag v*',
    operation: 'Messages',
  },
  {
    consumer: 'github-acme',
    token: 'anthropic',
    status: 'Active',
    consumerLabel: `${acme} › acme/web`,
    context: 'branch main',
    operation: 'Messages',
  },
  {
    consumer: 'github-acme',
    token: 'github',
    tone: 'warn',
    status: 'Risk accepted',
    consumerLabel: `${acme} › acme/infra`,
    context: 'any branch',
    operation: 'Read contents',
  },
  {
    consumer: 'gitlab-platform',
    token: 'slack',
    tone: 'warn',
    status: 'Expires in 9 days',
    consumerLabel: platform,
    context: 'environment production',
    operation: 'Post messages',
  },
  {
    consumer: 'gitlab-platform',
    token: 'discord-alerts',
    status: 'Active',
    consumerLabel: platform,
    context: 'branch main',
    operation: 'POST /',
  },
  {
    consumer: 'buildkite-acme',
    token: 'slack-legacy',
    tone: 'off',
    status: 'Inactive: token disabled',
    consumerLabel: 'Buildkite (acme) › pipeline deploy',
    operation: 'Post messages',
  },
];

/** The shared data set as seen with `?focus=gitlab-platform`: token lines speak for its accesses. */
export const tokensFocusedOnPlatform: MapToken[] = tokens.map((token) =>
  token.id === 'slack'
    ? { ...token, line: '⌛ via GitLab CI: expires in 9 days', lineTone: 'warn' }
    : token.id === 'discord-alerts'
      ? { ...token, line: 'via GitLab CI: active' }
      : token,
);

// --- The same install at scale --------------------------------------------------------------

const c = (id: string, name: string, line: string, brand: MapConsumer['logo']['brand']) => ({
  id,
  name,
  line,
  logo: { brand },
});

export const scaleConsumers: MapConsumer[] = [
  c('github-acme', 'GitHub Actions (acme)', 'org acme', 'github'),
  c('gitlab-platform', 'GitLab CI (platform)', 'group platform', 'gitlab'),
  c('github-acme-labs', 'GitHub Actions (acme-labs)', 'org acme-labs', 'github'),
  c('gitlab-data', 'GitLab CI (data)', 'group data', 'gitlab'),
  c('buildkite-acme', 'Buildkite (acme)', 'Generic OIDC', 'buildkite'),
  c('k8s-prod', 'Kubernetes (prod)', 'Generic OIDC', 'oidc'),
  c('circleci-mobile', 'CircleCI (mobile)', 'Generic OIDC', 'oidc'),
  c('github-acme-ios', 'GitHub Actions (acme-ios)', 'org acme-ios', 'github'),
  c('gitlab-ml', 'GitLab CI (ml)', 'group ml', 'gitlab'),
  c('github-acme-docs', 'GitHub Actions (acme-docs)', 'org acme-docs', 'github'),
  c('buildkite-data', 'Buildkite (data)', 'Generic OIDC', 'buildkite'),
  c('k8s-staging', 'Kubernetes (staging)', 'Generic OIDC', 'oidc'),
  c('gitlab-sec', 'GitLab CI (security)', 'group security', 'gitlab'),
  c('circleci-web', 'CircleCI (web)', 'Generic OIDC', 'oidc'),
];

const pairs: Array<[string, string, MapAccess['tone']?]> = [
  ['github-acme', 'openai'],
  ['github-acme', 'slack'],
  ['github-acme', 'slack'],
  ['github-acme', 'anthropic'],
  ['github-acme', 'github'],
  ['github-acme', 'internal-api'],
  ['gitlab-platform', 'slack', 'warn'],
  ['gitlab-platform', 'discord-alerts'],
  ['github-acme-labs', 'openai'],
  ['github-acme-labs', 'slack'],
  ['github-acme-labs', 'anthropic'],
  ['github-acme-labs', 'github'],
  ['gitlab-data', 'openai'],
  ['gitlab-data', 'anthropic'],
  ['gitlab-data', 'sentry'],
  ['buildkite-acme', 'slack'],
  ['buildkite-acme', 'datadog'],
  ['k8s-prod', 'openai'],
  ['k8s-prod', 'internal-api'],
  ['circleci-mobile', 'slack'],
  ['circleci-mobile', 'openai'],
  ['github-acme-ios', 'slack'],
  ['github-acme-ios', 'linear'],
  ['gitlab-ml', 'anthropic'],
  ['gitlab-ml', 'sentry'],
  ['github-acme-docs', 'linear'],
  ['github-acme-docs', 'sentry'],
  ['buildkite-data', 'datadog'],
  ['k8s-staging', 'github'],
  ['gitlab-sec', 'sentry'],
  ['circleci-web', 'datadog'],
];

const t = (
  id: string,
  name: string,
  brand: MapToken['logo']['brand'],
  requests: number,
  lastUsed: string,
): MapToken => ({ id, name, logo: { brand }, requests, denied: 0, errors: 0, lastUsed });

export const scaleTokens: MapToken[] = [
  { ...t('openai', 'OpenAI', 'openai', 3902, '1 min ago'), denied: 21, errors: 11 },
  { ...t('slack', 'Slack', 'slack', 2140, '2 min ago'), denied: 38 },
  { ...t('anthropic', 'Anthropic', 'anthropic', 1630, '3 min ago'), errors: 1 },
  t('github', 'GitHub', 'github', 311, '22 min ago'),
  t('discord-alerts', 'Discord alerts', 'discord', 49, '3 h ago'),
  t('internal-api', 'Internal API', 'custom', 40, '1 h ago'),
  t('sentry', 'Sentry', 'custom', 30, '2 h ago'),
  t('datadog', 'Datadog', 'custom', 20, '5 h ago'),
  t('linear', 'Linear', 'custom', 10, '1 day ago'),
].map((token) => ({
  ...token,
  line: plural(scaleUsers(token.id), 'consumer', 'consumers'),
}));

function scaleUsers(tokenId: string): number {
  return new Set(pairs.filter(([, token]) => token === tokenId).map(([consumer]) => consumer)).size;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const scaleAccesses: MapAccess[] = pairs.map(([consumer, token, tone]) => ({
  consumer,
  token,
  tone,
  status: tone === 'warn' ? 'Expires in 9 days' : 'Active',
}));

/** At scale, focused on GitLab CI (platform). */
export const scaleTokensFocused: MapToken[] = scaleTokens.map((token) =>
  token.id === 'slack'
    ? { ...token, line: '⌛ via GitLab CI: expires in 9 days', lineTone: 'warn' }
    : token.id === 'discord-alerts'
      ? { ...token, line: 'via GitLab CI: active' }
      : token,
);

// --- 24 hours of traffic (UTC, the last bar is so far) --------------------------------------

const HOURS: Array<[number, number, number, number]> = [
  [15, 402, 8, 0],
  [16, 373, 7, 0],
  [17, 324, 6, 0],
  [18, 265, 5, 0],
  [19, 206, 4, 0],
  [20, 157, 3, 0],
  [21, 118, 2, 0],
  [22, 98, 2, 0],
  [23, 93, 2, 0],
  [0, 88, 2, 0],
  [1, 103, 2, 0],
  [2, 147, 3, 0],
  [3, 255, 5, 0],
  [4, 373, 7, 0],
  [5, 459, 9, 2],
  [6, 510, 10, 0],
  [7, 549, 10, 1],
  [8, 579, 11, 0],
  [9, 596, 11, 3],
  [10, 589, 11, 0],
  [11, 607, 11, 2],
  [12, 590, 48, 2],
  [13, 418, 61, 1],
  [14, 62, 1, 1],
];

const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;

export const hourBars: ChartBar[] = HOURS.map(([hour, allowed, denied, errors], index) => ({
  label: hh(hour),
  range: `${hh(hour)}–${hh(hour + 1)}`,
  allowed,
  denied,
  errors,
  partial: index === HOURS.length - 1,
}));

export const dayBars: ChartBar[] = [
  ['Thu 9', 7120, 98, 4],
  ['Fri 10', 7410, 102, 9],
  ['Sat 11', 2210, 31, 0],
  ['Sun 12', 1980, 27, 1],
  ['Mon 13', 7630, 120, 6],
  ['Tue 14', 7702, 171, 10],
  ['Wed 15', 5180, 199, 8],
].map(([label, allowed, denied, errors], index) => ({
  label: String(label),
  allowed: Number(allowed),
  denied: Number(denied),
  errors: Number(errors),
  partial: index === 6,
}));

// --- Matrix ---------------------------------------------------------------------------------

export const matrixColumns: MatrixColumn[] = [
  {
    id: 'slack',
    name: 'Slack',
    logo: { brand: 'slack' },
    href: '/admin/access?token=slack',
    meta: '3 accesses · 2,140 req',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    logo: { brand: 'openai' },
    href: '/admin/access?token=openai',
    meta: '1 access · 3,902 req',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    logo: { brand: 'anthropic' },
    href: '/admin/access?token=anthropic',
    meta: '2 accesses',
  },
  {
    id: 'github',
    name: 'GitHub',
    logo: { brand: 'github' },
    href: '/admin/access?token=github',
    meta: '1 access',
  },
  {
    id: 'discord-alerts',
    name: 'Discord alerts',
    logo: { brand: 'discord' },
    href: '/admin/access?token=discord-alerts',
    meta: '1 access',
  },
];

export const matrixGroups: MatrixGroup[] = [
  {
    name: 'GitHub Actions (acme)',
    logo: { brand: 'github' },
    href: '/admin/consumers/github-acme',
    meta: 'org acme (1234567) · 6 accesses',
    rows: [
      {
        label: 'acme/api',
        href: '/admin/access?repo=acme/api',
        meta: '3 accesses',
        cells: {
          slack: {
            href: '/admin/access/acc_01',
            status: 'Active',
            constraint: 'env production',
            operations: '1 operation',
          },
          openai: {
            href: '/admin/access/acc_02',
            tone: 'warn',
            status: 'Secret expires',
            constraint: 'branch main',
            operations: '2 operations',
          },
          anthropic: {
            href: '/admin/access/acc_03',
            tone: 'bad',
            status: 'Expired',
            constraint: 'tag v*',
            operations: '1 operation',
          },
        },
      },
      {
        label: 'acme/web',
        href: '/admin/access?repo=acme/web',
        meta: '2 accesses',
        cells: {
          slack: {
            href: '/admin/access/acc_04',
            status: 'Active',
            constraint: 'env staging',
            operations: '1 operation',
          },
          anthropic: {
            href: '/admin/access/acc_05',
            status: 'Active',
            constraint: 'branch main',
            operations: '1 operation',
          },
          github: {
            href: '/admin/access/acc_06',
            tone: 'warn',
            glyph: '⚠',
            status: 'Risk accepted',
            constraint: 'pull request',
            operations: '1 operation',
          },
        },
      },
    ],
  },
  {
    name: 'Buildkite (acme)',
    logo: { brand: 'buildkite' },
    href: '/admin/consumers/buildkite-acme',
    meta: 'idle 41 days · 1 access',
    rows: [
      {
        label: 'pipeline deploy',
        href: '/admin/access?consumer=buildkite-acme',
        meta: '1 access',
        cells: {
          slack: {
            href: '/admin/access/acc_09',
            tone: 'off',
            status: 'Inactive',
            constraint: 'Slack (legacy)',
            operations: 'token disabled',
          },
        },
      },
    ],
  },
];

// --- Request list ---------------------------------------------------------------------------

export const requestItems: SplitItem[] = [
  {
    href: '?req=req_01JB8Z5K2Q7W3N4M6P8R9T0V1X',
    title: 'POST /chat.postMessage',
    outcome: { tone: 'bad', word: 'Denied', code: '403' },
    time: '14:03:22',
    datetime: '2026-10-15T14:03:22Z',
    meta: 'acme/web → slack',
    current: true,
  },
  {
    href: '?req=req_01JB8Z5JX1',
    title: 'POST /v1/chat/completions',
    outcome: { tone: 'ok', word: 'Allowed', code: '200' },
    time: '14:03:10',
    datetime: '2026-10-15T14:03:10Z',
    meta: 'acme/api → openai',
  },
  {
    href: '?req=req_01JB8Z5JW2',
    title: 'POST /chat.postMessage',
    outcome: { tone: 'ok', word: 'Allowed', code: '200' },
    time: '14:02:58',
    datetime: '2026-10-15T14:02:58Z',
    meta: 'acme/api → slack',
  },
  {
    href: '?req=req_01JB8Z5JV3',
    title: 'GET /api/v4/projects',
    outcome: { tone: 'bad', word: 'Denied', code: '401' },
    time: '14:02:41',
    datetime: '2026-10-15T14:02:41Z',
    meta: 'gitlab.example.org · unverified',
  },
  {
    href: '?req=req_01JB8Z5JS5',
    title: 'POST /v1/chat/completions',
    outcome: { tone: 'warn', word: 'Error', code: '502' },
    time: '14:01:55',
    datetime: '2026-10-15T14:01:55Z',
    meta: 'acme/api → openai',
  },
];
