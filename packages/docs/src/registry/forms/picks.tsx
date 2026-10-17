import { FieldSet, Picks } from '@tokengate/ui';
import type { ComponentDoc } from '../types';
import { environments, expiries } from './data';

export const picks: ComponentDoc = {
  slug: 'picks',
  name: 'Picks',
  summary: 'Compact pill radios for short values: environment, expiry.',
  usage: {
    when: ['A short value from a small set: “production”, “7 days”, “Never”.'],
    whenNot: [
      <>
        Options that need a sentence of explanation: <code>RadioCards</code>.
      </>,
      <>
        Values with a usage count or a logo: <code>RowPicker</code>.
      </>,
    ],
  },
  examples: [
    {
      title: 'Expiry',
      layout: 'stack',
      render: () => (
        <FieldSet id="pk-exp" legend="Expires">
          <Picks name="pk-exp" options={expiries} value="never" />
        </FieldSet>
      ),
      code: `<FieldSet id="exp" legend="Expires">
  <Picks name="exp" value="never" options={[
    { value: 'never', label: 'Never' },
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
    { value: '90d', label: '90 days' },
    { value: 'date', label: 'On a date' },
  ]} />
</FieldSet>`,
    },
    {
      title: 'Mono values with a meta',
      description: 'Exact names in mono; “Other” leads to a free-text field.',
      layout: 'stack',
      render: () => (
        <FieldSet
          id="pk-env"
          legend="Environment"
          hint="Exact name from the job’s environment: key."
        >
          <Picks name="pk-env" options={environments} value="production" />
        </FieldSet>
      ),
      code: `<FieldSet id="env" legend="Environment" hint="Exact name from the job’s environment: key.">
  <Picks name="env" value="production" options={[
    { value: 'production', label: 'production', mono: true, meta: 'most used' },
    { value: 'staging', label: 'staging', mono: true },
    { value: 'preview', label: 'preview', mono: true },
    { value: 'other', label: 'Other' },
  ]} />
</FieldSet>`,
    },
    {
      title: 'Nothing checked, error, disabled',
      layout: 'stack',
      render: () => (
        <FieldSet id="pk-err" legend="Expires" error="Choose when the access expires.">
          <Picks
            name="pk-err"
            options={[
              ...expiries.slice(0, 4),
              { value: 'date', label: 'On a date', disabled: true },
            ]}
          />
        </FieldSet>
      ),
      code: `<FieldSet id="exp" legend="Expires" error="Choose when the access expires.">
  <Picks name="exp" options={[…, { value: 'date', label: 'On a date', disabled: true }]} />
</FieldSet>`,
    },
  ],
  props: [
    {
      component: 'Picks',
      props: [
        { name: 'name', type: 'string', required: true, description: 'Radio group name.' },
        {
          name: 'options',
          type: 'readonly Pick[]',
          required: true,
          description: (
            <code>{'{ value, label, mono?, meta?, risk?, disabled?, checked?, o? }'}</code>
          ),
        },
        { name: 'value', type: 'string', description: 'The checked value.' },
        {
          name: 'id',
          type: 'string',
          description: 'Input id prefix; defaults to the FieldSet’s id.',
        },
        { name: 'required', type: 'boolean', description: 'Never inside a Reveal (it throws).' },
        { name: 'class', type: 'string', description: 'Extra classes on .picks.' },
      ],
    },
  ],
  accessibility: [
    'Native radios in labels: arrow keys move between picks.',
    'Each pick is at least 40px high.',
    'Checked is shown by a 2px accent border and background, and read as the radio state.',
  ],
  do: ['Keep labels to one or two words.', 'Preselect a safe default (Never, production).'],
  dont: ['Do not use picks for options that need an explanation.'],
  classes: ['picks', 'pick', 'meta', 'mono'],
};
