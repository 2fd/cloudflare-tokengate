// The shared tokengate data set (3 consumers, 6 tokens, 9 accesses) and a map at scale, for the
// viz tests.
import type { MapAccess, MapConsumer, MapToken } from '../../src';

export const consumers: MapConsumer[] = [
  {
    id: 'gitlab-platform',
    name: 'GitLab CI (platform)',
    line: 'group platform (5678901)',
    logo: { brand: 'gitlab' },
  },
  {
    id: 'github-acme',
    name: 'GitHub Actions (acme)',
    line: 'org acme (1234567)',
    logo: { brand: 'github' },
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
    id: 'slack',
    name: 'Slack',
    slug: 'slack',
    line: '⌛ 1 access expires in 9 days',
    lineTone: 'warn',
    logo: { brand: 'slack' },
    requests: 2140,
    denied: 38,
    errors: 0,
    lastUsed: '2 min ago',
  },
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

export const accesses: MapAccess[] = [
  {
    consumer: 'github-acme',
    token: 'openai',
    status: 'Active',
    consumerLabel: 'GitHub Actions (acme) › acme/api',
    context: 'environment production',
    operation: 'Chat completions',
  },
  {
    consumer: 'github-acme',
    token: 'slack',
    status: 'Active',
    consumerLabel: 'GitHub Actions (acme) › acme/api',
    context: 'environment production',
    operation: 'Post messages',
  },
  {
    consumer: 'github-acme',
    token: 'slack',
    status: 'Active',
    consumerLabel: 'GitHub Actions (acme) › acme/web',
    context: 'branch main',
    operation: 'Post messages',
  },
  {
    consumer: 'github-acme',
    token: 'anthropic',
    tone: 'bad',
    status: 'Expired',
    consumerLabel: 'GitHub Actions (acme) › acme/api',
    context: 'tag v*',
  },
  {
    consumer: 'github-acme',
    token: 'anthropic',
    status: 'Active',
    consumerLabel: 'GitHub Actions (acme) › acme/web',
    context: 'branch main',
  },
  {
    consumer: 'github-acme',
    token: 'github',
    tone: 'warn',
    status: 'Risk accepted',
    consumerLabel: 'GitHub Actions (acme) › acme/infra',
    context: 'any branch',
  },
  {
    consumer: 'gitlab-platform',
    token: 'slack',
    tone: 'warn',
    status: 'Expires in 9 days',
    consumerLabel: 'GitLab CI (platform) › platform/deploy-tools',
    context: 'environment production',
    operation: 'Post messages',
  },
  {
    consumer: 'gitlab-platform',
    token: 'discord-alerts',
    status: 'Active',
    consumerLabel: 'GitLab CI (platform) › platform/deploy-tools',
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
    href: '/admin/issuer-access-rules/acc_bk1',
  },
];

/** 14 consumers and 9 tokens: the map at scale. Consumer n has (15 - n) % 5 + 1 accesses. */
export function atScale(): { consumers: MapConsumer[]; tokens: MapToken[]; accesses: MapAccess[] } {
  const many: MapConsumer[] = Array.from({ length: 14 }, (_, i) => ({
    id: `c${i}`,
    name: `Credential access rule ${i}`,
    logo: { brand: 'github' },
    weight: 100 - i,
  }));
  const toks: MapToken[] = Array.from({ length: 9 }, (_, i) => ({
    id: `t${i}`,
    name: `Credential ${i}`,
    logo: { brand: 'custom' },
    requests: 1000 - i * 100,
    denied: 0,
    errors: 0,
    lastUsed: '1 h ago',
  }));
  const acc: MapAccess[] = [];
  many.forEach((c, i) => {
    acc.push({ consumer: c.id, token: `t${i % 9}`, status: 'Active' });
  });
  // the credential access rule in row 13 (outside the busiest 6) uses the quietest token
  acc.push({ consumer: 'c13', token: 't8', tone: 'warn', status: 'Expires in 2 days' });
  return { consumers: many, tokens: toks, accesses: acc };
}
