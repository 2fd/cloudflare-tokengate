import { Badge, FieldSet, RadioCards } from '@tokengate/ui';
import type { ComponentDoc } from '../types';
import { contexts } from './data';

export const radioCards: ComponentDoc = {
  slug: 'radio-cards',
  name: 'RadioCards',
  summary:
    'Radio cards for 2–6 options, each with a line of explanation. Checked shows “✓ Selected”; a risky option turns warn.',
  usage: {
    when: [
      '2–6 options where the person needs a sentence to choose: when jobs can use a token, what kind of consumer.',
      'An option with a risk: mark it risk, and the description starts with “Risk:”.',
    ],
    whenNot: [
      <>
        Existing values with usage counts: <code>RowPicker</code>.
      </>,
      <>
        Short values (environment, expiry): <code>Picks</code>.
      </>,
      <>
        Seven options or more: <code>Select</code>.
      </>,
    ],
  },
  examples: [
    {
      title: 'Preselected, with a badge',
      description: 'The server renders the likely option checked. A badge labels it.',
      layout: 'stack',
      render: () => (
        <FieldSet id="rc-ctx" legend="When can its jobs use the token?">
          <RadioCards name="rc-ctx" options={contexts.slice(0, 2)} value="environment" />
        </FieldSet>
      ),
      code: `<FieldSet id="ctx" legend="When can its jobs use the token?">
  <RadioCards name="ctx" value="environment" options={[
    { value: 'environment', title: 'Environment', badge: <Badge tone="accent">Most used</Badge>,
      description: 'Jobs that deploy to a GitHub environment' },
    { value: 'branch', title: 'Branch',
      description: 'Pushes, manual runs and schedules on a branch' },
  ]} />
</FieldSet>`,
    },
    {
      title: 'Risky option, checked',
      description:
        'A risk option shows a “⚠ Risk” tag and turns warn when checked. In a LiveForm it also shows the RiskAcceptance.',
      layout: 'stack',
      render: () => (
        <FieldSet id="rc-risk" legend="When can its jobs use the token?">
          <RadioCards name="rc-risk" options={contexts} value="pull_request" />
        </FieldSet>
      ),
      code: `<RadioCards name="ctx" value="pull_request" options={[
  …,
  { value: 'pull_request', title: 'Pull request into', risk: true,
    description: 'Risk: pull_request jobs run the code proposed in the pull request.' },
]} />`,
    },
    {
      title: 'Disabled and wide',
      description:
        'A disabled option stays visible with its reason struck through. A wide card spans the row.',
      layout: 'stack',
      render: () => (
        <FieldSet id="rc-off" legend="When can its jobs use the token?">
          <RadioCards
            name="rc-off"
            value="branch"
            options={[
              {
                value: 'environment',
                title: 'Environment',
                description: 'Jobs that deploy to a GitHub environment',
              },
              {
                value: 'branch',
                title: 'Branch',
                description: 'Pushes, manual runs and schedules on a branch',
              },
              {
                value: 'release',
                title: 'Release',
                disabled: true,
                wide: true,
                description: 'Releases are not published in this repository.',
              },
            ]}
          />
        </FieldSet>
      ),
      code: `<RadioCards name="ctx" value="branch" options={[
  { value: 'environment', title: 'Environment', description: '…' },
  { value: 'branch', title: 'Branch', description: '…' },
  { value: 'release', title: 'Release', disabled: true, wide: true,
    description: 'Releases are not published in this repository.' },
]} />`,
    },
    {
      title: 'Columns',
      description:
        'One column for long descriptions, three for short ones. Below 40rem every grid is one column.',
      layout: 'stack',
      render: () => (
        <>
          <FieldSet id="rc-kind" legend="What calls tokengate?">
            <RadioCards
              name="rc-kind"
              columns={3}
              value="github"
              options={[
                {
                  value: 'github',
                  title: 'GitHub Actions',
                  description: 'OIDC from token.actions.githubusercontent.com',
                },
                {
                  value: 'gitlab',
                  title: 'GitLab CI',
                  description: 'OIDC from your GitLab instance',
                },
                {
                  value: 'oidc',
                  title: 'Other OIDC',
                  badge: <Badge>Advanced</Badge>,
                  description: 'Any issuer with a JWKS URL',
                },
              ]}
            />
          </FieldSet>
          <FieldSet id="rc-scope" legend="Who can manage this token?">
            <RadioCards
              name="rc-scope"
              columns={1}
              value="owners"
              options={[
                {
                  value: 'owners',
                  title: 'Owners only',
                  description: 'Only owners change the secret or give access.',
                },
                {
                  value: 'managers',
                  title: 'Owners and access managers',
                  description:
                    'Access managers can give and remove consumer access, never see the secret.',
                },
              ]}
            />
          </FieldSet>
        </>
      ),
      code: `<RadioCards name="kind" columns={3} value="github" options={kinds} />
<RadioCards name="scope" columns={1} value="owners" options={scopes} />`,
    },
    {
      title: 'Type cards with a logo',
      description:
        'A logo above the title, for a choice of types (“Add a consumer”); “✓ Selected” moves to the top right corner.',
      render: () => (
        <RadioCards
          id="rc-logo"
          name="rc-logo"
          columns={3}
          value="github-actions"
          options={[
            {
              value: 'github-actions',
              title: 'GitHub Actions',
              description: 'Workflows in GitHub repositories',
              logo: 'github',
            },
            {
              value: 'gitlab-ci',
              title: 'GitLab CI',
              description: 'Pipelines on GitLab.com or your own GitLab',
              logo: 'gitlab',
            },
            {
              value: 'oidc',
              title: 'Another OIDC issuer',
              description:
                'Any CI that signs OIDC tokens, such as token.actions.githubusercontent.com',
              logo: 'oidc',
            },
          ]}
        />
      ),
      code: `<RadioCards name="type" columns={3} value="github-actions" options={[
  { value: 'github-actions', title: 'GitHub Actions', description: 'Workflows in GitHub repositories', logo: 'github' },
  { value: 'gitlab-ci', title: 'GitLab CI', description: '…', logo: 'gitlab' },
  { value: 'oidc', title: 'Another OIDC issuer', description: '…', logo: 'oidc' },
]} />`,
    },
  ],
  props: [
    {
      component: 'RadioCards',
      props: [
        { name: 'name', type: 'string', required: true, description: 'Radio group name.' },
        {
          name: 'options',
          type: 'readonly RadioCard[]',
          required: true,
          description: (
            <>
              <code>
                {
                  '{ value, title, description?, badge?, logo?, risk?, wide?, disabled?, checked?, o? }'
                }
              </code>
              . 2–6 of them.
            </>
          ),
        },
        {
          name: 'value',
          type: 'string',
          description: 'The checked value (or checked on an option).',
        },
        { name: 'columns', type: '1 | 2 | 3', default: '2', description: 'Cards per row.' },
        {
          name: 'id',
          type: 'string',
          description: 'Input id prefix; defaults to the FieldSet’s id.',
        },
        { name: 'required', type: 'boolean', description: 'Never inside a Reveal (it throws).' },
        {
          name: 'invalid',
          type: 'boolean',
          description: (
            <>
              The server rejected the group: the first option that is not disabled gets
              aria-invalid. Link the ErrorSummary entry to it with{' '}
              <code>firstChoiceId(id, options)</code>.
            </>
          ),
        },
        { name: 'class', type: 'string', description: 'Extra classes on .rcs.' },
      ],
    },
  ],
  accessibility: [
    'Each card is a label around a native radio: arrow keys move between options, Space checks.',
    '“✓ Selected” is decoration (aria-hidden); the radio state is read instead.',
    'The ⚠ glyph is hidden; the word “Risk” is read with the option, and its description says what the risk is.',
    'A disabled option keeps its text, so people learn why it is not available.',
    'On an error re-render, the ErrorSummary links to the first enabled radio (a fieldset cannot take focus), and that radio is aria-invalid.',
    'Focus shows a 2px ring around the whole card.',
  ],
  do: [
    'Preselect the option the entry point implies.',
    'Start a risky option’s description with “Risk:” and say what can happen.',
  ],
  dont: [
    'Do not use more than 6 cards.',
    'Do not use color alone to mark a risk.',
    'Do not hide disabled options without saying why.',
  ],
  classes: ['rcs', 'c1', 'c3', 'rc', 'wide', 'risk', 'rc-b', 'rc-t', 'rc-d', 'sel', 'risktag'],
};
