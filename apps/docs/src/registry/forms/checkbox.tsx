import { Checkbox } from '@tokengate/ui';
import type { ComponentDoc } from '../types';

export const checkbox: ComponentDoc = {
  slug: 'checkbox',
  name: 'Checkbox',
  summary: 'A single checkbox row: the box, then a statement of what checking it does.',
  usage: {
    when: [
      'One yes/no option that is off by default: “Also create a token for uploads.github.com”.',
      'A constraint that adds to a choice: “GitHub-hosted runners only”.',
    ],
    whenNot: [
      <>
        Several presets of the same kind: <code>CheckPresets</code>.
      </>,
      <>
        Accepting a risk before saving: <code>RiskAcceptance</code>.
      </>,
      'A choice between two named options: radio cards.',
    ],
  },
  examples: [
    {
      title: 'Default and checked',
      layout: 'stack',
      render: () => (
        <>
          <Checkbox name="cb-uploads" value="1">
            Also create a token for uploads.github.com with the same secret.
          </Checkbox>
          <Checkbox name="cb-hosted" value="1" checked>
            GitHub-hosted runners only
          </Checkbox>
        </>
      ),
      code: `<Checkbox name="also_uploads" value="1">
  Also create a token for uploads.github.com with the same secret.
</Checkbox>
<Checkbox name="hosted_only" value="1" checked>GitHub-hosted runners only</Checkbox>`,
    },
    {
      title: 'With a hint line',
      description: 'The second line says what the option changes.',
      layout: 'stack',
      render: () => (
        <Checkbox name="cb-hosted2" value="1" hint="Refuse jobs that run on self-hosted runners.">
          GitHub-hosted runners only
        </Checkbox>
      ),
      code: `<Checkbox name="hosted_only" value="1" hint="Refuse jobs that run on self-hosted runners.">
  GitHub-hosted runners only
</Checkbox>`,
    },
    {
      title: 'Disabled',
      layout: 'stack',
      render: () => (
        <Checkbox
          name="cb-uploads2"
          value="1"
          disabled
          hint="This repository has no uploads.github.com token type."
        >
          Also create a token for uploads.github.com
        </Checkbox>
      ),
      code: `<Checkbox name="also_uploads" value="1" disabled
  hint="This repository has no uploads.github.com token type.">
  Also create a token for uploads.github.com
</Checkbox>`,
    },
  ],
  props: [
    {
      component: 'Checkbox',
      props: [
        { name: 'name', type: 'string', required: true, description: 'Form field name.' },
        {
          name: 'value',
          type: 'string',
          description: 'Value sent when checked (the browser sends “on” without one).',
        },
        { name: 'checked', type: 'boolean', description: 'Checked on load.' },
        { name: 'disabled', type: 'boolean', description: 'Not editable and not submitted.' },
        { name: 'required', type: 'boolean', description: 'Never inside a Reveal (it throws).' },
        { name: 'id', type: 'string', description: 'Id of the input, for an ErrorSummary link.' },
        { name: 'hint', type: 'Child', description: 'Second line, part of the label.' },
        { name: 'invalid', type: 'boolean', description: 'Sets aria-invalid.' },
        {
          name: 'describedBy',
          type: 'string',
          description: 'Ids that describe the box (an error line).',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the label.' },
        { name: 'children', type: 'Child', required: true, description: 'The statement.' },
      ],
    },
  ],
  accessibility: [
    'The whole row is the label, so the click target is the full text, not only the 16px box.',
    'The hint is inside the label, so it is read with the option name.',
    'Focus shows a 2px ring around the whole row.',
  ],
  do: ['Write the label as a statement that is true when checked.'],
  dont: [
    'Do not use a negative label (“Do not allow …”).',
    'Do not use a checkbox to accept a risk: use RiskAcceptance, which names the risks.',
  ],
  classes: ['check', 'hint'],
};
