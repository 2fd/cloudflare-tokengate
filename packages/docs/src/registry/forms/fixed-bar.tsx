import { Badge, FixedBar, Inherit } from '@tokengate/ui';
import type { ComponentDoc } from '../types';
import { logos } from './data';

export const fixedBar: ComponentDoc = {
  slug: 'fixed-bar',
  name: 'FixedBar',
  related: ['Inherit'],
  summary:
    'A value preselected from the entry point, shown as a fact with a Change link instead of a field; and a read-only inherited fact.',
  usage: {
    when: [
      '“Give access” from a token page: the token is fixed (“Token: Slack · Change”).',
      <>
        A fact that comes from another object and cannot change here: <code>Inherit</code>{' '}
        (“Inherited from GitHub Actions (acme): organization acme (1234567)”).
      </>,
    ],
    whenNot: [
      'A value the person still has to choose: a picker.',
      'An editable derived value: a read-only Input with a note.',
    ],
  },
  examples: [
    {
      title: 'Token fixed, with a status',
      layout: 'stack',
      render: () => (
        <FixedBar
          label="Token"
          logo={logos.slackSm}
          name="Slack"
          meta="/proxy/slack"
          status={
            <Badge tone="ok" glyph="✓">
              Secret set
            </Badge>
          }
          change={{ href: '?change=token', srSuffix: 'token' }}
        />
      ),
      code: `<FixedBar label="Token" logo="slack"
  name="Slack" meta="/proxy/slack"
  status={<Badge tone="ok" glyph="✓">Secret set</Badge>}
  change={{ href: '/admin/access/new', srSuffix: 'token' }} />`,
    },
    {
      title: 'Consumer fixed, long name',
      description: 'The name part wraps before a badge overlaps it.',
      layout: 'stack',
      render: () => (
        <FixedBar
          label="Consumer"
          logo={logos.githubSm}
          name="GitHub Actions (acme)"
          meta="token.actions.githubusercontent.com · acme (1234567)"
          status={
            <Badge tone="warn" glyph="⚠">
              Risk accepted
            </Badge>
          }
          change={{ href: '?change=consumer', srSuffix: 'consumer' }}
        />
      ),
      code: `<FixedBar label="Consumer" logo="github" name="GitHub Actions (acme)"
  meta="token.actions.githubusercontent.com · acme (1234567)"
  status={<Badge tone="warn" glyph="⚠">Risk accepted</Badge>}
  change={{ href: '/admin/access/new?token=slack', srSuffix: 'consumer' }} />`,
    },
    {
      title: 'Inherited fact',
      layout: 'stack',
      render: () => (
        <Inherit>
          Inherited from <b>GitHub Actions (acme)</b>: organization{' '}
          <span class="mono">acme (1234567)</span>
        </Inherit>
      ),
      code: `<Inherit>
  Inherited from <b>GitHub Actions (acme)</b>: organization <span class="mono">acme (1234567)</span>
</Inherit>`,
    },
  ],
  props: [
    {
      component: 'FixedBar',
      props: [
        { name: 'label', type: 'Child', required: true, description: 'What is fixed (“Token”).' },
        { name: 'logo', type: 'LogoSpec', description: 'Brand tile (24px), decorative.' },
        { name: 'name', type: 'Child', required: true, description: 'The value, bold.' },
        { name: 'meta', type: 'Child', description: 'Mono fact after the name: path or ID.' },
        { name: 'status', type: 'Child', description: 'A status badge.' },
        {
          name: 'change',
          type: '{ href: string; srSuffix: string; label?: string }',
          description:
            'Link back to choose another value; srSuffix completes the hidden link text (the space is added).',
        },
        { name: 'class', type: 'string', description: 'Extra classes.' },
      ],
    },
    {
      component: 'Inherit',
      props: [
        { name: 'class', type: 'string', description: 'Extra classes.' },
        { name: 'children', type: 'Child', description: 'The fact; the source in b.' },
      ],
    },
  ],
  accessibility: [
    'The Change link reads “Change token”: the hidden suffix makes it unique on the page.',
    'The logo is decorative; the name is text.',
    'The value is plain text, not a disabled input, so it is read in order and not skipped.',
  ],
  do: ['Preselect from the entry point and show it as a fixed bar.', 'Always offer Change.'],
  dont: ['Do not render a disabled select for a fixed value.'],
  classes: ['fixedbar', 'lbl', 'grow', 'meta', 'mono', 'inherit'],
};
