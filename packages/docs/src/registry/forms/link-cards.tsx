import { LinkCards } from '@tokengate/ui';
import type { ComponentDoc } from '../types';
import { logos } from './data';

export const linkCards: ComponentDoc = {
  slug: 'link-cards',
  name: 'LinkCards',
  summary:
    'A grid of link cards: pick one to go to its form page. Each card is one link with a chevron.',
  usage: {
    when: [
      'Choose a type before a form that lives on its own page: the kind of consumer to add.',
      'An index of sections (the docs overview uses it without logos).',
    ],
    whenNot: [
      <>
        Types whose form fits on the same page: <code>TypeCatalog</code>.
      </>,
      'Actions: buttons.',
    ],
  },
  examples: [
    {
      title: 'With logos',
      layout: 'stack',
      render: () => (
        <LinkCards
          label="Consumer types"
          cards={[
            {
              href: '?kind=github',
              title: 'GitHub Actions',
              meta: '1 consumer',
              description: 'OIDC from token.actions.githubusercontent.com',
              logo: logos.github,
            },
            {
              href: '?kind=gitlab',
              title: 'GitLab CI',
              meta: '1 consumer',
              description: 'OIDC from your GitLab instance',
              logo: logos.gitlab,
            },
            {
              href: '?kind=buildkite',
              title: 'Buildkite',
              description: 'OIDC from agent.buildkite.com',
              logo: logos.buildkite,
            },
            {
              href: '?kind=oidc',
              title: 'Other OIDC issuer',
              description: 'Any issuer with a JWKS URL',
              logo: logos.custom,
            },
          ]}
        />
      ),
      code: `<LinkCards label="Consumer types" cards={[
  { href: '/admin/consumers/new?kind=github', title: 'GitHub Actions', meta: '1 consumer',
    description: 'OIDC from token.actions.githubusercontent.com',
    logo: 'github' },
  { href: '/admin/consumers/new?kind=gitlab', title: 'GitLab CI', … },
  { href: '/admin/consumers/new?kind=buildkite', title: 'Buildkite', … },
  { href: '/admin/consumers/new?kind=oidc', title: 'Other OIDC issuer', … },
]} />`,
    },
    {
      title: 'Without logos',
      description: 'Two columns: text, then the chevron.',
      layout: 'stack',
      render: () => (
        <LinkCards
          label="Token pages"
          cards={[
            {
              href: '?page=hosts',
              title: 'Allowed hosts',
              meta: '7 hosts',
              description: 'Where tokens may point.',
            },
            {
              href: '?page=keys',
              title: 'Encryption keys',
              description: 'The keys that seal stored secrets.',
            },
            {
              href: '?page=retention',
              title: 'Data retention',
              description: 'How long requests and audit events are kept.',
            },
          ]}
        />
      ),
      code: `<LinkCards label="Token pages" cards={[
  { href: '/admin/tokens/hosts', title: 'Allowed hosts', meta: '7 hosts', description: 'Where tokens may point.' },
  { href: '/admin/tokens/keys', title: 'Encryption keys', description: 'The keys that seal stored secrets.' },
  { href: '/admin/settings/retention', title: 'Data retention', description: 'How long requests and audit events are kept.' },
]} />`,
    },
  ],
  props: [
    {
      component: 'LinkCards',
      props: [
        {
          name: 'label',
          type: 'string',
          description: 'Name of the list when it has no heading of its own.',
        },
        {
          name: 'cards',
          type: 'readonly { href; title; description?; meta?; logo?: LogoSpec }[]',
          required: true,
          description: 'One card per destination.',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the ul.' },
      ],
    },
  ],
  accessibility: [
    'A list of links: screen readers announce the count, and each card is one link with its title and description.',
    'Logos and the chevron are decorative.',
    'The whole card is the click target; hover and focus show the accent border and the focus ring.',
  ],
  do: ['Keep descriptions to one line.', 'Use meta for a count that helps choose.'],
  dont: ['Do not put buttons or other links inside a card.'],
  classes: ['tcards', 'tcard', 't', 'd', 'go', 'faint', 'plain'],
};
