import { Field, Select } from '@tokengate/ui';
import type { ComponentDoc } from '../types';

const hosts = [
  { value: 'api.anthropic.com', label: 'api.anthropic.com' },
  { value: 'api.github.com', label: 'api.github.com' },
  { value: 'api.openai.com', label: 'api.openai.com' },
  { value: 'discord.com', label: 'discord.com' },
  { value: 'hooks.slack.com', label: 'hooks.slack.com' },
  { value: 'slack.com', label: 'slack.com' },
  { value: 'uploads.github.com', label: 'uploads.github.com', disabled: true },
];

export const select: ComponentDoc = {
  slug: 'select',
  name: 'Select',
  summary: 'A native 40px select with a drawn chevron, for seven or more options.',
  usage: {
    when: ['Seven or more options that fit in one line each: allowed hosts, regions, time zones.'],
    whenNot: [
      <>
        2–6 options: <code>RadioCards</code>, so every option and its explanation is visible.
      </>,
      <>
        Short values (environment, expiry): <code>Picks</code>.
      </>,
      <>
        Existing values with a usage count: <code>RowPicker</code>.
      </>,
    ],
  },
  examples: [
    {
      title: 'With a value',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <Field id="se-host" label="Host" hint="Tokens may point only at allowed hosts.">
            <Select name="host" options={hosts} value="slack.com" />
          </Field>
        </div>
      ),
      code: `const hosts = [
  { value: 'api.anthropic.com', label: 'api.anthropic.com' },
  …
  { value: 'uploads.github.com', label: 'uploads.github.com', disabled: true },
];

<Field id="host" label="Host" hint="Tokens may point only at allowed hosts.">
  <Select name="host" options={hosts} value="slack.com" />
</Field>`,
    },
    {
      title: 'Placeholder, error',
      description:
        'The placeholder option has an empty value; once a value is chosen it cannot be chosen again.',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <Field id="se-host2" label="Host" error="Choose the host this token calls.">
            <Select name="host" options={hosts} placeholder="Choose a host" />
          </Field>
        </div>
      ),
      code: `<Field id="host" label="Host" error="Choose the host this token calls.">
  <Select name="host" options={hosts} placeholder="Choose a host" />
</Field>`,
    },
    {
      title: 'Grouped options',
      description:
        'Option groups (optgroup) mix with plain options, in the order given: the audit target filter.',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <Field id="se-target" label="Target">
            <Select
              name="target"
              value="token"
              options={[
                { value: '', label: 'All targets' },
                {
                  group: 'Settings',
                  options: [
                    { value: 'admin_hosts', label: 'Admin hosts' },
                    { value: 'upstream_hosts', label: 'Upstream hosts' },
                    { value: 'login', label: 'Login' },
                  ],
                },
                {
                  group: 'Access',
                  options: [
                    { value: 'token', label: 'Service tokens' },
                    { value: 'consumer', label: 'Service consumers' },
                    { value: 'user', label: 'Users' },
                  ],
                },
              ]}
            />
          </Field>
        </div>
      ),
      code: `<Field id="target" label="Target">
  <Select name="target" value="token" options={[
    { value: '', label: 'All targets' },
    { group: 'Settings', options: [
      { value: 'admin_hosts', label: 'Admin hosts' },
      { value: 'upstream_hosts', label: 'Upstream hosts' },
      { value: 'login', label: 'Login' },
    ] },
    { group: 'Access', options: [
      { value: 'token', label: 'Service tokens' },
      { value: 'consumer', label: 'Service consumers' },
      { value: 'user', label: 'Users' },
    ] },
  ]} />
</Field>`,
    },
    {
      title: 'Disabled',
      layout: 'stack',
      render: () => (
        <div class="fields">
          <Field id="se-host3" label="Host" hint="Fixed by the Slack type.">
            <Select name="host" options={hosts} value="slack.com" disabled />
          </Field>
        </div>
      ),
      code: `<Field id="host" label="Host" hint="Fixed by the Slack type.">
  <Select name="host" options={hosts} value="slack.com" disabled />
</Field>`,
    },
  ],
  props: [
    {
      component: 'Select',
      props: [
        { name: 'id', type: 'string', description: 'Defaults to the Field’s id.' },
        { name: 'name', type: 'string', description: 'Form field name.' },
        {
          name: 'options',
          type: 'readonly (SelectOption | SelectOptionGroup)[]',
          required: true,
          description:
            'Seven or more, in a useful order (alphabetical, or most used first). SelectOption is { value; label; disabled? }; SelectOptionGroup is { group; options } (an optgroup). Both mix, in the order given.',
        },
        { name: 'value', type: 'string', description: 'The selected value.' },
        {
          name: 'placeholder',
          type: 'string',
          description: 'First option with an empty value, selected while there is no value.',
        },
        { name: 'required', type: 'boolean', description: 'Never inside a Reveal (it throws).' },
        { name: 'disabled', type: 'boolean', description: 'Not editable and not submitted.' },
        { name: 'autocomplete', type: 'string', description: 'Native autocomplete.' },
        { name: 'invalid', type: 'boolean', description: 'Defaults to the Field’s error state.' },
        {
          name: 'describedBy',
          type: 'string',
          description: 'Ids added after the Field’s hint, error and note ids (a shared hint).',
        },
        { name: 'class', type: 'string', description: 'Extra classes on the select.' },
      ],
    },
  ],
  accessibility: [
    'A native select: keyboard, type-ahead and screen reader support come from the browser.',
    'Inside a Field it is labelled and described like an input, and aria-invalid on error.',
    'Group labels are native optgroups: screen readers announce the group with its options.',
    'The chevron is a background image; the control border meets 3:1 in both schemes.',
  ],
  do: ['Order options so the likely one is easy to find.', 'Preselect the value from context.'],
  dont: [
    'Do not use a select for 2–6 options.',
    'Do not hide an explanation the person needs to choose inside option labels.',
  ],
  classes: ['select'],
};
